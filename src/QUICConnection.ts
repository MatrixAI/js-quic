import type { Connection, RecvInfo, SendInfo } from './native/types';
import type { StreamId } from './types';
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

  public connection: Connection;
  protected streams: Map<StreamId, QUICStream> = new Map();

  public constructor(connection: Connection) {
    super();
    this.connection = connection;
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
          quicStream = new QUICStream(
            this.connection,
            streamId
          );
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
          quicStream = new QUICStream(this.connection, streamId);
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

}

export default QUICConnection;
