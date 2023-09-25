import type {
  ReadableWritablePair,
  ReadableStreamDefaultController,
  WritableStreamDefaultController,
} from 'stream/web';
import type QUICConnection from './QUICConnection';
import type {
  QUICConfig,
  QUICConnectionMetadata,
  StreamId,
  StreamReasonToCode,
  StreamCodeToReason,
} from './types';
import {
  ReadableStream,
  WritableStream,
  CountQueuingStrategy,
} from 'stream/web';
import Logger from '@matrixai/logger';
import {
  CreateDestroy,
  ready,
  destroyed,
  status,
} from '@matrixai/async-init/dist/CreateDestroy';
import { quiche } from './native';
import * as utils from './utils';
import * as events from './events';
import * as errors from './errors';

const abortReadablePReason = Symbol('abort readableP reason');

interface QUICStream extends CreateDestroy {}
@CreateDestroy({
  eventDestroy: events.EventQUICStreamDestroy,
  eventDestroyed: events.EventQUICStreamDestroyed,
})
class QUICStream implements ReadableWritablePair<Uint8Array, Uint8Array> {
  /**
   * Creates a QUIC stream.
   *
   * This creation is synchronous as it avoids the need for concurrent locking
   * for generating new stream IDs.
   *
   * @param opts
   * @param opts.initiated - local or peer initiated stream
   * @param opts.streamId - stream ID
   * @param opts.connection - QUIC connection
   * @param opts.config - QUIC config
   * @param opts.reasonToCode - maps stream error reasons to stream error codes
   * @param opts.codeToReason - maps stream error codes to reasons
   * @param opts.logger
   *
   * The `reasonToCode` defaults to returning `0` as the code.
   * The `codeToReason` defaults to returning `Error` instance.
   */
  public static createQUICStream({
    initiated,
    streamId,
    connection,
    config,
    reasonToCode = () => 0,
    codeToReason = (type, code) =>
      new Error(`${type.toString()} ${code.toString()}`),
    logger = new Logger(`${this.name} ${streamId}`),
  }: {
    initiated: 'local' | 'peer';
    streamId: StreamId;
    connection: QUICConnection;
    config: QUICConfig;
    reasonToCode?: StreamReasonToCode;
    codeToReason?: StreamCodeToReason;
    logger?: Logger;
  }): QUICStream {
    logger.info(`Create ${this.name}`);
    const stream = new this({
      initiated,
      streamId,
      connection,
      config,
      reasonToCode,
      codeToReason,
      logger,
    });
    if (stream.type === 'uni') {
      if (initiated === 'local') {
        // Readable is automatically closed if it is local and unidirectional
        stream.readableController.close();
        stream._readClosed = true;
      } else if (initiated === 'peer') {
        // Writable is automatically closed if it is peer and unidirectional
        // This voids the promise, because the stream is a dummy stream
        // and there's no other way to close the writable stream
        // Ignores errors in case writable were to be aborted before it is closed
        void stream.writable.close().catch(() => {});
        stream._writeClosed = true;
      }
    }
    stream.addEventListener(
      events.EventQUICStreamError.name,
      stream.handleEventQUICStreamError,
    );
    stream.addEventListener(
      events.EventQUICStreamCloseRead.name,
      stream.handleEventQUICStreamCloseRead,
      { once: true },
    );
    stream.addEventListener(
      events.EventQUICStreamCloseWrite.name,
      stream.handleEventQUICStreamCloseWrite,
      { once: true },
    );
    logger.info(`Created ${this.name}`);
    return stream;
  }

  public readonly type: 'bidi' | 'uni';
  public readonly initiated: 'local' | 'peer';
  public readonly streamId: StreamId;
  public readonly readable: ReadableStream<Uint8Array>;
  public readonly writable: WritableStream<Uint8Array>;

