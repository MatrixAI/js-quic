import type { PromiseCancellable } from '@matrixai/async-cancellable';
import type { ContextTimed, ContextTimedInput } from '@matrixai/contexts';
import type QUICSocket from './QUICSocket';
import type {
  Host,
  Port,
  RemoteInfo,
  QUICConfig,
  ConnectionMetadata,
  StreamId,
  StreamCodeToReason,
  StreamReasonToCode,
} from './types';
import type { Connection, ConnectionError, SendInfo } from './native/types';
import Logger from '@matrixai/logger';
import { Timer } from '@matrixai/timer';
import { Lock } from '@matrixai/async-locks';
import { AbstractEvent, EventAll } from '@matrixai/events';
import {
  StartStop,
  ready,
  running,
  status,
} from '@matrixai/async-init/dist/StartStop';
import { timedCancellable, context } from '@matrixai/contexts/dist/decorators';
import { buildQuicheConfig, minIdleTimeout } from './config';
import QUICConnectionId from './QUICConnectionId';
import QUICStream from './QUICStream';
import { quiche, ConnectionErrorCode } from './native';
import * as utils from './utils';
import * as events from './events';
import * as errors from './errors';
import { sleep } from '../tests/utils';

interface QUICConnection extends StartStop {}
@StartStop({
  eventStart: events.EventQUICConnectionStart,
  eventStarted: events.EventQUICConnectionStarted,
  eventStop: events.EventQUICConnectionStop,
  eventStopped: events.EventQUICConnectionStopped,
})
class QUICConnection {
  /**
   * This determines when it is a client or server connection.
   */
  public readonly type: 'client' | 'server';

  /**
   * Resolves once the connection has closed.
   */
  public readonly closedP: Promise<void>;

  /**
   * Internal native connection object.
   * @internal
   */
  public readonly conn: Connection;

  /**
   * Internal stream map.
   * @internal
   */
  public readonly streamMap: Map<StreamId, QUICStream> = new Map();

  protected logger: Logger;
  protected socket: QUICSocket;
  protected config: QUICConfig;
  protected reasonToCode: StreamReasonToCode;
  protected codeToReason: StreamCodeToReason;

  /**
   * This ensures that `recv` is serialised.
   * Prevents a new `recv` call intercepting the previous `recv` call that is
   * still finishing up with a `send` call.
   */
  protected recvLock: Lock = new Lock();

  /**
   * Client initiated bidirectional stream starts at 0.
   * Increment by 4 to get the next ID.
   */
  protected streamIdClientBidi: StreamId = 0b00 as StreamId;

  /**
   * Server initiated bidirectional stream starts at 1.
   * Increment by 4 to get the next ID.
   */
  protected streamIdServerBidi: StreamId = 0b01 as StreamId;

  /**
   * Client initiated unidirectional stream starts at 2.
   * Increment by 4 to get the next ID.
   */
  protected streamIdClientUni: StreamId = 0b10 as StreamId;

  /**
   * Server initiated unidirectional stream starts at 3.
   * Increment by 4 to get the next ID.
   */
  protected streamIdServerUni: StreamId = 0b11 as StreamId;

  /**
   * Quiche connection timer. This performs time delayed state transitions.
   */
  protected connTimeoutTimer?: Timer;

  /**
   * Keep alive timer.
   *
   * Quiche does not natively ensure activity on the connection. This interval
   * timer guarantees that there will be activity on the connection by sending
   * acknowlegement eliciting frames, which will cause the peer to acknowledge.
   *
   * This is still useful even if the `config.maxIdleTimeout` is set to 0, which
   * means the connection will never timeout due to being idle.
   *
   * This mechanism will only start working after `secureEstablishedP`.
   */
  protected keepAliveIntervalTimer?: Timer;

  /**
   * Remote host which can change on every `QUICConnection.recv`.
   */
  protected _remoteHost: Host;

  /**
   * Remote port which can change on every `QUICConnection.recv`.
   */
  protected _remotePort: Port;

  /**
   * Chain of local certificates from leaf to root in DER format.
   */
  protected certDERs: Array<Uint8Array> = [];

  /**
   * Array of independent CA certificates in DER format.
   */
  protected caDERs: Array<Uint8Array> = [];

  /**
   * Secure connection establishment means that this connection has completed
   * peer certificate verification, and the connection is ready to be used.
   */
  protected secureEstablished = false;

  /**
   * Resolves after connection is established and peer certs have been verified.
   */
  protected secureEstablishedP: Promise<void>;
  protected resolveSecureEstablishedP: () => void;
  protected rejectSecureEstablishedP: (reason?: any) => void;

  protected resolveClosedP: () => void;

