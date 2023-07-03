import type QUICConnection from './QUICConnection';
import type {
  QUICStreamMap,
  StreamId,
  StreamReasonToCode,
  StreamCodeToReason,
  ConnectionMetadata,
} from './types';
import type { Connection } from './native/types';
import type {
  ReadableWritablePair,
  ReadableStreamDefaultController,
  WritableStreamDefaultController,
} from 'stream/web';
import {
  ReadableStream,
  WritableStream,
  CountQueuingStrategy,
} from 'stream/web';
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
 * - streamDestroy
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
  protected resolveReadableP?: () => void;
  protected resolveWritableP?: () => void;

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
    reasonToCode = () => 0,
    codeToReason = (type, code) =>
      new Error(`${type.toString()} ${code.toString()}`),
    logger = new Logger(`${this.name} ${streamId}`),
  }: {
    streamId: StreamId;
    connection: QUICConnection;
    reasonToCode?: StreamReasonToCode;
    codeToReason?: StreamCodeToReason;
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
    logger,
  }: {
    streamId: StreamId;
    connection: QUICConnection;
    reasonToCode: StreamReasonToCode;
    codeToReason: StreamCodeToReason;
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

    this.readable = new ReadableStream(
      {
        // Type: 'bytes',
        start: (controller) => {
          this.readableController = controller;
        },
        pull: async (controller) => {
          this.logger.warn('attempting data pull');
          // If nothing to read then we wait
          if (!this.conn.streamReadable(this.streamId)) {
            const readProm = utils.promise();
            this.resolveReadableP = readProm.resolveP;
            this.logger.warn('waiting for readable');
            await readProm.p;
          }

          const buf = Buffer.alloc(1024);
          let recvLength: number, fin: boolean;
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
              this.logger.debug(`Stream recv reported: error ${e.message}`);
              if (!this._recvClosed) {
                const reason =
                  (await this.processSendStreamError(e, 'recv')) ?? e;
                // If it is `StreamReset(u64)` error, then the peer has closed
                // the stream, and we are receiving the error code
                // If it is not a `StreamReset(u64)`, then something else broke,
                // and we need to propagate the error up and down the stream
                controller.error(reason);
                await this.closeRecv(true, reason);
              }
              return;
            }
          }
          this.logger.debug(`stream read ${recvLength} bytes with fin(${fin})`);
          // If fin is true, then that means, the stream is CLOSED
          if (!fin) {
            // Send the data normally
            if (!this._recvClosed) {
              this.readableController.enqueue(buf.subarray(0, recvLength));
            }
          } else {
            // Strip the end message, removing the null byte
            if (!this._recvClosed && recvLength > 1) {
              this.readableController.enqueue(buf.subarray(0, recvLength - 1));
            }
            await this.closeRecv();
            controller.close();
            return;
          }
        },
        cancel: async (reason) => {
          this.logger.debug(`readable aborted with [${reason.message}]`);
          await this.closeRecv(true, reason);
        },
      },
      new CountQueuingStrategy({
        highWaterMark: 1,
      }),
    );

    this.writable = new WritableStream(
      {
        start: (controller) => {
          this.writableController = controller;
        },
        write: async (chunk: Uint8Array, controller) => {
          await this.streamSend(chunk).catch((e) => controller.error(e));
          await this.connection.send();
        },
        close: async () => {
          // This gracefully closes, by sending a message at the end
          // If there wasn't an error, we will send an empty frame
          // with the `fin` set to true
          // If this itself results in an error, we can continue
          // But continue to do the below
          this.logger.debug('sending fin frame');
          // This.sendFinishedProm.resolveP();
          await this.streamSend(Buffer.from([0]), true);
          // Close without error
          await this.closeSend();
        },
        abort: async (reason?: any) => {
          // Abort can be called even if there are writes are queued up
          // The chunks are meant to be thrown away
          // We could tell it to shut down
          // This sends a `RESET_STREAM` frame, this abruptly terminates the writing part of a stream
          // The receiver can discard any data it already received on that stream
          // We don't have "unidirectional" streams so that's not important...
          await this.closeSend(true, reason);
        },
      },
      {
        highWaterMark: 1,
      },
    );
  }

  public get sendClosed(): boolean {
    return this._sendClosed;
  }

  public get recvClosed(): boolean {
    return this._recvClosed;
  }

  /**
   * Connection information including hosts, ports and cert data.
   */
  public get remoteInfo(): ConnectionMetadata {
    throw Error('TMP IMP');
    // Return this.connection.remoteInfo;
  }

  /**
   * Duplicating `remoteInfo` functionality.
   * This strictly exists to work with agnostic RPC stream interface.
   */
  public get meta(): ConnectionMetadata {
    throw Error('TMP IMP');
    // Return this.connection.remoteInfo;
  }

  /**
   * This method can be arrived top-down or bottom-up:
   *
   * 1. Top-down control flow - means explicit destruction from QUICConnection
   * 2. Bottom-up control flow - means stream events from users of this stream
   *
   * This will not wait for any transition events, It's either called when both
   * directions have closed. Or when force closing the connection which does not
   * require waiting.
   */
  public async destroy({ force = false }: { force?: boolean } = {}) {
    this.logger.info(`Destroy ${this.constructor.name}`);
    if (!this._recvClosed && force) {
      const e = new errors.ErrorQUICStreamClose();
      this.readableController.error(e);
      await this.closeRecv(true, e);
    }
    if (!this._sendClosed && force) {
      const e = new errors.ErrorQUICStreamClose();
      this.writableController.error(e);
      await this.closeSend(true, e);
    }
    await this.connection.send();
    this.streamMap.delete(this.streamId);
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
   * Called when stream is present in the `connection.readable` iterator
   * Checks for certain close conditions when blocked and closes the web-stream.
   */
  @ready(new errors.ErrorQUICStreamDestroyed(), false, ['destroying'])
  public read(): void {
    // If we're readable and the readable stream is still waiting, then we need to push some data.
    // Or if the stream has finished we need to read and clean up.
    this.logger.warn(`desired size ${this.readableController.desiredSize}`);
    if (
      (this.readableController.desiredSize != null &&
        this.readableController.desiredSize > 0) ||
      this.conn.streamFinished(this.streamId)
    ) {
      // We resolve the read block
      if (this.resolveReadableP != null) this.resolveReadableP();
    }
  }

  /**
   * Internal push is converted to an external pull
   * External system decides when to unblock
   */
  @ready(new errors.ErrorQUICStreamDestroyed(), false, ['destroying'])
  public write(): void {
    // Checking if the writable had an error
    try {
      this.conn.streamWritable(this.streamId, 0);
    } catch (e) {
      // If it threw an error, then the stream was closed with an error
      // We need to attempt a write to trigger state change and remove stream from writable iterator
      void this.streamSend(Buffer.from('dummy data'), true).catch(() => {});
    }
    if (this.resolveWritableP != null) {
      this.resolveWritableP();
    }
  }

  protected async streamSend(chunk: Uint8Array, fin = false): Promise<void> {
    // This means that the number of written bytes returned can be lower
    // than the length of the input buffer when the stream doesn't have
    // enough capacity for the operation to complete. The application
    // should retry the operation once the stream is reported as writable again.
    let sentLength: number;
    try {
      sentLength = this.conn.streamSend(this.streamId, chunk, fin);
      this.logger.debug(`stream wrote ${sentLength} bytes with fin(${fin})`);
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
        // We may receive a `StreamStopped(u64)` exception
        // meaning the peer has signalled for us to stop writing
        // If this occurs, we need to go back to the writable stream
        // and indicate that there was an error now
        // Actually it's sufficient to simply throw an exception I think
        // That would essentially do it
        const reason = (await this.processSendStreamError(e, 'send')) ?? e;
        // We have to close the send side (but the stream is already closed)
        await this.closeSend(true, reason);
        // Throws the exception back to the writer
        throw reason;
      }
    }
    if (sentLength < chunk.length) {
      const { p: writableP, resolveP: resolveWritableP } = utils.promise();
      this.resolveWritableP = resolveWritableP;
      this.logger.debug(
        `stream wrote only ${sentLength}/${chunk.byteLength} bytes, waiting for capacity`,
      );
      await writableP;
      // If the `sentLength` is -1, then it will be raised to `0`
      const remainingMessage = chunk.subarray(Math.max(sentLength, 0));
      await this.streamSend(remainingMessage, fin);
      this.logger.debug(
        `stream wrote remaining ${remainingMessage.byteLength} bytes with fin(${fin})`,
      );
      return;
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
    if (isError) this.logger.debug(`recv closed with error ${reason.message}`);
    // Further closes are NOPs
    if (this._recvClosed) return;
    this.logger.debug(`Close Recv`);
    // Indicate that the receiving side is closed
    this._recvClosed = true;
    const code = isError ? await this.reasonToCode('send', reason) : 0;
    // This will send a `STOP_SENDING` frame with the code
    // When the other peer sends, they will get a `StreamStopped(u64)` exception
    if (isError) {
      try {
        this.conn.streamShutdown(this.streamId, quiche.Shutdown.Read, code);
      } catch (e) {
        // Ignore if already shutdown
        if (e.message !== 'Done') throw e;
      }
      this.readableController.error(reason);
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
   * This is called from events on the stream.
   * Will trigger any error and clean up logic events.
   * If `isError` is true, then it will terminate with a reason.
   * The reason is converted to a code, and sent in a `RESET_STREAM` frame.
   */
  protected async closeSend(
    isError: boolean = false,
    reason?: any,
  ): Promise<void> {
    if (isError) this.logger.debug(`send closed with error ${reason.message}`);
    // Further closes are NOPs
    if (this._sendClosed) return;
    this.logger.debug(`Close Send`);
    // Indicate that the sending side is closed
    this._sendClosed = true;
    if (isError) {
      try {
        // If the QUIC stream is already closed
        // there's nothing to do on the QUIC stream
        const code = await this.reasonToCode('send', reason);
        // This will send a `RESET_STREAM` frame with the code
        // When the other peer receives, they will get a `StreamReset(u64)` exception
        this.conn.streamShutdown(this.streamId, quiche.Shutdown.Write, code);
      } catch (e) {
        // Ignore if already shutdown
        if (e.message !== 'Done') throw e;
      }
      this.writableController.error(reason);
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
    let match =
      e.message.match(/StreamStopped\((.+)\)/) ??
      e.message.match(/StreamReset\((.+)\)/);
    if (match != null) {
      const code = parseInt(match[1]);
      return await this.codeToReason(type, code);
    }
    match = e.message.match(/InvalidStreamState\((.+)\)/);
    if (match != null) {
      // `InvalidStreamState()` returns the stream ID and not any actual error code
      return await this.codeToReason(type, 0);
    }
    return null;
  }
}

export default QUICStream;
