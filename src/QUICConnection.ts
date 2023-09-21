import type { PromiseCancellable } from '@matrixai/async-cancellable';
import type { ContextTimed, ContextTimedInput } from '@matrixai/contexts';
import type QUICSocket from './QUICSocket';
import type QUICConnectionId from './QUICConnectionId';
import type {
  Host,
  Port,
  QUICConfig,
  RemoteInfo,
  StreamCodeToReason,
  StreamId,
  StreamReasonToCode,
  QUICConnectionMetadata,
} from './types';
import type { Connection, ConnectionError,  SendInfo } from './native/types';
import Logger from '@matrixai/logger';
import { Timer } from '@matrixai/timer';
import { Lock } from '@matrixai/async-locks';
import { AbstractEvent, EventAll } from '@matrixai/events';
import { StartStop, ready, running, status } from '@matrixai/async-init/dist/StartStop';
import { timedCancellable, context } from '@matrixai/contexts/dist/decorators';
import { buildQuicheConfig, minIdleTimeout } from './config';
import QUICStream from './QUICStream';
import { quiche, ConnectionErrorCode } from './native';
import * as events from './events';
import * as utils from './utils';
import * as errors from './errors';

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
   * This is the source connection ID.
   */
  public readonly connectionId: QUICConnectionId;

  /**
   * Internal native connection object.
   * @internal
   */
  public readonly conn: Connection;

  /**
   * Internal stream map.
   * This is also used by `QUICStream`.
   * @internal
   */
  public readonly streamMap: Map<StreamId, QUICStream> = new Map();

  /**
   * Logger.
   */
  protected logger: Logger;

  /**
   * Underlying socket.
   */
  protected socket: QUICSocket;

  protected config: QUICConfig;

  /**
   * Converts reason to code.
   * Used during `QUICStream` creation.
   */
  protected reasonToCode: StreamReasonToCode;

  /**
   * Converts code to reason.
   * Used during `QUICStream` creation.
   */
  protected codeToReason: StreamCodeToReason;

  /**
   * This is used to ensure that `recv` is serialised.
   * To prevent another `recv` call intercepting the previous `recv` call
   * that is still finishing up with a `send` call.
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
   * Internal conn timer. This is used to tick the state transitions on the
   * connection.
   */
  protected connTimeoutTimer?: Timer;

  /**
   * Keep alive timer.
   * If the max idle time is set to >0, the connection can time out on idleness.
   * Idleness is where there is no response from the other side. This can happen
   * from the beginning to the establishment of the connection and while the
   * connection is established. Normally there is nothing that will keep the
   * connection alive if there is no activity. This keep alive mechanism will
   * trigger ping frames to ensure that there is connection activity.
   * If the max idle time is set to 0, the connection never times out on idleness.
   * However, this keep alive mechanism will continue to work in case you need
   * activity on the connection for some reason.
   * Note that the timer used for the `ContextTimed` in `QUICClient.createQUICClient`
   * is independent of the max idle time. This keep alive mechanism will only
   * start working after secure establishment.
   */
  protected keepAliveIntervalTimer?: Timer;

  /**
   * This can change on every `recv` call
   */
  protected _remoteHost: Host;

  /**
   * This can change on every `recv` call
   */
  protected _remotePort: Port;

  /**
   * Secure connection establishment.
   * This can resolve or reject.
   * Will resolve after connection has established and peer certs have been validated.
   * Rejections cascade down to `secureEstablishedP` and `closedP`.
   */
  protected secureEstablished = false;
  protected secureEstablishedP: Promise<void>;
  protected resolveSecureEstablishedP: () => void;
  protected rejectSecureEstablishedP: (reason?: any) => void;

  /**
   * Connection closed promise.
   * This can resolve or reject.
   */
  public readonly closedP: Promise<void>;
  protected resolveClosedP: () => void;

  /**
   * This stores the last dispatched error.
   * If no error has occurred, it will be `null`.
   */
  protected errorLast: (
    | errors.ErrorQUICConnectionLocal<unknown>
    | errors.ErrorQUICConnectionPeer<unknown>
    | errors.ErrorQUICConnectionIdleTimeout<unknown>
    | errors.ErrorQUICConnectionInternal<unknown>
    | null
  ) = null;

  /**
   * Handle `EventQUICConnectionError`.
   * This may run multiple times, if in the process of handling
   * an error, another error occurs.
   */
  protected handleEventQUICConnectionError = (
    evt: events.EventQUICConnectionError
  ) => {
    const error = evt.detail;
    this.errorLast = error;
    if (
      (
        error instanceof errors.ErrorQUICConnectionLocal
        ||
        error instanceof errors.ErrorQUICConnectionPeer
      )
      && (
        (!error.data.isApp && error.data.errorCode === ConnectionErrorCode.NoError)
        ||
        (error.data.isApp && error.data.errorCode === 0)
      )
    ) {
      // Log out the excpetion as an info when it is graceful
      this.logger.info(utils.formatError(error));
    } else {
      // Log out the exception as an error when it is not graceful
      this.logger.error(utils.formatError(error));
    }
    // If the error is an internal error, throw it to become `EventError`
    // By default this will become an uncaught exception
    // Cannot attempt to close the connection, because an internal error is unrecoverable
    if (error instanceof errors.ErrorQUICConnectionInternal) {
      // Use `EventError` to deal with this
      throw error;
    }
    this.dispatchEvent(
      new events.EventQUICConnectionClose({
        detail: error
      })
    );
  }

  /**
   * This event represents the fact that `this.conn.close()` has already been called.
   * It does not actually mean that `closedP` is resolved.
   * That only occurs if the timeout timer detects that the connection is closed.
   *
   * Is only registered once.
   */
  protected handleEventQUICConnectionClose = async (
    evt: events.EventQUICConnectionClose
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
        force: true
      });
    }
  }

  protected handleEventQUICStream = (evt: EventAll) => {
    if (evt.detail instanceof AbstractEvent) {
      this.dispatchEvent(evt.detail.clone());
    }
  };

  protected handleEventQUICStreamSend = async () => {
    try {
      if (this[running]) await this.send();
      this.logger.warn('!sent!')
    } catch(e) {
      console.error(e);
      this.logger.warn(`!send errored with! ${e.message}`);
      throw e;
    }
  };

  /**
   * Registered once.
   */
  protected handleEventQUICStreamDestroyed = (
    evt: events.EventQUICStreamDestroyed
  ) => {
    const quicStream = evt.target as QUICStream;
    quicStream.removeEventListener(
      events.EventQUICStreamSend.name,
      this.handleEventQUICStreamSend
    );
    quicStream.removeEventListener(
      EventAll.name,
      this.handleEventQUICStream
    )
    this.streamMap.delete(quicStream.streamId);
  };

  public constructor({
    type,
    scid,
    dcid,
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
        dcid?: undefined;
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
        remoteInfo: RemoteInfo;
        config: QUICConfig;
        socket: QUICSocket;
        reasonToCode?: StreamReasonToCode;
        codeToReason?: StreamCodeToReason;
        logger?: Logger;
      }) {
    this.logger = logger ?? new Logger(`${this.constructor.name} ${scid}`);
    // Checking constraints
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
      // This message will be connected to the `this.start`
      this.logger.info(`Connect ${this.constructor.name}`);
      conn = quiche.Connection.connect(
        null,
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
      // This message will be connected to `this.start`
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
    this.connectionId = scid;
    this.socket = socket;
    this.config = config;
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
    const {
      p: closedP,
      resolveP: resolveClosedP,
    } = utils.promise();
    this.closedP = closedP;
    this.resolveClosedP = resolveClosedP;
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
   * Start the QUIC connection.
   * Mutual TLS verification will complete here.
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
      remoteInfo
    }: {
      data?: Uint8Array;
      remoteInfo?: RemoteInfo;
    } = {},
    @context ctx: ContextTimed
  ): Promise<void> {
    this.logger.info(`Start ${this.constructor.name}`);
    // If the connection has already been closed, we cannot start it again
    if (this.conn.isClosed()) {
      throw new errors.ErrorQUICConnectionClosed();
    }
    // Are we supposed to throw?
    // It depends, if the connection start is aborted
    // In a way, it makes sense for it be thrown
    // It doesn't just simply complete
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
      { once: true }
    );
    if (this.type === 'client') {
      // The timeout only starts after the first send is called
      await this.send();
    } else if (this.type === 'server') {
      if (data == null || remoteInfo == null) {
        throw new errors.ErrorQUICConnectionStartData(
          'Starting a server connection requires initial data and remote information'
        );
      }
      // This chain up recv and send and setup the max idle timeout
      await this.recv(data, remoteInfo);
    }
    try {
      // This will block until the connection is established
      // Which also depends on a mutual TLS handshake
      // It is expected that multiple `recv` and `send` pairs
      // will be called to complete the connection establishment
      await Promise.race([
        this.secureEstablishedP, // This might reject with a relevant error
        abortP, // This might abort for some other reason!
      ]);
    } catch (e) {
      // This should only be true if we are infact aborted due to start timeout
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
          Buffer.from('')
        );
        const localError = this.conn.localError()!;
        // This throws an augmented exception because that's what the events expect
        const e_ = new errors.ErrorQUICConnectionLocal(
          'Failed to start QUIC connection due to start timeout',
          {
            data: localError,
            cause: e
          }
        );
        this.dispatchEvent(
          new events.EventQUICConnectionError({
            detail: e_
          })
        );
      }
      // Wait for the connection to be fully closed
      // It is expected that max idle timer will eventually resolve this
      await this.closedP;
      // Throws the original exception
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
   * The `applicationError` if the connection close is due to the transport
   * layer or due to the application layer.
   * If `applicationError` is true, you can use any number as the `errorCode`.
   * The other peer must should understand the `errorCode`.
   * If `applicationError` is false, you must use `errorCode` from
   * `ConnectionErrorCode`.
   * The default `applicationError` is true because a normal graceful close
   * is an application error.
   * The default `errorCode` of 0 means general error.
   *
   * Providing error details is only used if the connection still needs to be
   * closed.
   */
  public async stop(
    {
      isApp = true,
      errorCode = 0,
      reason = new Uint8Array(),
      force = true,
    }:
      | {
          isApp: false;
          errorCode?: ConnectionErrorCode;
          reason?: Uint8Array;
          force?: boolean,
        }
      | {
          isApp?: true;
          errorCode?: number;
          reason?: Uint8Array;
          force?: boolean;
        } = {}
  ) {
    this.logger.info(`Stop ${this.constructor.name}`);
    this.stopKeepAliveIntervalTimer();
    // Closing the connection first to avoid accepting new streams
    if (!this.conn.isDraining() && !this.conn.isClosed()) {
      // If `this.conn.close` is already called, the connection will be draining,
      // in that case we just skip doing this local close.
      // If `this.conn.isTimedOut` is true, then the connection will be closed,
      // in that case we skip doing this local close.
      this.conn.close(isApp, errorCode, reason);
      const localError = this.conn.localError()!;
      const message = `Locally closed with ${
        localError.isApp
        ? 'application'
        : 'transport'
      } code ${localError.errorCode}`;
      const e = new errors.ErrorQUICConnectionLocal(
        message,
        { data: localError }
      );
      this.dispatchEvent(
        new events.EventQUICConnectionError(
          { detail: e }
        )
      );
    }
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
    // Waiting for `closedP` to resolve
    // Only the timeout timer will resolve this promise
    await this.closedP;
    this.removeEventListener(
      events.EventQUICConnectionError.name,
      this.handleEventQUICConnectionError
    );
    this.removeEventListener(
      events.EventQUICConnectionClose.name,
      this.handleEventQUICConnectionClose
    );
    this.logger.info(`Stopped ${this.constructor.name}`);
  }

  /**
   * Use this to get the connection error
   * Note that it could be `undefined` if it was due to a timeout.
   * Compare to `this.errorLast`
   */
  public getConnectionError(): ConnectionError | undefined {
    return this.conn.localError() ?? this.conn.peerError() ?? undefined;
  }

  /**
   * Gets an array of certificates in PEM format starting on the leaf.
   */
  public getLocalCertsChain(): Array<string> {
    const certs: Array<string> = [];
    if (typeof this.config.cert === 'string') {
      certs.push(this.config.cert);
    } else if (this.config.cert instanceof Uint8Array) {
      certs.push(utils.derToPEM(this.config.cert));
    } else if (Array.isArray(this.config.cert)) {
      for (const cert of this.config.cert) {
        if (typeof cert === 'string') {
          certs.push(cert);
        } else if (cert instanceof Uint8Array) {
          certs.push(utils.derToPEM(cert));
        }
      }
    }
    return certs;
  }

  /**
   * Gets an array of certificates in PEM format starting on the leaf.
   */
  public getRemoteCertsChain(): Array<string> {
    const certsDER = this.conn.peerCertChain();
    if (certsDER == null) return [];
    return certsDER.map(utils.derToPEM);
  }

  public meta(): QUICConnectionMetadata {
    return {
      localHost: this.localHost,
      localPort: this.localPort,
      remoteHost: this.remoteHost,
      remotePort: this.remotePort,
      localCertificates: this.getLocalCertsChain(),
      remoteCertificates: this.getRemoteCertsChain(),
    };
  }

  /**
   * Receives data from the socket for this connection.
   * The data flows from the socket this connection to streams.
   * This takes data from the quiche connection and pushes to the
   * `QUICStream` collection.
   *
   * This function is callable during `start` and `stop`.
   * It is in fact necessary to ensure that the connection completes
   * the `start` and `stop` state transitions.
   * This is why it's not wrapped under `@ready()`.
   *
   * When the connection is draining, we can still receive data.
   * However no streams are allowed to read or write data.
   *
   * When this is called, a monitor is created to be used within the
   * call graph. This is to ensure mutual exclusion between this call
   * graph and other potential call graphs. It is possible to pass in
   * an existing monitor to be used instead, as that would attach this
   * call to be part of an existing call graph. The mutual exclusion of
   * the call graphs is important, as often `recv` and `send` pairs
   * usually need to be done together.
   * @internal
   */
  @ready(new errors.ErrorQUICConnectionNotRunning(), false, ['starting', 'stopping'])
  public async recv(
    data: Uint8Array,
    remoteInfo: RemoteInfo,
  ): Promise<void> {
    // Enforce mutual exclusion for an atomic pair of `this.recv` and `this.send`.
    await this.recvLock.withF(async () => {
      // The remote information may be changed on each received packet
      // If it changes, this would mean the connection has migrated
      // Here the remote host and port is updated, however we have not verified
      // this behaviour
      this._remoteHost = remoteInfo.host;
      this._remotePort = remoteInfo.port;
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
        // If `config.verifyPeer` is true and `config.verifyCallback` is undefined
        // then during the TLS handshake, a `TlsFail` exception will only be thrown
        // if the peer did not supply a certificate or that its certificate failed
        // the default certificate verification procedure.
        // If `config.verifyPeer` is true and `config.verifyCallback` is defined,
        // then during the TLS handshake, a `TlsFail` exception will only be thrown
        // if the peer did not supply a peer certificate.

        // Other exceptions may occur such as `UnknownVersion`, `InvalidPacket`
        // and more...

        // Whether `TlsFail` or any other exception, the quiche connection
        // internally will have `close` called on it with a local or peer error.

        // However it may not enter draining state until a `this.conn.send` is
        // called.

        // Because all state processing is centralised inside `this.send`,
        // regardless of the exception, we will call `this.send` in
        // order to complete the entire state transition, and all errors will
        // be processed in the `this.send` call. That is also where we will
        // perform custom TLS verification.

        // However if there is no peer error or local error, the exception is
        // not coming from quiche, and therefore represents a software error.

        // Note that peer errors while set by the `this.conn.recv`, will not
        // be thrown upwards. Only local errors will be thrown upwards here.

        // Going through the source code, it shows that this is the case
        // LOCAL ERROR can only occur after close() (which can happen due to conn.recv())
        // PEER ERROR can only occur after recv() (which can happen due to conn.recv())

        // Processing the custom TLS callback means
        // and if it passes, we would ideally proceed to processing the streams
        // That would mean we did have a verifyCallback being true
        // Then we woul be established, but not secure established
        // Then... we would go down to `send`
        // Then afterwards check the custom callback
        // if it fails... then we just close and send again
        // if it succeeds... then actually we want to process the streams again!
        // That means we have to run `processStreams` again after send
        // But only if we did a TLS verification, and it passed

        const localError = this.conn.localError();
        if (localError == null) {
          const e_ = new errors.ErrorQUICConnectionInternal(
            'Failed connection recv due with unknown error',
            { cause: e }
          );
          this.dispatchEvent(new events.EventQUICConnectionError({ detail: e_ }));
          throw e_;
        } else {
          // This is a legitimate state transition of the connection
          // So it is not a caller error, therefore we do not throw it up
          const e_ = new errors.ErrorQUICConnectionLocal(
            'Failed connection due to local error',
            {
              cause: e,
              data: localError,
            }
          );
          this.dispatchEvent(
            new events.EventQUICConnectionError({ detail: e_ })
          );
          return;
        }
      }
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
      // If we are "secure established" we can process streams.
      if (this.secureEstablished) {
        this.processStreams();
      }
      await this.send();
    });
  }

  /**
   * Sends data to the socket from this connection.
   * This takes the data from the quiche connection that is on the send buffer.
   * The data flows from the streams to this connection to the socket.
   *
   * - Call this if `recv` is called.
   * - Call this if timer expires.
   * - Call this if stream is written.
   * - Call this if stream is read.
   *
   * This function is callable during `start` and `stop`.
   * It is in fact necessary to ensure that the connection completes
   * the `start` and `stop` state transitions.
   * This is why it's not wrapped under `@ready()`.
   *
   * When this is called, a monitor is created to be used within the
   * call graph. This is to ensure mutual exclusion between this call
   * graph and other potential call graphs. It is possible to pass in
   * an existing monitor to be used instead, as that would attach this
   * call to be part of an existing call graph. The mutual exclusion of
   * the call graphs is important, as often `recv` and `send` pairs
   * usually need to be done together.
   * @internal
   */
  @ready(new errors.ErrorQUICConnectionNotRunning(), false, ['starting', 'stopping'])
  public async send(): Promise<void> {
    let sendLength: number;
    let sendInfo: SendInfo;
    // Send until `Done`
    while (true) {
      // This is the fastest way of allocating a buffer per send
      // It's needed because sending the data out on the socket is now asynchronous
      const sendBuffer = Buffer.allocUnsafe(
        this.config.maxSendUdpPayloadSize
      );
      try {
        const result = this.conn.send(sendBuffer);
        if (result === null) {
          // Break the loop
          break;
        }
        [sendLength, sendInfo] = result;
      } catch (e) {
        // This is a software error
        // Exceptions could be `BufferTooShort`, `InvalidState`
        // Not a legitimate state transition
        const e_ = new errors.ErrorQUICConnectionInternal(
          'Failed connection send with unknown internal error',
          { cause: e }
        );
        this.dispatchEvent(
          new events.EventQUICConnectionError({ detail: e_ })
        );
        throw e_;
      }
      this.dispatchEvent(
        new events.EventQUICConnectionSend({
          detail: {
            msg: sendBuffer.subarray(0, sendLength),
            port: sendInfo.to.port,
            address: sendInfo.to.host,
          }
        })
      );
    }
    // Resets the connection timeout timer
    // The reason this is here, is because the timeout will only be non-null
    // after the first send call is made, subsequently each send call may
    // end up resetting the timeout
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
      try {
        await this.config.verifyCallback(
          peerCertsChain.map(utils.derToPEM),
          utils.collectPEMs(this.config.ca)
        );
      } catch (e) {
        // This simulates `TlsFail` due to the certificate failing verification
        this.conn.close(
          false,
          304,
          Buffer.from('')
        );
        const localError = this.conn.localError()!;
        const e_ = new errors.ErrorQUICConnectionLocal(
          'Failed connection due to custom verification callback',
          {
            cause: e,
            data: localError
          }
        );
        this.dispatchEvent(
          new events.EventQUICConnectionError({
            detail: e_
          })
        );
        // This is a legitimate state transition of the connection
        // So it is not a caller error, therefore we do not throw it up
        return;
      }
      this.resolveSecureEstablishedP();
      this.processStreams();
    }
    if (this[status] !== 'stopping') {
      const peerError = this.conn.peerError();
      if (peerError != null) {
        const message = `Peer closed with ${
          peerError.isApp
          ? 'application'
          : 'transport'
        } code ${peerError.errorCode}`;
        this.dispatchEvent(
          new events.EventQUICConnectionError({
            detail: new errors.ErrorQUICConnectionPeer(
              message,
              { data: peerError }
            )
          })
        );
        // This is a legitimate state transition
        // and will result stop being called
        return;
      }
    }
  }

  /**
   * Process all stream data.
   * This will process readable streams and writable streams.
   * This will create new streams if needed.
   *
   * THIS method needs a look over it
   * Why not read after stream creation.
   * it should be moving the handle event at the top
   * And the dead case needs to be re-examined too
   */
  protected processStreams() {
    for (const streamId of this.conn.readable() as Iterable<StreamId>) {
      let quicStream = this.streamMap.get(streamId);
      if (quicStream == null) {
        // Wait a minute, if the stream doesn't exist
        // Then it has to be a peer initiated stream
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
          this.handleEventQUICStreamSend
        );
        quicStream.addEventListener(
          events.EventQUICStreamDestroyed.name,
          this.handleEventQUICStreamDestroyed,
          { once: true },
        );
        quicStream.addEventListener(
          EventAll.name,
          this.handleEventQUICStream,
        );
        this.dispatchEvent(
          new events.EventQUICConnectionStream({ detail: quicStream }),
        );
      }
      quicStream.read();
    }
    for (const streamId of this.conn.writable() as Iterable<StreamId>) {
      const quicStream = this.streamMap.get(streamId);
      // When there's a concurrent stream close from both ends
      // It is possible for `quicStream` to have already been deleted
      // When the remote's `STOP_SENDING` frame arrives, quiche notifies
      // us as the stream is writable (even though we had already closed it)
      // Therefore we must process this closed writable stream, by acknowledging
      // `StreamStopped` exception
      if (quicStream == null) {
        try {
          // Check if it can write 0 bytes
          // This will throw `StreamStopped`
          this.conn.streamWritable(streamId, 0);
        } catch (e) {
          if (e.message.match(/StreamStopped\((.+)\)/) != null) {
            // Now as long as it is in fact `StreamStopped`, this passes
            // And the quiche underlying state is then cleaned up
            continue;
          }
          // This would be considered a critical error because we do not expect
          // any other possibility, it would be an upstream bug
          // And thus it is thrown upwards
          const e_ = new errors.ErrorQUICConnectionInternal(
            'Failed to write 0 bytes to a stream that is not stopped',
            { cause: e },
          );
          this.dispatchEvent(
            new events.EventQUICConnectionError({
              detail: e_,
            }),
          );
          throw e_;
        }
        // If this occurs, then this is a runtime domain error
        // Because it represents our own domain's bug
        const e = new errors.ErrorQUICConnectionInternal(
          'Failed processing stream, stream was writable even though `QUICStream` does not exist',
        );
        this.dispatchEvent(
          new events.EventQUICConnectionError({
            detail: e,
          }),
        );
        throw e;
      } else {
        quicStream.write();
      }
    }
  }

  /**
   * This only gets called on the first `send`.
   * Aftewards, nothing can cancel this, except here.
   * It's the responsiblity of this timer to resolve the `closedP` normally.
   * This is because when a quiche connection is closing, it enters a draining phase
   * and stays draining for some time, before finally becoming closed.
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
      // We need to check if the connection timed out due to the `maxIdleTimeout`, if so we dispatch the error and close.
      if (this.conn.isClosed()) {
        this.resolveClosedP();
        if (this.conn.isTimedOut()) {
          this.dispatchEvent(
            new events.EventQUICConnectionError({
              detail: new errors.ErrorQUICConnectionIdleTimeout()
            })
          );
        }
        return;
      }
      // Otherwise, we should be calling send after the timeout
      // If the status is not equal null, then we can send
      await this.send();
      // Note that a `0` timeout is still a valid timeout
      const timeout = this.conn.timeout();
      // If this is `null`, then quiche is requesting the timer to be cleaned up
      if (timeout == null) {
        // If the max idle timeout is 0, then the timeout may revert to `null`
        // It would only be set when the connection is ready to be closed
        return;
      }
      // Allow an extra 1ms for the delay to fully complete, so we can avoid a repeated 0ms delay
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
      // Here we cancellation only matters if the timer status is `null` or settling
      // If it is `null`, then the timer handler doesn't run
      // If it is `settled`, then cancelling is a noop
      // If it is `settling`, then cancelling only prevents it at the beginning
      // Afterwards if it continues, it will continue to execute
      this.connTimeoutTimer?.cancel();

      // FIXME: THIS SHOULD BE NEEDED, INVESTIGATE
      // Timer needs to be deleted because if the timer is cancelled
      // It would not be settled, and the next time this is called
      // We may need to set the timer when the connection is to be closed
      // This should not be needed because immediately after cancel the timer is settled
      delete this.connTimeoutTimer;

      if (this.conn.isClosed()) {
        this.resolveClosedP();
        // For this to happen, it must be because the connection actually timed out
        // Not due to a proper close that already occurred
        if (this.conn.isTimedOut()) {
          this.dispatchEvent(
            new events.EventQUICConnectionError({
              detail: new errors.ErrorQUICConnectionIdleTimeout()
            })
          );
        }
      }
      return;
    }

    // At this point we may be recreating the timer or resetting the timer
    // If the timer does not exist or that it is settled we are going to create it
    // If it was cancelled, we also need to create it
    // Which is why if the timer is cancelled we would have deleted it

    // If there's no timer, create it
    // If the timer is settled, create it
    // If the timer is settling, do nothing (it will recreate itself)
    // If the timer is null, reset it
    // Plus 1 to the `timeout` to compensate for clock de-sync between JS and Rust
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
   * Creates a new stream on the connection.
   * This is a serialised call, it must be blocking.
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
    quicStream.addEventListener(
      EventAll.name,
      this.handleEventQUICStream
    );
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
   * Make sure to set the interval to be less than then the `maxIdleTime` unless
   * if the `maxIdleTime` is `0`.
   * If the `maxIdleTime` is `0`, then this is not needed to keep the connection
   * open. However, it can still be useful to maintain liveliness for NAT purposes.
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
        lazy: true
      });
    };
    this.keepAliveIntervalTimer = new Timer({
      delay: ms,
      handler: keepAliveHandler,
      lazy: true
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