  /**
   * Stores the last dispatched error. If no error, it will be `null`.
   *
   * `QUICConnection.stop` will need this if it is called by the user concurrent
   * with handling `EventQUICConnectionError`. It ensures that `this.stop` uses
   * the original error when force destroying the streams.
   */
  protected errorLast:
    | errors.ErrorQUICConnectionLocal<unknown>
    | errors.ErrorQUICConnectionPeer<unknown>
    | errors.ErrorQUICConnectionIdleTimeout<unknown>
    | errors.ErrorQUICConnectionInternal<unknown>
    | null = null;

  /**
   * Handle `EventQUICConnectionError`.
   *
   * QUIC connections always close with errors. Graceful errors are logged out
   * at INFO level, while non-graceful errors are logged out at ERROR level.
   *
   * Internal errors will be thrown upwards to become an uncaught exception.
   *
   * @throws {errors.ErrorQUICConnectionInternal}
   */
  protected handleEventQUICConnectionError = (
    evt: events.EventQUICConnectionError,
  ) => {
    const error = evt.detail;
    this.errorLast = error;
    // Log out error for debugging
    this.logger.info(utils.formatError(error));
    if (error instanceof errors.ErrorQUICConnectionInternal) {
      throw error;
    }
    this.dispatchEvent(
      new events.EventQUICConnectionClose({
        detail: error,
      }),
    );
  };

  /**
   * Handles `EventQUICConnectionClose`.
   * Registered once.
   *
   * This event means that `this.conn.close()` is already called.
   * It does not mean that `this.closedP` is resolved. The resolving of
   * `this.closedP` depends on the `this.connTimeoutTimer`.
   */
  protected handleEventQUICConnectionClose = async (
    evt: events.EventQUICConnectionClose,
  ) => {
    const error = evt.detail;
    // Reject the secure established promise
    // This will allow `this.start()` to reject with the error.
    // No effect if this connection is running.
    if (!this.secureEstablished) {
      this.rejectSecureEstablishedP(error);
    }
    // Complete the final send call if it was a local close
    if (error instanceof errors.ErrorQUICConnectionLocal) {
      await this.send();
    }
    // If the connection is still running, we will force close the connection
    if (this[running] && this[status] !== 'stopping') {
      // The `stop` will need to retrieve the error from `this.errorLast`
      await this.stop({
        force: true,
      });
    }
  };

  /**
   * Handles all `EventQUICStream` events.
   */
  protected handleEventQUICStream = (evt: EventAll) => {
    if (evt.detail instanceof AbstractEvent) {
      this.dispatchEvent(evt.detail.clone());
    }
  };

  /**
   * Handles `EventQUICStreamSend`.
   *
   * This handler will trigger `this.send` when there is data in the writable
   * stream buffer. As this is asynchronous, it is necessary to check if this
   * `QUICConnection` is still running.
   */
  protected handleEventQUICStreamSend = async () => {
    if (this[running]) await this.send();
  };

  /**
   * Handles `EventQUICStreamDestroyed`.
   * Registered once.
   */
  protected handleEventQUICStreamDestroyed = (
    evt: events.EventQUICStreamDestroyed,
  ) => {
    const quicStream = evt.target as QUICStream;
    quicStream.removeEventListener(
      events.EventQUICStreamSend.name,
      this.handleEventQUICStreamSend,
    );
    quicStream.removeEventListener(EventAll.name, this.handleEventQUICStream);
    this.streamMap.delete(quicStream.streamId);
  };

