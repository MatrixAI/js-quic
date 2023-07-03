import type { PromiseCancellable } from '@matrixai/async-cancellable';
import type { ContextTimed } from '@matrixai/contexts';
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
  VerifyCallback,
} from './types';
import type { Connection, ConnectionErrorCode, SendInfo } from './native/types';
import { Lock, LockBox, Monitor, RWLockWriter } from '@matrixai/async-locks';
import {
  ready,
  running,
  StartStop,
  status,
} from '@matrixai/async-init/dist/StartStop';
import Logger from '@matrixai/logger';
import { Timer } from '@matrixai/timer';
import { context, timedCancellable } from '@matrixai/contexts/dist/decorators';
import { buildQuicheConfig } from './config';
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
@StartStop()
class QUICConnection extends EventTarget {
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
   * Bubble up stream destroy event
   */
  protected handleQUICStreamDestroyEvent = () => {
    this.dispatchEvent(new events.QUICStreamDestroyEvent());
  };

  /**
   * Connection establishment.
   * This can resolve or reject.
   * Rejections cascade down to `secureEstablishedP` and `closedP`.
   */
  protected establishedP: Promise<void>;

  /**
   * Connection has been verified and secured.
   * This can only happen after `establishedP`.
   * On the server side, being established means it is also secure established.
   * On the client side, after being established, the client must wait for the
   * first short frame before it is also secure established.
   * This can resolve or reject.
   * Rejections cascade down to `closedP`.
   */
  protected secureEstablishedP: Promise<void>;

  /**
   * Connection closed promise.
   * This can resolve or reject.
   */
  protected closedP: Promise<void>;

  protected resolveEstablishedP: () => void;
  protected rejectEstablishedP: (reason?: any) => void;
  protected resolveSecureEstablishedP: () => void;
  protected rejectSecureEstablishedP: (reason?: any) => void;
  protected resolveClosedP: () => void;
  protected rejectClosedP: (reason?: any) => void;

  public readonly lockbox = new LockBox<RWLockWriter>();
  public readonly lockCode = 'ConnectionEventLockId';

  protected customVerified = false;
  protected shortReceived = false;
  protected secured = false;
  protected count = 0;
  protected verifyCallback: VerifyCallback | undefined;

  public static createQUICConnection(
    args:
      | {
          type: 'client';
          scid: QUICConnectionId;
          dcid?: undefined;
          remoteInfo: RemoteInfo;
          config: QUICConfig;
          socket: QUICSocket;
          reasonToCode?: StreamReasonToCode;
          codeToReason?: StreamCodeToReason;
          verifyCallback?: VerifyCallback;
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
          verifyCallback?: VerifyCallback;
          logger?: Logger;
        },
    ctx?: Partial<ContextTimed>,
  ): PromiseCancellable<QUICConnection>;
  @timedCancellable(true, Infinity, errors.ErrorQUICConnectionStartTimeOut)
  public static async createQUICConnection(
    args:
      | {
          type: 'client';
          scid: QUICConnectionId;
          dcid?: undefined;
          remoteInfo: RemoteInfo;
          config: QUICConfig;
          socket: QUICSocket;
          reasonToCode?: StreamReasonToCode;
          codeToReason?: StreamCodeToReason;
          verifyCallback?: VerifyCallback;
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
          verifyCallback?: VerifyCallback;
          logger?: Logger;
        },
    @context ctx: ContextTimed,
  ): Promise<QUICConnection> {
    const timeoutTime = ctx.timer.getTimeout();
    if (timeoutTime !== Infinity && timeoutTime >= args.config.maxIdleTimeout) {
      throw new errors.ErrorQUICConnectionInvalidConfig(
        'connection timeout timer must be strictly less than maxIdleTimeout',
      );
    }
    ctx.signal.throwIfAborted();
    const abortProm = promise<never>();
    const abortHandler = () => {
      abortProm.rejectP(ctx.signal.reason);
    };
    ctx.signal.addEventListener('abort', abortHandler);
    const connection = new this(args);
    // This ensures that TLS has been established and verified on both sides
    try {
      await Promise.race([
        Promise.all([
          connection.start(),
          connection.establishedP,
          connection.secureEstablishedP,
        ]),
        abortProm.p,
      ]);
    } catch (e) {
      const code =
        args.reasonToCode != null ? (await args.reasonToCode(e)) ?? 0 : 0;
      await connection.stop({
        applicationError: false,
        errorCode: code,
        errorMessage: e.message,
        force: true,
      });
      throw e;
    } finally {
      ctx.signal.removeEventListener('abort', abortHandler);
    }
    connection.logger.debug('secureEstablishedP');
    // After this is done
    // We need to establish the keep alive interval time
    if (connection.config.keepAliveIntervalTime != null) {
      connection.startKeepAliveIntervalTimer(
        connection.config.keepAliveIntervalTime,
      );
    }

    return connection;
  }

