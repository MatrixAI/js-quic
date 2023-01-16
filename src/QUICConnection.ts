import type QUICSocket from './QUICSocket';
import type QUICConnectionMap from './QUICConnectionMap';
import type { ConnectionId, StreamId, UDPRemoteInfo } from './types';
import type { Config, Connection, RecvInfo, SendInfo, ConnectionErrorCode } from './native/types';
import {
  CreateDestroy,
  ready,
  status
} from '@matrixai/async-init/dist/CreateDestroy';
import Logger from '@matrixai/logger';
import QUICStream from './QUICStream';
import { quiche } from './native';
import * as events from './events';
import * as utils from './utils';
import * as errors from './errors';

/**
 * Think of this as equivalent to `net.Socket`.
 * Errors here are emitted to the connection only.
 * Not to the server.
 */
interface QUICConnection extends CreateDestroy {}
@CreateDestroy()
class QUICConnection extends EventTarget {

  public readonly connectionId: ConnectionId;
  public readonly type: 'client' | 'server';
  public conn: Connection;
  public connectionMap: QUICConnectionMap;
  public streamMap: Map<StreamId, QUICStream> = new Map();
  protected logger: Logger;
  protected socket: QUICSocket;
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
    logger = new Logger(`${this.name} ${scid.toString('hex')}`),
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
    const connection = new this({
      type: 'server',
      conn,
      connectionId: scid,
      socket,
      logger,
    });
    socket.connectionMap.set(connection.connectionId, connection);
    logger.info(`Created ${this.name}`);
    return connection;
  }

  public constructor({
    type,
    conn,
    connectionId,
    socket,
    logger
  }: {
    type: 'client' | 'server';
    conn: Connection;
    connectionId: ConnectionId;
    socket: QUICSocket;
    logger: Logger;
  }) {
    super();
    this.logger = logger;
    this.type = type;
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
      // If this is already closed, then `Done` will be thrown
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
    // If it is not closed, it could still be draining
    if (!this.conn.isClosed()) {
      // The `recv`, `send`, `timeout`, and `on_timeout` should continue to be called
      const { p: closeP, resolveP: resolveCloseP } = utils.promise();
      this.resolveCloseP = resolveCloseP;
      await Promise.all([
        this.send(),
        closeP
      ]);
    }
    this.connectionMap.delete(this.connectionId);
    this.logger.info(`Destroyed ${this.constructor.name}`);
  }

  /**
   * Called when the server receives data intended for the connection.
   * UDP -> Connection -> Stream
   * This pushes data to the streams.
   * When the connection is draining, we can still receive data.
   * However no streams are allowed to read or write.
   */
  @ready(new errors.ErrorQUICConnectionDestroyed(), false, ['destroying'])
  public async recv(data: Uint8Array, recvInfo: RecvInfo) {
    try {
      if (this.conn.isClosed()) {
        if (this.resolveCloseP != null) this.resolveCloseP();
        return;
      }
      try {
        this.conn.recv(data, recvInfo);
      } catch (e) {
        // Depending on the exception, the `this.conn.recv`
        // may have automatically started closing the connection
        this.dispatchEvent(
          new events.QUICConnectionErrorEvent({ detail: e })
        );
        return;
      }
      if (!this.conn.isDraining() && (this.conn.isInEarlyData() || this.conn.isEstablished())) {
        for (const streamId of this.conn.readable() as Iterable<StreamId>) {
          let quicStream = this.streamMap.get(streamId);
          if (quicStream == null) {
            quicStream = await QUICStream.createStream({
              streamId,
              connection: this,
              logger: this.logger.getChild(`${QUICStream.name} ${streamId}`)
            });
            console.log('NEW STERAM ON READ', streamId);
            this.dispatchEvent(new events.QUICConnectionStreamEvent({ detail: quicStream }));
          }
          // We must emit a readable event, otherwise the quic stream
          // will not actually read anything
          quicStream.dispatchEvent(new events.QUICStreamReadableEvent());
        }
        for (const streamId of this.conn.writable() as Iterable<StreamId>) {
          let quicStream = this.streamMap.get(streamId);
          if (quicStream == null) {
            quicStream = await QUICStream.createStream({
              streamId,
              connection: this,
              logger: this.logger.getChild(`${QUICStream.name} ${streamId}`)
            });
            this.streamMap.set(streamId, quicStream);
            this.dispatchEvent(new events.QUICConnectionStreamEvent({ detail: quicStream }));
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
      }
    } finally {
      // Set the timeout
      this.setTimeout();
      // If this call wasn't executed in the midst of a destroy
      // and yet the connection is closed or is draining, then
      // we need to destroy this connection
      if (
        this[status] !== 'destroying' &&
        this.conn.isClosed() &&
        this.conn.isDraining()
      ) {
        await this.destroy();
      }
    }
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
  @ready(new errors.ErrorQUICConnectionDestroyed(), false, ['destroying'])
  public async send(): Promise<void> {
    try {
      if (this.conn.isClosed()) {
        if (this.resolveCloseP != null) this.resolveCloseP();
        return;
      } else if (this.conn.isDraining()) {
        return;
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
          try {

            // If the `this.conn.send` failed, then this close
            // may not be able to be sent to the outside
            // It's possible a second call to `this.conn.send` will succeed
            // Otherwise a timeout will occur, which will eventually destroy
            // this connection

            this.conn.close(
              false,
              quiche.ConnectionErrorCode.InternalError,
              Buffer.from('Failed to send data', 'utf-8') // The message!
            );
          } catch (e) {
            // Only `Done` is possible, no other errors are possible
            if (e.message !== 'Done') {
              utils.never();
            }
          }
          this.dispatchEvent(new events.QUICConnectionErrorEvent({ detail: e }));
          return;
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
          this.dispatchEvent(new events.QUICConnectionErrorEvent({ detail: e }));
          return;
        }
      }
    } finally {
      this.setTimeout();
      if (
        this[status] !== 'destroying' &&
        this.conn.isClosed() &&
        this.conn.isDraining()
      ) {
        // Wait if this has a lock
        // then you cannot call destroy
        // The read lock WILL block the write lock here
        await this.destroy();
      }
    }
  }

  /**
   * Sets the timeout
   */
  protected setTimeout(): void {
    const time = this.conn.timeout();

    // Does this ever time out?
    console.log('EVER TIMEOUT', time);

    if (time != null) {
      clearTimeout(this.timer);
      this.timer = setTimeout(
        async () => {
          // This would only run if the `recv` and `send` is not called
          // Otherwise this handler would be cleared each time and be reset
          this.conn.onTimeout();
          // Trigger a send, this will also set the timeout again at the end
          await this.send();
        },
        time
      );
    } else {
      clearTimeout(this.timer);
      delete this.timer;
    }
  }
}

export default QUICConnection;
