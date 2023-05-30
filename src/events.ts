import type QUICConnection from './QUICConnection';
import type QUICStream from './QUICStream';

// Socket events

abstract class QUICSocketEvent extends Event {};

class QUICSocketStopEvent extends Event {
  constructor(options?: EventInit) {
    super('socketStop', options);
  }
}

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

abstract class QUICClientEvent extends Event {};

class QUICClientDestroyEvent extends Event {
  constructor(options?: EventInit) {
    super('clientDestroy', options);
  }
}

class QUICClientErrorEvent extends Event {
  public detail: Error;
  constructor(
    options: EventInit & {
      detail: Error;
    },
  ) {
    super('clientError', options);
    this.detail = options.detail;
  }
}

// Server events

abstract class QUICServerEvent extends Event {};

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

abstract class QUICConnectionEvent extends Event {};

class QUICConnectionStreamEvent extends QUICConnectionEvent {
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

class QUICConnectionDestroyEvent extends QUICConnectionEvent {
  constructor(options?: EventInit) {
    super('connectionDestroy', options);
  }
}

class QUICConnectionErrorEvent extends QUICConnectionEvent {
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

abstract class QUICStreamEvent extends Event {};

class QUICStreamDestroyEvent extends QUICStreamEvent {
  constructor(options?: EventInit) {
    super('streamDestroy', options);
  }
}

export {
  QUICSocketEvent,
  QUICSocketStopEvent,
  QUICSocketErrorEvent,
  QUICClientEvent,
  QUICClientDestroyEvent,
  QUICClientErrorEvent,
  QUICServerEvent,
  QUICServerConnectionEvent,
  QUICServerStopEvent,
  QUICServerErrorEvent,
  QUICConnectionEvent,
  QUICConnectionStreamEvent,
  QUICConnectionDestroyEvent,
  QUICConnectionErrorEvent,
  QUICStreamEvent,
  QUICStreamDestroyEvent,
};
