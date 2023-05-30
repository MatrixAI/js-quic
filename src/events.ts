import type QUICConnection from './QUICConnection';
import type QUICStream from './QUICStream';

// Socket events

class QUICSocketStopEvent extends Event {
  constructor(options?: EventInit) {
    super('socketStop', options);
  }
}

/**
 * If the socket is encapsulated in the client or server, then any error event
 * will be re-meitted as a `clientError` or `serverError` event.
 */
class QUICSocketErrorEvent extends Event {
  public detail: Error;
  constructor(
    options: EventInit & {
      detail: Error;
    },
  ) {
    super('socketError', options);
    this.detail = options.detail;
  }
}

// Client events

class QUICClientDestroyEvent extends Event {
  constructor(options?: EventInit) {
    super('clientDestroy', options);
  }
}

class QUICClientErrorEvent extends Event {
  public detail: QUICSocketErrorEvent | QUICConnectionErrorEvent;
  constructor(
    options: EventInit & {
      detail: QUICSocketErrorEvent | QUICConnectionErrorEvent;
    },
  ) {
    super('clientError', options);
    this.detail = options.detail;
  }
}

// Server events

class QUICServerConnectionEvent extends Event {
  public detail: QUICConnection;
  constructor(
    options: EventInit & {
      detail: QUICConnection;
    },
  ) {
    super('serverConnection', options);
    this.detail = options.detail;
  }
}

class QUICServerStopEvent extends Event {
  constructor(options?: EventInit) {
    super('serverStop', options);
  }
}

class QUICServerErrorEvent extends Event {
  public detail: QUICSocketErrorEvent | Error;
  constructor(
    options: EventInit & {
      detail: QUICSocketErrorEvent | Error;
    },
  ) {
    super('serverError', options);
    this.detail = options.detail;
  }
}

// Connection events

class QUICConnectionStreamEvent extends Event {
  public detail: QUICStream;
  constructor(
    options: EventInit & {
      detail: QUICStream;
    },
  ) {
    super('connectionStream', options);
    this.detail = options.detail;
  }
}

class QUICConnectionDestroyEvent extends Event {
  constructor(options?: EventInit) {
    super('connectionDestroy', options);
  }
}

class QUICConnectionErrorEvent extends Event {
  public detail: Error;
  constructor(
    options: EventInit & {
      detail: Error;
    },
  ) {
    super('connectionError', options);
    this.detail = options.detail;
  }
}

// Stream events

class QUICStreamDestroyEvent extends Event {
  constructor(options?: EventInit) {
    super('streamDestroy', options);
  }
}

export {
  QUICSocketStopEvent,
  QUICSocketErrorEvent,
  QUICClientDestroyEvent,
  QUICClientErrorEvent,
  QUICServerConnectionEvent,
  QUICServerStopEvent,
  QUICServerErrorEvent,
  QUICConnectionStreamEvent,
  QUICConnectionDestroyEvent,
  QUICConnectionErrorEvent,
  QUICStreamDestroyEvent,
};