  protected logger: Logger;
  protected connection: QUICConnection;
  protected reasonToCode: StreamReasonToCode;
  protected codeToReason: StreamCodeToReason;
  protected readableController: ReadableStreamDefaultController;
  protected writableController: WritableStreamDefaultController;
  protected _readClosed: boolean = false;
  protected _writeClosed: boolean = false;
  protected readableChunk?: Buffer;
  protected resolveReadableP?: () => void;
  protected rejectReadableP?: (reason?: any) => void;
  protected resolveWritableP?: () => void;
  protected rejectWritableP?: (reason?: any) => void;
  protected closedP: Promise<void>;
  protected resolveClosedP: () => void;

  /**
   * Handles `EventQUICStreamError`.
   *
   * This event propagates all errors relating to locally cancelling or aborting
   * the readable or writable, or receiving a `RESET_STREAM` or `STOP_SENDING`
   * on the readable or writable respectively.
   *
   * Internal errors will be thrown upwards to become an uncaught exception.
   *
   * @throws {errors.ErrorQUICStreamInternal}
   */
  protected handleEventQUICStreamError = (evt: events.EventQUICStreamError) => {
    const error = evt.detail;
    this.logger.error(utils.formatError(error));
    if (error instanceof errors.ErrorQUICStreamInternal) {
      throw error;
    }
    if (
      error instanceof errors.ErrorQUICStreamLocalRead ||
      error instanceof errors.ErrorQUICStreamPeerRead
    ) {
      this.dispatchEvent(
        new events.EventQUICStreamCloseRead({
          detail: error,
        }),
      );
    } else if (
      error instanceof errors.ErrorQUICStreamLocalWrite ||
      error instanceof errors.ErrorQUICStreamPeerWrite
    ) {
      this.dispatchEvent(
        new events.EventQUICStreamCloseWrite({
          detail: error,
        }),
      );
    }
  };

  /**
   * Handles `EventQUICStreamCloseRead`.
   * Registered once.
   */
  protected handleEventQUICStreamCloseRead = async () => {
    this._readClosed = true;
    if (this._readClosed && this._writeClosed) {
      this.resolveClosedP();
      if (!this[destroyed] && this[status] !== 'destroying') {
        // By disabling force, we don't end up running cancel again
        await this.destroy({ force: false });
      }
    }
  };

  /**
   * Handles `EventQUICStreamCloseWrite`.
   * Registered once.
   */
  protected handleEventQUICStreamCloseWrite = async () => {
    this._writeClosed = true;
    if (this._readClosed && this._writeClosed) {
      this.resolveClosedP();
      if (!this[destroyed] && this[status] !== 'destroying') {
        // By disabling force, we don't end up running cancel again
        await this.destroy({ force: false });
      }
    }
  };

