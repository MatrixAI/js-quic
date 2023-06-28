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
   */
  protected streamIdClientUni: StreamId = 0b10 as StreamId;

  /**
   * Server initiated unidirectional stream starts at 3.
   * Increment by 4 to get the next ID.
   */
  protected streamIdServerUni: StreamId = 0b11 as StreamId;

  /**
   * Internal conn timer. This is used to tick the state transitions on the
   * conn.
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
   * However this keep alive mechanism will continue to work in case you need
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

  // TODO: use it or loose it?
  /**
   * Bubble up all QUIC stream events.
   */
  protected handleQUICStreamEvents = (e: events.QUICStreamEvent) => {
    this.dispatchEvent(e);
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

  protected wasEstablished: boolean = false;

  protected resolveEstablishedP: () => void;
  protected rejectEstablishedP: (reason?: any) => void;
  protected resolveSecureEstablishedP: () => void;
  protected rejectSecureEstablishedP: (reason?: any) => void;
  protected resolveClosedP: () => void;
  protected rejectClosedP: (reason?: any) => void;

  protected lastErrorMessage?: string;

  public readonly lockbox = new LockBox<RWLockWriter>();
  public readonly lockCode = 'Lock'; // TODO: more unique code

  protected customVerified = false;
  protected shortReceived = false;
  protected shortSent = false;
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
      await connection.stop({
        applicationError: false,
        errorCode: 42, // FIXME: use a proper code
        errorMessage: e.message,
        force: true,
      });
      throw e;
    } finally {
      ctx.signal.removeEventListener('abort', abortHandler);
    }
    connection.logger.warn('secured');
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
    this.resolveEstablishedP = () => {
      // Upon the first time you call this, it is now true
      // But prior to this

      this.wasEstablished = true;
      resolveEstablishedP();
    };
    this.rejectEstablishedP = rejectEstablishedP;

    // We can do something where, once you "resolve"
    // Then it is in fact established
    // Alternatively, we can just bind into the `establishedP` here
    // Does this become a dangling promsie?
    // Cause it is `void` here
    // I think it's better to use the `resolveEstablishedP`

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
   * The default `errorCode` of 0 means no error or general error.
   * This is the same as basically waiting for `closedP`.
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
    const streamDestroyPs: Array<Promise<void>> = [];
    for (const stream of this.streamMap.values()) {
      streamDestroyPs.push(stream.destroy({ force }));
    }
    await Promise.all(streamDestroyPs);
    // Do we do this afterward or before?
    // FIXME: not sure it really matters, don't really need a keep alive while stopping.
    this.stopKeepAliveIntervalTimer();
    try {
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
          this.conn.close(
            applicationError,
            errorCode,
            Buffer.from(errorMessage),
          );
          // If we get a `Done` exception we don't bother calling send
          // The send only gets sent if the `Done` is not the case
          await this.send(mon);
        } catch (e) {
          // Ignore 'Done' if already closed
          if (e.message !== 'Done') throw e;
        }
      });
    } catch (e) {
      // If the connection is already closed, `Done` will be thrown
      if (e.message !== 'Done') {
        // No other exceptions are expected
        utils.never();
      }
    }

    if (this.conn.isClosed()) {
      this.resolveClosedP();
    }
    // Now we await for the closedP
    await this.closedP;

    // The reason we only delete afterwards
    // Is because we do it before we are opened (or just constructed)
    // Techincally it was constructed, and then we added ourselves to it
    // But during `start` we are just waiting
    this.socket.connectionMap.delete(this.connectionId);

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
        if (e.message !== 'TlsFail') {
          // No other exceptions are expected
          utils.never();
        }
        // Do note that if we get a TlsFail
        // We must proceed without throwing any exceptions
        // But we must "save" the error here
        // We don't need the save the localError or remoteError
        // Cause that will be "saved"
        // Only this e.message <- this will be whatever is the last message
        this.lastErrorMessage = e.message;
      }

      // Checking if the packet was a short frame.
      // Short indicates that the peer has completed TLS verification
      if (!this.shortReceived) {
        const header = quiche.Header.fromSlice(data, quiche.MAX_CONN_ID_LEN);
        // If short frame
        if (header.ty === 5) {
          this.shortReceived = true;
          this.conn.sendAckEliciting();
        }
      }

      if (
        !this.secured &&
        this.shortReceived &&
        this.shortReceived &&
        !this.conn.isDraining()
      ) {
        if (this.count >= 1) {
          this.secured = true;
          this.resolveSecureEstablishedP();
          // This.dispatchEvent(new events.QUICConnectionRemoteSecureEvent()); TODO
        }
        this.count += 1;
      }

      // We don't actually "fail"
      // the closedP until we proceed
      // But note that if there's an error

      if (this.conn.isEstablished()) {
        this.resolveEstablishedP();
      }

      // We also need to know whether this is our first short frame
      // After we are already established
      // This may not be robust
      // Cause technically
      // What if we were "concatenated" packet
      // Then it could be a problem right?

      if (this.conn.isClosed()) {
        this.resolveClosedP();
        return;
      }

      if (this.conn.isInEarlyData() || this.conn.isEstablished()) {
        const readIds: Array<number> = [];
        for (const streamId of this.conn.readable() as Iterable<StreamId>) {
          let quicStream = this.streamMap.get(streamId);
          if (quicStream == null) {
            // The creation will set itself to the stream map
            quicStream = await QUICStream.createQUICStream({
              streamId,
              connection: this,
              codeToReason: this.codeToReason,
              reasonToCode: this.reasonToCode,
              // MaxReadableStreamBytes: this.maxReadableStreamBytes,
              // maxWritableStreamBytes: this.maxWritableStreamBytes,
              logger: this.logger.getChild(`${QUICStream.name} ${streamId}`),
            });
            this.dispatchEvent(
              new events.QUICConnectionStreamEvent({ detail: quicStream }),
            );
          }
          readIds.push(quicStream.streamId);
          quicStream.read();
          // QuicStream.dispatchEvent(new events.QUICStreamReadablaeEvent()); // TODO: remove?
        }
        if (readIds.length > 0) {
          this.logger.info(`processed reads for ${readIds}`);
        }
        const writeIds: Array<number> = [];
        for (const streamId of this.conn.writable() as Iterable<StreamId>) {
          let quicStream = this.streamMap.get(streamId);
          if (quicStream == null) {
            // The creation will set itself to the stream map
            quicStream = await QUICStream.createQUICStream({
              streamId,
              connection: this,
              codeToReason: this.codeToReason,
              reasonToCode: this.reasonToCode,
              // MaxReadableStreamBytes: this.maxReadableStreamBytes,
              logger: this.logger.getChild(`${QUICStream.name} ${streamId}`),
            });
            this.dispatchEvent(
              new events.QUICConnectionStreamEvent({ detail: quicStream }),
            );
          }
          // QuicStream.dispatchEvent(new events.QUICStreamWritableEvent()); // TODO: remove?
          writeIds.push(quicStream.streamId);
          quicStream.write();
        }
        if (writeIds.length > 0) {
          this.logger.info(`processed writes for ${writeIds}`);
        }
      }
    } finally {
      // This.garbageCollectStreams('recv'); // FIXME: this was removed? How is this handled now?
      this.logger.debug('RECV FINALLY');
      // Set the timeout
      this.setConnTimeOutTimer(); // FIXME: Might not be needed here, Only need it after calling send
      // If this call wasn't executed in the midst of a destroy
      // and yet the connection is closed or is draining, then
      // we need to destroy this connection
      if (
        this[status] !== 'destroying' &&
        (this.conn.isClosed() || this.conn.isDraining())
      ) {
        this.logger.debug('CALLING DESTROY 2');
        // Destroy in the background, we still need to process packets
        void this.stop({}, mon).catch(() => {});
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
      }
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
        const peerCertsPem = peerCerts.map((c) => utils.certificateDERToPEM(c));
        // Dispatching certs available event
        // this.dispatchEvent(new events.QUICConnectionRemoteCertEvent()); TODO
        try {
          if (this.verifyCallback != null) this.verifyCallback(peerCertsPem);
          this.conn.sendAckEliciting();
        } catch (e) {
          // Force the connection to end.
          // Error 304 indicates cert chain failed verification.
          // Error 372 indicates cert chain was missing.
          this.conn.close(
            false,
            304,
            Buffer.from(`Custom TLSFail: ${e.message}`),
          );
        }
      }

      // Check the header type
      if (!this.shortSent) {
        const header = quiche.Header.fromSlice(
          sendBuffer,
          quiche.MAX_CONN_ID_LEN,
        );
        // If short frame
        if (header.ty === 5) {
          // Short was sent, locally secured
          this.shortSent = true;
        }
      }
    } catch (e) {
      // If called `stop` due to an error here
      // we MUST not call `this.send` again
      // in fact, we do a hard-stop
      // There's no need to even have a timeout at all
      // Remember this exception COULD be due to `e`
      // It could be due to `localError` or `remoteError`
      // All of this is possible
      // Generally at least one of them is the reason

      // the error has to be one or the other

      await this.stop(
        {
          applicationError: true,
          errorCode: 0, // TODO: actual code? use code mapping?
          errorMessage: e.message,
        },
        mon,
      );

      // We need to finish without any exceptions
      return;
    }
    if (this.conn.isClosed()) {
      // But if it is closed with no error
      // Then we just have to proceed!
      // Plus if we are called here
      this.resolveClosedP();
      await this.stop(
        this.conn.localError() ?? this.conn.peerError() ?? {},
        mon,
      );
    } else {
      // In all other cases, reset the conn timer
      this.setConnTimeOutTimer();
    }
  }

  protected setConnTimeOutTimer(): void {
    const connTimeOutHandler = async () => {
      // This can only be called when the timeout has occurred
      // This transitions the connection state
      this.logger.debug('CALLING ON TIMEOUT');
      this.conn.onTimeout();

      // At this point...
      // we check the conditions on the connection
      // This way we can RESOLVE things like
      // conn closed or established or other things
      // or if we are draining
      // if we have timed out... etc
      // All state changes need to result in reaction
      // Is established is not required
      // But we can have a bunch of things that check and react accordingly
      // So if it is timed out, it gets closed too
      // But if it is is timed out due to idle we raise an error

      // At the same time, we may in fact be closed too
      if (this.conn.isClosed()) {
        // If it was still starting waiting for the secure event,
        // we need to reject that promise.
        if (this[status] === 'starting') {
          this.rejectSecureEstablishedP(
            new errors.ErrorQUICConnectionInternal('Connection has closed!'),
          );
        }

        // We actually finally closed here
        // Actually the question is that this could be an error
        // The act of closing is an error?
        // That's confusing
        this.resolveClosedP();
        // If we are not stopping nor are we stopped
        // And we are not running, call await this stop

        // We need to trigger this as well by calling stop
        // What happens if we are starting too?
        if (this[running] && this[status] !== 'stopping') {
          // If we are already stopping, stop multiple times is idempotent
          // Wait if we call stop multiple times
          // Actually we may already be stopping
          // But also that if the status is starting
          // But also if we are starting
          // Resolve the closeP
          // is technically an error!
          const mon = new Monitor(this.lockbox, RWLockWriter);
          await this.stop(
            this.conn.localError() ?? this.conn.peerError() ?? {},
            mon,
          );
        }

        // Finish
        return;
      }

      const mon = new Monitor(this.lockbox, RWLockWriter);
      await this.send(mon);

      // Note that a `0` timeout is still a valid timeout
      const timeout = this.conn.timeout();
      // If this is `null`, then technically there's nothing to do
      if (timeout == null) return;
      // Allow an extra 1ms for the delay to fully complete, so we can avoid a repeated 0ms delay
      this.connTimeOutTimer = new Timer({
        delay: timeout + 1,
        handler: connTimeOutHandler,
      });
    };
    // Note that a `0` timeout is still a valid timeout
    const timeout = this.conn.timeout();
    // If this is `null` there's nothing to do
    if (timeout == null) return;
    // If there was an existing timer, we cancel it and set a new one
    if (
      this.connTimeOutTimer != null &&
      this.connTimeOutTimer.status === null
    ) {
      this.connTimeOutTimer.reset(timeout);
    } else {
      this.logger.debug(`timeout created with delay ${timeout}`);
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
   * open. However it can still be useful to maintain liveness for NAT purposes.
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
    this.keepAliveIntervalTimer?.cancel();
  }

  /**
   * Creates a new stream on the connection.
   * Only supports bidi streams atm.
   * This is a serialised call, it must be blocking.
   */
  @ready(new errors.ErrorQUICConnectionNotRunning())
  public async streamNew(streamType: 'bidi' = 'bidi'): Promise<QUICStream> {
    // You wouldn't want AsyncMonitor here
    // The problem is that we want re-entrant contexts

    // Technically you can do concurrent bidi and uni style streams
    // but no support for uni streams yet
    // So we don't bother with it
    return await this.streamIdLock.withF(async () => {
      let streamId: StreamId;
      if (this.type === 'client' && streamType === 'bidi') {
        streamId = this.streamIdClientBidi;
      } else if (this.type === 'server' && streamType === 'bidi') {
        streamId = this.streamIdServerBidi;
      }

      // If you call this again
      // you will get another stream ID
      // but the problem is that
      // if you call it multiple times concurrently
      // you'll have an issue
      // this can only be called one at a time
      // This is not allowed to be concurrent
      // You cannot open many streams all concurrently
      // since stream creations are serialised

      // If we are in draining state
      // we cannot call this anymore
      // Hre ewe send the stream id
      // with stream capacity will fail
      // We send a 0-length buffer first
      const quicStream = await QUICStream.createQUICStream({
        streamId: streamId!,
        connection: this,
        codeToReason: this.codeToReason,
        reasonToCode: this.reasonToCode,
        // MaxReadableStreamBytes: this.maxReadableStreamBytes,
        // maxWritableStreamBytes: this.maxWritableStreamBytes,
        logger: this.logger.getChild(`${QUICStream.name} ${streamId!}`),
      });
      // Ok the stream is opened and working
      if (this.type === 'client' && streamType === 'bidi') {
        this.streamIdClientBidi = (this.streamIdClientBidi + 4) as StreamId;
      } else if (this.type === 'server' && streamType === 'bidi') {
        this.streamIdServerBidi = (this.streamIdServerBidi + 4) as StreamId;
      }
      return quicStream;
    });
  }

  // /**
  //  * Used to update or disable the keep alive interval.
  //  * Calling this will reset the delay before the next keep alive.
  //  */
  // @ready(new errors.ErrorQUICConnectionNotRunning())
  // public setKeepAlive(intervalDelay?: number) {
  //   // Clearing timeout prior to update
  //   if (this.keepAliveInterval != null) {
  //     clearTimeout(this.keepAliveInterval);
  //     delete this.keepAliveInterval;
  //   }
  //   // Setting up keep alive interval
  //   if (intervalDelay != null) {
  //     this.keepAliveInterval = setInterval(async () => {
  //       // Trigger an ping frame and send
  //       this.conn.sendAckEliciting();
  //       await this.send();
  //     }, intervalDelay);
  //   }
  // }
  //
  // // Timeout handling, these methods handle time keeping for quiche.
  // // Quiche will request an amount of time, We then call `onTimeout()` after that time has passed.
  // protected deadline: number = 0;
  // protected onTimeout = async () => {
  //   this.logger.warn('ON TIMEOUT CALLED ' + new Date());
  //   this.logger.debug('timeout on timeout');
  //   // Clearing timeout
  //   clearTimeout(this.timer);
  //   delete this.timer;
  //   this.deadline = Infinity;
  //   // Doing timeout actions
  //   // console.time('INTERNAL ON TIMEOUT');
  //   this.conn.onTimeout();
  //   // console.timeEnd('INTERNAL ON TIMEOUT');
  //   this.logger.warn('BEFORE CALLING SEND' + new Date());
  //   if (this[destroyed] === false) await this.send();
  //   this.logger.warn('AFTER CALLING SEND ' + new Date());
  //   if (
  //     this[status] !== 'destroying' &&
  //     (this.conn.isClosed() || this.conn.isDraining())
  //   ) {
  //     this.logger.debug('CALLING DESTROY 3');
  //     // Destroy in the background, we still need to process packets
  //     void this.destroy().catch(() => {});
  //   }
  //   this.logger.warn('BEFORE CHECK TIMEOUT' + new Date());
  //   this.checkTimeout();
  //   this.logger.warn('AFTER CHECK TIMEOUT' + new Date());
  // };

  /**
   * Checks the timeout event, should be called whenever the following events happen.
   * 1. `send()` is called
   * 2. `recv()` is called
   * 3. timer times out.
   *
   * This needs to do 3 things.
   * 1. Create a timer if none exists
   * 2. Update the timer if `conn.timeout()` is less than current timeout.
   * 3. clean up timer if `conn.timeout()` is null.
   */
  // protected checkTimeout = () => {
  //   this.logger.debug('timeout checking timeout');
  //   // During construction, this ends up being null
  //   const time = this.conn.timeout();
  //   this.logger.error(`THE TIME (${this.times}): ` + time + ' ' + new Date());
  //   this.times++;
  //
  //   if (time == null) {
  //     // Clear timeout
  //     if (this.timer != null) this.logger.debug('timeout clearing timeout');
  //     clearTimeout(this.timer);
  //     delete this.timer;
  //     this.deadline = Infinity;
  //   } else {
  //     const newDeadline = Date.now() + time;
  //     if (this.timer != null) {
  //       if (time === 0) {
  //         this.logger.debug('timeout triggering instant timeout');
  //         // Skip timer and call onTimeout
  //         setImmediate(this.onTimeout);
  //       } else if (newDeadline < this.deadline) {
  //         this.logger.debug(`timeout updating timer with ${time} delay`);
  //         clearTimeout(this.timer);
  //         delete this.timer;
  //         this.deadline = newDeadline;
  //
  //         this.logger.warn('BEFORE SET TIMEOUT 1: ' + time);
  //
  //         this.timer = setTimeout(this.onTimeout, time);
  //       }
  //     } else {
  //       if (time === 0) {
  //         this.logger.debug('timeout triggering instant timeout');
  //         // Skip timer and call onTimeout
  //         setImmediate(this.onTimeout);
  //         return;
  //       }
  //       this.logger.debug(`timeout creating timer with ${time} delay`);
  //       this.deadline = newDeadline;
  //
  //       this.logger.warn('BEFORE SET TIMEOUT 2: ' + time);
  //
  //       this.timer = setTimeout(this.onTimeout, time);
  //     }
  //   }
  // };

  // protected garbageCollectStreams(where: string) {
  //   const nums: Array<number> = [];
  //   // Only check if packets were sent
  //   for (const [streamId, quicStream] of this.streamMap) {
  //     // Stream sending can finish after a packet is sent
  //     nums.push(streamId);
  //     quicStream.read();
  //   }
  //   if (nums.length > 0) {
  //     this.logger.info(`checking read finally ${where} for ${nums}`);
  //   }
  // }
}

export default QUICConnection;