  /**
   * Constructs a QUIC connection.
   *
   * @param opts
   * @param opts.type - client or server connection
   * @param opts.scid - source connection ID
   * @param opts.dcid - destination connection ID
   * @param opts.serverName - client connections can use server name for
   *                          verifying the server's certificate, however if
   *                          `config.verifyCallback` is set, this will have no
   *                          effect
   * @param opts.remoteInfo - remote host and port
   * @param opts.config - QUIC config
   * @param opts.socket - injected socket
   * @param opts.reasonToCode - maps stream error reasons to stream error codes
   * @param opts.codeToReason - maps stream error codes to reasons
   * @param opts.logger
   *
   * @throws {errors.ErrorQUICConnectionConfigInvalid}
   */
  public constructor({
    type,
    scid,
    dcid,
    serverName = null,
    remoteInfo,
    config,
    socket,
    reasonToCode = () => 0,
    codeToReason = (type, code) => new Error(`${type} ${code}`),
    logger,
  }:
    | {
        type: 'client';
        scid: QUICConnectionId;
        dcid?: void;
        serverName?: string | null;
        remoteInfo: RemoteInfo;
        config: QUICConfig;
        socket: QUICSocket;
        reasonToCode?: StreamReasonToCode;
        codeToReason?: StreamCodeToReason;
        logger?: Logger;
      }
    | {
        type: 'server';
        scid: QUICConnectionId;
        dcid: QUICConnectionId;
        serverName?: void;
        remoteInfo: RemoteInfo;
        config: QUICConfig;
        socket: QUICSocket;
        reasonToCode?: StreamReasonToCode;
        codeToReason?: StreamCodeToReason;
        logger?: Logger;
      }) {
    this.logger = logger ?? new Logger(`${this.constructor.name} ${scid}`);
    if (
      config.keepAliveIntervalTime != null &&
      config.maxIdleTimeout !== 0 &&
      config.keepAliveIntervalTime >= config.maxIdleTimeout
    ) {
      throw new errors.ErrorQUICConnectionConfigInvalid(
        '`keepAliveIntervalTime` must be less than `maxIdleTimeout`',
      );
    }
    const quicheConfig = buildQuicheConfig(config);
    let conn: Connection;
    if (type === 'client') {
      this.logger.info(`Connect ${this.constructor.name}`);
      conn = quiche.Connection.connect(
        serverName,
        scid,
        {
          host: socket.host,
          port: socket.port,
        },
        {
          host: remoteInfo.host,
          port: remoteInfo.port,
        },
        quicheConfig,
      );
    } else if (type === 'server') {
      this.logger.info(`Accept ${this.constructor.name}`);
      conn = quiche.Connection.accept(
        scid,
        dcid,
        {
          host: socket.host,
          port: socket.port,
        },
        {
          host: remoteInfo.host,
          port: remoteInfo.port,
        },
        quicheConfig,
      );
    }
    // This will output to the log keys file path
    if (config.logKeys != null) {
      conn!.setKeylog(config.logKeys);
    }
    this.type = type;
    this.conn = conn!;
    this.socket = socket;
    this.config = config;
    if (this.config.cert != null) {
      const certPEMs = utils.collectPEMs(this.config.cert);
      this.certDERs = certPEMs.map(utils.pemToDER);
    }
    if (this.config.ca != null) {
      const caPEMs = utils.collectPEMs(this.config.ca);
      this.caDERs = caPEMs.map(utils.pemToDER);
    }
    this.reasonToCode = reasonToCode;
    this.codeToReason = codeToReason;
    this._remoteHost = remoteInfo.host;
    this._remotePort = remoteInfo.port;
    const {
      p: secureEstablishedP,
      resolveP: resolveSecureEstablishedP,
      rejectP: rejectSecureEstablishedP,
    } = utils.promise();
    this.secureEstablishedP = secureEstablishedP;
    this.resolveSecureEstablishedP = () => {
      // This is an idempotent mutation
      this.secureEstablished = true;
      resolveSecureEstablishedP();
    };
    this.rejectSecureEstablishedP = rejectSecureEstablishedP;
    const { p: closedP, resolveP: resolveClosedP } = utils.promise();
    this.closedP = closedP;
    this.resolveClosedP = resolveClosedP;
  }

  /**
   * This is the source connection ID.
   */
  public get connectionId() {
    const sourceId = this.conn.sourceId();
    // Zero copy construction of QUICConnectionId
    return new QUICConnectionId(
      sourceId.buffer,
      sourceId.byteOffset,
      sourceId.byteLength,
    );
  }

  /**
   * This is the destination connection ID.
   * This is only fully known after establishing the connection
   */
  @ready(new errors.ErrorQUICConnectionNotRunning())
  public get connectionIdPeer() {
    const destinationId = this.conn.destinationId();
    // Zero copy construction of QUICConnectionId
    return new QUICConnectionId(
      destinationId.buffer,
      destinationId.byteOffset,
      destinationId.byteLength,
    );
  }

  /**
   * A common ID between the client and server connection.
   * Used to identify connection pairs more easily.
   */
  @ready(new errors.ErrorQUICConnectionNotRunning())
  public get connectionIdShared() {
    const sourceId = this.conn.sourceId();
    const destinationId = this.conn.destinationId();
    if (Buffer.compare(sourceId, destinationId) <= 0) {
      return new QUICConnectionId(Buffer.concat([sourceId, destinationId]));
    } else {
      return new QUICConnectionId(Buffer.concat([destinationId, sourceId]));
    }
  }

  public get remoteHost(): Host {
    return this._remoteHost;
  }

  public get remotePort(): Port {
    return this._remotePort;
  }

  public get localHost(): Host {
    return this.socket.host;
  }

  public get localPort(): Port {
    return this.socket.port;
  }

  public get closed() {
    return this.conn.isClosed();
  }

