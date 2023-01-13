import Logger from '@matrixai/logger';
import type { Config, Connection, RecvInfo, SendInfo, ConnectionErrorCode } from './native/types';
import type { ConnectionId, ConnectionIdString, QUICConnectionMap, StreamId, UDPRemoteInfo } from './types';
import QUICStream from './QUICStream';
import { quiche } from './native';
import * as errors from './errors';
import * as events from './events';
import {
  CreateDestroy,
  ready,
} from '@matrixai/async-init/dist/CreateDestroy';
import type QUICSocket from './QUICSocket';
import * as utils from './utils';

/**
 * Think of this as equivalent to `net.Socket`.
 * Errors here are emitted to the connection only.
 * Not to the server.
 */
interface QUICConnection extends CreateDestroy {}
@CreateDestroy()
class QUICConnection extends EventTarget {

  public readonly connectionId: ConnectionId;
  public conn: Connection;
  public connectionMap: QUICConnectionMap;
  public streamMap: Map<StreamId, QUICStream> = new Map();
  protected socket: QUICSocket;
  protected logger: Logger;
  protected timer?: ReturnType<typeof setTimeout>;
  protected resolveCloseP?: () => void;

  /**
   * Create QUICConnection by connecting to a server
   */
  public static async connectConnection() {

  }

  /**
   * Create QUICConnection by accepting a client
   */
  public static async acceptConnection({
    scid,
    dcid,
    socket,
    rinfo,
    config,
    logger = new Logger(this.name),
  }: {
    scid: ConnectionId;
    dcid: ConnectionId;
    socket: QUICSocket;
    rinfo: UDPRemoteInfo;
    config: Config;
    logger?: Logger;
  }) {
    logger.info(`Creating ${this.name}`);
    const conn = quiche.Connection.accept(
      scid,
      dcid,
      {
        host: socket.host,
        port: socket.port,
      },
      {
        host: rinfo.address,
        port: rinfo.port,
      },
      config
    );
    const quicConnection = new this({
      conn,
      connectionId: scid,
      socket,
      logger,
    });
    logger.info(`Constructing ${this.name}`);
    return quicConnection;
  }

  /**
   * Call this when the timeout expires
   */
  protected handleTimeout = async () => {
    this.conn.onTimeout();
    // Must call send afterwards
    await this.send();

    // The `send` should check if it is closed
    // The `recv` should check if it is closed
  };


  public constructor({
    conn,
    connectionId,
    // handleTimeout,
    socket,
    logger
  }: {
    conn: Connection;
    connectionId: ConnectionId;
    socket: QUICSocket;
    logger: Logger;
  }) {
    super();
    this.logger = logger;
    this.conn = conn;
    this.connectionId = connectionId;
    this.connectionMap = socket.connectionMap;
    this.socket = socket;
    // Sets the timeout on the first
    this.setTimeout();
  }

  /**
   * This provides the ability to destroy with a specific error
   */
  public async destroy(
    {
      appError = false,
      errorCode = quiche.ConnectionErrorCode.NoError,
      errorMessage = '',
    }: {
      appError?: boolean;
      errorCode?: ConnectionErrorCode;
      errorMessage?: string;
    } = {}
  ) {
    this.logger.info(`Destroying ${this.constructor.name}`);
    for (const stream of this.streamMap.values())  {
      await stream.destroy();
    }
    try {
      this.conn.close(
        appError,
        errorCode,
        Buffer.from(errorMessage)
      );
    } catch (e) {
      if (e.message !== 'Done') {
        // No other exceptions are expected
        utils.never();
      }
    }
    if (!this.conn.isClosed()) {
      // The `recv`, `send`, `timeout`, and `on_timeout` should continue to be called
      const { p: closeP, resolveP: resolveCloseP } = utils.promise();
      this.resolveCloseP = resolveCloseP;
      await closeP;
    }
    this.connectionMap.delete(
      utils.encodeConnectionId(this.connectionId)
    );
    this.logger.info(`Stopped ${this.constructor.name}`);
  }