  public constructor({
    initiated,
    streamId,
    connection,
    config,
    reasonToCode,
    codeToReason,
    logger,
  }: {
    initiated: 'local' | 'peer';
    streamId: StreamId;
    connection: QUICConnection;
    config: QUICConfig;
    reasonToCode: StreamReasonToCode;
    codeToReason: StreamCodeToReason;
    logger: Logger;
  }) {
    if (utils.isStreamBidirectional(streamId)) {
      this.type = 'bidi';
    } else if (utils.isStreamUnidirectional(streamId)) {
      this.type = 'uni';
    }
    this.logger = logger;
    this.initiated = initiated;
    this.streamId = streamId;
    this.connection = connection;
    this.reasonToCode = reasonToCode;
    this.codeToReason = codeToReason;
    const { p: closedP, resolveP: resolveClosedP } = utils.promise();
    this.closedP = closedP;
    this.resolveClosedP = resolveClosedP;
    // This will setup the readable chunk buffer with the size set to the
    // configured per-stream buffer size. Note that this doubles the memory
    // usage of each stream due to maintaining both the Rust and JS buffers
    if (this.type === 'uni') {
      if (initiated === 'local') {
        // We expect the readable stream to be closed
        this.readableChunk = undefined;
      } else if (initiated === 'peer') {
        this.readableChunk = Buffer.allocUnsafe(config.initialMaxStreamDataUni);
      }
    } else if (this.type === 'bidi' && initiated === 'local') {
      this.readableChunk = Buffer.allocUnsafe(
        config.initialMaxStreamDataBidiLocal,
      );
    } else if (this.type === 'bidi' && initiated === 'peer') {
      this.readableChunk = Buffer.allocUnsafe(
        config.initialMaxStreamDataBidiRemote,
      );
    }
    if (this.type === 'uni' && initiated === 'local') {
      // This is just a dummy stream that will be auto-closed during creation
      this.readable = new ReadableStream({
        start: this.readableStart.bind(this),
      });
    } else {
      this.readable = new ReadableStream(
        {
          start: this.readableStart.bind(this),
          pull: this.readablePull.bind(this),
          cancel: this.readableCancel.bind(this),
        },
        // Allow 1 buffered 'message', Buffering is handled via quiche
        new CountQueuingStrategy({
          highWaterMark: 1,
        }),
      );
    }
    if (this.type === 'uni' && this.initiated === 'peer') {
      // This is just a dummy stream that will be auto-closed during creation
      this.writable = new WritableStream({
        start: this.writableStart.bind(this),
      });
    } else {
      this.writable = new WritableStream(
        {
          start: this.writableStart.bind(this),
          write: this.writableWrite.bind(this),
          close: this.writableClose.bind(this),
          abort: this.writableAbort.bind(this),
        },
        {
          // Allow 1 buffered 'message', Buffering is handled via quiche
          highWaterMark: 1,
        },
      );
      // Initialise local state only when it is not uni-directional and peer initiated
      try {
        // Quiche stream state doesn't yet exist until data is either received
        // or sent on the stream. However in this QUIC library, one may want to
        // create a new stream to use. Therefore in order to maintain consistent
        // closing behaviour, we can prime the stream state in quiche by sending
        // a 0-length message. The data is not actually send to the peer.
        connection.conn.streamSend(streamId, new Uint8Array(0), false);
      } catch (e) {
        // If the peer initally sent `RESET_STREAM`, and we constructed the
        // `QUICStream`, then we cannot create local quiche stream state.
        // We would get the `StreamStopped` exception here. If so, we can
        // ignore.
        if (utils.isStreamStopped(e) === false) {
          throw new errors.ErrorQUICStreamInternal(
            'Failed to prime local stream state with a 0-length message',
            { cause: e },
          );
        }
      }
    }
  }

  /**
   * Returns true of the writable has closed.
   */
  public get writeClosed(): boolean {
    return this._writeClosed;
  }

  /**
   * Returns true if the readable has closed.
   */
  public get readClosed(): boolean {
    return this._readClosed;
  }

  @ready(new errors.ErrorQUICStreamDestroyed())
  public get meta(): QUICConnectionMetadata {
    return this.connection.meta();
  }

  public get closed() {
    return this._readClosed && this._writeClosed;
  }

  /**
   * Destroy the QUIC stream.
   *
   * @param opts
   * @param opts.force - if true, this will cancel readable and abort writable.
   * @param opts.reason - the reason to send to the peer, and if readable and
   *                      writable is cancelled and aborted, then this will be
   *                      the readable and writable error.
   *
   * @throws {errors.ErrorQUICStreamInternal} - if cancel fails
   */
  public async destroy({
    force = true,
    reason,
  }: {
    force?: boolean;
    reason?: any;
  } = {}) {
    this.logger.info(`Destroy ${this.constructor.name}`);
    if (force && !(this._readClosed && this._writeClosed)) {
      this.cancel(reason);
    }
    // If force is false, this will wait for graceful close of both readable
    // and writable.
    await this.closedP;
    this.removeEventListener(
      events.EventQUICStreamError.name,
      this.handleEventQUICStreamError,
    );
    this.removeEventListener(
      events.EventQUICStreamCloseRead.name,
      this.handleEventQUICStreamCloseRead,
    );
    this.removeEventListener(
      events.EventQUICStreamCloseWrite.name,
      this.handleEventQUICStreamCloseWrite,
    );
    this.logger.info(`Destroyed ${this.constructor.name}`);
  }

  /**
   * Cancels the readable and aborts the writable.
   *
   * If streams have already closed or cancelled then this will do nothing.
   * If the underlying quiche streams already closed then this will do nothing.
   *
   * Cancellation will occur in the background.
   *
   * @throws {errors.ErrorQUICStreamInternal} - if cancel fails
   */
  public cancel(reason?: any): void {
    this.readableCancel(reason);
    this.writableAbort(reason);
  }

