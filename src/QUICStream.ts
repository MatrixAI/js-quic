import type {
  ReadableWritablePair,
  ReadableStreamDefaultController,
  WritableStreamDefaultController,
} from 'stream/web';
import type QUICConnection from './QUICConnection';
import type {
  QUICConfig,
  StreamId,
  StreamReasonToCode,
  StreamCodeToReason,
  QUICConnectionMetadata,
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
import * as events from './events';
import * as utils from './utils';
import * as errors from './errors';

interface QUICStream extends CreateDestroy {}
@CreateDestroy({
  eventDestroy: events.EventQUICStreamDestroy,
  eventDestroyed: events.EventQUICStreamDestroyed,
})
class QUICStream implements ReadableWritablePair<Uint8Array, Uint8Array> {
  /**
   * Synchronous creation here.
   * Avoids concurrency issues.
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
        // This is the one place where we void a floating promise
        // That's because the stream is a dummy stream
        // At the same time, we will ignore any errors that occur
        // Just in case the writable were to be aborted before it is closed
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
      { once: true }
    );
    stream.addEventListener(
      events.EventQUICStreamCloseWrite.name,
      stream.handleEventQUICStreamCloseWrite,
      { once: true }
    );
    logger.info(`Created ${this.name}`);
    return stream;
  }

  /**
   * Type of the stream.
   * Currently unidirectional streams is not supported.
   */
  public readonly type: 'bidi' | 'uni';

  /**
   * Stream was initiated by who?
   * Whether the `QUICConnection` is client or server,
   * both can have streams that are either locally initiated or peer initiated.
   */
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

  public readonly closedP: Promise<void>;
  protected resolveClosedP: () => void;

  /**
   * We expect QUIC stream error in 2 ways.
   * QUIC stream closure of the stream codes.
   * On read side
   * On write side
   * We are able to use exception classes to distinguish things
   * Because it's always about the error itself!A
   * Note that you must distinguish between actual internal errors, and errors on the stream itself
   *
   * When this error is handled, the streams are already canceled.
   */
  protected handleEventQUICStreamError = (evt: events.EventQUICStreamError) => {
    const error = evt.detail;
    this.logger.error(utils.formatError(error));
    if (error instanceof errors.ErrorQUICStreamInternal) {
      throw error;
    }
    if (
      error instanceof errors.ErrorQUICStreamLocalRead
      ||
      error instanceof errors.ErrorQUICStreamPeerRead
    ) {
      this.dispatchEvent(
        new events.EventQUICStreamCloseRead({
          detail: error
        })
      );
    } else if (
      error instanceof errors.ErrorQUICStreamLocalWrite
      ||
      error instanceof errors.ErrorQUICStreamPeerWrite
    ) {
      this.dispatchEvent(
        new events.EventQUICStreamCloseWrite({
          detail: error
        })
      );
    }
  };

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

  protected handleEventQUICStreamCloseWrite = async () => {
    this._writeClosed = true;
    if (this._readClosed && this._writeClosed) {
      this.resolveClosedP();
      if (!this[destroyed] && this[status] !== 'destroying') {
        // If we are destroying, we still end up calling this
        // This is to enable, that when a failed cancellation to continue to destroy
        // By disabling force, we don't end up running cancel again
        // But that way it does infact successfully destroy
        await this.destroy({ force: false });
      }
    }
  };

  /**
   * For `reasonToCode`, returning `0` means unknown reason.
   * Thus `0` is the default reason.
   *
   * When we get a code, we also just create a generic `Error`.
   * Although we will create a special error just for this.
   *
   * You are supposed to supply the `reasonToCode` and `codeToReason`.
   * Based on what you think are appropriate stream error codes.
   *
   * There is one reason you should be aware of that is internal to QUIC.
   * `ErrorQUICStreamInternal`. This may go into `reasonToCode`.
   *
   * By default this will mean a close event is emitted with this as the code.
   * However such a code does not mean it came from the other side or was sent.
   * It just means something internally happened to the stream that broke.
   * The `ErrorQUICStreamInternal` thus may be a relevant exception for any
   * stream related operations.
   *
   * @internal
   */
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
    // This will be used to know when both readable and writable is closed
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
      this.readableChunk = Buffer.allocUnsafe(config.initialMaxStreamDataBidiLocal);
    } else if (this.type === 'bidi' && initiated === 'peer') {
      this.readableChunk = Buffer.allocUnsafe(config.initialMaxStreamDataBidiRemote);
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
        new CountQueuingStrategy({
          // Allow 1 buffered message, so we can know when data is desired, and we can know when to un-pause.
          highWaterMark: 1,
        }),
      );
    }

    if (this.type ==='uni' && this.initiated === 'peer') {
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

      // If it is uni directional and it is peer initiated
      // Then we cannot write to the peer, and thus no point in initialising state
      try {
        // Quiche stream state doesn't yet exist until data is either received
        // or sent on the stream. However in this QUIC library, one may want to
        // create a new stream to use. Therefore in order to maintain consistent
        // closing behaviour, we can prime the stream state in quiche by sending
        // a 0-length message. The data is not actually send to the peer.
        connection.conn.streamSend(streamId, new Uint8Array(0), false);
      } catch (e) {
        // There is no need to prime the state if our the other side already close the readable side
        // In this case, we need to ensure that we understand the stream is already closed
        // It's possible... that even though it was bidirectional
        // That the other side already cancelled the readable side
        // So in this case it would be `StreamStopped` error code
        // If it is a stream stopped, then we can ignore here
        // It will be dealt with on the next write inside `writableWrite`
        // Remember we cannot dispatch events inside the constructor
        if (utils.isStreamStopped(e) === false) {
          // Note that `conn.streamSend` does not throw `Done` when writing
          // a 0-length message, therefore this is a software error
          throw new errors.ErrorQUICStreamInternal(
            'Failed to prime local stream state with a 0-length message',
            { cause: e }
          );
        }
      }
    }
  }

  /**
   * Returns connection data for the connection this stream is on.
   */
  @ready(new errors.ErrorQUICStreamDestroyed())
  public get meta(): QUICConnectionMetadata {
    return this.connection.meta();
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

  public get closed() {
    return this._readClosed && this._writeClosed;
  }

  /**
   * This method can be arrived top-down or bottom-up:
   *
   * 1. Top-down control flow - means explicit destruction from QUICConnection
   * 2. Bottom-up control flow - means stream events from users of this stream
   *
   * If force is true then this will cancel readable and abort writable.
   * If force is false then it will just wait for readable and writable to be closed.
   *
   * Unlike QUICConnection, this defaults to true for force.
   *
   * @throws {errors.ErrorQUICStreamInternal}
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
      // If force is true, we are going to cancel the 2 streams
      // This means cancelling the readable stream and aborting the writable stream
      // Whether this fails or succeeds, it will trigger the close handler
      // Which means we recurse back into `this.destroy`.
      // If it failed, it recurses into destroy and will succeed (because the force will be false)
      // If it succeeded, it recurses into destroy into a noop.
      this.cancel(reason);
    }
    // This can only resolve, if you call this without being forced
    // You have to wait for close from the users of the stream
    await this.closedP;
    this.removeEventListener(
      events.EventQUICStreamError.name,
      this.handleEventQUICStreamError
    );
    this.removeEventListener(
      events.EventQUICStreamCloseRead.name,
      this.handleEventQUICStreamCloseRead,
    );
    this.removeEventListener(
      events.EventQUICStreamCloseWrite.name,
      this.handleEventQUICStreamCloseWrite
    );
    this.logger.info(`Destroyed ${this.constructor.name}`);
  }

  /**
   * Will trigger the destruction of the `QUICStream` if the readable or writable haven't closed, yet they will be forced
   * closed with `reason` as the error.
   * If streams have already closed then this will do nothing.
   * This is synchronous by design but cancelling will happen asynchronously in the background.
   *
   * This ends up calling the cancel and abort methods.
   * Those methods are needed because the readable and writable might be locked with
   * a reader and writer respectively. So we have to cancel and abort from the "inside" of
   * the stream.
   * It's essential that this is synchronus, as that ensures only one thing is running at a time.
   * Note that if cancellation fails...
   *
   * Calling this will lead an asynchronous destruction of this `QUICStream` instance.
   * This could throw actually. But cancellation is likely to have occurred.
   *
   * @throws {errors.ErrorQUICStreamInternal}
   */
  public cancel(reason?: any): void {
    this.readableCancel(reason);
    this.writableAbort(reason);
  }

  /**
   * Called when stream is present in the `connection.readable` iterator.
   * It resolves a promise waiting for more data to be available and processed by the readable stream.
   *
   * If the stream has finished then we want to process the finish condition and clean up the readable stream.
   * Normally a stream will only finish after all the data is read from it and the fin flag is true.
   * The stream will become finished with data still on the buffer if there was an error.
   * We need to process this error condition and clean up. All buffered data will have been dropped by quiche.
   *
   * This is public but should only be used internally by the `QUICConnection`.
   * @internal
   */
  @ready(new errors.ErrorQUICStreamDestroyed(), false, ['destroying'])
  public read(): void {
    this.resolveReadableP?.();
  }

  /**
   * Internal push is converted to an external pull
   * External system decides when to unblock
   *
   * If the writable stream had an error then it will be writable until the error received from quiche.
   * To be responsive in this condition we're checking if the stream is writable to trigger an error.
   * If there is an error we trigger a dummy write to get this error and clean up the writable stream.
   *
   * This is public but should only be used internally by the `QUICConnection`.
   * @internal
   */
  @ready(new errors.ErrorQUICStreamDestroyed(), false, ['destroying'])
  public write(): void {
    // TODO: temp fix, needs review
    // We need to proactivity handle write stream errors here
    try {
      this.connection.conn.streamWritable(this.streamId, 0);
    } catch (e) {
      this.logger.warn(e.message);
      let code: number | false;
      if ((code = utils.isStreamStopped(e)) !== false) {
        // Stream was stopped by the peer
        const reason = this.codeToReason('write', code);
        const e_ = new errors.ErrorQUICStreamPeerWrite(
          'Peer stopped the writable stream',
          {
            data: { code },
            cause: reason
          }
        );
        this.writableController.error(reason);
        this.dispatchEvent(
          new events.EventQUICStreamError({
            detail: e_
          })
        );
      } else {
        // This could happen due to `InvalidStreamState`
        // or something else that is unknown
        // I think invalid stream state shouldn't really happen
        // Cause anything blocked and waiting would have been rejected
        const e_ = new errors.ErrorQUICStreamInternal(
          'Local stream writable could not `streamSend`',
          { cause: e }
        );
        // Ensure state transitions to error first before event handlers
        this.writableController.error(e_);
        this.dispatchEvent(
          new events.EventQUICStreamError({
            detail: e_
          })
        );
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
        rejectP: rejectReadableP
      } = utils.promise();
      // This will act as the signal to continue reading
      // What if it rejects? We could argue that when the stream is cancelled
      // Then anything blocking it should be cancelled too
      this.resolveReadableP = resolveReadableP;
      this.rejectReadableP = rejectReadableP;
      // If this rejects:
      // Case 1 is the stream readable side was closed with `STOP_SENDING`
      // Case 2 which is peer sends `STREAM_RESET` - this is handled afterwards
      // Case 3 is some internal error happened
      // In either case of 1 and 3, the error is thrown upwards
      // The stream enters an errored state, and any reader will
      // get the same exception
      // Note that in case 1, since it is cancelled... it's not necessary to do anything here
      // As the pull method will be blocked, and eventually be garbage collected
      try {
        await readableP;
      } catch (e) {
        throw e;
      }
    }

    let recvLength: number, fin: boolean;
    let result: [number, boolean] | null;
    try {
      result = this.connection.conn.streamRecv(this.streamId, this.readableChunk!);
      // [recvLength, fin] = result;
    } catch (e) {
      let code: number | false;
      if ((code = utils.isStreamReset(e)) !== false) {
        // Use the reason as the cause
        const reason = this.codeToReason('read', code);
        const e_ = new errors.ErrorQUICStreamPeerRead(
          'Peer reset the readable stream',
          {
            data: { code },
            cause: reason
          }
        );
        this.readableController.error(reason);
        this.dispatchEvent(
          new events.EventQUICStreamError({
            detail: e_
          })
        );
        // The pull doesn't need to throw it upwards, the controller.error already ensures errored state
        // And any read operation will end up throwing
        // But we do it here for symmetricity with write
        throw reason;
      } else {
        // In all other cases, this is an internal error
        // Error messages might be `Done`, `InvalidStreamState`
        const e_ = new errors.ErrorQUICStreamInternal(
          'Failed `streamRecv` on the readable stream',
          { cause: e }
        );
        this.readableController.error(e_);
        this.dispatchEvent(
          new events.EventQUICStreamError({
            detail: e_
          })
        );
        throw e_;
      }
    }

    if (result === null) {
      // This is an error, because this must be readable at this point
      const e = new errors.ErrorQUICStreamInternal(
        'Failed `streamRecv` on the readable stream because it is not readable',
      );
      this.readableController.error(e);
      this.dispatchEvent(
        new events.EventQUICStreamError({
          detail: e
        })
      );
      throw e;
    }

    [recvLength, fin] = result;

    // If it is 0-length message, the `fin` should be true
    // But even if it isn't, we can just ignore the chunk
    // Readers shouldn't be reading a 0-length message
    if (recvLength > 0) {
      this.readableController.enqueue(this.readableChunk!.subarray(0, recvLength));
    }
    // Generally a recv length of 0 will come with a fin being true
    // QUIC stream should not in fact give you a 0-length message with
    // fin being false, however if the implementation is buggy, we just
    // drop that frame
    if (fin) {
      // Reader will receive `{ value: undefined, done: true }`
      this.readableController.close();
      // If fin is true, then that means, the stream is CLOSED
      this.dispatchEvent(
        new events.EventQUICStreamCloseRead()
      );
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

    this.dispatchEvent(
      new events.EventQUICStreamSend()
    );

    return;
  }

  /**
   * This will be serialised with close
   */
  protected async writableWrite(
    chunk: Uint8Array,
  ): Promise<void> {
    if (chunk.byteLength === 0) {
      return;
    }
    let sentLength: number;
    while (true) {
      try {
        const result = this.connection.conn.streamSend(this.streamId, chunk, false);
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
              cause: reason
            }
          );
          this.writableController.error(reason);
          this.dispatchEvent(
            new events.EventQUICStreamError({
              detail: e_
            })
          );
          throw reason;
        } else {
          // This could happen due to `InvalidStreamState`
          // or something else that is unknown
          // I think invalid stream state shouldn't really happen
          // Cause anything blocked and waiting would have been rejected
          const e_ = new errors.ErrorQUICStreamInternal(
            'Local stream writable could not `streamSend`',
            { cause: e }
          );
          // Ensure state transitions to error first before event handlers
          this.writableController.error(e_);
          this.dispatchEvent(
            new events.EventQUICStreamError({
              detail: e_
            })
          );
          // Ensure caller rejects
          throw e_;
        }
      }
      // Every time this succeeds, we need to dispatch
      this.dispatchEvent(
        new events.EventQUICStreamSend()
      );
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
          rejectP: rejectWritableP
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
            cause: reason
          }
        );
        // Close method doesn't get access to the controller
        this.writableController.error(reason);
        this.dispatchEvent(
          new events.EventQUICStreamError({
            detail: e_
          })
        );
        // This fails the `close`, however no matter what
        // the writable stream is in a closed state
        throw reason;
      } else {
        // This could happen due to `InvalidStreamState`
        const e_ = new errors.ErrorQUICStreamInternal(
          'Local stream writable could not `streamSend`',
          { cause: e }
        );
        this.writableController.error(e_);
        this.dispatchEvent(
          new events.EventQUICStreamError({
            detail: e_
          })
        );
        throw e_;
      }
    }
    // Graceful close on the write without any code
    this.dispatchEvent(
      new events.EventQUICStreamCloseWrite()
    );

    // Trigger send
    this.dispatchEvent(
      new events.EventQUICStreamSend()
    );
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
    // What if this fails?
    // Possible failures: InvalidStreamState and Done
    // Done is only possible if this stream no longer exists
    // The stream state should still exist, at this point
    // Idempotent, that's not that important
    // Discards buffered data
    let result: void | null;
    try {
      result = this.connection.conn.streamShutdown(this.streamId, quiche.Shutdown.Read, code);
    } catch (e) {
      const e_ = new errors.ErrorQUICStreamInternal(
        'Local stream readable could not be shutdown',
        { cause: e }
      );
      this.readableController.error(e_);
      this.dispatchEvent(
        new events.EventQUICStreamError({
          detail: e_
        })
      );
      throw e_;
    }
    if (result === null) {
      // Means stream no longer exists
      // This is technically an error
      // Cause that should not happen here
      // The stream must exist
      const e = new errors.ErrorQUICStreamInternal(
        'Local stream readable could not be shutdown because it does not exist',
      );
      this.readableController.error(e);
      this.dispatchEvent(
        new events.EventQUICStreamError({
          detail: e
        })
      );
      throw e;
    }
    const e = new errors.ErrorQUICStreamLocalRead(
      'Closing readable stream locally',
      {
        data: { code },
        cause: reason
      }
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
        detail: e
      })
    );
    this.dispatchEvent(
      new events.EventQUICStreamSend()
    );
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
      this.connection.conn.streamShutdown(this.streamId, quiche.Shutdown.Write, code);
    } catch (e) {
      const e_ = new errors.ErrorQUICStreamInternal(
        'Local stream writable could not be shutdown',
        { cause: e }
      );
      this.writableController.error(e_);
      this.dispatchEvent(
        new events.EventQUICStreamError({
          detail: e_
        })
      );
      throw e_;
    }
    const e = new errors.ErrorQUICStreamLocalWrite(
      'Closing writable stream locally',
      {
        data: { code },
        cause: reason
      }
    );
    this.writableController.error(reason);
    // This will reject the writable call
    // But at the same time, it means the writable stream transitions to errored state
    // But the whole writable stream is going to be closed anyway
    this.rejectWritableP?.(reason);
    this.dispatchEvent(
      new events.EventQUICStreamError({
        detail: e
      })
    );
    this.dispatchEvent(
      new events.EventQUICStreamSend()
    );
    return;
  }
}

export default QUICStream;
