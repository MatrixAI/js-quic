import type QUICConnection from './QUICConnection';
import type QUICStream from './QUICStream';
import {
  ErrorQUICConnectionLocal,
  ErrorQUICConnectionPeer,
  ErrorQUICConnectionInternal,
  ErrorQUICStreamLocalRead,
  ErrorQUICStreamLocalWrite,
  ErrorQUICStreamPeerRead,
  ErrorQUICStreamPeerWrite,
  ErrorQUICStreamInternal,
  ErrorQUICConnectionIdleTimeout,
  ErrorQUICSocketInternal,
  ErrorQUICServerInternal,
  ErrorQUICServerSocketNotRunning,
  ErrorQUICClientSocketNotRunning,
  ErrorQUICClientInternal,
} from './errors';
import type { ConnectionError } from './native';
import { AbstractEvent } from '@matrixai/events';

abstract class EventQUIC<T = undefined> extends AbstractEvent<T> {}

// Socket events

abstract class EventQUICSocket<T = undefined> extends EventQUIC<T> {}

class EventQUICSocketStart extends EventQUICSocket {}

class EventQUICSocketStarted extends EventQUICSocket {}

class EventQUICSocketStop extends EventQUICSocket {}

class EventQUICSocketStopped extends EventQUICSocket {}

class EventQUICSocketError extends EventQUICSocket<
  ErrorQUICSocketInternal<unknown>
> {}

class EventQUICSocketClose extends EventQUICSocket<
  | ErrorQUICSocketInternal<unknown>
  | undefined
> {}

// Client events

abstract class EventQUICClient<T = undefined> extends EventQUIC<T> {}

class EventQUICClientDestroy extends EventQUICClient {}

class EventQUICClientDestroyed extends EventQUICClient {}

/**
 * All `EventQUICConnectionError` errors is also `EventQUICClient` errors.
 * This is because `QUICClient` is 1 to 1 to `QUICConnection`.
 * It's thin wrapper around it.
 */
class EventQUICClientError extends EventQUICClient<
  | ErrorQUICClientInternal<unknown>
  | ErrorQUICClientSocketNotRunning<unknown>
  | ErrorQUICConnectionLocal<unknown>
  | ErrorQUICConnectionPeer<unknown>
  | ErrorQUICConnectionIdleTimeout<unknown>
  | ErrorQUICConnectionInternal<unknown>
> {}

class EventQUICClientClose extends EventQUICClient {}

// Server events

abstract class EventQUICServer<T = undefined> extends EventQUIC<T> {}

class EventQUICServerConnection extends EventQUICServer<QUICConnection> {}

class EventQUICServerStart extends EventQUICServer {}

class EventQUICServerStarted extends EventQUICServer {}

class EventQUICServerStop extends EventQUICServer {}

class EventQUICServerStopped extends EventQUICServer {}

class EventQUICServerError extends EventQUICServer<
  | ErrorQUICServerInternal<unknown>
  | ErrorQUICServerSocketNotRunning<unknown>
> {}

class EventQUICServerClose extends EventQUICServer {}

// Connection events

abstract class EventQUICConnection<T = undefined> extends EventQUIC<T> {}

class EventQUICConnectionStart extends EventQUICConnection {}

class EventQUICConnectionStarted extends EventQUICConnection {}

class EventQUICConnectionStop extends EventQUICConnection {}

class EventQUICConnectionStopped extends EventQUICConnection {}

/**
 * Closing a quic connection is always an error no matter if it is graceful or not.
 * This is due to the utilisation of the error code and error message during connection close.
 * Additionally it is also possible that that the QUIC connection times out. In this case,
 * quiche does not send a `CONNECTION_CLOSE` frame. That is a timeout error.
 */
class EventQUICConnectionError extends EventQUICConnection<
  | ErrorQUICConnectionLocal<unknown>
  | ErrorQUICConnectionPeer<unknown>
  | ErrorQUICConnectionIdleTimeout<unknown>
  | ErrorQUICConnectionInternal<unknown>
> {}

/**
 * Once a connection is closing, this event is dispatched.
 * For `QUICConnection` the connection cannot close without a preceding
 * error event. Therefore all exceptions are passed through here.
 * Note that in the circumstance of `ErrorQUICConnectionInternal` it should
 * be expected that the underlying `quiche` connection is broken.
 * If so, then a close here will still try to close the `QUICConnection`.
 */
