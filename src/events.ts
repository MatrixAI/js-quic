import type QUICConnection from "./QUICConnection";

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

export {
  QUICServerConnectionEvent,
  QUICStreamReadableEvent,
  QUICStreamWritableEvent,
  QUICSocketErrorEvent,
  QUICServerErrorEvent,
  QUICConnectionErrorEvent,
};