  /**
   * Starts the QUIC connection.
   *
   * This will complete the handshake and verify the peer's certificate.
   * The connection will be ready to be used after this resolves. The peer's
   * verification of the local certificate occurs concurrently.
   *
   * @param opts
   * @param opts.data - server connections receive initial data
   * @param opts.remoteInfo - server connections receive remote host and port
   * @param ctx - timed context overrides `config.minIdleTimeout` which only
   *              works if `config.maxIdleTimeout` is greater than
   *              `config.minIdleTimeout`
   *
   * @throws {errors.ErrorQUICConnectionStartTimeout} - if timed out due to `ctx.timer` or `config.minIdleTimeout`
   * @throws {errors.ErrorQUICConnectionStartData} - if no initial data for server connection
   * @throws {errors.ErrorQUICConnection} - all other connection failure errors
   */
  public start(
    opts?: {
      data?: Uint8Array;
      remoteInfo?: RemoteInfo;
    },
    ctx?: Partial<ContextTimedInput>,
  ): PromiseCancellable<void>;
  @timedCancellable(
    true,
    minIdleTimeout,
    errors.ErrorQUICConnectionStartTimeout,
  )
  public async start(
    {
      data,
      remoteInfo,
    }: {
      data?: Uint8Array;
      remoteInfo?: RemoteInfo;
    } = {},
    @context ctx: ContextTimed,
  ): Promise<void> {
    this.logger.info(`Start ${this.constructor.name}`);
    // If the connection has already been closed, we cannot start it again
    if (this.conn.isClosed()) {
      throw new errors.ErrorQUICConnectionClosed();
    }
    ctx.signal.throwIfAborted();
    const { p: abortP, rejectP: rejectAbortP } = utils.promise<never>();
    const abortHandler = () => {
      rejectAbortP(ctx.signal.reason);
    };
    ctx.signal.addEventListener('abort', abortHandler);
    this.addEventListener(
      events.EventQUICConnectionError.name,
      this.handleEventQUICConnectionError,
    );
    this.addEventListener(
      events.EventQUICConnectionClose.name,
      this.handleEventQUICConnectionClose,
      { once: true },
    );
    if (this.type === 'client') {
      await this.send();
    } else if (this.type === 'server') {
      if (data == null || remoteInfo == null) {
        throw new errors.ErrorQUICConnectionStartData(
          'Starting a server connection requires initial data and remote information',
        );
      }
      await this.recv(data, remoteInfo);
    }
    try {
      // This will block until the connection is established
      await Promise.race([this.secureEstablishedP, abortP]);
    } catch (e) {
      if (ctx.signal.aborted) {
        // No `QUICStream` objects could have been created, however quiche stream
        // state should be cleaned up, and this can be done synchronously
        for (const streamId of this.conn.readable() as Iterable<StreamId>) {
          this.conn.streamShutdown(streamId, quiche.Shutdown.Read, 0);
        }
        for (const streamId of this.conn.writable() as Iterable<StreamId>) {
          this.conn.streamShutdown(streamId, quiche.Shutdown.Write, 0);
        }
        // According to RFC9000, closing while in the middle of a handshake
        // should use a transport error code `APPLICATION_ERROR`.
        // For this library we extend this "handshake" phase to include the
        // the TLS handshake too.
        // This is also the behaviour of quiche when the connection is not
        // in a "safe" state to send application errors (where `app` parameter is true).
        // https://www.rfc-editor.org/rfc/rfc9000.html#section-10.2.3-3
        this.conn.close(
          false,
          ConnectionErrorCode.ApplicationError,
          Buffer.from(''),
        );
        const localError = this.conn.localError()!;
        const e_ = new errors.ErrorQUICConnectionLocal(
          'Failed to start QUIC connection due to start timeout',
          {
            data: localError,
            cause: e,
          },
        );
        this.dispatchEvent(
          new events.EventQUICConnectionError({
            detail: e_,
          }),
        );
      }
      // Wait for the connection to be fully closed by the `this.connTimeoutTimer`
      await this.closedP;
      // Throws original exception
      throw e;
    } finally {
      ctx.signal.removeEventListener('abort', abortHandler);
    }
    if (this.config.keepAliveIntervalTime != null) {
      this.startKeepAliveIntervalTimer(this.config.keepAliveIntervalTime);
    }
    this.logger.info(`Started ${this.constructor.name}`);
  }

