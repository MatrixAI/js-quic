import type { Connection } from './native/types';
import * as errors from './errors';
import * as events from './events';

/**
 * Think of this as equivalent to `net.Socket`.
 * Errors here are emitted to the connection only.
 * Not to the server.
 */
class QUICConnection extends EventTarget {

  public connection: Connection;

  /**
   * Called when the server receives data intended for the connection.
   */
  public recv(data, recvInfo) {
    let recvLength;
    try {
      recvLength = this.connection.recv(data, recvInfo);
    } catch (e) {
      this.dispatchEvent(new events.QUICErrorEvent({ detail: e }));
      return;
    }

    // We dispatch events on the connection
    // not on the server anymore


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
  public send() {
    // Call the internal send
    // Then actually send to the socket?
    // ?

  }

}

export default QUICConnection;