  /**
   * Called when stream is present in the `this.connection.conn.readable` iterator.
   *
   * If the quiche stream received `RESET_STREAM`, then this is processed as an
   * error, and will drop all buffered data. All other cases will be processed
   * gracefully.
   *
   * Note that this does not dispatch `EventQUICStreamSend` because
   * `QUICConnection` will process the connection send automatically, as the
   * origin of change here is from the `QUICConnection`.
   *
   * @throws {errors.ErrorQUICStreamInternal}
   * @internal
   */
  @ready(new errors.ErrorQUICStreamDestroyed(), false, ['destroying'])
  public read(): void {
    // Stream is finished if due to `RESET_STREAM` or `fin` flag
    if (this.connection.conn.streamFinished(this.streamId)) {
      let result: [number, boolean] | null;
      try {
        result = this.connection.conn.streamRecv(
          this.streamId,
          this.readableChunk!,
        );
      } catch (e) {
        // If due to `RESET_STREAM` immediately cancel the readable and drop all buffers
        let code: number | false;
        if ((code = utils.isStreamReset(e)) !== false) {
          // Use the reason as the cause
          const reason = this.codeToReason('read', code);
          const e_ = new errors.ErrorQUICStreamPeerRead(
            'Peer reset the readable stream',
            {
              data: { code },
              cause: reason,
            },
          );
          // This is idempotent and won't error even if it is already stopped
          this.readableController.error(reason);
          // This rejects the readableP if it exists
          // The pull method may be blocked by `await readableP`
          // When rejected, it will throw up the exception
          // However because the stream is cancelled, then
          // the exception has no effect, and any reads of this stream
          // will simply return `{ value: undefined, done: true }`
          this.rejectReadableP?.(reason);
          this.dispatchEvent(
            new events.EventQUICStreamError({
              detail: e_,
            }),
          );
          // Readable is now errored (cancelled)
          return;
        } else {
          // In all other cases, this is an internal error
          // Error messages might be `Done`, `InvalidStreamState`
          const e_ = new errors.ErrorQUICStreamInternal(
            'Failed `streamRecv` on the readable stream',
            { cause: e },
          );
          this.readableController.error(e_);
          this.rejectReadableP?.(e_);
          this.dispatchEvent(
            new events.EventQUICStreamError({
              detail: e_,
            }),
          );
          throw e_;
        }
      }
      if (result === null) {
        // This is an error, because this must be readable at this point
        const e = new errors.ErrorQUICStreamInternal(
          'Failed `streamRecv` on the readable stream',
        );
        this.readableController.error(e);
        this.rejectReadableP?.(e);
        this.dispatchEvent(
          new events.EventQUICStreamError({
            detail: e,
          }),
        );
        throw e;
      }
      // If due to `fin` flag then close the readable gracefully
      const [recvLength] = result;
      if (recvLength > 0) {
        this.readableController.enqueue(
          this.readableChunk!.subarray(0, recvLength),
        );
      }
      this.readableController.close();
      this.dispatchEvent(new events.EventQUICStreamCloseRead());
      // Abort the `readablePull` since we have already processed the fin frame
      this.rejectReadableP?.(abortReadablePReason);
      return;
    }
    // Resolve the read blocking promise if exists
    // If already resolved, this is a noop
    this.resolveReadableP?.();
  }