  /**
   * Stops the QUIC connection.
   *
   * @param opts
   * @param opts.isApp - whether the destroy is initiated by the application
   * @param opts.errorCode - the error code to send to the peer, use
   *                         `ConnectionErrorCode` if `isApp` is false,
   *                         otherwise any unsigned integer is fine.
   * @param opts.reason - the reason to send to the peer
   * @param opts.force - force controls whether to cancel streams or wait for
   *                     streams to close gracefully
   *
   * The provided error parameters is only used if the quiche connection is not
   * draining or closed.
   */
  public async stop({
    isApp = true,
    errorCode = 0,
    reason = new Uint8Array(),
    force = true,
  }:
    | {
        isApp: false;
        errorCode?: ConnectionErrorCode;
        reason?: Uint8Array;
        force?: boolean;
      }
    | {
        isApp?: true;
        errorCode?: number;
        reason?: Uint8Array;
        force?: boolean;
      } = {}) {
    this.logger.info(`Stop ${this.constructor.name}`);
    this.stopKeepAliveIntervalTimer();

    // Yield to allow any background processing to settle before proceeding.
    // This will allow any streams to process buffers before continuing
    await sleep(0);

    // Destroy all streams
    const streamsDestroyP: Array<Promise<void>> = [];
    for (const quicStream of this.streamMap.values()) {
      // The reason is only used if `force` is `true`
      // If `force` is not true, this will gracefully wait for
      // both readable and writable to gracefully close
      streamsDestroyP.push(
        quicStream.destroy({
          reason: this.errorLast,
          force: force || this.conn.isDraining() || this.conn.isClosed(),
        }),
      );
    }
    await Promise.all(streamsDestroyP);

    // Close after processing all streams
    if (!this.conn.isDraining() && !this.conn.isClosed()) {
      // If `this.conn.close` is already called, the connection will be draining,
      // in that case we just skip doing this local close.
      // If `this.conn.isTimedOut` is true, then the connection will be closed,
      // in that case we skip doing this local close.
      this.conn.close(isApp, errorCode, reason);
      const localError = this.conn.localError()!;
      const message = `Locally closed with ${
        localError.isApp ? 'application' : 'transport'
      } code ${localError.errorCode}`;
      const e = new errors.ErrorQUICConnectionLocal(message, {
        data: localError,
      });
      this.dispatchEvent(new events.EventQUICConnectionError({ detail: e }));
    }

    // Waiting for `closedP` to resolve
    // Only the `this.connTimeoutTimer` will resolve this promise
    await this.closedP;
    this.removeEventListener(
      events.EventQUICConnectionError.name,
      this.handleEventQUICConnectionError,
    );
    this.removeEventListener(
      events.EventQUICConnectionClose.name,
      this.handleEventQUICConnectionClose,
    );
    this.logger.info(`Stopped ${this.constructor.name}`);
  }

  /**
   * Get connection error.
   * This could be `undefined` if connection timed out.
   */
  public getConnectionError(): ConnectionError | undefined {
    return this.conn.localError() ?? this.conn.peerError() ?? undefined;
  }

  /**
   * Array of independent CA certificates in DER format.
   */
  public getLocalCACertsChain(): Array<Uint8Array> {
    return this.caDERs;
  }

  /**
   * Chain of local certificates from leaf to root in DER format.
   */
  public getLocalCertsChain(): Array<Uint8Array> {
    return this.certDERs;
  }

  /**
   * Chain of remote certificates from leaf to root in DER format.
   */
  public getRemoteCertsChain(): Array<Uint8Array> {
    return this.conn.peerCertChain() ?? [];
  }

  public meta(): ConnectionMetadata {
    return {
      localHost: this.localHost,
      localPort: this.localPort,
      remoteHost: this.remoteHost,
      remotePort: this.remotePort,
      localCertsChain: this.certDERs,
      localCACertsChain: this.caDERs,
      remoteCertsChain: this.getRemoteCertsChain(),
    };
  }

