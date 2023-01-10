import Logger from '@matrixai/logger';
import type { Config, Connection, RecvInfo, SendInfo } from './native/types';
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

  // protected timer?: ReturnType<typeof setTimeout>;
  // protected handleTimeout: () => Promise<void>;

  public static async connectConnection() {

  }

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

    // do we use `handleTimeout`
    // this.handleTimeout = handleTimeout;
    // Setup the timeout timer
    // this.setTimeout();
    // It's possible that the timer
    // of the connection may change as we query it
    // On each even that is
  }

  // and we should potentally ask aon each timer
  // CHECK if this changes depending on the situation
  // or if it is still the same
  // if not, then 1 timer is enough
  // but it's interestingly that the loop
  // is that the lowest timeout
  // Why does it
  // in the upstream code, it iterates over all connectiosn
  // and calls the `conn.on_timeout()` not just the single connection
  // public timeout(): number | null {
  //   return this.connection.timeout();
  // }

  // public setTimeout() {
  //   const time = this.connection.timeout();

  //   // Turns out this is `null` at the beginning
  //   // So nothing gets set
  //   // Therefore I imagine it must change over time
  //   // We have to poll the library on every event
  //   // To check!
  //   console.log('The time that gets set', time);

  //   if (time != null) {
  //     this.timer = setTimeout(
  //       async () => {
  //         // Do we call this?
  //         // If so, we must continue
  //         this.connection.onTimeout();

  //         // The server must handle the timeout too!?
  //         await this.handleTimeout();

  //         // Do we reset the timeout afterwards?
  //         // So that the next timeout is called?
  //         // Could this result in an infinite loop?
  //         // I'm not sure
  //         this.setTimeout();

  //       },
  //       time
  //     );
  //   } else {
  //     clearTimeout(this.timer);
  //     delete this.timer;
  //   }
  // }


  /**
   * Called when the server receives data intended for the connection.
   * Do we wait for stream writes to actually be done?
   * Or we go straight to answering?
   * Cause emitting readable/writable events, is running the handlers.
   *
   * UDP -> Connection -> Stream
   *
   * This pushes data to the streams.
   */
  public recv(data: Uint8Array, recvInfo: RecvInfo) {
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
  public async send(): Promise<void> {
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
   * An explicit stop closes the streams first, then closes the connections
   */
  public async stop() {
    this.logger.info(`Stopping ${this.constructor.name}`);

    // Connection error codes are
    // 0x00: No error
    // 0x01: Internal error
    // 0x02: connectio refused
    // 0x03: flow control error
    // 0x04: stream limit error
    // ... goes on

    // not sure how that is achieved here
    for (const stream of this.streamMap.values())  {
      await stream.stop();
    }

    // I'm not sure how this really works
    // it doesn't immediately mean the connection is closed
    // need to wireshark to see what is actually being sent
    try {
      this.conn.close(
        true,
        0x00,
        Buffer.from('')
      );
    } catch (e) {
      if (e.message !== 'Done') {
        throw e;
      }
    }

    // do we remove
    // JUST because we close
    // doesn't mean isClosed is true
    // we don't know

    this.logger.info(`Stopped ${this.constructor.name}`);

  }

  // An external system has to poll
  // to know when our connection is actually closed
  // Cause closing is lazy
  public isClosed() {
    return this.conn.isClosed();
  }

}

export default QUICConnection;