  /**
   * Called when stream is present in the `this.connection.conn.writable` iterator.
   *
   * If the quiche stream received `STOP_SENDING`, then this is processed as an
   * error, and will drop all buffered data. All other cases will be processed
   * gracefully.
   *
   * Note that this does not dispatch `EventQUICStreamSend` because `QUICConnection` will
   * process the connection send automatically, as the origin of change here is from the
   * `QUICConnection`.
   *
   * @throws {errors.ErrorQUICStreamInternal}
   * @internal
   */
  @ready(new errors.ErrorQUICStreamDestroyed(), false, ['destroying'])
  public write(): void {
    // Stream is aborted if due to `STOP_SENDING`
    try {
      this.connection.conn.streamCapacity(this.streamId);
    } catch (e) {
      let code: number | false;
      if ((code = utils.isStreamStopped(e)) !== false) {
        // Stream was stopped by the peer
        const reason = this.codeToReason('write', code);
        const e_ = new errors.ErrorQUICStreamPeerWrite(
          'Peer stopped the writable stream',
          {
            data: { code },
            cause: reason,
          },
        );
        this.writableController.error(reason);
        this.rejectWritableP?.(reason);
        this.dispatchEvent(
          new events.EventQUICStreamError({
            detail: e_,
          }),
        );
        return;
      } else {
        // This could happen due to `InvalidStreamState`
        const e_ = new errors.ErrorQUICStreamInternal(
          'Local stream writable could not `streamSend`',
          { cause: e },
        );
        this.writableController.error(e_);
        this.rejectWritableP?.(e_);
        this.dispatchEvent(
          new events.EventQUICStreamError({
            detail: e_,
          }),
        );
        throw e_;
      }
    }
    // Resolve the write blocking promise if exists
    // If already resolved, this is a noop
    this.resolveWritableP?.();
  }

  protected readableStart(controller: ReadableStreamDefaultController): void {
    this.readableController = controller;
  }

  protected writableStart(controller: WritableStreamDefaultController): void {
    this.writableController = controller;
  }

  protected async readablePull(): Promise<void> {
    // Block the pull if the quiche stream is not readable
    if (!this.connection.conn.streamReadable(this.streamId)) {
      const {
        p: readableP,
        resolveP: resolveReadableP,
        rejectP: rejectReadableP,
      } = utils.promise();
      this.resolveReadableP = resolveReadableP;
      this.rejectReadableP = rejectReadableP;
      try {
        await readableP;
      } catch (e) {
        // Abort this if `this.read` already processed `fin`
        if (e === abortReadablePReason) return;
        throw e;
      }
    }
    let result: [number, boolean] | null;
    try {
      result = this.connection.conn.streamRecv(
        this.streamId,
        this.readableChunk!,
      );
    } catch (e) {
      let code: number | false;
      if ((code = utils.isStreamReset(e)) !== false) {
        const reason = this.codeToReason('read', code);
        const e_ = new errors.ErrorQUICStreamPeerRead(
          'Peer reset the readable stream',
          {
            data: { code },
            cause: reason,
          },
        );
        this.readableController.error(reason);
        this.dispatchEvent(
          new events.EventQUICStreamError({
            detail: e_,
          }),
        );
        // The pull doesn't need to throw it upwards, the controller.error
        // already ensures errored state, and any read operation will end up
        // throwing, but we do it here to be symmetric with write.
        throw reason;
      } else {
        const e_ = new errors.ErrorQUICStreamInternal(
          'Failed `streamRecv` on the readable stream',
          { cause: e },
        );
        this.readableController.error(e_);
        this.dispatchEvent(
          new events.EventQUICStreamError({
            detail: e_,
          }),
        );
        throw e_;
      }
    }
    if (result === null) {
      // This is an error, because this must be readable at this point

      // This means Done
      // Which means nothing is readable
      // It's possible because whatever was readable is already read
      // In that case...?
      // do we just `return` OR do the close/close read dispatch

      const e = new errors.ErrorQUICStreamInternal(
        'Failed `streamRecv` on the readable stream because it is not readable',
      );
      this.readableController.error(e);
      this.dispatchEvent(
        new events.EventQUICStreamError({
          detail: e,
        }),
      );
      throw e;
    }
    const [recvLength, fin] = result;
    if (recvLength > 0) {
      this.readableController.enqueue(
        this.readableChunk!.subarray(0, recvLength),
      );
    }
    if (fin) {
      // Reader will receive `{ value: undefined, done: true }`
      this.readableController.close();
      // If fin is true, then that means, the stream is CLOSED
      this.dispatchEvent(new events.EventQUICStreamCloseRead());
    }
    // Trigger send after processing read
    // You would want to dispatch an event here
    // So that QUICConnection can call this.send to make this work
    // But it's not a close event
    // What could it be?
    // EventQUICStreamSend - event
    // means that data is "enqueued" onto the stream state to be sent
    // would you do then say that, that's true as long
    // it's not a close read or whatever?

    // Basically every time you were to call `send`
    // You dispatch the event instead
    // That saves the error handling to `QUICConnection` instead

    this.dispatchEvent(new events.EventQUICStreamSend());

    return;
  }

