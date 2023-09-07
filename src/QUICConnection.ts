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
import { Connection, ConnectionErrorCode, SendInfo } from './native/types';
import type { Monitor } from '@matrixai/async-locks';
import { Lock, LockBox, RWLockWriter } from '@matrixai/async-locks';
import {
  ready,
  running,
  StartStop,
  status,
} from '@matrixai/async-init/dist/StartStop';
import Logger from '@matrixai/logger';
import { Timer } from '@matrixai/timer';
import { context, timedCancellable } from '@matrixai/contexts/dist/decorators';
import { withF } from '@matrixai/resources';
import { utils as contextsUtils } from '@matrixai/contexts';
import { buildQuicheConfig, minIdleTimeout } from './config';
import QUICStream from './QUICStream';
import { quiche } from './native';
import * as events from './events';
import * as utils from './utils';
import { never, promise } from './utils';
import * as errors from './errors';

const timerCleanupReasonSymbol = Symbol('timerCleanupReasonSymbol');

/**
 * Think of this as equivalent to `net.Socket`.
 * Errors here are emitted to the connection only.
 * Not to the server.
 *
 * Events (events are executed post-facto):
 * - connectionStream
 * - connectionStop
 * - connectionError - can occur due to a timeout too
 * - streamDestroy
 */
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
   * Tracks the locks for use with the monitors
   */
  public readonly lockBox = new LockBox<RWLockWriter>();

  /**
   * This is the locking key for the monitor.
   */
  public readonly lockingKey = 'QUICConnection lock recv send';

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
   * Stream ID increment lock.
   */
  protected streamIdLock: Lock = new Lock();

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
   * Currently unsupported.
   */
  protected _streamIdClientUni: StreamId = 0b10 as StreamId;

  /**
   * Server initiated unidirectional stream starts at 3.
   * Increment by 4 to get the next ID.
   * Currently unsupported.
   */
  protected _streamIdServerUni: StreamId = 0b11 as StreamId;

  /**
   * Internal conn timer. This is used to tick the state transitions on the
   * connection.
   */
  protected connTimeOutTimer?: Timer;

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
  protected secureEstablishedP: Promise<void>;
  protected resolveSecureEstablishedP: () => void;
  protected rejectSecureEstablishedP: (reason?: any) => void;
  protected secureEstablished = false;

  /**
   * Connection closed promise.
   * This can resolve or reject.
   */
  protected closedP: Promise<void>;
  protected resolveClosedP: () => void;
  protected rejectClosedP: (reason?: any) => void;

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
      throw new errors.ErrorQUICConnectionInvalidConfig(
        'keepAliveIntervalTime must be shorter than maxIdleTimeout',
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
    this.resolveSecureEstablishedP = resolveSecureEstablishedP;
    this.rejectSecureEstablishedP = rejectSecureEstablishedP;
    const {
      p: closedP,
      resolveP: resolveClosedP,
      rejectP: rejectClosedP,
    } = utils.promise();
    this.closedP = closedP;
    this.resolveClosedP = resolveClosedP;
    this.rejectClosedP = rejectClosedP;
  }

  public get remoteHost(): string {
    return utils.fromHost(this._remoteHost);
  }

  public get remotePort(): number {
    return utils.fromPort(this._remotePort);
  }

  public get localHost(): string {
    return this.socket.host;
  }

  public get localPort(): number {
    return this.socket.port;
  }

  /**
   * Start the QUIC connection.
   * This will depend on the `QUICSocket`, `QUICClient`, and `QUICServer`
   * to call atomic pairs of `recv` and `send` to complete starting the
   * connection. We also include mutual TLS verification before we consider
   * this connection to be started.
   */
  public start(
    ctx?: Partial<ContextTimedInput>,
  ): PromiseCancellable<void>;
  @timedCancellable(
    true,
    minIdleTimeout,
    errors.ErrorQUICConnectionStartTimeOut,
  )
  public async start(@context ctx: ContextTimed): Promise<void> {
    this.logger.info(`Start ${this.constructor.name}`);
    ctx.signal.throwIfAborted();
    const { p: abortP, rejectP: rejectAbortP } = promise<never>();
    const abortHandler = () => {
      rejectAbortP(ctx.signal.reason);
    };
    ctx.signal.addEventListener('abort', abortHandler);

    // AT THIS POINT YOU SHOULD BE STARTING THE MAX IDLE TIMEOUT TIMER
    // WHY IS THIS NOT HERE?
    // REMEMBER THAT MIN IDLE TIMEOUT is the minimum boundary
    // Since it is only useful if it is less time than the max idle timer
    // OR SHOULD the max idle timer start from the `constructor`?

    try {
      // This will block until the connection is established
      // Which also depends on a mutual TLS handshake
      // It is expected that multiple `recv` and `send` pairs
      // will be called to complete the connection establishment
      await Promise.race([
        this.secureEstablishedP,
        abortP,
      ]);
    } catch (e) {
      // Force destroy any streams that may have been created
      const streamsDestroyPs: Array<Promise<void>> = [];
      for (const stream of this.streamMap.values()) {
        streamsDestroyPs.push(stream.destroy({ force: true }));
      }
      await Promise.all(streamsDestroyPs);
      try {
        // According to RFC9000, closing while in the middle of a handshake
        // should use a transport error code `APPLICATION_ERROR`.
        // For this library we extend this "handshake" phase to include the
        // the TLS handshake too.
        // This is also the behaviour of quiche when the connection is not
        // in a "safe" state to send application errors.
        // https://www.rfc-editor.org/rfc/rfc9000.html#section-10.2.3-3
        this.conn.close(
          false,
          ConnectionErrorCode.ApplicationError,
          Buffer.from('')
        );
      } catch (e) {
        // If already closed, ignore, otherwise it is a software bug
        if (e.message !== 'Done') {
          throw e;
        }
      }
      // Wait for the connection to be fully closed
      // It is expected that max idle timer will eventually resolve this
      await this.closedP;
      // Throw the start timeout exception upwards
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
   * This is the same as basically waiting for `closedP`.
   *
   * Providing error details is only used if the connection still needs to be
   * closed. If stop was triggered internally then the error details are obtained
   * by the connection.
   */
  public async stop(
    {
      applicationError = true,
      errorCode = 0,
      errorMessage = '',
      force = false,
    }:
      | {
          applicationError?: false;
          errorCode?: ConnectionErrorCode;
          errorMessage?: string;
          force?: boolean;
        }
      | {
          applicationError: true;
          errorCode?: number;
          errorMessage?: string;
          force?: boolean;
        } = {},
    // Mon?: Monitor<RWLockWriter>,
  ) {
    this.logger.info(`Stop ${this.constructor.name}`);

    // Cleaning up existing streams
    const streamsDestroyP: Array<Promise<void>> = [];

    for (const stream of this.streamMap.values()) {
      // A quiche connection closing will not clean up any stream state, so they need to be cleaned up here
      streamsDestroyP.push(
        stream.destroy({
          force: this.conn.isDraining() || this.conn.isClosed() || force,
        }),
      );
    }
    await Promise.all(streamsDestroyP);

    this.stopKeepAliveIntervalTimer();

    // If this is already closed, then `Done` will be thrown on send
    // Otherwise it can send `CONNECTION_CLOSE` frame
    // This can be 0x1c close at the QUIC layer or no errors
    // Or it can be 0x1d for application close with an error
    // Upon receiving a `CONNECTION_CLOSE`, you can send back
    // 1 packet containing a `CONNECTION_CLOSE` frame too
    // (with `NO_ERROR` code if appropriate)
    // It must enter into a draining state, and no other packets can be sent
    this.conn.close(applicationError, errorCode, Buffer.from(errorMessage));
    try {
      // I don't know if this requires `mon` at all
      await this.send();
    } catch (e) {
      if (e.message !== 'Done') {
        never();
      }
    }

    // If it it is already closed, just resolve the closed promise
    if (this.conn.isClosed()) {
      this.resolveClosedP();
    } else {
      // Wait for the closed promise to resolve
      // The `recv` and `send` will be the ones resolving this promise
      await this.closedP;
    }

    this.logger.info(`Stopped ${this.constructor.name}`);
  }

  /**
   * Gets an array of certificates in PEM format starting on the leaf.
   */
  @ready(new errors.ErrorQUICConnectionNotRunning())
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
  @ready(new errors.ErrorQUICConnectionNotRunning())
  public getRemoteCertsChain(): Array<string> {
    const certsDER = this.conn.peerCertChain();
    if (certsDER == null) return [];
    return certsDER.map(utils.derToPEM);
  }

  @ready(new errors.ErrorQUICConnectionNotRunning())
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
    mon?: Monitor<RWLockWriter>,
  ): Promise<void> {
    if (mon == null) {
      return this.withMonitor((mon) => {
        return this.recv(data, remoteInfo, mon);
      });
    }
    await mon.lock(this.lockingKey)();
    // The remote information may be changed on each receive
    // However to do so would mean connection migration,
    // which is not yet supported
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
      this.logger.debug(`recv ${data.byteLength} bytes`);
      // This can process concatenated QUIC packets
      // This may mutate `data`
      this.conn.recv(data, recvInfo);
    } catch (e) {
      // NEED EXPLANATION ABOUT THIS
      // I don't understand why this matters here
      // if we have a TLS failure

      // Should only be a `TLSFail` if we fail here.
      // The error details will be available as a local error.
      // TlsFail is ignored here but the connection will transition to closed
      // and the TlsFailure will be processed in the finally block
      if (e.message !== 'TlsFail') {
        // No other exceptions are expected
        never();
      }
      // TODO: I don't know if we can have a local AND a peer error. may need to combine into an aggregate error.
      // getting local error
      const localError = this.conn.localError();
      if (localError != null) {
        const message = `connection failed with localError ${Buffer.from(
          localError.reason,
        ).toString()}(${localError.errorCode})`;
        this.logger.info(message);
        const error = new errors.ErrorQUICConnectionInternal(message, {
          data: {
            type: 'local',
            ...localError,
          },
        });
        this.rejectSecureEstablishedP(error);
        this.dispatchEvent(
          new events.EventQUICConnectionError({
            detail: error,
          }),
        );
      }
      // getting the peer error
      const peerError = this.conn.peerError();
      if (peerError != null) {
        const message = `Connection errored out with peerError ${Buffer.from(
          peerError.reason,
        ).toString()}(${peerError.errorCode})`;
        this.logger.info(message);
        const error = new errors.ErrorQUICConnectionInternal(message, {
          data: {
            type: 'local',
            ...peerError,
          },
        });
        this.rejectSecureEstablishedP(error);
        this.dispatchEvent(
          new events.EventQUICConnectionError({
            detail: error,
          }),
        );
      }
      if (localError != null && peerError != null) never('Just checking if this is ever true');
      this.logger.warn('Possible Deadlock C');
      // FIXME: this will probably deadlock, It's being called in recv, triggers a send and needs further recv's to
      //  fully resolve.
      await this.stop({ force: true });
      return;
    }
    // We don't actually "fail"
    // the closedP until we proceed
    // But note that if there's an error

    if (
      this[status] !== 'destroying' &&
      (this.conn.isClosed() || this.conn.isDraining())
    ) {
      // When processing a `recv`
      // We may process into a closed state
      // We have to then "complete" the call
      // I don't believe this makes sense either
      // this.logger.debug('calling stop due to closed or draining');
      // Destroy in the background, we still need to process packets.
      // Draining means no more packets are sent, so streams must be force closed.
      // TODO: check if this catch is needed.
      // TODO: I'm sure this stop is still needed unless it's handled via an event now?
      // void this.stop({ force: true }, mon).catch(() => {});
      if (this.conn.isClosed()) {
        this.resolveClosedP();
        return;
      }
    }

    if (this.conn.isInEarlyData() || this.conn.isEstablished()) {
      await this.processStreams();
    }
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
  public async send(mon?: Monitor<RWLockWriter>): Promise<void> {
    if (mon == null) {
      return this.withMonitor((mon) => {
        return this.send(mon);
      });
    }
    await mon.lock(this.lockingKey)();
    const sendBuffer = new Uint8Array(quiche.MAX_DATAGRAM_SIZE);
    let sendLength: number;
    let sendInfo: SendInfo;
    try {
      // Send until `Done`
      while (true) {
        try {
          [sendLength, sendInfo] = this.conn.send(sendBuffer);
        } catch (e) {
          if (e.message === 'Done') {
            break;
          }
          throw e;
        }
        await this.socket.send(
          sendBuffer,
          0,
          sendLength,
          sendInfo.to.port,
          sendInfo.to.host,
        );
        this.logger.debug(`sent ${sendLength} bytes`);
      }
    } catch (e) {
      // An error here means a hard failure in sending, we must force clean up
      //  since any further communication is expected to fail.
      this.logger.debug(`Calling stop due to sending error [${e.message}]`);
      const code = await this.reasonToCode('send', e);
      await this.stop({
        applicationError: false,
        errorCode: code,
        errorMessage: e.message,
        force: true,
      });
      // We need to finish without any exceptions
      return;
    }

    // Handling custom TLS verification, this must be done after the following conditions.
    //  1. Connection established.
    //  2. Certs available.
    //  3. Sent after connection has established.
    if (!this.secureEstablished && this.conn.isEstablished()) {
      this.resolveSecureEstablishedP();
      this.secureEstablished = true;
      if ( this.config.verifyPeer && this.config.verifyCallback != null ) {
        const peerCerts = this.conn.peerCertChain();
        // If verifyPeer is true then certs should always exist
        if (peerCerts == null) never();
        const peerCertsPem: Array<string> = peerCerts.map((c) =>
          utils.derToPEM(c),
        );
        try {
          // Running verify callback if available
          const ca = utils.concatPEMs(this.config.ca);
          await this.config.verifyCallback(peerCertsPem, ca);
          this.logger.debug('TLS verification succeeded');
          // Generate ack frame to satisfy the short + 1 condition of secure establishment
          this.conn.sendAckEliciting();
        } catch (e) {
          // Force the connection to end.
          // Error 304 indicates cert chain failed verification.
          // Error 372 indicates cert chain was missing.
          this.logger.debug(
            `TLS fail due to [${e.message}], closing connection`,
          );
          this.conn.close(
            false,
            304,
            Buffer.from(`Custom TLSFail: ${e.message}`),
          );
        }
      }
    }

    if (this.conn.isClosed()) {
      // Handle stream clean up if closed
      this.resolveClosedP();
      const error = this.conn.localError() ?? this.conn.peerError();
      const stopOptions =
        error !== null
          ? {
              applicationError: error.isApp,
              errorCode: error.errorCode,
              errorMessage: Buffer.from(error.reason).toString('utf-8'),
              force: true,
            }
          : { force: true };
      await this.stop(stopOptions);
    }
    this.setConnTimeOutTimer();
  }

  /**
   * Process all stream data.
   * This only occurs upon receving data for this connection.
   * This will process readable streams and writable streams.
   * This will create new streams if needed.
   */
  protected async processStreams() {
    for (const streamId of this.conn.readable() as Iterable<StreamId>) {
      let quicStream = this.streamMap.get(streamId);
      if (quicStream == null) {
        // The creation will set itself to the stream map
        quicStream = await QUICStream.createQUICStream({
          streamId,
          connection: this,
          codeToReason: this.codeToReason,
          reasonToCode: this.reasonToCode,
          logger: this.logger.getChild(`${QUICStream.name} ${streamId}`),
        });
        this.streamMap.set(quicStream.streamId, quicStream);
        const handleEventQUICStreamDestroyed = (
          e: events.EventQUICStreamDestroyed,
        ) => {
          this.streamMap.delete(quicStream!.streamId);
        };
        quicStream.addEventListener(
          events.EventQUICStreamDestroyed.name,
          handleEventQUICStreamDestroyed,
          { once: true },
        );
        this.dispatchEvent(
          new events.EventQUICConnectionStream({ detail: quicStream }),
        );
        // No need to read after creation, doing so will throw during early cancellation
      } else {
        await quicStream.read();
      }
    }
    for (const streamId of this.conn.writable() as Iterable<StreamId>) {
      const quicStream = this.streamMap.get(streamId);

      // NEED EXPLANATION FOR THIS

      if (quicStream == null) {
        // This is a dead case, there are only two ways streams are created.
        //  The QUICStream will always exist before processing it's writable.
        //  1. First time it is seen in the readable iterator
        //  2. created using `streamNew()`

        // There is one condition where this can happen. That is when both sides of the stream cancel concurrently.
        // Local state is cleaned up while the remote side still sends a closing frame.
        try {
          // Check if the stream can write 0 bytes, should throw if the stream has ended.
          // We need to check if it's writable to trigger any state change for the stream.
          this.conn.streamWritable(streamId, 0);
          never(
            'The stream should never be writable if a QUICStream does not exist for it',
          );
        } catch (e) {
          // Stream should be stopped here, any other error is a never
          if (e.message.match(/StreamStopped\((.+)\)/) == null) {
            // We only expect a StreamStopped error here
            throw e;
          }
          // If stopped we just ignore it, `streamWritable` should've cleaned up the native state
          this.logger.debug(
            `StreamId ${streamId} was writable without an existing stream and error ${e.message}`,
          );
        }
      } else {
        await quicStream.write();
      }
    }
  }

  protected setConnTimeOutTimer(): void {
    const logger = this.logger.getChild('timer');
    const connTimeOutHandler = async () => {
      // This can only be called when the timeout has occurred.
      // This transitions the connection state.
      // `conn.timeout()` is time aware, so calling `conn.onTimeout` will only
      //  trigger state transitions after the time has passed.
      logger.debug('CALLING ON TIMEOUT');
      this.conn.onTimeout();

      // Handling timeout condition
      if (this.conn.isTimedOut()) {
        const error = new errors.ErrorQUICConnectionIdleTimeOut()
        this.rejectSecureEstablishedP(error);
        this.dispatchEvent(
          new events.EventQUICConnectionError({
            detail: error,
          }),
        );
      }

      // Connection may have closed after timing out
      if (this.conn.isClosed()) {
        logger.debug('resolving closedP');
        // We resolve closing here, stop checks if the connection has timed out
        //  and handles it.
        this.resolveClosedP();
        // If we are still running and not stopping then we need to stop
        if (this[running] && this[status] !== 'stopping') {
          // Background stopping, we don't want to block the timer resolving
          void this.stop({ force: true });
        }
        logger.debug('CLEANING UP TIMER');
        return;
      }

      // There may be data to send after timing out
      void this.send();

      // Note that a `0` timeout is still a valid timeout
      const timeout = this.conn.timeout();
      // If this is `null`, then quiche is requesting the timer to be cleaned up
      if (timeout == null) {
        logger.debug('CLEANING UP TIMER');
        return;
      }
      // Allow an extra 1ms for the delay to fully complete, so we can avoid a repeated 0ms delay
      logger.debug(`Recreating timer with ${timeout + 1} delay`);
      this.connTimeOutTimer = new Timer({
        delay: timeout + 1,
        handler: connTimeOutHandler,
      });
    };
    // Note that a `0` timeout is still a valid timeout
    const timeout = this.conn.timeout();
    // If this is `null`, then quiche is requesting the timer to be cleaned up
    if (timeout == null) {
      // Clean up timer if it is running
      if (
        this.connTimeOutTimer != null &&
        this.connTimeOutTimer.status === null
      ) {
        logger.debug('CLEANING UP TIMER');
        this.connTimeOutTimer.cancel(timerCleanupReasonSymbol);
      }
      return;
    }
    // If there was an existing timer, we cancel it and set a new one
    if (
      this.connTimeOutTimer != null &&
      this.connTimeOutTimer.status === null
    ) {
      logger.debug(`resetting timer with ${timeout + 1} delay`);
      this.connTimeOutTimer.reset(timeout + 1);
    } else {
      logger.debug(`timeout created with delay ${timeout}`);
      this.connTimeOutTimer = new Timer({
        delay: timeout + 1,
        handler: connTimeOutHandler,
      });
    }
  }

  /**
   * Creates a new stream on the connection.
   * Only supports bidi streams atm.
   * This is a serialised call, it must be blocking.
   */
  @ready(new errors.ErrorQUICConnectionNotRunning())
  public async streamNew(streamType: 'bidi' = 'bidi'): Promise<QUICStream> {
    // Using a lock on stream ID to prevent racing updates
    return await this.streamIdLock.withF(async () => {
      let streamId: StreamId;
      if (this.type === 'client' && streamType === 'bidi') {
        streamId = this.streamIdClientBidi;
      } else if (this.type === 'server' && streamType === 'bidi') {
        streamId = this.streamIdServerBidi;
      }
      const quicStream = await QUICStream.createQUICStream({
        streamId: streamId!,
        connection: this,
        codeToReason: this.codeToReason,
        reasonToCode: this.reasonToCode,
        logger: this.logger.getChild(`${QUICStream.name} ${streamId!}`),
      });

      this.streamMap.set(quicStream.streamId, quicStream);
      const handleEventQUICStreamDestroyed = (
        e: events.EventQUICStreamDestroyed,
      ) => {
        this.streamMap.delete(quicStream!.streamId);
      };
      quicStream.addEventListener(
        events.EventQUICStreamDestroyed.name,
        handleEventQUICStreamDestroyed,
        { once: true },
      );

      // Ok the stream is opened and working
      if (this.type === 'client' && streamType === 'bidi') {
        this.streamIdClientBidi = (this.streamIdClientBidi + 4) as StreamId;
      } else if (this.type === 'server' && streamType === 'bidi') {
        this.streamIdServerBidi = (this.streamIdServerBidi + 4) as StreamId;
      }
      return quicStream;
    });
  }

  /**
   * Starts the keep alive interval timer.
   * Make sure to set the interval to be less than then the `maxIdleTime` unless
   * if the `maxIdleTime` is `0`.
   * If the `maxIdleTime` is `0`, then this is not needed to keep the connection
   * open. However, it can still be useful to maintain liveliness for NAT purposes.
   */
  protected startKeepAliveIntervalTimer(ms: number): void {
    const keepAliveHandler = async () => {
      // Intelligently schedule a PING frame.
      // If the connection has already sent ack-eliciting frames
      // then this is a noop.
      this.conn.sendAckEliciting();
      await this.send();
      this.keepAliveIntervalTimer = new Timer({
        delay: ms,
        handler: keepAliveHandler,
      });
    };
    this.keepAliveIntervalTimer = new Timer({
      delay: ms,
      handler: keepAliveHandler,
    });
  }

  /**
   * Stops the keep alive interval timer
   */
  protected stopKeepAliveIntervalTimer(): void {
    this.keepAliveIntervalTimer?.cancel(timerCleanupReasonSymbol);
  }

  /**
   * @internal
   */
  public withMonitor<T>(
    f: (mon: Monitor<RWLockWriter>) => Promise<T>,
  ): Promise<T> {
    return withF([contextsUtils.monitor(this.lockBox, RWLockWriter)], ([mon]) =>
      f(mon),
    );
  }
}

export default QUICConnection;
