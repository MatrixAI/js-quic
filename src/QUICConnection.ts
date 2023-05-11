import type QUICSocket from './QUICSocket';
import type QUICConnectionMap from './QUICConnectionMap';
import type QUICConnectionId from './QUICConnectionId';
// This is specialized type
import type { QUICConfig } from './config';
import type { Host, Port, RemoteInfo, StreamId } from './types';
import type { Connection, ConnectionErrorCode, SendInfo } from './native/types';
import type { StreamCodeToReason, StreamReasonToCode } from './types';
import type { ConnectionMetadata } from './types';
import {
  CreateDestroy,
  ready,
  status,
} from '@matrixai/async-init/dist/CreateDestroy';
import Logger from '@matrixai/logger';
import { Lock } from '@matrixai/async-locks';
import { destroyed } from '@matrixai/async-init';
import { buildQuicheConfig } from './config';
import QUICStream from './QUICStream';
import { quiche } from './native';
import * as events from './events';
import * as utils from './utils';
import * as errors from './errors';
import { promise } from './utils';

/**
 * Think of this as equivalent to `net.Socket`.
 * Errors here are emitted to the connection only.
 * Not to the server.
 *
 * Events (events are executed post-facto):
 * - stream - when new stream is created
 * - destroy - when destruction is done
 * - error - when an error is emitted
 */
interface QUICConnection extends CreateDestroy {}
@CreateDestroy()
class QUICConnection extends EventTarget {
  public readonly connectionId: QUICConnectionId;
  public readonly type: 'client' | 'server';

  public conn: Connection;
  public connectionMap: QUICConnectionMap;
  public streamMap: Map<StreamId, QUICStream> = new Map();
  protected reasonToCode: StreamReasonToCode;
  protected codeToReason: StreamCodeToReason;
  protected maxReadableStreamBytes: number | undefined;
  protected maxWritableStreamBytes: number | undefined;
  protected destroyingMap: Map<StreamId, QUICStream> = new Map();

  // This basically allows one to await this promise
  // once resolved, always resolved...
  // note that this may be rejected... at the beginning
  // if the connection setup fails (not sure how this can work yet)
  public readonly establishedP: Promise<void>;
  protected resolveEstablishedP: () => void;
  protected rejectEstablishedP: (reason?: any) => void;
  public readonly handshakeP: Promise<void>;
  protected resolveHandshakeP: () => void;

  protected logger: Logger;
  protected socket: QUICSocket;
  protected timer?: ReturnType<typeof setTimeout>;
  protected keepAliveInterval?: ReturnType<typeof setInterval>;
  public readonly closedP: Promise<void>;
  protected resolveCloseP?: () => void;

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

  // /**
  //  * Client initiated unidirectional stream starts at 2.
  //  * Increment by 4 to get the next ID.
  //  */
  // protected streamIdClientUni: StreamId = 0b10 as StreamId;

  // /**
  //  * Server initiated unidirectional stream starts at 3.
  //  * Increment by 4 to get the next ID.
  //  */
  // protected streamIdServerUni: StreamId = 0b11 as StreamId;

  // These can change on every `recv` call
  protected _remoteHost: Host;
  protected _remotePort: Port;

