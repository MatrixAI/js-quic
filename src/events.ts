import type {
  ErrorQUICConnectionLocal,
  ErrorQUICConnectionPeer,
  ErrorQUICConnectionInternal,
  ErrorQUICConnectionIdleTimeout,
  ErrorQUICServerInternal,
  ErrorQUICServerSocketNotRunning,
  ErrorQUICClientSocketNotRunning,
  ErrorQUICClientInternal,
} from './errors.js';
import { AbstractEvent } from '@matrixai/events';

abstract class EventQUIC<T = undefined> extends AbstractEvent<T> {}

// Socket events

abstract class EventQUICSocket<T = undefined> extends EventQUIC<T> {}

class EventQUICSocketStart extends EventQUICSocket {}

class EventQUICSocketStarted extends EventQUICSocket {}

class EventQUICSocketStop extends EventQUICSocket {}

class EventQUICSocketStopped extends EventQUICSocket {}

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

class EventQUICClientErrorSend extends EventQUICSocket<Error> {}

class EventQUICClientClose extends EventQUICClient<
  | ErrorQUICClientSocketNotRunning<unknown>
  | ErrorQUICConnectionLocal<unknown>
  | ErrorQUICConnectionPeer<unknown>
  | ErrorQUICConnectionIdleTimeout<unknown>
> {}

// Server events

abstract class EventQUICServer<T = undefined> extends EventQUIC<T> {}

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

export {
  EventQUIC,
  EventQUICSocket,
  EventQUICSocketStart,
  EventQUICSocketStarted,
  EventQUICSocketStop,
  EventQUICSocketStopped,
  EventQUICClient,
  EventQUICClientDestroy,
  EventQUICClientDestroyed,
  EventQUICClientError,
  EventQUICClientErrorSend,
  EventQUICClientClose,
  EventQUICServer,
  EventQUICServerStart,
  EventQUICServerStarted,
  EventQUICServerStop,
  EventQUICServerStopped,
  EventQUICServerError,
  EventQUICServerClose,
};