  /**
   * This will be serialised with close
   */
  protected async writableWrite(chunk: Uint8Array): Promise<void> {
    if (chunk.byteLength === 0) {
      return;
    }
    let sentLength: number;
    while (true) {
      try {
        const result = this.connection.conn.streamSend(
          this.streamId,
          chunk,
          false,
        );
        if (result === null) {
          // This will trigger send, and also loop back to the top
          sentLength = 0;
        } else {
          sentLength = result;
        }
      } catch (e) {
        let code: number | false;
        if ((code = utils.isStreamStopped(e)) !== false) {
          // Stream was stopped by the peer
          const reason = this.codeToReason('write', code);
          const e_ = new errors.ErrorQUICStreamPeerWrite(
            'Peer stopped the writable stream',
            {
              data: { code },
              cause: reason,
            },
          );
          this.writableController.error(reason);
          this.dispatchEvent(
            new events.EventQUICStreamError({
              detail: e_,
            }),
          );
          throw reason;
        } else {
          // This could happen due to `InvalidStreamState`
          // or something else that is unknown
          // I think invalid stream state shouldn't really happen
          // Cause anything blocked and waiting would have been rejected
          const e_ = new errors.ErrorQUICStreamInternal(
            'Local stream writable could not `streamSend`',
            { cause: e },
          );
          // Ensure state transitions to error first before event handlers
          this.writableController.error(e_);
          this.dispatchEvent(
            new events.EventQUICStreamError({
              detail: e_,
            }),
          );
          // Ensure caller rejects
          throw e_;
        }
      }
      // Every time this succeeds, we need to dispatch
      this.dispatchEvent(new events.EventQUICStreamSend());
      // Every time the sent length is less than the input length, then we must wait again
      // Because it means the buffer is not enough for the entire chunk, there's still
      // remaining work to do
      // It means we have to await writableP, which is resolved when the stream is writable
      // again which means usually there's capacity opened up on the buffer
      if (sentLength < chunk.byteLength) {
        // Cause that means we still have data left to send, and we should
        // send in the remaining data afterwards by subtracting the sent length
        chunk = chunk.subarray(sentLength, chunk.byteLength);
        const {
          p: writableP,
          resolveP: resolveWritableP,
          rejectP: rejectWritableP,
        } = utils.promise();
        this.resolveWritableP = resolveWritableP;
        this.rejectWritableP = rejectWritableP;

        // If this rejects, the entire write is rejected
        // It should be rejected in the case of abort
        // But it would not be rejected in the case of close...
        // Since it would not even be runnable in that case
        // If someone were to call close, while this is waiting on being writable
        // It cannot actually be called... you cannot do a graceful close
        // While a write is still being blocked
        // You can only do an abort
        await writableP;
        continue;
      }
      // We are done here
      return;
    }
  }

