import type {
  ReadableWritablePair,
  ReadableStreamDefaultController,
  WritableStreamDefaultController,
} from 'stream/web';
import type QUICConnection from './QUICConnection.js';
import type {
  QUICConfig,
  ConnectionMetadata,
  StreamId,
  StreamReasonToCode,
  StreamCodeToReason,
} from './types.js';
import {
  ReadableStream,
  WritableStream,
  CountQueuingStrategy,
} from 'stream/web';
import Logger from '@matrixai/logger';
import { createDestroy, destroyed, status } from '@matrixai/async-init';
import quiche from './native/quiche.js';
import * as utils from './utils.js';
import * as events from './events.js';
import * as errors from './errors.js';

const abortReadablePReason = Symbol('abort readableP reason');

interface QUICStream extends createDestroy.CreateDestroy {}
@createDestroy.CreateDestroy({
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
  public readonly closedP: Promise<void>;

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
    if (error instanceof errors.ErrorQUICStreamInternal) {
      // Log out error for debugging
      this.logger.debug(utils.formatError(error));
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
    // This will set up the readable chunk buffer with the size set to the
    // configured per-stream buffer size. Note that this doubles the memory
    // usage of each stream due to maintaining both the Rust and JS buffers
    if (this.type === 'uni' && initiated === 'local') {
      // We expect the readable stream to be closed
      this.readableChunk = undefined;
    } else {
      this.readableChunk = Buffer.allocUnsafe(config.readableChunkSize);
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
        // create a new stream to use. Therefore, in order to maintain consistent
        // closing behaviour, we can prime the stream state in quiche by sending
        // a 0-length message. The data is not actually send to the peer.
        connection.conn.streamSend(streamId, new Uint8Array(0), false);
      } catch (e) {
        // If the peer initially sent `RESET_STREAM`, and we constructed the
        // `QUICStream`, then we cannot create local quiche stream state.
        // We would get the `StreamStopped` exception here. If so, we can
        // ignore.
        if (utils.isStreamStopped(e) === false) {
          if (e.message === 'StreamLimit') {
            // Some peers advertise `initial_max_streams_uni: 0` (or an
            // exhausted count) and rely on MAX_STREAMS frames post-handshake
            // to grant stream credit. This is used for flow-controlled or
            // stake-weighted QoS on the server side (e.g. Solana's Agave
            // TPU-QUIC server). The eager-prime `streamSend(0-length)` races
            // ahead of any credit grant. Swallow the StreamLimit here so the
            // stream object is still constructed locally; the first real
            // `writableWrite` will retry `streamSend` (see retry block there)
            // and succeed once MAX_STREAMS has arrived.
            // Throwing here both broke the consumer's view of stream creation
            // (returning a stream id that was then rejected) AND left quiche's
            // internal state such that subsequent `newStream` calls hit
            // `ErrorQUICUndefinedBehaviour: We should never repeat streamIds`.
          } else {
            throw new errors.ErrorQUICStreamInternal(
              `Failed to prime local stream state with a 0-length message: ${e.message}`,
              { cause: e },
            );
          }
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

  @createDestroy.ready(new errors.ErrorQUICStreamDestroyed())
  public get meta(): ConnectionMetadata {
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
  @createDestroy.ready(new errors.ErrorQUICStreamDestroyed(), false, [
    'destroying',
  ])
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
          // This rejects the readableP if it exists to release it from it's blocked state
          this.rejectReadableP?.(reason);
          this.dispatchEvent(
            new events.EventQUICStreamError({
              detail: e_,
            }),
          );
          return;
        } else {
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
      // Close the readable gracefully
      const [recvLength] = result;
      if (recvLength > 0) {
        this.readableController.enqueue(
          // Making a copy to be enqueued
          Buffer.from(this.readableChunk!.subarray(0, recvLength)),
        );
      }
      this.readableController.close();
      this.dispatchEvent(new events.EventQUICStreamCloseRead());
      // Abort the `readablePull` since we have already processed the fin frame
      this.rejectReadableP?.(abortReadablePReason);
      return;
    }
    // Resolve the read blocking promise if exists.
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
  @createDestroy.ready(new errors.ErrorQUICStreamDestroyed(), false, [
    'destroying',
  ])
  public write(): void {
    // Stream is aborted if due to `STOP_SENDING`
    try {
      this.connection.conn.streamCapacity(this.streamId);
    } catch (e) {
      let code: number | false;
      if ((code = utils.isStreamStopped(e)) !== false) {
        // Cleanup the underlying quiche stream state, otherwise the stream
        // remains writable, and we end up re-creating a `QUICStream`.
        this.connection.conn.streamShutdown(
          this.streamId,
          quiche.Shutdown.Write,
          code,
        );
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
    // Resolve the write blocking promise if exists.
    // If already resolved, this is a noop
    this.resolveWritableP?.();
  }

  protected readableStart(controller: ReadableStreamDefaultController): void {
    this.readableController = controller;
  }

  protected writableStart(controller: WritableStreamDefaultController): void {
    this.writableController = controller;
  }

  /**
   * Serialised by `ReadableStream`.
   *
   * @throws {errors.ErrorQUICStreamInternal}
   */
  protected async readablePull(): Promise<void> {
    // Block the pull if the quiche stream is not readable
    if (!this.connection.conn.streamReadable(this.streamId)) {
      const {
        p: readableP,
        resolveP: resolveReadableP,
        rejectP: rejectReadableP,
      } = utils.promise();
      // Prevent promise rejection leak
      void readableP.catch(() => {});
      this.resolveReadableP = resolveReadableP;
      this.rejectReadableP = rejectReadableP;
      try {
        await readableP;
      } catch {
        // If readableP was rejected then we just want to end early here,
        // anything rejecting it should already have errored the stream.
        return;
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
        return;
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
        // Making a copy to be enqueued
        Buffer.from(this.readableChunk!.subarray(0, recvLength)),
      );
    }
    if (fin) {
      // Reader will receive `{ value: undefined, done: true }`
      this.readableController.close();
      // If fin is true, then that means, the stream is CLOSED
      this.dispatchEvent(new events.EventQUICStreamCloseRead());
    }
    this.dispatchEvent(new events.EventQUICStreamSend());
    return;
  }

  /**
   * Serialised with `this.writableClose` by `WritableStream`.
   *
   * @throws {errors.ErrorQUICStreamInternal}
   */
  protected async writableWrite(chunk: Uint8Array): Promise<void> {
    if (chunk.byteLength === 0) {
      return;
    }
    let sentLength: number;
    // Bounded retry on StreamLimit. Peers that advertise
    // `initial_max_streams_uni: 0` (e.g. Solana's Agave TPU-QUIC for
    // unstaked clients) issue MAX_STREAMS frames post-handshake rather
    // than at handshake time. `streamSend` can therefore fail with
    // `StreamLimit` on the first write attempt; a short backoff lets the
    // connection's receive loop process incoming MAX_STREAMS frames
    // before we fail the caller. Total wait is bounded at ~1 s.
    let streamLimitRetries = 0;
    const STREAM_LIMIT_MAX_RETRIES = 20;
    const STREAM_LIMIT_BACKOFF_MS = 50;
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
          return;
        } else if (
          (e as { message?: string }).message === 'StreamLimit' &&
          streamLimitRetries < STREAM_LIMIT_MAX_RETRIES
        ) {
          streamLimitRetries++;
          await new Promise<void>((resolve) =>
            setTimeout(resolve, STREAM_LIMIT_BACKOFF_MS),
          );
          continue;
        } else {
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
      this.dispatchEvent(new events.EventQUICStreamSend());
      // If sent length is less than the chunk length, then blocker the writer.
      // The `this.writableP` will resolve when there's more capacity on the buffer.
      if (sentLength < chunk.byteLength) {
        chunk = chunk.subarray(sentLength, chunk.byteLength);
        const {
          p: writableP,
          resolveP: resolveWritableP,
          rejectP: rejectWritableP,
        } = utils.promise();
        // Prevent promise rejection leak
        void writableP.catch(() => {});
        this.resolveWritableP = resolveWritableP;
        this.rejectWritableP = rejectWritableP;
        await writableP;
        continue;
      }
      return;
    }
  }

  /**
   * Serialised with `this.writableWrite` by `WritableStream`.
   *
   * @throws {errors.ErrorQUICStreamInternal}
   */
  protected writableClose(): void {
    try {
      // This will not throw `Done` if the chunk is 0-length as it is here.
      this.connection.conn.streamSend(this.streamId, new Uint8Array(0), true);
    } catch (e) {
      let code: number | false;
      // If the stream is already reset, we cannot gracefully close
      if ((code = utils.isStreamStopped(e)) !== false) {
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
        // This fails the `close`, however no matter what
        // the writable stream is in a closed state.
        return;
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
    this.dispatchEvent(new events.EventQUICStreamCloseWrite());
    this.dispatchEvent(new events.EventQUICStreamSend());
    return;
  }

  /**
   * `ReadableStream` ensures that this method is idempotent
   *
   * @throws {errors.ErrorQUICStreamInternal}
   */
  protected readableCancel(reason?: any): void {
    if (this._readClosed) return;
    const code = this.reasonToCode('read', reason);
    // Discards buffered readable data
    try {
      // The stream may have already received `RESET_STREAM`.
      // In which case this would return `null`.
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
    this.readableController.error(reason);
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
   * `WritableStream` ensures that this method is idempotent.
   *
   * @throws {errors.ErrorQUICStreamInternal}
   */
  protected writableAbort(reason?: any): void {
    if (this._writeClosed) return;
    const code = this.reasonToCode('write', reason);
    // Discards buffered writable data
    try {
      // The stream may have already received `STOP_SENDING`.
      // In which case this would return `null`.
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