  public constructor({
    type,
    scid,
    dcid,
    remoteInfo,
    config,
    socket,
    reasonToCode = () => 0,
    codeToReason = (type, code) => new Error(`${type} ${code}`),
    verifyCallback,
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
        verifyCallback?: VerifyCallback;
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
        verifyCallback?: VerifyCallback;
        logger?: Logger;
      }) {
    super();
    this.logger = logger ?? new Logger(`${this.constructor.name} ${scid}`);
    // Checking constraints
    if (
      config.keepAliveIntervalTime != null &&
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
    this.verifyCallback = verifyCallback;
    this._remoteHost = remoteInfo.host;
    this._remotePort = remoteInfo.port;
    const {
      p: establishedP,
      resolveP: resolveEstablishedP,
      rejectP: rejectEstablishedP,
    } = utils.promise();
    this.establishedP = establishedP;
    this.resolveEstablishedP = resolveEstablishedP;
    this.rejectEstablishedP = rejectEstablishedP;

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

  public get remoteHost() {
    return this._remoteHost;
  }

  public get remotePort() {
    return this._remotePort;
  }

  public get localHost() {
    return this.socket.host;
  }

  public get localPort() {
    return this.socket.port;
  }

  /**
   * This will set up the connection initiate sending
   */
  public async start(): Promise<void> {
    this.logger.info(`Start ${this.constructor.name}`);
    // Set the connection up
    this.socket.connectionMap.set(this.connectionId, this);
    await this.send();
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
    mon?: Monitor<RWLockWriter>,
  ) {
    this.logger.info(`Stop ${this.constructor.name}`);
    // Cleaning up existing streams
    const streamsDestroyP: Array<Promise<void>> = [];
    this.logger.debug('triggering stream destruction');
    for (const stream of this.streamMap.values()) {
      // If we're draining then streams will never end on their own.
      // We must force them to end.
      if (this.conn.isDraining() || this.conn.isClosed() || force) {
        await stream.destroy();
      }
      streamsDestroyP.push(stream.destroyedP);
    }
    this.logger.debug('waiting for streams to destroy');
    await Promise.all(streamsDestroyP);
    this.logger.debug('streams destroyed');
    this.stopKeepAliveIntervalTimer();

    mon = mon ?? new Monitor<RWLockWriter>(this.lockbox, RWLockWriter);
    // Trigger closing connection in the background and await close later.
    void mon.withF(this.lockCode, async (mon) => {
      // If this is already closed, then `Done` will be thrown
      // Otherwise it can send `CONNECTION_CLOSE` frame
      // This can be 0x1c close at the QUIC layer or no errors
      // Or it can be 0x1d for application close with an error
      // Upon receiving a `CONNECTION_CLOSE`, you can send back
      // 1 packet containing a `CONNECTION_CLOSE` frame too
      // (with `NO_ERROR` code if appropriate)
      // It must enter into a draining state, and no other packets can be sent
      try {
        this.conn.close(applicationError, errorCode, Buffer.from(errorMessage));
        // If we get a `Done` exception we don't bother calling send
        // The send only gets sent if the `Done` is not the case
        await this.send(mon);
      } catch (e) {
        // Ignore 'Done' if already closed
        if (e.message !== 'Done') {
          // No other exceptions are expected
          never();
        }
      }
    });

    if (this.conn.isClosed()) {
      this.resolveClosedP();
    }
    this.setConnTimeOutTimer();
    // Now we await for the closedP
    this.logger.debug('awaiting closedP');
    await this.closedP;
    this.logger.debug('closedP');
    this.connTimeOutTimer?.cancel(timerCleanupReasonSymbol);

    // Removing the connection from the socket's connection map
    this.socket.connectionMap.delete(this.connectionId);

    // Checking for errors and emitting them as events
    // Emit error if connection timed out
    if (this.conn.isTimedOut()) {
      const error = this.secured
        ? new errors.ErrorQUICConnectionIdleTimeOut()
        : new errors.ErrorQUICConnectionStartTimeOut();

      this.rejectEstablishedP(error);
      this.rejectSecureEstablishedP(error);
      this.dispatchEvent(
        new events.QUICConnectionErrorEvent({
          detail: error,
        }),
      );
    }

    // Emit error if peer error
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
      this.rejectEstablishedP(error);
      this.rejectSecureEstablishedP(error);
      this.dispatchEvent(
        new events.QUICConnectionErrorEvent({
          detail: error,
        }),
      );
    }

    // Emit error if local error
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
      this.rejectEstablishedP(error);
      this.rejectSecureEstablishedP(error);
      this.dispatchEvent(
        new events.QUICConnectionErrorEvent({
          detail: error,
        }),
      );
    }

    this.dispatchEvent(new events.QUICConnectionStopEvent());
    this.logger.info(`Stopped ${this.constructor.name}`);
  }