  /**
   * This is mutually exclusive with write.
   * It will be serialised!
   */
  protected writableClose(): void {
    try {
      // This will not throw `Done` if the chunk is 0-length as it is here
      // Close is always sending a 0-length message
      // That technically means there's no need to wait for anything
      this.connection.conn.streamSend(this.streamId, new Uint8Array(0), true);
    } catch (e) {
      let code: number | false;
      // If the stream is already reset, we cannot gracefully close
      if ((code = utils.isStreamStopped(e)) !== false) {
        // Stream was stopped by the peer
        const reason = this.codeToReason('write', code);
        const e_ = new errors.ErrorQUICStreamPeerWrite(
          'Peer stopped the writable stream',
          {
            data: { code },
            cause: reason,
          },
        );
        // Close method doesn't get access to the controller
        this.writableController.error(reason);
        this.dispatchEvent(
          new events.EventQUICStreamError({
            detail: e_,
          }),
        );
        // This fails the `close`, however no matter what
        // the writable stream is in a closed state
        throw reason;
      } else {
        // This could happen due to `InvalidStreamState`
        const e_ = new errors.ErrorQUICStreamInternal(
          'Local stream writable could not `streamSend`',
          { cause: e },
        );
        this.writableController.error(e_);
        this.dispatchEvent(
          new events.EventQUICStreamError({
            detail: e_,
          }),
        );
        throw e_;
      }
    }
    // Graceful close on the write without any code
    this.dispatchEvent(new events.EventQUICStreamCloseWrite());

    // Trigger send
    this.dispatchEvent(new events.EventQUICStreamSend());
    return;
  }

  /**
   * This is factored out and callable by both `readable.cancel` and `this.cancel`.
   * ReadableStream ensures that this method is idempotent
   *
   * @throws {errors.ErrorQUICStreamInternal}
   */
  protected readableCancel(reason?: any): void {
    // Ignore if already closed
    // This is only needed if this function is called from `this.cancel`.
    // Because the web stream already ensures `cancel` is idempotent.
    if (this._readClosed) return;
    const code = this.reasonToCode('read', reason);
    // It is possible this stream has already received a `RESET_STREAM` and
    //  therefore this will return null and be done.
    // Discards buffered data
    try {
      this.connection.conn.streamShutdown(
        this.streamId,
        quiche.Shutdown.Read,
        code,
      );
    } catch (e) {
      const e_ = new errors.ErrorQUICStreamInternal(
        'Local stream readable could not be shutdown',
        { cause: e },
      );
      this.readableController.error(e_);
      this.dispatchEvent(
        new events.EventQUICStreamError({
          detail: e_,
        }),
      );
      throw e_;
    }
    const e = new errors.ErrorQUICStreamLocalRead(
      'Closing readable stream locally',
      {
        data: { code },
        cause: reason,
      },
    );
    // This is idempotent and won't error even if it is already stopped

    this.readableController.error(reason);
    // This rejects the readableP if it exists
    // The pull method may be blocked by `await readableP`
    // When rejected, it will throw up the exception
    // However because the stream is cancelled, then
    // the exception has no effect, and any reads of this stream
    // will simply return `{ value: undefined, done: true }`
    this.rejectReadableP?.(reason);
    this.dispatchEvent(
      new events.EventQUICStreamError({
        detail: e,
      }),
    );
    this.dispatchEvent(new events.EventQUICStreamSend());
    return;
  }

  /**
   * This is factored out and callable by both `writable.abort` and `this.cancel`.
   *
   * @throws {errors.ErrorQUICStreamInternal}
   */
  protected writableAbort(reason?: any): void {
    // Ignore if already closed
    // This is only needed if this function is called from `this.cancel`.
    // Because the web stream already ensures `cancel` is idempotent.
    if (this._writeClosed) return;
    const code = this.reasonToCode('write', reason);
    // Discards buffered data
    try {
      this.connection.conn.streamShutdown(
        this.streamId,
        quiche.Shutdown.Write,
        code,
      );
    } catch (e) {
      const e_ = new errors.ErrorQUICStreamInternal(
        'Local stream writable could not be shutdown',
        { cause: e },
      );
      this.writableController.error(e_);
      this.dispatchEvent(
        new events.EventQUICStreamError({
          detail: e_,
        }),
      );
      throw e_;
    }
    const e = new errors.ErrorQUICStreamLocalWrite(
      'Closing writable stream locally',
      {
        data: { code },
        cause: reason,
      },
    );
    this.writableController.error(reason);
    // This will reject the writable call
    // But at the same time, it means the writable stream transitions to errored state
    // But the whole writable stream is going to be closed anyway
    this.rejectWritableP?.(reason);
    this.dispatchEvent(
      new events.EventQUICStreamError({
        detail: e,
      }),
    );
    this.dispatchEvent(new events.EventQUICStreamSend());
    return;
  }
}

export default QUICStream;