  /**
   * Receives data from the socket for this connection.
   *
   * The data flows from the socket this connection to streams.
   * This takes data from the quiche connection and pushes to the
   * `QUICStream` collection.
   *
   * This function is callable during `this.start` and `this.stop`.
   * When the connection is draining, we can still receive data.
   * However no streams are allowed to read or write data.
   *
   * @internal
   */
  @ready(new errors.ErrorQUICConnectionNotRunning(), false, [
    'starting',
    'stopping',
  ])
  public async recv(data: Uint8Array, remoteInfo: RemoteInfo): Promise<void> {
    // Enforce mutual exclusion for an atomic pair of `this.recv` and `this.send`.
    await this.recvLock.withF(async () => {
      const recvInfo = {
        to: {
          host: this.localHost,
          port: this.localPort,
        },
        from: {
          host: remoteInfo.host,
          port: remoteInfo.port,
        },
      };
      try {
        // This can process multiple QUIC packets.
        // Remember that 1 QUIC packet can have multiple QUIC frames.
        // Expect the `data` is mutated here due to in-place decryption,
        // so do not re-use the `data` afterwards.
        this.conn.recv(data, recvInfo);
      } catch (e) {
        // If `config.verifyPeer` is true and `config.verifyCallback` is undefined,
        // then during the TLS handshake, a `TlsFail` exception will only be thrown
        // if the peer did not supply a certificate or that its certificate failed
        // the default certificate verification procedure.
        // If `config.verifyPeer` is true and `config.verifyCallback` is defined,
        // then during the TLS handshake, a `TlsFail` exception will only be thrown
        // if the peer did not supply a peer certificate.
        const localError = this.conn.localError();
        if (localError == null) {
          // If there was no local error, then this is an internal error.
          const e_ = new errors.ErrorQUICConnectionInternal(
            'Failed connection recv due with unknown error',
            { cause: e },
          );
          this.dispatchEvent(
            new events.EventQUICConnectionError({ detail: e_ }),
          );
          throw e_;
        } else {
          // Quiche connection recv will automatically close with local
          // connection error and start draining.
          // This is a legitimate state transition.
          let e_: errors.ErrorQUICConnectionLocal<unknown>;
          if (e.message === 'TlsFail') {
            e_ = new errors.ErrorQUICConnectionLocalTLS(
              'Failed connection due to native TLS verification',
              {
                cause: e,
                data: localError,
              },
            );
          } else {
            e_ = new errors.ErrorQUICConnectionLocal(
              'Failed connection due to local error',
              {
                cause: e,
                data: localError,
              },
            );
          }
          this.dispatchEvent(
            new events.EventQUICConnectionError({ detail: e_ }),
          );
          return;
        }
      }
      // The remote information may be changed on each received packet.
      // If it changes, this would mean the connection has migrated.
      this._remoteHost = remoteInfo.host;
      this._remotePort = remoteInfo.port;
      // If `config.verifyCallback` is not defined, simply being established is
      // sufficient to mean we are securely established, however if it is defined
      // then secure establishment occurs only after custom TLS verification has
      // passed.
      if (
        !this.secureEstablished &&
        this.conn.isEstablished() &&
        this.config.verifyCallback == null
      ) {
        this.resolveSecureEstablishedP();
      }
      // If we are securely established we can process streams.
      if (this.secureEstablished) {
        this.processStreams();
      }
      // After every recv, there must be a send.
      await this.send();
    });
  }

  /**
   * Sends data to the socket from this connection.
   *
   * This takes the data from the quiche connection that is on the send buffer.
   * The data flows from the streams to this connection to the socket.
   *
   * - Call this if connecting to a server.
   * - Call this if `recv` is called.
   * - Call this if `connTimeoutTimer` ticks.
   * - Call this if stream is written.
   * - Call this if stream is read.
   *
   * This function is callable during `this.start` and `this.stop`.
   * When the connection is draining, we can still receive data.
   * However no streams are allowed to read or write data.
   *
   * @internal
   */
  @ready(new errors.ErrorQUICConnectionNotRunning(), false, [
    'starting',
    'stopping',
  ])
  public async send(): Promise<void> {
    let sendLength: number;
    let sendInfo: SendInfo;
    // Send until `Done`
    while (true) {
      // Fastest way of allocating a buffer, which will be dispatched
      const sendBuffer = Buffer.allocUnsafe(this.config.maxSendUdpPayloadSize);
      try {
        const result = this.conn.send(sendBuffer);
        if (result === null) {
          // Break the loop
          break;
        }
        [sendLength, sendInfo] = result;
      } catch (e) {
        // Internal error if send failed
        const e_ = new errors.ErrorQUICConnectionInternal(
          'Failed connection send with unknown internal error',
          { cause: e },
        );
        this.dispatchEvent(new events.EventQUICConnectionError({ detail: e_ }));
        throw e_;
      }
      this.dispatchEvent(
        new events.EventQUICConnectionSend({
          detail: {
            msg: sendBuffer.subarray(0, sendLength),
            port: sendInfo.to.port,
            address: sendInfo.to.host,
          },
        }),
      );
    }
    // Resets the `this.connTimeoutTimer` because quiche timeout becomes
    // non-null after the first send call is made, and subsequently, each
    // send call may end up resetting the quiche timeout value.
    this.setConnTimeoutTimer();
    if (
      !this.secureEstablished &&
      !this.conn.isDraining() &&
      !this.conn.isClosed() &&
      this.conn.isEstablished() &&
      this.config.verifyPeer &&
      this.config.verifyCallback != null
    ) {
      const peerCertsChain = this.conn.peerCertChain()!;
      // Custom TLS verification
      const cryptoError = await this.config.verifyCallback(
        peerCertsChain,
        this.caDERs,
      );
      if (cryptoError != null) {
        // This simulates the crypto error that occurs natively
        this.conn.close(false, cryptoError, Buffer.from(''));
        const localError = this.conn.localError()!;
        const e_ = new errors.ErrorQUICConnectionLocalTLS(
          'Failed connection due to custom TLS verification',
          {
            data: localError,
          },
        );
        this.dispatchEvent(
          new events.EventQUICConnectionError({
            detail: e_,
          }),
        );
        return;
      }
      // If this succeeds, then we have securely established, and we can
      // process all the streams, that would have originally occurred in
      // `this.recv`. This will only be run on the first time, we perform
      // the custom TLS verification
      this.resolveSecureEstablishedP();
      this.processStreams();
    }
    if (this[status] !== 'stopping') {
      const peerError = this.conn.peerError();
      if (peerError != null) {
        const message = `Peer closed with ${
          peerError.isApp ? 'application' : 'transport'
        } code ${peerError.errorCode}`;
        if (
          peerError.errorCode >= quiche.CRYPTO_ERROR_START &&
          peerError.errorCode <= quiche.CRYPTO_ERROR_STOP
        ) {
          this.dispatchEvent(
            new events.EventQUICConnectionError({
              detail: new errors.ErrorQUICConnectionPeerTLS(message, {
                data: peerError,
              }),
            }),
          );
        } else {
          this.dispatchEvent(
            new events.EventQUICConnectionError({
              detail: new errors.ErrorQUICConnectionPeer(message, {
                data: peerError,
              }),
            }),
          );
        }
        return;
      }
    }
  }

