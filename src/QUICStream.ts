import type QUICConnection from './QUICConnection';
import type {
  QUICStreamMap,
  StreamId,
  StreamReasonToCode,
  StreamCodeToReason
} from './types';
import type { Connection } from './native/types';
import Logger from '@matrixai/logger';
import { ReadableStream, WritableStream, } from 'stream/web';
import {
  CreateDestroy,
  ready,
  status
} from '@matrixai/async-init/dist/CreateDestroy';
import { quiche } from './native';
import * as events from './events';
import * as utils from './utils';
import * as errors from './errors';

/**
 * Events:
 * - destroy
 *
 * Swap from using `readable` and `writable` to just function calls.
 * It's basically the same, since it's just the connection telling the stream
 * is readable/writable. Rather than creating events for it.
 */
interface QUICStream extends CreateDestroy {}
@CreateDestroy()
class QUICStream extends EventTarget implements ReadableWritablePair<Uint8Array, Uint8Array> {

  public streamId: StreamId;
  public readable: ReadableStream<Uint8Array>;
  public writable: WritableStream<Uint8Array>;

  protected logger: Logger;
  protected connection: QUICConnection;
  protected conn: Connection;
  protected streamMap: QUICStreamMap;
  protected reasonToCode: StreamReasonToCode;
  protected codeToReason: StreamCodeToReason;
  protected readableController: ReadableStreamDefaultController;
  protected writableController: WritableStreamDefaultController;
  protected _sendClosed: boolean = false;
  protected _recvClosed: boolean = false;
  protected _recvPaused: boolean = false;
  protected resolveWritableP?: () => void;

  /**
   * For `reasonToCode`, return 0 means "unknown reason"
   * It is the catch all for codes.
   * So it is the default reason.
   *
   * It may receive any reason for cancellation.
   * It may receive an exception when streamRecv fails!
   */
  public static async createQUICStream({
    streamId,
    connection,
    reasonToCode = () => 0,
    codeToReason = (code) => new Error(code.toString()),
    logger = new Logger(`${this.name} ${streamId}`)
  }: {
    streamId: StreamId;
    connection: QUICConnection;
    reasonToCode?: StreamReasonToCode;
    codeToReason?: StreamCodeToReason;
    logger?: Logger;
  }): Promise<QUICStream> {
    logger.info(`Create ${this.name}`);
    const stream = new this({
      streamId,
      connection,
      reasonToCode,
      codeToReason,
      logger
    });
    connection.streamMap.set(stream.streamId, stream);
    logger.info(`Created ${this.name}`);
    return stream;
  }

  public constructor(
    {
      streamId,
      connection,
      reasonToCode,
      codeToReason,
      logger,
    }: {
      streamId: StreamId;
      connection: QUICConnection;
      reasonToCode: StreamReasonToCode;
      codeToReason: StreamCodeToReason;
      logger: Logger;
    }
  ) {
    super();
    this.logger = logger;
    this.streamId = streamId;
    this.connection = connection;
    this.conn = connection.conn;
    this.streamMap = connection.streamMap;
    this.reasonToCode = reasonToCode;
    this.codeToReason = codeToReason;

    // Try the BYOB later, it seems more performant

    this.readable = new ReadableStream({
      type: 'bytes',
      // autoAllocateChunkSize: 1024,
      start: (controller) => {
        this.readableController = controller;
      },
      pull: async () => {
        this._recvPaused = false;
        await this.streamRecv();
      },
      cancel: async (reason) => {
        await this.closeRecv(true, reason);
      }
    });

    this.writable = new WritableStream({
      start: (controller) => {
        this.writableController = controller;
      },
      write: async (chunk: Uint8Array) => {
        await this.streamSend(chunk);
      },
      close: async () => {
        // This gracefully closes, by sending a message at the end
        // If there wasn't an error, we will send an empty frame
        // with the `fin` set to true
        // If this itself results in an error, we can continue
        // But continue to do the below
        await this.streamSend(new Uint8Array(0), true);
        await this.closeSend();
      },
      abort: async (reason?: any) => {
        // Abort can be called even if there are writes are queued up
        // The chunks are meant to be thrown away
        // We could tell it to shutdown
        // This sends a `RESET_STREAM` frame, this abruptly terminates the sending part of a stream
        // The receiver can discard any data it already received on that stream
        // We don't have "unidirectional" streams so that's not important...
        await this.closeSend(true, reason);
      }
    });
  }

