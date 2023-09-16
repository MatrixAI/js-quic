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

abstract class EventQUIC<T = null> extends AbstractEvent<T> {}

// Socket events

abstract class EventQUICSocket<T = null> extends EventQUIC<T> {}

class EventQUICSocketStart extends EventQUICSocket {}

class EventQUICSocketStarted extends EventQUICSocket {}

class EventQUICSocketStop extends EventQUICSocket {}

class EventQUICSocketStopped extends EventQUICSocket {}

class EventQUICSocketError extends EventQUICSocket<ErrorQUICSocketInternal<unknown>> {}

class EventQUICSocketClose extends EventQUICSocket {}

// Client events

abstract class EventQUICClient<T = null> extends EventQUIC<T> {}

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

abstract class EventQUICServer<T = null> extends EventQUIC<T> {}

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

abstract class EventQUICConnection<T = null> extends EventQUIC<T> {}

class EventQUICConnectionStream extends EventQUICConnection<QUICStream> {}

class EventQUICConnectionStart extends EventQUICConnection {}

class EventQUICConnectionStarted extends EventQUICConnection {}

// These 2 Stop and Stopped is the definitive end of the connection, like "close"
class EventQUICConnectionStop extends EventQUICConnection {}

class EventQUICConnectionStopped extends EventQUICConnection {}

// This is only when there's an error for the connection itself
// It could be a local error, peer error, or recv/send internal error
// This means both inband errors in the connection, and also errors that come from operational procedure
// The error exception class tells us what kind of thing it is
// That way we can have local and peer and internal
// then users can decide how to handle each one
class EventQUICConnectionError extends EventQUICConnection<
  | ErrorQUICConnectionLocal<unknown> // errors that I'm sending to the peer (also due to idle timeout)
  | ErrorQUICConnectionPeer<unknown> // errors that I'm receiving from the peer
  | ErrorQUICConnectionIdleTimeout<unknown>
  | ErrorQUICConnectionInternal<unknown> // other internal errors which means the thing is broken
> {}

// This is when the other side has gracefully closed the connection
// If we gracefully close the connection, this is not emitted
// If we were to do close, that would be confusing, it would have to run all the time
// Since the connection always closes, and it would not be a post-facto event
// End event just means the other side gracefully closed the connection

// To match nodejs, after error event, we can only expect a close event (close in this case means stop and stopped)
// alternatively, we can do something like a closed event
// What if we do it like this instead?
// Thus we can have a error, and a local close - well the eror usually means close is happening
// EventQUICConnectionLocalClose
// EventQUICConnectionPeerClose

// This does not happen, we use the close
// And users can determine what to do
// class EventQUICConnectionEnd extends EventQUICConnection<ConnectionError> {}


// Matching up with nodejs

// error event is the same as error -> close
// end is the same as end for graceful end with 0 -> close
// close event is the same as Stop/Stopped

// If this is a graceful close or non-graceful close, either way
// it is closing... how should you know if it is a peer or not?
// Well i guess it depends on the close error
// and also it would be easier to have close and just distinguish between them
// On the other hand, this represents specifically the inband code
// An error above always translates to us closing here
// UNLESS... the above is an internal error that prevents us from closing
// But we usually let that bubble up... and we don't capture that in our event model
// Then on close we have connection error
// This is the possible events then (note that if  stop close stopped also had an error)
// STOP -> ERROR -> CLOSE -> STOPPED
// ERROR -> CLOSE -> STOP -> STOPPED
// The `ConnectionError` does not exist when the connection is timed out
// And no connection close frame is sent
class EventQUICConnectionClose extends EventQUICConnection<
  { type: 'local' | 'peer' } & ConnectionError
  |
  { type: 'timeout' }
> {}
// if the peer connection failed, it's neither one or the other
// we have to state `timeout`


// Stream events

abstract class EventQUICStream<T = null> extends EventQUIC<T> {}

class EventQUICStreamDestroy extends EventQUICStream {}

class EventQUICStreamDestroyed extends EventQUICStream {}

// Note that you can close the readable side, and give a code
// You can close the writable side, and give a code
// Neither of which represents an "error" for the quic stream error?
// Or does it?
// Because one could argue either way, and then have a way to separate
// Intenral errors from non-internal errors

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
  // offset: number;
  // length: number;
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
