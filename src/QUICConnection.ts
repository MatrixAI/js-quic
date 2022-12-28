import type { Connection, RecvInfo, SendInfo } from './native/types';
import type { ConnectionId, StreamId } from './types';
import QUICStream from './QUICStream';
import { quiche } from './native';
import * as errors from './errors';
import * as events from './events';

/**
 * Think of this as equivalent to `net.Socket`.
 * Errors here are emitted to the connection only.
 * Not to the server.
 */
class QUICConnection extends EventTarget {

  public readonly connectionId: ConnectionId;
  public connection: Connection;
  public connections: Map<ConnectionId, QUICConnection>;
  public streams: Map<StreamId, QUICStream> = new Map();

  protected handleTimeout: () => Promise<void>;

  protected timer?: ReturnType<typeof setTimeout>;

  public constructor({
    connectionId,
    connection,
    connections,
    handleTimeout
  }: {
    connectionId: ConnectionId;
    connection: Connection;
    connections: Map<ConnectionId, QUICConnection>,
    handleTimeout: () => Promise<void>,
  }) {
    super();
    this.connectionId = connectionId;
    this.connection = connection;
    this.connections = connections;
    // do we use `handleTimeout`
    this.handleTimeout = handleTimeout;

    // Setup the timeout timer
    this.setTimeout();

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

  public setTimeout() {
    const time = this.connection.timeout();

    console.log('The time that gets set', time);

    if (time != null) {
      this.timer = setTimeout(
        async () => {
          // Do we call this?
          // If so, we must continue
          this.connection.onTimeout();

          // The server must handle the timeout too!?
          await this.handleTimeout();

          // Do we reset the timeout afterwards?
          // So that the next timeout is called?
          // Could this result in an infinite loop?
          // I'm not sure
          this.setTimeout();

        },
        time
      );
    } else {
      clearTimeout(this.timer);
      delete this.timer;
    }
  }


  /**
   * Called when the server receives data intended for the connection.
   * Do we wait for stream writes to actually be done?
   * Or we go straight to answering?
   * Cause emitting readable/writable events, is running the handlers.
   */
  public recv(data: Uint8Array, recvInfo: RecvInfo) {
    try {
      this.connection.recv(data, recvInfo);
    } catch (e) {
      // The `connection.recv` AUTOMATICALLY
      // calls `connection.close` internally
      // when there's an error
      // So it's possible at this point the connection is already closed
      this.dispatchEvent(new events.QUICConnectionErrorEvent({ detail: e }));
      return;
    }
    // Process all streams
    if (this.connection.isInEarlyData() || this.connection.isEstablished()) {
      // Every time the connection is ready, we are going to create streams
      // and process it accordingly
      for (const streamId of this.connection.writable() as Iterable<StreamId>) {
        let quicStream = this.streams.get(streamId);
        if (quicStream == null) {
          quicStream = new QUICStream({
            streamId,
            connection: this.connection,
            streams: this.streams,
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

      for (const streamId of this.connection.readable() as Iterable<StreamId>) {
        let quicStream = this.streams.get(streamId);
        if (quicStream == null) {
          quicStream = new QUICStream({
            streamId,
            connection: this.connection,
            streams: this.streams
          });
        }
        // We must emit a readable event, otherwise the quic stream
        // will not actually read anything
        quicStream.dispatchEvent(new Event('readable'));
      }
    }
  }

  /**
   * Called when the server has to send back data.
   * This happens on every message, that is even message for other connections.
   * Also for timeout events.
   * There may be no data to send out!
   * It's the server's job to plug this into the UDP socket.
   *
   * Perhaps this is called by `QUICClient` too?
   */
  public send(): [Uint8Array, SendInfo] | undefined {
    const dataSend = new Uint8Array(quiche.MAX_DATAGRAM_SIZE);
    let dataSendLength;
    let sendInfo;
    try {
      [dataSendLength, sendInfo] = this.connection.send(
        dataSend
      );
    } catch (e) {
      if (e.message === 'Done') {
        return;
      }
      // This will run any event handler attached to this
      this.dispatchEvent(new events.QUICConnectionErrorEvent({ detail: e }));
      try {

        // This is currently the only place it closes
        // which means a connection only closes during an error?
        // But that's a bit weird
        // Wait a minute
        // IT IS possible
        // that upon receiving a packet, the connection is closed
        // That's cause the server never "closes"
        // the connection
        // In order to close the connection explicitly from the server side
        // You have tell ALL the streams to shutdown
        // It's not graceful though

        // If we close here...

        this.connection.close(
          false, // Not an application error, was a library error
          0x01,  // Arbitrary error code of 0x01
          Buffer.from('Failed to send data') // The message!
        );
      } catch (e) {
        if (e.message === 'Done') {
          return;
        }
        this.dispatchEvent(new events.QUICConnectionErrorEvent({ detail: e }));
      }
      // This mirrors the TCP net socket behaviour
      this.dispatchEvent(
        new events.QUICConnectionCloseEvent({ detail: true })
      );
      return;
    }
    return [
      dataSend.subarray(0, dataSendLength),
      sendInfo
    ];
    // This is the `send` done for a SINGLE connection
    // But it has to be done for every single connection
    // Only the server has access to this, and it needs
    // to manage this appropriately
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

    // Connection error codes are
    // 0x00: No error
    // 0x01: Internal error
    // 0x02: connectio refused
    // 0x03: flow control error
    // 0x04: stream limit error
    // ... goes on

    // not sure how that is achieved here
    for (const stream of this.streams.values())  {
      await stream.stop();
    }

    // I'm not sure how this really works
    // it doesn't immediately mean the connection is closed
    // need to wireshark to see what is actually being sent
    try {
      this.connection.close(
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

  }

  // An external system has to poll
  // to know when our connection is actually closed
  // Cause closing is lazy
  public isClosed() {
    return this.connection.isClosed();
  }

}

export default QUICConnection;