  /**
   * Called when the server receives data intended for the connection.
   * Do we wait for stream writes to actually be done?
   * Or we go straight to answering?
   * Cause emitting readable/writable events, is running the handlers.
   *
   * UDP -> Connection -> Stream
   *
   * This pushes data to the streams.
   *
   * This blocks other calls, specifically other `recv` and `send` calls.
   * It also is allowed to be called while in `destroying` status.
   * This is because `destroying` will be waiting for the closing.
   *
   * These are the 2 entry points into connection.
   */
  @ready(new errors.ErrorQUICConnectionDestroyed(), true, ['destroying'])
  public recv(data: Uint8Array, recvInfo: RecvInfo) {

    if (this.conn.isDraining()) {
      // If this is true, then we no longer call `send`

    } else if (this.conn.isClosed()) {
      // If this true, then that means we are truly closed
      if (this.resolveCloseP != null) this.resolveCloseP();
    }

    try {
      this.conn.recv(data, recvInfo);
    } catch (e) {
      // The `connection.recv` AUTOMATICALLY
      // calls `connection.close` internally
      // when there's an error
      // So it's possible at this point the connection is already closed
      // this.dispatchEvent(new events.QUICConnectionErrorEvent({ detail: e }));
      // return;
      throw e;
    }
    // Process all streams
    if (this.conn.isInEarlyData() || this.conn.isEstablished()) {

      this.logger.debug(`Connection is in early data or is established`);

      // Every time the connection is ready, we are going to create streams
      // and process it accordingly
      for (const streamId of this.conn.writable() as Iterable<StreamId>) {
        let quicStream = this.streamMap.get(streamId);
        if (quicStream == null) {
          quicStream = new QUICStream({
            streamId,
            connection: this,
          });
        }
        // This triggers a writable event
        // If nothing is listening on this
        // The event is discarded
        // But when the stream is first created
        // It will be ready to be written to
        // But if it is blocked it will wait
        // for the next writable event
        // This event won't be it...
        // So it's only useful for existing streams
        quicStream.dispatchEvent(
          new events.QUICStreamWritableEvent()
        );
      }

      for (const streamId of this.conn.readable() as Iterable<StreamId>) {
        let quicStream = this.streamMap.get(streamId);
        if (quicStream == null) {
          quicStream = new QUICStream({
            streamId,
            connection: this,
          });
        }
        // We must emit a readable event, otherwise the quic stream
        // will not actually read anything
        quicStream.dispatchEvent(new events.QUICStreamReadableEvent());
      }
    }

    // Why disptach evnet?
    // Why not just directly call a function
    // It's the same idea

    this.logger.debug('Received QUIC packet data');
  }

  /**
   * Called when the server has to send back data.
   * This is better understood as "flushing" the connection send buffer.
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
  @ready(new errors.ErrorQUICConnectionDestroyed(), true, ['destroying'])
  public async send(): Promise<void> {

    // If an event occurs
    // We know that we are going to call `send`
    // Cause the timer has expired
    // If so

    if (this.conn.isDraining()) {
      // If this is true, then we no longer call `send`
      // But we have to still continue to wait

    } else if (this.conn.isClosed()) {
      // If this true, then that means we are truly closed
      // At this point we don't call `send`
      // But we resolve the destruction promise if any
      if (this.resolveCloseP != null) this.resolveCloseP();
    }

    const sendBuffer = new Uint8Array(quiche.MAX_DATAGRAM_SIZE);
    let sendLength: number;
    let sendInfo: SendInfo;
    while (true) {
      try {
        [sendLength, sendInfo] = this.conn.send(sendBuffer);
      } catch (e) {
        if (e.message === 'Done') {
          return;
        }
        // this.dispatchEvent(new events.QUICEvent('error', { detail: e }));
        try {
          // The connection will not close immediately
          this.conn.close(
            false, // Not an application error, was a library error
            0x01,  // Arbitrary error code of 0x01
            Buffer.from('Failed to send data', 'utf-8') // The message!
          );
        } catch (e) {
          // Only `Done` is possible, no other errors are possible
          // this means the connection is already closed
          if (e.message !== 'Done') {
            utils.never();
          }
        }

        throw e;
        // return;
      }
      try {
        await this.socket.send(
          sendBuffer,
          0,
          sendLength,
          sendInfo.to.port,
          sendInfo.to.host
        );
      } catch (e) {
        throw e;

        // this.dispatchEvent(new events.QUICEvent('error', { detail: e }));
        // return;
      }
    }
  }

  // A connection can be closed manually
  // or it could be closed through an error
  // on the example it cycles through everything,
  // that it cycles through all connections to know if something must be sent
  // Maybe it just cycles through and figures out whichever one is properly closed
  // Also if a conneci


  /**
   * Sets the timeout
   */
  protected setTimeout(): void {
    const time = this.conn.timeout();
    if (time != null) {
      this.timer = setTimeout(
        async () => {
          this.setTimeout();
          return this.handleTimeout();
        },
        time
      );
    } else {
      clearTimeout(this.timer);
      delete this.timer;
    }
  }

  protected pollConn() {

    this.setTimeout();
    if (this.conn.isDraining()) {
      // If this is true, then we no longer call `send`
      // But we have to still continue to wait

    } else if (this.conn.isClosed()) {
      // If this true, then that means we are truly closed
      // At this point we don't call `send`
      // But we resolve the destruction promise if any
      if (this.resolveCloseP != null) this.resolveCloseP();
    } else if (this.conn.isTimedOut()) {
      // What does this mean?

    }

  }

  // An external system has to poll
  // to know when our connection is actually closed
  // Cause closing is lazy
  public isClosed() {
    return this.conn.isClosed();
  }

}

export default QUICConnection;
