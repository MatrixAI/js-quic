import type QUICConnection from './QUICConnection';
import type QUICStream from './QUICStream';
import type {
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
  ErrorQUICSocketInternal<unknown> | undefined
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
  | ErrorQUICClientSocketNotRunning<unknown>
  | ErrorQUICClientInternal<unknown>
  | ErrorQUICConnectionLocal<unknown>
  | ErrorQUICConnectionPeer<unknown>
  | ErrorQUICConnectionIdleTimeout<unknown>
  | ErrorQUICConnectionInternal<unknown>
> {}

class EventQUICClientClose extends EventQUICClient<
  | ErrorQUICClientSocketNotRunning<unknown>
  | ErrorQUICConnectionLocal<unknown>
  | ErrorQUICConnectionPeer<unknown>
  | ErrorQUICConnectionIdleTimeout<unknown>
> {}

// Server events

abstract class EventQUICServer<T = undefined> extends EventQUIC<T> {}

class EventQUICServerConnection extends EventQUICServer<QUICConnection> {}

class EventQUICServerStart extends EventQUICServer {}

class EventQUICServerStarted extends EventQUICServer {}

class EventQUICServerStop extends EventQUICServer {}

class EventQUICServerStopped extends EventQUICServer {}

class EventQUICServerError extends EventQUICServer<
  ErrorQUICServerSocketNotRunning<unknown> | ErrorQUICServerInternal<unknown>
> {}

class EventQUICServerClose extends EventQUICServer<
  ErrorQUICServerSocketNotRunning<unknown> | undefined
> {}

// Connection events

abstract class EventQUICConnection<T = undefined> extends EventQUIC<T> {}

class EventQUICConnectionStart extends EventQUICConnection {}

class EventQUICConnectionStarted extends EventQUICConnection {}

class EventQUICConnectionStop extends EventQUICConnection {}

class EventQUICConnectionStopped extends EventQUICConnection {}

/**
 * Closing a quic connection is always an error no matter if it is graceful or
 * not. This is due to the utilisation of the error code and reason during
 * connection close. Additionally it is also possible that that the QUIC
 * connection times out. In this case, quiche does will not send a
 * `CONNECTION_CLOSE` frame.
 */
class EventQUICConnectionError extends EventQUICConnection<
  | ErrorQUICConnectionLocal<unknown>
  | ErrorQUICConnectionPeer<unknown>
  | ErrorQUICConnectionIdleTimeout<unknown>
  | ErrorQUICConnectionInternal<unknown>
> {}

class EventQUICConnectionClose extends EventQUICConnection<
  | ErrorQUICConnectionLocal<unknown>
  | ErrorQUICConnectionPeer<unknown>
  | ErrorQUICConnectionIdleTimeout<unknown>
> {}

class EventQUICConnectionStream extends EventQUICConnection<QUICStream> {}

class EventQUICConnectionSend extends EventQUICConnection<{
  msg: Uint8Array;
  port: number;
  address: string;
}> {}

// Stream events

abstract class EventQUICStream<T = undefined> extends EventQUIC<T> {}

class EventQUICStreamDestroy extends EventQUICStream {}

class EventQUICStreamDestroyed extends EventQUICStream {}

/**
 * Gracefully closing a QUIC stream does not require an error event.
 */
class EventQUICStreamError extends EventQUICStream<
  | ErrorQUICStreamLocalRead<unknown>
  | ErrorQUICStreamLocalWrite<unknown>
  | ErrorQUICStreamPeerRead<unknown>
  | ErrorQUICStreamPeerWrite<unknown>
  | ErrorQUICStreamInternal<unknown>
> {}

/**
 * QUIC stream readable side is closed.
 *
 * `ErrorQUICStreamLocalRead` - readable side cancelled locally with code.
 * `ErrorQUICStreamPeerRead` - readable side cancelled by peer aborting the
 *                             remote writable side.
 * `undefined` - readable side closed gracefully.
 */
class EventQUICStreamCloseRead extends EventQUICStream<
  | ErrorQUICStreamLocalRead<unknown>
  | ErrorQUICStreamPeerRead<unknown>
  | undefined
> {}

/**
 * QUIC stream writable side is closed.
 *
 * `ErrorQUICStreamLocalWrite` - writable side aborted locally with code.
 * `ErrorQUICStreamPeerWrite` - writable side aborted by peer cancelling the
 *                             remote readable side.
 * `undefined` - writable side closed gracefully.
 */
class EventQUICStreamCloseWrite extends EventQUICStream<
  | ErrorQUICStreamLocalWrite<unknown>
  | ErrorQUICStreamPeerWrite<unknown>
  | undefined
> {}

class EventQUICStreamSend extends EventQUICStream {}

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
  EventQUICServerError,
  EventQUICServerClose,
  EventQUICServerConnection,
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
