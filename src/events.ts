import type { SendInfo } from './native/types';
import type QUICConnection from "./QUICConnection";

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

class QUICConnectionCloseEvent extends Event {
  public detail: boolean;
  constructor(
    options: EventInit & {
      detail: boolean
    }
  ) {
    super('close', options);
    this.detail = options.detail;
  }
}

class QUICConnectionSendEvent extends Event {
  public detail: [Uint8Array, SendInfo];
  constructor(
    options: EventInit & {
      detail: [Uint8Array, SendInfo]
    }
  ) {
    super('send', options);
    this.detail = options.detail;
  }
}

class QUICConnectionEvent extends Event {
  public detail: QUICConnection;
  constructor(
    options: EventInit & {
      detail: QUICConnection
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

export {
  QUICSocketErrorEvent,
  QUICServerErrorEvent,
  QUICConnectionErrorEvent,
  QUICConnectionCloseEvent,
  QUICConnectionEvent,
  QUICStreamReadableEvent,
  QUICStreamWritableEvent,
};
