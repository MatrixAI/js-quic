import type QUICConnection from './QUICConnection';
import type {
  QUICStreamMap,
  StreamId,
  StreamReasonToCode,
  StreamCodeToReason,
  ConnectionMetadata,
} from './types';
import type { Connection } from './native/types';
import { ReadableStream, WritableStream } from 'stream/web';
import Logger from '@matrixai/logger';
import {
  CreateDestroy,
  ready,
  status,
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
class QUICStream
  extends EventTarget
  implements ReadableWritablePair<Uint8Array, Uint8Array>
{
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
  // This resolves when `streamSend` would result in a `StreamStopped(u64)` error indicating sending has ended
  protected sendFinishedProm = utils.promise<void>();
  // This resolves when `streamRecv` results in a `StreamReset(u64)` or a fin flag indicating receiving has ended
  protected recvFinishedProm = utils.promise<void>();
  protected destroyingMap: Map<StreamId, QUICStream>;

  /**
   * For `reasonToCode`, return 0 means "unknown reason"
   * It is the catch-all for codes.
   * So it is the default reason.
   *
   * It may receive any reason for cancellation.
   * It may receive an exception when streamRecv fails!
   */
  public static async createQUICStream({
    streamId,
    connection,
    destroyingMap,
    reasonToCode = () => 0,
    codeToReason = (type, code) =>
      new Error(`${type.toString()} ${code.toString()}`),
    maxReadableStreamBytes = 100_000, // About 100KB
    maxWritableStreamBytes = 100_000, // About 100KB
    logger = new Logger(`${this.name} ${streamId}`),
  }: {
    streamId: StreamId;
    connection: QUICConnection;
    destroyingMap: Map<StreamId, QUICStream>;
    reasonToCode?: StreamReasonToCode;
    codeToReason?: StreamCodeToReason;
    maxReadableStreamBytes?: number;
    maxWritableStreamBytes?: number;
    logger?: Logger;
  }): Promise<QUICStream> {
    logger.info(`Create ${this.name}`);
    // 'send' a 0-len message to initialize stream state in Quiche. No 0-len data is actually sent so this does not
    //  create remote state.
    try {
      connection.conn.streamSend(streamId, new Uint8Array(0), false);
    } catch {
      // Ignore errors, we only want to initialize local state here.
    }
    const stream = new this({
      streamId,
      connection,
      reasonToCode,
      codeToReason,
      destroyingMap,
      maxReadableStreamBytes,
      maxWritableStreamBytes,
      logger,
    });
    connection.streamMap.set(stream.streamId, stream);
    logger.info(`Created ${this.name}`);
    return stream;
  }

  public constructor({
    streamId,
    connection,
    reasonToCode,
    codeToReason,
    destroyingMap,
    maxReadableStreamBytes,
    maxWritableStreamBytes,
    logger,
  }: {
    streamId: StreamId;
    connection: QUICConnection;
    reasonToCode: StreamReasonToCode;
    codeToReason: StreamCodeToReason;
    destroyingMap: Map<StreamId, QUICStream>;
    maxReadableStreamBytes: number;
    maxWritableStreamBytes: number;
    logger: Logger;
  }) {
    super();
    this.logger = logger;
    this.streamId = streamId;
    this.connection = connection;
    this.conn = connection.conn;
    this.streamMap = connection.streamMap;
    this.reasonToCode = reasonToCode;
    this.codeToReason = codeToReason;
    this.destroyingMap = destroyingMap;

    this.readable = new ReadableStream(
      {
        type: 'bytes',
        // AutoAllocateChunkSize: 1024,
        start: (controller) => {
          this.readableController = controller;
        },
        pull: async () => {
          this._recvPaused = false;
          await this.streamRecv();
        },
        cancel: async (reason) => {
          await this.closeRecv(true, reason);
        },
      },
      {
        highWaterMark: maxReadableStreamBytes,
      },
    );

    this.writable = new WritableStream(
      {
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
          this.logger.debug('sending fin frame');
          await this.streamSend(new Uint8Array(0), true).catch((e) => {
            // Ignore send error if stream is already closed
            if (e.message !== 'send') throw e;
          });
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
        },
      },
      {
        highWaterMark: maxWritableStreamBytes,
      },
    );
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
   * Connection information including hosts, ports and cert data.
   */
  public get remoteInfo(): ConnectionMetadata {
    return this.connection.remoteInfo;
  }

  /**
   * Duplicating `remoteInfo` functionality.
   * This strictly exists to work with agnostic RPC stream interface.
   */
  public get meta(): ConnectionMetadata {
    return this.connection.remoteInfo;
  }

  /**
   * This method can be arrived top-down or bottom-up:
   *
   * 1. Top-down control flow - means explicit destruction from QUICConnection
   * 2. Bottom-up control flow - means stream events from users of this stream
   */
  public async destroy() {
    this.logger.info(`Destroy ${this.constructor.name}`);
    if (!this._recvClosed) {
      const e = new errors.ErrorQUICStreamClose();
      this.readableController.error(e);
      await this.closeRecv(true, e);
    }
    if (!this._sendClosed) {
      const e = new errors.ErrorQUICStreamClose();
      this.writableController.error(e);
      await this.closeSend(true, e);
    }
    await this.connection.send();
    // Await this.streamSend(new Uint8Array(0), true).catch(e => console.error(e));
    this.logger.debug('waiting for underlying streams to finish');
    this.destroyingMap.set(this.streamId, this);
    this.isFinished();
    await Promise.all([this.sendFinishedProm.p, this.recvFinishedProm.p]);
    this.logger.debug('done waiting for underlying streams to finish');
    this.streamMap.delete(this.streamId);
    // Remove from the shortlist, just in case
    this.destroyingMap.delete(this.streamId);
    // We need to wait for the connection to finish before fully destroying
    this.dispatchEvent(new events.QUICStreamDestroyEvent());
    this.logger.info(`Destroyed ${this.constructor.name}`);
  }

  /**
   * Used to cancel the streams. This function is synchronous but triggers some asynchronous events.
   */
  public cancel(reason?: any): void {
    reason = reason ?? new errors.ErrorQUICStreamCancel();
    if (!this._recvClosed) {
      this.readableController.error(reason);
      void this.closeRecv(true, reason);
    }
    if (!this._sendClosed) {
      this.writableController.error(reason);
      void this.closeSend(true, reason);
    }
  }

  /**
   * External push is converted to internal pull
   * Internal system decides when to unblock
   */
  @ready(new errors.ErrorQUICStreamDestroyed(), false, ['destroying'])
  public read(): void {
    // After reading it's possible the writer had a state change.
    this.isSendFinished();
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
  @ready(new errors.ErrorQUICStreamDestroyed(), false, ['destroying'])
  public write(): void {
    // Checking if writable has ended
    void this.isSendFinished();
    if (this.resolveWritableP != null) {
      this.resolveWritableP();
    }
  }

  /**
   * Checks if the underlying stream has finished.
   * Will trigger send and recv stream destruction events if so.
   */
  public isFinished(): boolean {
    return this.isRecvFinished() && this.isSendFinished();
  }

  /**
   * Checks if the stream has finished receiving data.
   * Will trigger recv close if it has finished.
   * Returns if the stream has finished, This can be due to a `fin` or a `RESET_STREAM` frame.
   */
  public isRecvFinished(): boolean {
    const recvFinished = this.conn.streamFinished(this.streamId);
    if (recvFinished) {
      // If it is finished then we resolve the promise and clean up
      this.recvFinishedProm.resolveP();
      if (!this._recvClosed) {
        const err = new errors.ErrorQUICStreamUnexpectedClose(
          'Readable stream closed early with no reason',
        );
        this.readableController.error(err);
        void this.closeRecv(true, err);
      }
    }
    return recvFinished;
  }

  /**
   * Checks if the stream has finished sending data.
   * Will trigger recv close if it has finished.
   * This will likely be due to a 'STOP_SENDING' frame.
   */
  public isSendFinished(): boolean {
    try {
      this.conn.streamWritable(this.streamId, 0);
      return false;
    } catch (e) {
      this.logger.info(e.message);
      // If the writable has ended, we need to close the writable.
      // We need to do this in the background to keep this synchronous.
      void this.processSendStreamError(e, 'send').then((reason) => {
        if (!this._sendClosed) {
          const err =
            reason ??
            new errors.ErrorQUICStreamUnexpectedClose(
              'Writable stream closed early with no reason',
            );
          this.writableController.error(err);
          void this.closeSend(true, err);
        }
        this.sendFinishedProm.resolveP();
      });
      return true;
    }
  }

  protected async streamRecv(): Promise<void> {
    const buf = Buffer.alloc(1024);
    let recvLength: number, fin: boolean;
    this.logger.info('trying receiving');
    try {
      [recvLength, fin] = this.conn.streamRecv(this.streamId, buf);
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
        return;
      } else {
        this.logger.debug('Stream reported: error');
        // Signal receiving has ended
        this.recvFinishedProm.resolveP();
        const reason = await this.processSendStreamError(e, 'recv');
        if (reason != null) {
          // If it is `StreamReset(u64)` error, then the peer has closed
          // the stream, and we are receiving the error code
          this.readableController.error(reason);
          await this.closeRecv(true, reason);
        } else {
          // If it is not a `StreamReset(u64)`, then something else broke
          // and we need to propagate the error up and down the stream
          this.readableController.error(e);
          await this.closeRecv(true, e);
        }
        return;
      }
    } finally {
      // Let's check if sending side has finished
      await this.connection.send();
    }

    // If fin is true, then that means, the stream is CLOSED
    if (fin) {
      // This will render `stream.cancel` a noop
      this.logger.debug('Stream reported: fin');
      if (!this._recvClosed) this.readableController.close();
      await this.closeRecv();
      // Signal receiving has ended
      this.recvFinishedProm.resolveP();
      return;
    }
    // Only fin packets are 0 length, so we enqueue after checking fin
    if (!this._recvClosed) {
      this.readableController.enqueue(buf.subarray(0, recvLength));
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
      sentLength = this.conn.streamSend(this.streamId, chunk, fin);
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
        // Signal sending has ended
        this.sendFinishedProm.resolveP();
        // We may receive a `StreamStopped(u64)` exception
        // meaning the peer has signalled for us to stop writing
        // If this occurs, we need to go back to the writable stream
        // and indicate that there was an error now
        // Actually it's sufficient to simply throw an exception I think
        // That would essentially do it
        const reason = await this.processSendStreamError(e, 'send');
        if (reason != null) {
          // We have to close the send side (but the stream is already closed)
          await this.closeSend(true, e);
          // Throws the exception back to the writer
          throw reason;
        } else {
          // Something else broke
          // here we close the stream by sending a `STREAM_RESET`
          // with the error, this doesn't involving calling `streamSend`
          await this.closeSend(true, e);
          throw e;
        }
      }
    } finally {
      await this.connection.send();
    }
    if (sentLength < chunk.length) {
      const { p: writableP, resolveP: resolveWritableP } = utils.promise();
      this.resolveWritableP = resolveWritableP;
      await writableP;
      // If the `sentLength` is -1, then it will be raised to `0`
      return await this.streamSend(
        chunk.subarray(Math.max(sentLength, 0)),
        fin,
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
    reason?: any,
  ): Promise<void> {
    // Further closes are NOPs
    if (this._recvClosed) return;
    this.logger.debug(`Close Recv`);
    // Indicate that the receiving side is closed
    this._recvClosed = true;
    const code = isError ? await this.reasonToCode('send', reason) : 0;
    // This will send a `STOP_SENDING` frame with the code
    // When the other peer sends, they will get a `StreamStopped(u64)` exception
    try {
      this.conn.streamShutdown(this.streamId, quiche.Shutdown.Read, code);
    } catch (e) {
      // Ignore if already shutdown
      if (e.message !== 'Done') throw e;
    }
    await this.connection.send();
    if (this[status] !== 'destroying' && this._recvClosed && this._sendClosed) {
      // Only destroy if we are not already destroying
      // and that both recv and send is closed
      void this.destroy();
    }
    this.logger.debug(`Closed Recv`);
  }

  /**
   * This is called from events on the stream
   * If `isError` is true, then it will terminate with an reason.
   * The reason is converted to a code, and sent in a `RESET_STREAM` frame.
   */
  protected async closeSend(
    isError: boolean = false,
    reason?: any,
  ): Promise<void> {
    // Further closes are NOPs
    if (this._sendClosed) return;
    this.logger.debug(`Close Send`);
    // Indicate that the sending side is closed
    this._sendClosed = true;
    // If the QUIC stream is already closed
    // there's nothing to do on the QUIC stream
    const code = isError ? await this.reasonToCode('send', reason) : 0;
    // This will send a `RESET_STREAM` frame with the code
    // When the other peer receives, they will get a `StreamReset(u64)` exception
    try {
      this.conn.streamShutdown(this.streamId, quiche.Shutdown.Write, code);
    } catch (e) {
      // Ignore if already shutdown
      if (e.message !== 'Done') throw e;
    }
    await this.connection.send();
    if (this[status] !== 'destroying' && this._recvClosed && this._sendClosed) {
      // Only destroy if we are not already destroying
      // and that both recv and send is closed
      void this.destroy();
    }
    this.logger.debug(`Closed Send`);
  }

  /**
   * This will process any errors from a `streamSend` or `streamRecv`, extract the code and covert to a reason.
   * Will return null if the error was not an expected stream ending error.
   */
  protected async processSendStreamError(
    e: Error,
    type: 'recv' | 'send',
  ): Promise<any | null> {
    const match =
      e.message.match(/StreamStopped\((.+)\)/) ??
      e.message.match(/InvalidStreamState\((.+)\)/) ??
      e.message.match(/StreamReset\((.+)\)/);
    if (match != null) {
      const code = parseInt(match[1]);
      return await this.codeToReason(type, code);
    }
    return null;
  }
}

export default QUICStream;
