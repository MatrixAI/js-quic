import type QUICSocket from './QUICSocket';
import type QUICConnectionMap from './QUICConnectionMap';
import type QUICConnectionId from './QUICConnectionId';
import type { Host, ConnectionId, Port, StreamId, RemoteInfo } from './types';
import type { Config, Connection, SendInfo, ConnectionErrorCode } from './native/types';
import {
  CreateDestroy,
  ready,
  status
} from '@matrixai/async-init/dist/CreateDestroy';
import Logger from '@matrixai/logger';
import { Lock } from '@matrixai/async-locks';
import QUICStream from './QUICStream';
import { quiche } from './native';
import * as events from './events';
import * as utils from './utils';
import * as errors from './errors';

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

  protected logger: Logger;
  protected socket: QUICSocket;
  protected timer?: ReturnType<typeof setTimeout>;
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
    logger = new Logger(`${this.name} ${scid}`),
  }: {
    scid: QUICConnectionId;
    socket: QUICSocket;
    remoteInfo: RemoteInfo;
    config: Config;
    logger?: Logger;
  }) {
    logger.info(`Connect ${this.name}`);
    const conn = quiche.Connection.connect(
      null,
      scid,
      {
        host: socket.host,
        port: socket.port
      },
      {
        host: remoteInfo.host,
        port: remoteInfo.port,
      },
      config
    );
    const connection = new this({
      type: 'client',
      conn,
      connectionId: scid,
      socket,
      remoteInfo,
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
    logger = new Logger(`${this.name} ${scid}`),
  }: {
    scid: QUICConnectionId;
    dcid: QUICConnectionId;
    socket: QUICSocket;
    remoteInfo: RemoteInfo;
    config: Config;
    logger?: Logger;
  }): Promise<QUICConnection> {
    logger.info(`Accept ${this.name}`);
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
      config
    );
    const connection = new this({
      type: 'server',
      conn,
      connectionId: scid,
      socket,
      remoteInfo,
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
    logger
  }: {
    type: 'client' | 'server';
    conn: Connection;
    connectionId: QUICConnectionId;
    socket: QUICSocket;
    remoteInfo: RemoteInfo;
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
    console.log('CONSTRUCTION');
    // Sets the timeout on the first
    this.setTimeout();
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
    this.logger.info(`Destroy ${this.constructor.name}`);
    for (const stream of this.streamMap.values())  {
      await stream.destroy();
    }
    try {
      // If this is already closed, then `Done` will be thrown
      // Otherwise it can send `CONNECTION_CLOSE` frame
      // This can be 0x1c close at the QUIC layer or no errors
      // Or it can be 0x1d for application close with an error
      // Upon receiving a `CONNECTION_CLOSE`, you can send back
      // 1 packet containing a `CONNECTION_CLOSE` frame too
      // (with `NO_ERROR` code if appropriate)
      // It must enter into a draining state, and no other packets can be sent
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
    this.dispatchEvent(new events.QUICConnectionDestroyEvent());
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
  public async recv(data: Uint8Array, remoteInfo: RemoteInfo) {
    try {
      if (this.conn.isClosed()) {
        if (this.resolveCloseP != null) this.resolveCloseP();
        return;
      }
      // The remote info may have changed on each receive
      // here we update!
      // This still requires testing to see what happens
      this._remoteHost = remoteInfo.host;
      this._remotePort = remoteInfo.port;
      // Used by quiche
      const recvInfo = {
        to: {
          host: this.localHost,
          port: this.localPort
        },
        from: {
          host: remoteInfo.host,
          port: remoteInfo.port
        },
      };
      try {
        // console.log('Did a recv', data.byteLength);
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
            // The creation will set itself to the stream map
            quicStream = await QUICStream.createQUICStream({
              streamId,
              connection: this,
              logger: this.logger.getChild(`${QUICStream.name} ${streamId}`)
            });
            this.dispatchEvent(new events.QUICConnectionStreamEvent({ detail: quicStream }));
          }
          quicStream.read();
        }
        for (const streamId of this.conn.writable() as Iterable<StreamId>) {
          let quicStream = this.streamMap.get(streamId);
          if (quicStream == null) {
            // The creation will set itself to the stream map
            quicStream = await QUICStream.createQUICStream({
              streamId,
              connection: this,
              logger: this.logger.getChild(`${QUICStream.name} ${streamId}`)
            });
            this.dispatchEvent(new events.QUICConnectionStreamEvent({ detail: quicStream }));
          }
          quicStream.write();
        }
      }
    } finally {

      // console.log('RECV FINALLY');

      // Set the timeout
      this.setTimeout();
      // If this call wasn't executed in the midst of a destroy
      // and yet the connection is closed or is draining, then
      // we need to destroy this connection
      if (
        this[status] !== 'destroying' &&
        (
          this.conn.isClosed() ||
          this.conn.isDraining()
        )
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

        // console.log('I AM RESOLVING THE CLOSE');

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
          // console.log('Did a send');
          [sendLength, sendInfo] = this.conn.send(sendBuffer);
        } catch (e) {
          if (e.message === 'Done') {
            // console.log('SEND IS DONE');
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

      // console.log('SEND FINALLY');

      this.setTimeout();
      if (
        this[status] !== 'destroying' &&
        (this.conn.isClosed() || this.conn.isDraining())
      ) {
        await this.destroy();
      } else if (
        this[status] === 'destroying' &&
        (this.conn.isClosed() && this.resolveCloseP != null)
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
        logger: this.logger.getChild(`${QUICStream.name} ${streamId!}`),
      });
      const writer = quicStream.writable.getWriter();

      try {
        // This will now wait until the 0-length buffer is actually sent
        await writer.write(new Uint8Array(0));
        writer.releaseLock();
      } catch (e) {
        // You must release the lock even before you run destroy
        writer.releaseLock();
        // If the write failed, it will only close the sending side
        // But in this case, it means we actually failed to open the stream entirely
        // In which case we destroy the stream
        // Do we need to release the writer?
        await quicStream.destroy();
        throw e;
      }
      // Ok the stream is opened and working
      if (this.type === 'client' && streamType === 'bidi') {
        this.streamIdClientBidi = this.streamIdClientBidi + 4 as StreamId;
      } else if (this.type === 'server' && streamType === 'bidi') {
        this.streamIdServerBidi = this.streamIdServerBidi + 4 as StreamId;
      }
      return quicStream;
    });
  }

  /**
   * Sets the timeout
   */
  protected setTimeout(): void {
    // console.group('setTimeout');
    // During construction, this ends up being null
    const time = this.conn.timeout();

    // On the receive
    // this is called again
    // the result is 5000 ms
    // So after 5 seconds there is supposed to be a timeout

    // After the send is called
    // the time given becomes 1 second
    // Why did it reduce to 1000 ms?

    // console.log('Time given:', time);

    // console.log('IS DRAINING', this.conn.isDraining());

    // Do note there is a change in one of our methods
    // I think I remember, we still need to change over to that
    // To enusre that exceptions mean `Done`
    // console.log('PATH STATS', this.conn.pathStats());

    if (time != null) {
      // console.log('Resetting the timeout');

      clearTimeout(this.timer);
      this.timer = setTimeout(
        async () => {

          // console.log('TIMEOUT HANDLER CALLED');
          // console.log('draining', this.conn.isDraining());
          // console.log('closed', this.conn.isClosed());
          // console.log('timed out', this.conn.isTimedOut());
          // console.log('established', this.conn.isEstablished());
          // console.log('in early data', this.conn.isInEarlyData());
          // console.log('resumed', this.conn.isResumed());

          // This would only run if the `recv` and `send` is not called
          // Otherwise this handler would be cleared each time and be reset
          this.conn.onTimeout();

          // console.log('AFTER ON TIMEOUT');
          // DRAINING IS FALSE
          // console.log('draining', this.conn.isDraining());
          // CLOSED IS TRUE
          // console.log('closed', this.conn.isClosed());
          // TIMEDOUT IS TRUE
          // console.log('timed out', this.conn.isTimedOut());
          // console.log('established', this.conn.isEstablished());
          // console.log('in early data', this.conn.isInEarlyData());
          // console.log('resumed', this.conn.isResumed());

          // Trigger a send, this will also set the timeout again at the end
          await this.send();
        },
        time
      );
    } else {

      // console.log('Clearing the timeout');

      clearTimeout(this.timer);
      delete this.timer;
    }

    // console.groupEnd();
  }
}

export default QUICConnection;