  protected processStreams() {
    for (const streamId of this.conn.readable() as Iterable<StreamId>) {
      let quicStream = this.streamMap.get(streamId);
      if (quicStream == null) {
        quicStream = QUICStream.createQUICStream({
          initiated: 'peer',
          streamId,
          config: this.config,
          connection: this,
          codeToReason: this.codeToReason,
          reasonToCode: this.reasonToCode,
          logger: this.logger.getChild(`${QUICStream.name} ${streamId}`),
        });
        this.streamMap.set(quicStream.streamId, quicStream);
        quicStream.addEventListener(
          events.EventQUICStreamSend.name,
          this.handleEventQUICStreamSend,
        );
        quicStream.addEventListener(
          events.EventQUICStreamDestroyed.name,
          this.handleEventQUICStreamDestroyed,
          { once: true },
        );
        quicStream.addEventListener(EventAll.name, this.handleEventQUICStream);
        this.dispatchEvent(
          new events.EventQUICConnectionStream({ detail: quicStream }),
        );
      }
      quicStream.read();
    }
    for (const streamId of this.conn.writable() as Iterable<StreamId>) {
      let quicStream = this.streamMap.get(streamId);
      if (quicStream == null) {
        quicStream = QUICStream.createQUICStream({
          initiated: 'peer',
          streamId,
          config: this.config,
          connection: this,
          codeToReason: this.codeToReason,
          reasonToCode: this.reasonToCode,
          logger: this.logger.getChild(`${QUICStream.name} ${streamId}`),
        });
        this.streamMap.set(quicStream.streamId, quicStream);
        quicStream.addEventListener(
          events.EventQUICStreamSend.name,
          this.handleEventQUICStreamSend,
        );
        quicStream.addEventListener(
          events.EventQUICStreamDestroyed.name,
          this.handleEventQUICStreamDestroyed,
          { once: true },
        );
        quicStream.addEventListener(EventAll.name, this.handleEventQUICStream);
        this.dispatchEvent(
          new events.EventQUICConnectionStream({ detail: quicStream }),
        );
      }
      quicStream.write();
    }
  }

  /**
   * Sets up the connection timeout timer.
   *
   * This only gets called on the first `QUICConnection.send`.
   * It's the responsiblity of this timer to resolve the `closedP`.
   */
  protected setConnTimeoutTimer(): void {
    const connTimeoutHandler = async (signal: AbortSignal) => {
      // If aborted, just immediately resolve
      if (signal.aborted) return;
      // This can only be called when the timeout has occurred.
      // This transitions the connection state.
      // `conn.timeout()` is time aware, so calling `conn.onTimeout` will only
      //  trigger state transitions after the time has passed.
      this.conn.onTimeout();
      // If it is closed, we can resolve, and we are done for this connection.
      if (this.conn.isClosed()) {
        this.resolveClosedP();
        // Check if the connection timed out due to the `maxIdleTimeout`
        if (this.conn.isTimedOut()) {
          this.dispatchEvent(
            new events.EventQUICConnectionError({
              detail: new errors.ErrorQUICConnectionIdleTimeout(),
            }),
          );
        }
        return;
      }
      await this.send();
      // Note that a `0` timeout is still a valid timeout
      const timeout = this.conn.timeout();
      // If the max idle timeout is 0, then the timeout may be `null`,
      // and it would only be set when the connection is ready to be closed.
      // If it is `null`, there is no need to setup the next timer
      if (timeout == null) {
        return;
      }
      // Allow an extra 1ms to compensate for clock desync with quiche
      this.connTimeoutTimer = new Timer({
        delay: timeout + 1,
        handler: connTimeoutHandler,
        lazy: true,
      });
    };
    // Note that a `0` timeout is still a valid timeout
    const timeout = this.conn.timeout();
    // If this is `null`, then quiche is requesting the timer to be cleaned up
    if (timeout == null) {
      // Cancellation only matters if the timer status is `null` or settling
      // If it is `null`, then the timer handler doesn't run
      // If it is `settled`, then cancelling is a noop
      // If it is `settling`, then cancelling only prevents it at the beginning of the handler
      this.connTimeoutTimer?.cancel();
      // The `this.connTimeoutTimer` is a lazy timer, so it's status may still
      // be `null` or `settling`. So we have to delete it here to ensure that
      // the timer will be recreated.
      delete this.connTimeoutTimer;
      if (this.conn.isClosed()) {
        this.resolveClosedP();
        if (this.conn.isTimedOut()) {
          this.dispatchEvent(
            new events.EventQUICConnectionError({
              detail: new errors.ErrorQUICConnectionIdleTimeout(),
            }),
          );
        }
      }
      return;
    }
    // If there's no timer, create it
    // If the timer is settled, create it
    // If the timer is null, reset it
    // If the timer is settling, do nothing (it will recreate itself)
    // Plus 1 to the `timeout` to compensate for clock desync with quiche
    if (
      this.connTimeoutTimer == null ||
      this.connTimeoutTimer.status === 'settled'
    ) {
      this.connTimeoutTimer = new Timer({
        delay: timeout + 1,
        handler: connTimeoutHandler,
        lazy: true,
      });
    } else if (this.connTimeoutTimer.status == null) {
      this.connTimeoutTimer.reset(timeout + 1);
    }
  }