class EventQUICConnectionClose extends EventQUICConnection<
  | ErrorQUICConnectionLocal<unknown>
  | ErrorQUICConnectionPeer<unknown>
  | ErrorQUICConnectionIdleTimeout<unknown>
> {}

/**
 * When a QUICStream is created, it is ready to be used.
 */
class EventQUICConnectionStream extends EventQUICConnection<QUICStream> {}

// Stream events

abstract class EventQUICStream<T = undefined> extends EventQUIC<T> {}

class EventQUICStreamDestroy extends EventQUICStream {}

class EventQUICStreamDestroyed extends EventQUICStream {}

/**
 * QUIC stream encountered an error.
 * Unlike QUICConnection, you can just have graceful close without any error event at all.
 * This is because streams can just be finished with no code.
 * But QUICConnection closure always comes with some error code and reason, even if the code is 0.
 */
class EventQUICStreamError extends EventQUICStream<
  | ErrorQUICStreamLocalRead<unknown> // I may send out errors on both stop sending (shutdown read) and reset stream (shutdown write)
  | ErrorQUICStreamLocalWrite<unknown> // I may send out errors on both stop sending (shutdown read) and reset stream (shutdown write)
  | ErrorQUICStreamPeerRead<unknown> // I may receive errors on both stop sending (shutdown read) and reset stream (shutdown write)
  | ErrorQUICStreamPeerWrite<unknown> // I may receive errors on both stop sending (shutdown read) and reset stream (shutdown write)
  | ErrorQUICStreamInternal<unknown>
> {}

/**
 * QUIC stream readable side was closed
 * Local means I closed my readable side - there must be an error code.
 * Peer means the peer closed my readable side by closing their writable side - there may not be an error code.
 * If no code, it means it was graceful.
 */
class EventQUICStreamCloseRead extends EventQUICStream<{
  type: 'local';
  code: number;
} | {
  type: 'peer';
  code?: number;
}> {}

/**
 * QUIC stream writable side was closed
 * Local means I closed my writable side - there may not be an error code.
 * Peer means the peer closed my writable side by closing their readable side - there must be an error code.
 * If no code, it means it was graceful.
 */
class EventQUICStreamCloseWrite extends EventQUICStream<{
  type: 'local';
  code?: number;
} | {
  type: 'peer';
  code: number;
}> {}

/**
 * This means there is data enqueued on the stream buffer to be sent.
 * The `QUICConnection` needs to listen on this event to know when to send data.
 * Also includes `EventQUICStreamCloseRead` event
 * And `EventQUICStreamCloseWrite` event
 * All 3 events means that there is data on the stream buffer to be sent.
 * Honestly you could just use this, and dispatch it again.
 */
class EventQUICStreamSend extends EventQUICStream {}

/**
 * This means there's data to be sent from the quic connection
 * This means scheduling something to the QUICSocket.send
 * We would want to schedule the details of the call here
 *
 * Remember this means the `this.socket.send` is then called in
 * QUICServer or QUICClient, and is therefore completely async
 * In relation to the while loop. Because multiple calls to this
 * can be scheduled. It means it can be scheduled up before being
 * flushed. There's no guarantee the other side received it.
 * That's fine though. Errors are then managed by QUICServer
 * or QUICClient
 */
class EventQUICConnectionSend extends EventQUICConnection<{
  msg: Uint8Array;
  port: number;
  address: string;
}> {}

export {
  EventQUIC,
  EventQUICSocket,
  EventQUICSocketStart,
  EventQUICSocketStarted,
  EventQUICSocketStop,
  EventQUICSocketStopped,
  EventQUICSocketError,
  EventQUICSocketClose,

  EventQUICClient,
  EventQUICClientDestroy,
  EventQUICClientDestroyed,
  EventQUICClientError,
  EventQUICClientClose,

  EventQUICServer,
  EventQUICServerStart,
  EventQUICServerStarted,
  EventQUICServerStop,
  EventQUICServerStopped,
  EventQUICServerConnection,
  EventQUICServerError,
  EventQUICServerClose,

  EventQUICConnection,
  EventQUICConnectionStart,
  EventQUICConnectionStarted,
  EventQUICConnectionStop,
  EventQUICConnectionStopped,
  EventQUICConnectionError,
  EventQUICConnectionClose,
  EventQUICConnectionStream,

  EventQUICConnectionSend,

  EventQUICStream,
  EventQUICStreamDestroy,
  EventQUICStreamDestroyed,
  EventQUICStreamError,
  EventQUICStreamCloseRead,
  EventQUICStreamCloseWrite,

  EventQUICStreamSend,

};
