import type QUICConnection from "./QUICConnection";
import type QUICStream from "./QUICStream";

class QUICSocketStopEvent extends Event {
  constructor(options?: EventInit) {
    super('stop', options);
  }
}

class QUICSocketErrorEvent extends Event {
  public detail: Error;
  constructor(
    options: EventInit & {
      detail: Error
    }
  ) {
    super('error', options);
    this.detail = options.detail;
  }
}

class QUICServerConnectionEvent extends Event {
  public detail: QUICConnection;
  constructor(
    options: EventInit & {
      detail: QUICConnection
    }
  ) {
    super('connection', options);
    this.detail = options.detail;
  }
}

class QUICServerStopEvent extends Event {
  constructor(options?: EventInit) {
    super('stop', options);
  }
}

class QUICServerErrorEvent extends Event {
  public detail: Error;
  constructor(
    options: EventInit & {
      detail: Error
    }
  ) {
    super('error', options);
    this.detail = options.detail;
  }
}

class QUICConnectionStreamEvent extends Event {
  public detail: QUICStream;
  constructor(
    options: EventInit & {
      detail: QUICStream
    }
  ) {
    super('stream', options);
    this.detail = options.detail;
  }
}

class QUICConnectionDestroyEvent extends Event {
  constructor(options?: EventInit) {
    super('destroy', options);
  }
}

class QUICConnectionErrorEvent extends Event {
  public detail: Error;
  constructor(
    options: EventInit & {
      detail: Error
    }
  ) {
    super('error', options);
    this.detail = options.detail;
  }
}

class QUICStreamReadableEvent extends Event {
  constructor(options?: EventInit) {
    super('readable', options);
  }
}

class QUICStreamWritableEvent extends Event {
  constructor(options?: EventInit) {
    super('writable', options);
  }
}

class QUICStreamDestroyEvent extends Event {
  constructor(options?: EventInit) {
    super('destroy', options);
  }
}

export {
  QUICSocketStopEvent,
  QUICSocketErrorEvent,
  QUICServerConnectionEvent,
  QUICServerStopEvent,
  QUICServerErrorEvent,
  QUICConnectionStreamEvent,
  QUICConnectionDestroyEvent,
  QUICConnectionErrorEvent,
  QUICStreamReadableEvent, // TODO, remove in favour of methods
  QUICStreamWritableEvent, // TODO, remove in favour of methods
  QUICStreamDestroyEvent,
};
