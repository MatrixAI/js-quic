import type QUICConnection from './QUICConnection';
import type QUICStream from './QUICStream';

class QUICSocketStopEvent extends Event {
  constructor(options?: EventInit) {
    super('stop', options);
  }
}

class QUICSocketErrorEvent extends Event {
  public detail: Error;
  constructor(
    options: EventInit & {
      detail: Error;
    },
  ) {
    super('error', options);
    this.detail = options.detail;
  }
}

class QUICServerConnectionEvent extends Event {
  public detail: QUICConnection;
  constructor(
    options: EventInit & {
      detail: QUICConnection;
    },
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
  public detail: QUICSocketErrorEvent | Error;
  constructor(
    options: EventInit & {
      detail: QUICSocketErrorEvent | Error;
    },
  ) {
    super('error', options);
    this.detail = options.detail;
  }
}

// The stream, may come with initial information
// So we can put the remote info regarding that
// Into the stream
// Each stream will have a fixed conn ID
// Then again... it's possible for the stream to have varying peer info too
// It sort of depends again
// Since you could be handling 1 stream
// Then another stream runs, concurrently from a different remote host
// So you never really get the initial thing

class QUICConnectionStreamEvent extends Event {
  public detail: QUICStream;
  constructor(
    options: EventInit & {
      detail: QUICStream;
    },
  ) {
    super('stream', options);
    this.detail = options.detail;
  }
}

class QUICConnectionSendEvent extends Event {
  constructor(options?: EventInit) {
    super('send', options);
  }
}

class QUICConnectionRecvEvent extends Event {
  constructor(options?: EventInit) {
    super('recv', options);
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
      detail: Error;
    },
  ) {
    super('error', options);
    this.detail = options.detail;
  }
}
class QUICConnectionRemoteCertEvent extends Event {
  constructor(options?: EventInit) {
    super('remoteCert', options);
  }
}

class QUICConnectionRemoteSecureEvent extends Event {
  constructor(options?: EventInit) {
    super('remoteSecure', options);
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

class QUICClientDestroyEvent extends Event {
  constructor(options?: EventInit) {
    super('destroy', options);
  }
}

class QUICClientErrorEvent extends Event {
  public detail: QUICSocketErrorEvent | QUICConnectionErrorEvent;
  constructor(
    options: EventInit & {
      detail: QUICSocketErrorEvent | QUICConnectionErrorEvent;
    },
  ) {
    super('error', options);
    this.detail = options.detail;
  }
}

export {
  QUICSocketStopEvent,
  QUICSocketErrorEvent,
  QUICServerConnectionEvent,
  QUICServerStopEvent,
  QUICServerErrorEvent,
  QUICConnectionStreamEvent,
  QUICConnectionSendEvent,
  QUICConnectionRecvEvent,
  QUICConnectionDestroyEvent,
  QUICConnectionErrorEvent,
  QUICConnectionRemoteCertEvent,
  QUICConnectionRemoteSecureEvent,
  QUICStreamReadableEvent,
  QUICStreamWritableEvent,
  QUICStreamDestroyEvent,
  QUICClientDestroyEvent,
  QUICClientErrorEvent,
};