  /**
   * Create QUICConnection by connecting to a server
   */
  public static async connectQUICConnection({
    scid,
    socket,
    remoteInfo,
    config,
    reasonToCode = () => 0,
    codeToReason = (type, code) =>
      new Error(`${type.toString()} ${code.toString()}`),
    maxReadableStreamBytes,
    maxWritableStreamBytes,
    logger = new Logger(`${this.name} ${scid}`),
  }: {
    scid: QUICConnectionId;
    socket: QUICSocket;
    remoteInfo: RemoteInfo;
    config: QUICConfig;
    reasonToCode?: StreamReasonToCode;
    codeToReason?: StreamCodeToReason;
    maxReadableStreamBytes?: number;
    maxWritableStreamBytes?: number;
    logger?: Logger;
  }) {
    logger.info(`Connect ${this.name}`);
    const quicheConfig = buildQuicheConfig(config);
    const conn = quiche.Connection.connect(
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
    // This will output to the log keys file path
    if (config.logKeys != null) {
      conn.setKeylog(config.logKeys);
    }
    const connection = new this({
      type: 'client',
      conn,
      connectionId: scid,
      socket,
      remoteInfo,
      reasonToCode,
      codeToReason,
      maxReadableStreamBytes,
      maxWritableStreamBytes,
      logger,
    });
    socket.connectionMap.set(connection.connectionId, connection);
    logger.info(`Connected ${this.name}`);
    return connection;
  }

  /**
   * Create QUICConnection by accepting a client
   */
  public static async acceptQUICConnection({
    scid,
    dcid,
    socket,
    remoteInfo,
    config,
    reasonToCode = () => 0,
    codeToReason = (type, code) =>
      new Error(`${type.toString()} ${code.toString()}`),
    maxReadableStreamBytes,
    maxWritableStreamBytes,
    logger = new Logger(`${this.name} ${scid}`),
  }: {
    scid: QUICConnectionId;
    dcid: QUICConnectionId;
    socket: QUICSocket;
    remoteInfo: RemoteInfo;
    config: QUICConfig;
    reasonToCode?: StreamReasonToCode;
    codeToReason?: StreamCodeToReason;
    maxReadableStreamBytes?: number;
    maxWritableStreamBytes?: number;
    logger?: Logger;
  }): Promise<QUICConnection> {
    logger.info(`Accept ${this.name}`);
    const quicheConfig = buildQuicheConfig(config);
    const conn = quiche.Connection.accept(
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
    // This will output to the log keys file path
    if (config.logKeys != null) {
      conn.setKeylog(config.logKeys);
    }
    const connection = new this({
      type: 'server',
      conn,
      connectionId: scid,
      socket,
      remoteInfo,
      reasonToCode,
      codeToReason,
      maxReadableStreamBytes,
      maxWritableStreamBytes,
      logger,
    });
    socket.connectionMap.set(connection.connectionId, connection);
    logger.info(`Accepted ${this.name}`);
    return connection;
  }

  public constructor({
    type,
    conn,
    connectionId,
    socket,
    remoteInfo,
    reasonToCode,
    codeToReason,
    maxReadableStreamBytes,
    maxWritableStreamBytes,
    logger,
  }: {
    type: 'client' | 'server';
    conn: Connection;
    connectionId: QUICConnectionId;
    socket: QUICSocket;
    remoteInfo: RemoteInfo;
    reasonToCode: StreamReasonToCode;
    codeToReason: StreamCodeToReason;
    maxReadableStreamBytes: number | undefined;
    maxWritableStreamBytes: number | undefined;
    logger: Logger;
  }) {
    super();
    this.logger = logger;
    this.type = type;
    this.conn = conn;
    this.connectionId = connectionId;
    this.connectionMap = socket.connectionMap;
    this.socket = socket;
    this._remoteHost = remoteInfo.host;
    this._remotePort = remoteInfo.port;
    this.reasonToCode = reasonToCode;
    this.codeToReason = codeToReason;
    this.maxReadableStreamBytes = maxReadableStreamBytes;
    this.maxWritableStreamBytes = maxWritableStreamBytes;
    // Sets the timeout on the first
    this.checkTimeout();

    // Note that you must be able to reject too
    // otherwise one might await for establishment forever
    // the server side has to code up their own bootstrap
    // but the client side just uses the quiche library
    const {
      p: establishedP,
      resolveP: resolveEstablishedP,
      rejectP: rejectEstablishedP,
    } = utils.promise();
    this.establishedP = establishedP;
    this.resolveEstablishedP = resolveEstablishedP;
    this.rejectEstablishedP = rejectEstablishedP;
    const { p: closedP, resolveP: resolveClosedP } = utils.promise();
    this.resolveCloseP = resolveClosedP;
    this.closedP = closedP;
    const { p: handshakeP, resolveP: resolveHandshakeP } = utils.promise();
    this.handshakeP = handshakeP;
    this.resolveHandshakeP = resolveHandshakeP;
  }

  // Immediately call this after construction
  // if you want to pass the key log to something
  // note that you must close the file descriptor afterward
  public setKeylog(path) {
    this.conn.setKeylog(path);
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

  public get remoteInfo(): ConnectionMetadata {
    const derCerts = this.conn.peerCertChain();
    const remoteCertificates =
      derCerts != null
        ? derCerts.map((der) => utils.certificateDERToPEM(der))
        : null;
    return {
      remoteCertificates,
      localHost: this.localHost,
      localPort: this.localPort,
      remoteHost: this.remoteHost,
      remotePort: this.remotePort,
    };
  }

  /**
   * This provides the ability to destroy with a specific error. This will wait for the connection to fully drain.
   */
  public async destroy({
    appError = false,
    errorCode = quiche.ConnectionErrorCode.NoError,
    errorMessage = '',
    force = false,
  }: {
    appError?: boolean;
    errorCode?: ConnectionErrorCode;
    errorMessage?: string;
    force?: boolean;
  } = {}) {
    this.logger.info(`Destroy ${this.constructor.name}`);
    // Clean up keep alive
    if (this.keepAliveInterval != null) {
      clearTimeout(this.keepAliveInterval);
      delete this.keepAliveInterval;
    }
    // Handle destruction concurrently
    const destroyProms: Array<Promise<void>> = [];
    for (const stream of this.streamMap.values()) {
      if (force) {
        destroyProms.push(stream.destroy());
      } else {
        const destroyProm = promise();
        stream.addEventListener('destroy', () => destroyProm.resolveP(), {
          once: true,
        });
        destroyProms.push(destroyProm.p);
      }
    }
    await Promise.all(destroyProms);
    try {
      // If this is already closed, then `Done` will be thrown
      // Otherwise it can send `CONNECTION_CLOSE` frame
      // This can be 0x1c close at the QUIC layer or no errors
      // Or it can be 0x1d for application close with an error
      // Upon receiving a `CONNECTION_CLOSE`, you can send back
      // 1 packet containing a `CONNECTION_CLOSE` frame too
      // (with `NO_ERROR` code if appropriate)
      // It must enter into a draining state, and no other packets can be sent
      this.conn.close(appError, errorCode, Buffer.from(errorMessage));
    } catch (e) {
      if (e.message !== 'Done') {
        this.logger.debug('already closed');
        // No other exceptions are expected
        utils.never();
      }
    }
    // Sending if
    await this.send();
    // If it is not closed, it could still be draining
    this.logger.debug('Waiting for closeP');
    await this.closedP;
    this.logger.debug('closeP resolved');
    this.connectionMap.delete(this.connectionId);
    // Checking if timed out
    if (this.conn.isTimedOut()) {
      this.logger.error('Connection timed out');
      this.dispatchEvent(
        new events.QUICSocketErrorEvent({
          detail: new errors.ErrorQUICConnectionTimeout(),
        }),
      );
    }
    this.dispatchEvent(new events.QUICConnectionDestroyEvent());
    // Clean up timeout if it's still running
    if (this.timer != null) {
      clearTimeout(this.timer);
      delete this.timer;
    }
    this.logger.info(`Destroyed ${this.constructor.name}`);
  }

  /**
   * Called when the socket receives data from the remote side intended for this connection.
   * UDP -> Connection -> Stream
   * This pushes data to the streams.
   * When the connection is draining, we can still receive data.
   * However, no streams are allowed to read or write.
   */
  @ready(new errors.ErrorQUICConnectionDestroyed(), false, ['destroying'])
  public async recv(data: Uint8Array, remoteInfo: RemoteInfo) {
    this.logger.debug('RECV CALLED');
    try {
      // The remote info may have changed on each receive
      // here we update!
      // This still requires testing to see what happens
      this._remoteHost = remoteInfo.host;
      this._remotePort = remoteInfo.port;
      // Used by quiche
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
        this.conn.recv(data, recvInfo);
        this.logger.debug(`RECEIVED ${data.byteLength} of data`);
      } catch (e) {
        this.logger.error(`recv error ${e.message}`);
        // Depending on the exception, the `this.conn.recv`
        // may have automatically started closing the connection
        if (e.message === 'TlsFail') {
          const newError = new errors.ErrorQUICConnectionTLSFailure(undefined, {
            data: {
              localError: this.conn.localError(),
              peerError: this.conn.peerError(),
            },
          });
          this.dispatchEvent(
            new events.QUICConnectionErrorEvent({ detail: newError }),
          );
        } else {
          this.dispatchEvent(
            new events.QUICConnectionErrorEvent({
              detail: new errors.ErrorQUICConnection(e.message, {
                cause: e,
                data: {
                  localError: this.conn.localError(),
                  peerError: this.conn.peerError(),
                },
              }),
            }),
          );
        }
        return;
      }
      this.dispatchEvent(new events.QUICConnectionRecvEvent());
      // Here we can resolve our promises!
      if (this.conn.isEstablished()) {
        this.resolveEstablishedP();
      }
      if (this.conn.isClosed()) {
        if (this.resolveCloseP != null) this.resolveCloseP();
        return;
      }
      if (
        !this.conn.isDraining() &&
        (this.conn.isInEarlyData() || this.conn.isEstablished())
      ) {
        for (const streamId of this.conn.readable() as Iterable<StreamId>) {
          let quicStream = this.streamMap.get(streamId);
          if (quicStream == null) {
            // The creation will set itself to the stream map
            quicStream = await QUICStream.createQUICStream({
              streamId,
              connection: this,
              destroyingMap: this.destroyingMap,
              codeToReason: this.codeToReason,
              reasonToCode: this.reasonToCode,
              maxReadableStreamBytes: this.maxReadableStreamBytes,
              maxWritableStreamBytes: this.maxWritableStreamBytes,
              logger: this.logger.getChild(`${QUICStream.name} ${streamId}`),
            });
            this.dispatchEvent(
              new events.QUICConnectionStreamEvent({ detail: quicStream }),
            );
          }
          quicStream.read();
          quicStream.dispatchEvent(new events.QUICStreamReadableEvent());
        }
        for (const streamId of this.conn.writable() as Iterable<StreamId>) {
          let quicStream = this.streamMap.get(streamId);
          if (quicStream == null) {
            // The creation will set itself to the stream map
            quicStream = await QUICStream.createQUICStream({
              streamId,
              connection: this,
              codeToReason: this.codeToReason,
              reasonToCode: this.reasonToCode,
              destroyingMap: this.destroyingMap,
              maxReadableStreamBytes: this.maxReadableStreamBytes,
              logger: this.logger.getChild(`${QUICStream.name} ${streamId}`),
            });
            this.dispatchEvent(
              new events.QUICConnectionStreamEvent({ detail: quicStream }),
            );
          }
          quicStream.dispatchEvent(new events.QUICStreamWritableEvent());
          quicStream.write();
        }
        // Checking shortlist if streams have finished.
        for (const [streamId, stream] of this.destroyingMap) {
          if (stream.isFinished()) {
            // If it has finished, it will trigger its own clean up.
            // Remove the stream from the shortlist.
            this.destroyingMap.delete(streamId);
          }
        }
      }
    } finally {
      this.logger.debug('RECV FINALLY');
      // Set the timeout
      this.checkTimeout();
      // If this call wasn't executed in the midst of a destroy
      // and yet the connection is closed or is draining, then
      // we need to destroy this connection
      if (
        this[status] !== 'destroying' &&
        (this.conn.isClosed() || this.conn.isDraining())
      ) {
        this.logger.debug('CALLING DESTROY 2');
        // Destroy in the background, we still need to process packets
        void this.destroy();
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
   */
  @ready(new errors.ErrorQUICConnectionDestroyed(), false, ['destroying'])
  public async send(): Promise<void> {
    this.logger.debug('SEND CALLED');
    if (this.conn.isClosed()) {
      if (this.resolveCloseP != null) this.resolveCloseP();
      return;
    } else if (this.conn.isDraining()) {
      return;
    }
    try {
      const sendBuffer = new Uint8Array(quiche.MAX_DATAGRAM_SIZE);
      let sendLength: number;
      let sendInfo: SendInfo;
      while (true) {
        try {
          this.logger.debug('Did a send');
          [sendLength, sendInfo] = this.conn.send(sendBuffer);
        } catch (e) {
          this.logger.debug(`SEND FAILED WITH ${e.message}`);
          if (e.message === 'Done') {
            if (this.conn.isClosed()) {
              this.logger.debug('SEND CLOSED');
              if (this.resolveCloseP != null) this.resolveCloseP();
              return;
            }
            this.logger.debug('SEND IS DONE');
            return;
          }
          this.logger.error('Failed to send, cleaning up');
          try {
            // If the `this.conn.send` failed, then this close
            // may not be able to be sent to the outside
            // It's possible a second call to `this.conn.send` will succeed
            // Otherwise a timeout will occur, which will eventually destroy
            // this connection

            this.conn.close(
              false,
              quiche.ConnectionErrorCode.InternalError,
              Buffer.from('Failed to send data', 'utf-8'), // The message!
            );
          } catch (e) {
            // Only `Done` is possible, no other errors are possible
            if (e.message !== 'Done') {
              utils.never();
            }
          }
          this.dispatchEvent(
            new events.QUICConnectionErrorEvent({
              detail: new errors.ErrorQUICConnection(e.message, {
                cause: e,
                data: {
                  localError: this.conn.localError(),
                  peerError: this.conn.peerError(),
                },
              }),
            }),
          );
          return;
        }
        try {
          this.logger.debug(
            `ATTEMPTING SEND ${sendLength} bytes to ${sendInfo.to.port}:${sendInfo.to.host}`,
          );

          await this.socket.send(
            sendBuffer,
            0,
            sendLength,
            sendInfo.to.port,
            sendInfo.to.host,
          );
          this.logger.info(`SENT ${sendLength} of data`);
        } catch (e) {
          this.logger.error(`send error ${e.message}`);
          this.dispatchEvent(
            new events.QUICConnectionErrorEvent({ detail: e }),
          );
          return;
        }
        this.dispatchEvent(new events.QUICConnectionSendEvent());
      }
    } finally {
      this.logger.debug('SEND FINALLY');
      this.checkTimeout();
      if (
        this[status] !== 'destroying' &&
        (this.conn.isClosed() || this.conn.isDraining())
      ) {
        // Ignore errors and run in background
        void this.destroy().catch(() => {});
      } else if (
        this[status] === 'destroying' &&
        this.conn.isClosed() &&
        this.resolveCloseP != null
      ) {
        // If we flushed the draining, then this is what will happen
        this.resolveCloseP();
      }
    }
  }

  /**
   * Creates a new stream on the connection.
   * Only supports bidi streams atm.
   * This is a serialised call, it must be blocking.
   */
  @ready(new errors.ErrorQUICConnectionDestroyed())
  public async streamNew(streamType: 'bidi' = 'bidi'): Promise<QUICStream> {
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
        destroyingMap: this.destroyingMap,
        maxReadableStreamBytes: this.maxReadableStreamBytes,
        maxWritableStreamBytes: this.maxWritableStreamBytes,
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

  /**
   * Used to update or disable the keep alive interval.
   * Calling this will reset the delay before the next keep alive.
   */
  @ready(new errors.ErrorQUICConnectionDestroyed())
  public setKeepAlive(intervalDelay?: number) {
    // Clearing timeout prior to update
    if (this.keepAliveInterval != null) {
      clearTimeout(this.keepAliveInterval);
      delete this.keepAliveInterval;
    }
    // Setting up keep alive interval
    if (intervalDelay != null) {
      this.keepAliveInterval = setInterval(async () => {
        // Trigger an ping frame and send
        this.conn.sendAckEliciting();
        await this.send();
      }, intervalDelay);
    }
  }

  // Timeout handling, these methods handle time keeping for quiche.
  // Quiche will request an amount of time, We then call `onTimeout()` after that time has passed.
  protected deadline: number = 0;
  protected onTimeout = async () => {
    this.logger.debug('timeout on timeout');
    // Clearing timeout
    clearTimeout(this.timer);
    delete this.timer;
    this.deadline = Infinity;
    // Doing timeout actions
    this.conn.onTimeout();
    if (this[destroyed] === false) await this.send();
    if (
      this[status] !== 'destroying' &&
      (this.conn.isClosed() || this.conn.isDraining())
    ) {
      this.logger.debug('CALLING DESTROY 3');
      // Destroy in the background, we still need to process packets
      void this.destroy();
    }
    this.checkTimeout();
  };
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
  protected checkTimeout = () => {
    this.logger.debug('timeout checking timeout');
    // During construction, this ends up being null
    const time = this.conn.timeout();
    if (time == null) {
      // Clear timeout
      if (this.timer != null) this.logger.debug('timeout clearing timeout');
      clearTimeout(this.timer);
      delete this.timer;
      this.deadline = Infinity;
    } else {
      const newDeadline = Date.now() + time;
      if (this.timer != null) {
        if (time === 0) {
          this.logger.debug('timeout triggering instant timeout');
          // Skip timer and call onTimeout
          setImmediate(this.onTimeout);
        } else if (newDeadline < this.deadline) {
          this.logger.debug(`timeout updating timer with ${time} delay`);
          clearTimeout(this.timer);
          delete this.timer;
          this.deadline = newDeadline;
          this.timer = setTimeout(this.onTimeout, time);
        }
      } else {
        if (time === 0) {
          this.logger.debug('timeout triggering instant timeout');
          // Skip timer and call onTimeout
          setImmediate(this.onTimeout);
          return;
        }
        this.logger.debug(`timeout creating timer with ${time} delay`);
        this.deadline = newDeadline;
        this.timer = setTimeout(this.onTimeout, time);
      }
    }
  };
}

export default QUICConnection;
