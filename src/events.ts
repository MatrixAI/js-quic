import type QUICConnection from './QUICConnection';
import type QUICStream from './QUICStream';
import { AbstractEvent } from '@matrixai/events';

abstract class EventQUIC<T = null> extends AbstractEvent<T> {}

// Socket events

abstract class EventQUICSocket<T = null> extends EventQUIC<T> {}

class EventQUICSocketStart extends EventQUICSocket {}

class EventQUICSocketStarted extends EventQUICSocket {}

class EventQUICSocketStop extends EventQUICSocket {}

class EventQUICSocketStopped extends EventQUICSocket {}

class EventQUICSocketError extends EventQUICSocket<Error> {}

// Client events

abstract class EventQUICClient<T = null> extends EventQUIC<T> {}

class EventQUICClientDestroy extends EventQUICClient {}

class EventQUICClientError extends EventQUICClient<Error> {}

// Server events

abstract class EventQUICServer<T = null> extends EventQUIC<T> {}

class EventQUICServerConnection extends EventQUICServer<QUICConnection> {}

class EventQUICServerStart extends EventQUICServer {}

class EventQUICServerStarted extends EventQUICServer {}

class EventQUICServerStop extends EventQUICServer {}

class EventQUICServerStopped extends EventQUICServer {}

class EventQUICServerError extends EventQUICServer<Error> {}

// Connection events

abstract class EventQUICConnection<T = null> extends EventQUIC<T> {}

class EventQUICConnectionStream extends EventQUICConnection<QUICStream> {}

class EventQUICConnectionStart extends EventQUICConnection {}

class EventQUICConnectionStarted extends EventQUICConnection {}

class EventQUICConnectionStop extends EventQUICConnection {}

class EventQUICConnectionStopped extends EventQUICConnection<Error | null> {}

// If this represents a terminal state, then we must not emit stop
// Then we would transition to calling `this.stop({ error })
// rather than dispatching at the error
// cause there's no "error state", it is only stopped state
// And in this case stopped with an error!
// Ok so we get rid of `stop` then
class EventQUICConnectionError extends EventQUICConnection<Error> {}

class EventQUICConnectionClosed extends EventQUICConnection {}

// Stream events

abstract class EventQUICStream<T = null> extends EventQUIC<T> {}

class EventQUICStreamDestroy extends EventQUICStream {}

class EventQUICStreamDestroyed extends EventQUICStream {}

export {
  EventQUIC,
  EventQUICSocket,
  EventQUICSocketStart,
  EventQUICSocketStarted,
  EventQUICSocketStop,
  EventQUICSocketStopped,
  EventQUICSocketError,
  EventQUICClient,
  EventQUICClientDestroy,
  EventQUICClientError,
  EventQUICServer,
  EventQUICServerConnection,
  EventQUICServerStart,
  EventQUICServerStarted,
  EventQUICServerStop,
  EventQUICServerStopped,
  EventQUICServerError,
  EventQUICConnection,
  EventQUICConnectionStream,
  EventQUICConnectionStart,
  EventQUICConnectionStarted,
  EventQUICConnectionStop,
  EventQUICConnectionStopped,
  EventQUICConnectionError,
  EventQUICConnectionClosed,
  EventQUICStream,
  EventQUICStreamDestroy,
  EventQUICStreamDestroyed,
};