  public get sendClosed(): boolean {
    return this._sendClosed;
  }

  public get recvClosed(): boolean {
    return this._recvClosed;
  }

  public get recvPaused(): boolean {
    return this._recvPaused;
  }

  /**
   * This method can be arrived top-down or bottom-up:
   *
   * 1. Top-down control flow - means explicit destruction from QUICConnection
   * 2. Bottom-up control flow - means stream events from users of this stream
   */
  public async destroy(
    {
      force = false
    }: {
      force?: boolean
    } = {}
  ) {
    this.logger.info(`Destroy ${this.constructor.name}`);

    // If the streams are locked, this means they are in-use
    // or they have been composed with `pipeThrough` or `pipeTo`.
    // At this point the management of their lifecycle is no longer
    // `QUICStream`'s responsibility.
    // If they not already closed, we cannot proceed with destroying
    // this `QUICStream`.
    // If the streams are not locked, and they haven't been closed yet,

    if (!this.readable.locked && !this._recvClosed) {
      await this.readable.cancel();
    }
    if (!this.writable.locked && !this._sendClosed) {
      await this.writable.close();
    }
    if (this.readable.locked && !this._recvClosed) {
      if (!force) {
        throw new errors.ErrorQUICStreamLocked();
      } else {
        const e = new errors.ErrorQUICStreamClose();
        this.readableController.error(e);
        await this.closeRecv(true, e);
      }
    }
    if (this.writable.locked && !this._sendClosed) {
      if (!force) {
        throw new errors.ErrorQUICStreamLocked();
      } else {
        const e = new errors.ErrorQUICStreamClose();
        this.writableController.error(e);
        await this.closeSend(true, e);
      }
    }
    this.streamMap.delete(this.streamId);
    this.dispatchEvent(new events.QUICStreamDestroyEvent());
    this.logger.info(`Destroyed ${this.constructor.name}`);
  }

  /**
   * External push is converted to internal pull
   * Internal system decides when to unblock
   */
  @ready(new errors.ErrorQUICStreamDestroyed)
  public read(): void {
    if (this._recvPaused) {
      // Do nothing if we are paused
      return;
    }
    void this.streamRecv();
  }

  /**
   * Internal push is converted to an external pull
   * External system decides when to unblock
   */
  @ready(new errors.ErrorQUICStreamDestroyed)
  public write(): void {
    if (this.resolveWritableP != null) {
      this.resolveWritableP();
    }
  }

  protected async streamRecv(): Promise<void> {
    const buf = Buffer.alloc(1024);
    let recvLength: number, fin: boolean;
    try {
      [recvLength, fin] = this.conn.streamRecv(
        this.streamId,
        buf
      );
    } catch (e) {
      if (e.message === 'Done') {
        // When it is reported to be `Done`, it just means that there is no data to read
        // it does not mean that the stream is closed or finished
        // In such a case, we just ignore and continue
        // However after the stream is closed, then it would continue to return `Done`
        // This can only occur in 2 ways, either via the `fin`
        // or through an exception here where the stream reports an error
        // Since we don't call this method unless it is readable
        // This should never be reported... (this branch should be dead code)
        this.logger.debug('Stream reported: done');
        return;
      } else {
        this.logger.debug('Stream reported: error');
        const match = e.message.match(/StreamReset\((.+)\)/);
        if (match != null) {
          // If it is `StreamReset(u64)` error, then the peer has closed
          // the stream and we are receiving the error code
          const code = parseInt(match[1]);
          const reason = await this.codeToReason('recv', code);
          this.readableController.error(reason);
          await this.closeRecv();
        } else {
          // If it is not a `StreamReset(u64)`, then something else broke
          // and we need to propagate the error up and down the stream
          this.readableController.error(e);
          await this.closeRecv(true, e);
        }
        return;
      }
    }
    // It's possible to get a 0-length buffer
    // In fact 0-length buffers are used to "open" a stream
    if (recvLength > 0) {
      this.readableController.enqueue(buf.subarray(0, recvLength));
    }
    // If fin is true, then that means, the stream is CLOSED
    if (fin) {
      // This will render `stream.cancel` a noop
      this.logger.debug('Stream reported: fin');
      this.readableController.close();
      await this.closeRecv();
      return;
    }
    // Now we pause receiving if the queue is full
    if (
      this.readableController.desiredSize != null &&
      this.readableController.desiredSize <= 0
    ) {
      this._recvPaused = true;
    }
  }