  /**
   * Creates a new QUIC stream on the connection.
   */
  @ready(new errors.ErrorQUICConnectionNotRunning())
  public newStream(type: 'bidi' | 'uni' = 'bidi'): QUICStream {
    let streamId: StreamId;
    if (this.type === 'client' && type === 'bidi') {
      streamId = this.streamIdClientBidi;
    } else if (this.type === 'server' && type === 'bidi') {
      streamId = this.streamIdServerBidi;
    } else if (this.type === 'client' && type === 'uni') {
      streamId = this.streamIdClientUni;
    } else if (this.type === 'server' && type === 'uni') {
      streamId = this.streamIdServerUni;
    }
    const quicStream = QUICStream.createQUICStream({
      initiated: 'local',
      streamId: streamId!,
      connection: this,
      config: this.config,
      codeToReason: this.codeToReason,
      reasonToCode: this.reasonToCode,
      logger: this.logger.getChild(`${QUICStream.name} ${streamId!}`),
    });
    this.streamMap.set(quicStream.streamId, quicStream);
    quicStream.addEventListener(
      events.EventQUICStreamSend.name,
      this.handleEventQUICStreamSend,
    );
    quicStream.addEventListener(
      events.EventQUICStreamDestroyed.name,
      this.handleEventQUICStreamDestroyed,
      { once: true },
    );
    quicStream.addEventListener(EventAll.name, this.handleEventQUICStream);
    if (this.type === 'client' && type === 'bidi') {
      this.streamIdClientBidi = (this.streamIdClientBidi + 4) as StreamId;
    } else if (this.type === 'server' && type === 'bidi') {
      this.streamIdServerBidi = (this.streamIdServerBidi + 4) as StreamId;
    } else if (this.type === 'client' && type === 'uni') {
      this.streamIdClientUni = (this.streamIdClientUni + 4) as StreamId;
    } else if (this.type === 'server' && type === 'uni') {
      this.streamIdServerUni = (this.streamIdServerUni + 4) as StreamId;
    }
    return quicStream;
  }

  /**
   * Starts the keep alive interval timer.
   *
   * Interval time should be less than `maxIdleTimeout` unless it is `0`, which
   * means `Infinity`.
   *
   * If the `maxIdleTimeout` is `0`, this can still be useful to maintain
   * activity on the connection.
   */
  protected startKeepAliveIntervalTimer(ms: number): void {
    const keepAliveHandler = async (signal: AbortSignal) => {
      if (signal.aborted) return;
      // Intelligently schedule a PING frame.
      // If the connection has already sent ack-eliciting frames
      // then this is a noop.
      this.conn.sendAckEliciting();
      await this.send();
      if (signal.aborted) return;
      this.keepAliveIntervalTimer = new Timer({
        delay: ms,
        handler: keepAliveHandler,
        lazy: true,
      });
    };
    this.keepAliveIntervalTimer = new Timer({
      delay: ms,
      handler: keepAliveHandler,
      lazy: true,
    });
  }

  /**
   * Stops the keep alive interval timer
   */
  protected stopKeepAliveIntervalTimer(): void {
    this.keepAliveIntervalTimer?.cancel();
  }
}

export default QUICConnection;
