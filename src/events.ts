class QUICErrorEvent extends Event {
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

class QUICConnectionEvent extends Event {
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
  QUICErrorEvent
};