  protected async streamSend(chunk: Uint8Array, fin = false): Promise<void> {
    // This means that the number of written bytes returned can be lower
    // than the length of the input buffer when the stream doesn’t have
    // enough capacity for the operation to complete. The application
    // should retry the operation once the stream is reported as writable again.
    let sentLength: number;
    try {
      sentLength = this.conn.streamSend(
        this.streamId,
        chunk,
        fin
      );
    } catch (e) {
      // If the Done is returned
      // then no data was sent
      // because the stream has no capacity
      if (e.message === 'Done') {
        // If the chunk size itself is 0,
        // it is still possible to have no capacity
        // to send a 0-length buffer.
        // To indicate this we set the sentLength to -1.
        // This ensures that we are always blocked below.
        sentLength = -1;
      } else {
        // We may receive a `StreamStopped(u64)` exception
        // meaning the peer has signalled for us to stop writing
        // If this occurs, we need to go back to the writable stream
        // and indicate that there was an error now
        // Actually it's sufficient to simply throw an exception I think
        // That would essentially do it
        const match = e.message.match(/StreamStopped\((.+)\)/);
        if (match != null) {
          const code = parseInt(match[1]);
          const reason = await this.codeToReason('send', code);
          // We have to close the send side (but the stream is already closed)
          await this.closeSend();
          // Throws the exception back to the writer
          throw reason;
        } else {
          // Some thing else broke
          // here we close the stream by sending a `STREAM_RESET`
          // with the error, this doesn't involving calling `streamSend`
          await this.closeSend(true, e);
          throw e;
        }
      }
    }
    if (sentLength < chunk.length) {
      const { p: writableP, resolveP: resolveWritableP } = utils.promise();
      this.resolveWritableP = resolveWritableP;
      await writableP;
      // If the `sentLength` is -1, then it will be raised to `0`
      return await this.streamSend(
        chunk.subarray(Math.max(sentLength, 0)),
        fin
      );
    }
  }

  /**
   * This is called from events on the stream
   * If `isError` is true, then it will terminate with a reason.
   * The reason is converted to a code, and sent in a `STOP_SENDING` frame.
   */
  protected async closeRecv(
    isError: boolean = false,
    reason?: any
  ): Promise<void> {
    this.logger.info(`Close Recv`);
    if (isError) {
      // This will send a `STOP_SENDING` frame with the code
      // When the other peer sends, they will get a `StreamStopped(u64)` exception
      const code = await this.reasonToCode('recv', reason);
      this.conn.streamShutdown(
        this.streamId,
        quiche.Shutdown.Read,
        code
      );
    }
    this._recvClosed = true;
    if (
      this[status] !== 'destroying' &&
      this._recvClosed &&
      this._sendClosed
    ) {
      // Only destroy if we are not already destroying
      // and that both recv and send is closed
      await this.destroy();
    }
    this.logger.info(`Closed Recv`);
  }

  /**
   * This is called from events on the stream
   * If `isError` is true, then it will terminate with an reason.
   * The reason is converted to a code, and sent in a `RESET_STREAM` frame.
   */
  protected async closeSend(
    isError: boolean = false,
    reason?: any
  ): Promise<void> {
    this.logger.info(`Close Send`);
    // If the QUIC stream is already closed
    // there's nothign to do on the QUIC stream
    if (isError) {
      // This will send a `RESET_STREAM` frame with the code
      // When the other peer receives, they will get a `StreamReset(u64)` exception
      const code = await this.reasonToCode('send', reason);
      this.conn.streamShutdown(
        this.streamId,
        quiche.Shutdown.Write,
        code
      );
    }
    // Indicate that the sending side is closed
    this._sendClosed = true;
    if (
      this[status] !== 'destroying' &&
      this._recvClosed &&
      this._sendClosed
    ) {
      // Only destroy if we are not already destroying
      // and that both recv and send is closed
      await this.destroy();
    }
    this.logger.info(`Closed Send`);
  }
}

export default QUICStream;