  /**
   * Gets an array of certificates in PEM format start on the leaf.
   */
  @ready(new errors.ErrorQUICConnectionNotRunning())
  public getRemoteCertsChain(): Array<string> {
    const certsDER = this.conn.peerCertChain();
    if (certsDER == null) return [];
    return certsDER.map(utils.certificateDERToPEM);
  }

  /**
   * Called when the socket receives data from the remote side intended for this connection.
   * UDP -> Connection -> Stream
   * This pushes data to the streams.
   * When the connection is draining, we can still receive data.
   * However, no streams are allowed to read or write.
   *
   * This method must not throw any exceptions.
   * Any errors must be emitted as events.
   * @internal
   */
  public async recv(
    data: Uint8Array,
    remoteInfo: RemoteInfo,
    mon: Monitor<RWLockWriter>,
  ) {
    if (!mon.isLocked(this.lockCode)) {
      return mon.withF(this.lockCode, async (mon) => {
        return this.recv(data, remoteInfo, mon);
      });
    }

    try {
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
        // Should only be a `TLSFail` if we fail here.
        // The error details will be available as a local error.
        if (e.message !== 'TlsFail') {
          // No other exceptions are expected
          utils.never();
        }
      }

      // Checking if the packet was a short frame.
      // Short indicates that the peer has completed TLS verification
      if (!this.shortReceived) {
        const header = quiche.Header.fromSlice(data, quiche.MAX_CONN_ID_LEN);
        // If short frame
        if (header.ty === 5) {
          this.shortReceived = true;
        }
      }
      // Checks if `secureEstablishedP` should be resolved. The condition for
      //  this is if a short frame has been received and 1 extra frame has been
      //  received. This allows for the remote to close the connection.
      if (!this.secured && this.shortReceived && !this.conn.isDraining()) {
        if (this.count >= 1) {
          this.secured = true;
          this.resolveSecureEstablishedP();
        }
        this.count += 1;
      }

      // We don't actually "fail"
      // the closedP until we proceed
      // But note that if there's an error

      if (this.conn.isEstablished()) {
        this.resolveEstablishedP();
      }

      if (this.conn.isClosed()) {
        this.resolveClosedP();
        return;
      }

      if (this.conn.isInEarlyData() || this.conn.isEstablished()) {
        await this.processStreams();
      }
    } finally {
      this.logger.debug('RECV FINALLY');
      if (
        this[status] !== 'destroying' &&
        (this.conn.isClosed() || this.conn.isDraining())
      ) {
        this.logger.debug('calling stop due to closed or draining');
        // Destroy in the background, we still need to process packets.
        // Draining means no more packets are sent, so streams must be force closed.
        void this.stop({ force: true }, mon).catch(() => {});
      }
    }
  }

  /**
   * Called when the socket has to send back data on this connection.
   * This is better understood as "flushing" the connection send buffer.
   * This is because the data to send actually comes from the quiche library
   * and any data that is currently buffered on the streams.
   * It will send everything into the UDP socket.
   *
   * UDP <- Connection <- Stream
   *
   * Call this if `recv` is called.
   * Call this if timer expires.
   * Call this if stream is written.
   * Call this if stream is read.
   *
   * We can push the connection into the stream.
   * The streams have access to the connection object.
   *
   * This method must not throw any exceptions.
   * Any errors must be emitted as events.
   * @internal
   */
  public async send(
    mon: Monitor<RWLockWriter> = new Monitor<RWLockWriter>(
      this.lockbox,
      RWLockWriter,
    ),
  ): Promise<void> {
    if (!mon.isLocked(this.lockCode)) {
      return mon.withF(this.lockCode, async (mon) => {
        return this.send(mon);
      });
    }

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

        // Handling custom TLS verification, this must be done after the following conditions.
        //  1. Connection established.
        //  2. Certs available.
        //  3. Sent after connection has established.
        if (
          !this.customVerified &&
          this.conn.isEstablished() &&
          this.conn.peerCertChain() != null
        ) {
          this.customVerified = true;
          const peerCerts = this.conn.peerCertChain();
          if (peerCerts == null) never();
          const peerCertsPem = peerCerts.map((c) =>
            utils.certificateDERToPEM(c),
          );
          try {
            // Running verify callback if available
            if (this.verifyCallback != null) this.verifyCallback(peerCertsPem);
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
    } catch (e) {
      // An error here means a hard failure in sending, we must force clean up
      //  since any further communication is expected to fail.
      this.logger.debug(`Calling stop due to sending error [${e.message}]`);
      const code = await this.reasonToCode('send', e);
      await this.stop(
        {
          applicationError: false,
          errorCode: code,
          errorMessage: e.message,
          force: true,
        },
        mon,
      );
      // We need to finish without any exceptions
      return;
    }
    if (this.conn.isClosed()) {
      // Handle stream clean up if closed
      this.resolveClosedP();
      await this.stop(
        this.conn.localError() ?? this.conn.peerError() ?? {},
        mon,
      );
    }
    this.setConnTimeOutTimer();
  }

  /**
   * Keeps stream processing logic all in one place.
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
        quicStream.addEventListener(
          'streamDestroy',
          this.handleQUICStreamDestroyEvent,
          { once: true },
        );
        this.dispatchEvent(
          new events.QUICConnectionStreamEvent({ detail: quicStream }),
        );
      }
      quicStream.read();
    }
    for (const streamId of this.conn.writable() as Iterable<StreamId>) {
      const quicStream = this.streamMap.get(streamId);
      if (quicStream == null) {
        // This is a dead case, there are only two ways streams are created.
        //  The QUICStream will always exist before processing it's writable.
        //  1. First time it is seen in the readable iterator
        //  2. created using `streamNew()`
        never();
      }
      quicStream.write();
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

      // Connection may have closed after timing out
      if (this.conn.isClosed()) {
        // If it was still starting waiting for the secure event, we need to
        //  reject the `secureEstablishedP` promise.
        if (this[status] === 'starting') {
          this.rejectSecureEstablishedP(
            new errors.ErrorQUICConnectionInternal('Connection has closed!'),
          );
        }

        logger.debug('resolving closedP');
        // We resolve closing here, stop checks if the connection has timed out
        //  and handles it.
        this.resolveClosedP();
        // If we are still running and not stopping then we need to stop
        if (this[running] && this[status] !== 'stopping') {
          const mon = new Monitor(this.lockbox, RWLockWriter);
          // Background stopping, we don't want to block the timer resolving
          void this.stop({ force: true }, mon);
        }
        logger.debug('CLEANING UP TIMER');
        return;
      }

      const mon = new Monitor(this.lockbox, RWLockWriter);
      // There may be data to send after timing out
      void this.send(mon);

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
      const mon = new Monitor(this.lockbox, RWLockWriter);
      this.conn.sendAckEliciting();
      await this.send(mon);
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
      quicStream.addEventListener(
        'streamDestroy',
        this.handleQUICStreamDestroyEvent,
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
}

export default QUICConnection;
