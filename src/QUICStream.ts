import type QUICConnection from './QUICConnection';
import type {
  QUICStreamMap,
  StreamId,
  StreamReasonToCode,
  StreamCodeToReason,
  QUICConnectionMetadata,
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
import { never } from './utils';

/**
 * Events:
 * - streamDestroy
 *
 * Swap from using `readable` and `writable` to just function calls.
 * It's basically the same, since it's just the connection telling the stream
 * is readable/writable. Rather than creating events for it.
 */
interface QUICStream extends CreateDestroy {}
@CreateDestroy({
  eventDestroy: events.EventQUICStreamDestroy,
  eventDestroyed: events.EventQUICStreamDestroyed,
})
class QUICStream implements ReadableWritablePair<Uint8Array, Uint8Array> {
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
  protected destroyProm = utils.promise();

  /**
   * For `reasonToCode`, return 0 means "unknown reason"
   * It is the catch-all for codes.
   * So it is the default reason.
   *
   * It may receive any reason for cancellation.
   * It may receive an exception when streamRecv fails!
   *
   * Creation will create stream state locally in quiche. Remote state is not created until data is sent.
   * This happens when...
   * 1. The writable is written to.
   * 2. The readable is cancelled.
   * 3. The writable is aborted.
   * 4. The QUICStream is cancelled.
   *
   * In the case that the stream was ended before data was sent the remote side will create state that has already ended.
   *
   * @internal Only used by {@link QUICConnection} to create a stream.
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
    const stream = new this({
      streamId,
      connection,
      reasonToCode,
      codeToReason,
      logger,
    });
    logger.info(`Created ${this.name}`);
    return stream;
  }

  /**
   * @internal Should only be used by {@link createQUICStream} to create the stream
   * @param streamId - ID of the stream.
   * @param connection - `QUICConnection` the stream was created on.
   * @param reasonToCode
   * @param codeToReason
   * @param logger
   */
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
    this.logger = logger;
    this.streamId = streamId;
    this.connection = connection;
    this.conn = connection.conn;
    this.streamMap = connection.streamMap;
    this.reasonToCode = reasonToCode;
    this.codeToReason = codeToReason;

    // 'send' a 0-len message to initialize stream state in Quiche. No 0-len data is actually sent so this does not
    //  create Peer state.
    try {
      connection.conn.streamSend(streamId, new Uint8Array(0), false);
    } catch (e) {
      // Any errors here are critical and should be investigated.
      throw new errors.ErrorQUICStreamCreationFailed(undefined, { cause: e });
    }

    this.readable = new ReadableStream(
      {
        start: (controller) => {
          this.readableController = controller;
        },
        pull: async (controller) => {
          // If nothing to read then we wait
          if (!this.conn.streamReadable(this.streamId)) {
            const readProm = utils.promise();
            this.resolveReadableP = readProm.resolveP;
            this.logger.debug('readable waiting for more data');
            await readProm.p;
            if (!this.conn.streamReadable(this.streamId)) {
              // If there is nothing to read then we are tying up loose ends,
              // do nothing and return. I don't think this will even happen though.
              return;
            }
            this.logger.debug('readable resuming');
          }

          const buf = Buffer.alloc(1024);
          let recvLength: number, fin: boolean;
          // Read messages until buffer is empty
          try {
            [recvLength, fin] = this.conn.streamRecv(this.streamId, buf);
          } catch (e) {
            this.logger.debug(`Stream recv reported: error ${e.message}`);
            // Done means there is no more data to read
            if (!this._recvClosed && e.message !== 'Done') {
              const reason =
                (await this.processSendStreamError(e, 'recv')) ?? e;
              // If it is `StreamReset(u64)` error, then the peer has closed
              // the stream, and we are receiving the error code
              // If it is not a `StreamReset(u64)`, then something else broke,
              // and we need to propagate the error up and down the stream
              // Only the readable stream needs to end since the quiche stream errored
              this.readableController.error(reason);
              await this.closeRecv();
              // It is possible the stream was cancelled, let's check the writable state;
              try {
                this.conn.streamWritable(this.streamId, 0);
              } catch (e) {
                const match = e.message.match(/InvalidStreamState\((.+)\)/);
                if (match == null) {
                  return never(
                    'Errors besides [InvalidStreamState(StreamId)] are not expected here',
                  );
                }
                this.writableController.error(reason);
              }
            }
            // Trigger send after processing error
            await this.connection.send();
            return;
          }
          this.logger.debug(`stream read ${recvLength} bytes with fin(${fin})`);
          // Check and drop if we're already closed or message is 0-length message
          if (!this._recvClosed && recvLength > 0) {
            controller.enqueue(buf.subarray(0, recvLength));
          }
          // If fin is true, then that means, the stream is CLOSED
          if (fin) {
            await this.closeRecv();
            controller.close();
          }
          // Trigger send after processing read
          await this.connection.send();
        },
        cancel: async (reason) => {
          this.logger.debug(`readable aborted with [${reason.message}]`);
          await this.closeRecvError(reason);
        },
      },
      new CountQueuingStrategy({
        // Allow 1 buffered message, so we can know when data is desired, and we can know when to un-pause.
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
          // Triggering send after processing write
          await this.connection.send();
        },
        close: async () => {
          // Gracefully ends the stream with a 0-length fin frame
          this.logger.debug('sending fin frame');
          await this.streamSend(new Uint8Array(0), true);
          // Close without error
          await this.closeSend();
        },
        abort: async (reason) => {
          // Forces the stream to immediately close with an error. Will trigger a `RESET_STREAM` frame to be sent to
          //  the peer. Any buffered data is discarded.
          await this.closeSendError(reason);
        },
      },
      {
        // Allow 1 buffered 'message', Buffering is handled via quiche
        highWaterMark: 1,
      },
    );
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
  public get sendClosed(): boolean {
    return this._sendClosed;
  }

  /**
   * Returns true if the readable has closed.
   */
  public get recvClosed(): boolean {
    return this._recvClosed;
  }

  /**
   * A promise that resolves once this `QUICStream` has ended.
   */
  public get destroyedP() {
    return this.destroyProm.p;
  }

  /**
   * This method can be arrived top-down or bottom-up:
   *
   * 1. Top-down control flow - means explicit destruction from QUICConnection
   * 2. Bottom-up control flow - means stream events from users of this stream
   *
   * If force is true then this will trigger destruction and await for the `QUICStream` to end.
   * If force is false then it will just wait for the `QUICStream` to end.
   */
  public async destroy({
    force = false,
  }: {
    force?: boolean;
  } = {}) {
    this.logger.info(`Destroy ${this.constructor.name}`);
    // Force close any open streams
    if (force) this.cancel(new errors.ErrorQUICStreamClose());
    await this.destroyProm.p;
    this.logger.info(`Destroyed ${this.constructor.name}`);
  }

  /**
   * Will trigger the destruction of the `QUICStream` if the readable or writable haven't closed, yet they will be forced
   * closed with `reason` as the error.
   * If streams have already closed then this will do nothing.
   * This is synchronous by design but cancelling will happen asynchronously in the background.
   */
  public cancel(reason?: any): void {
    reason = reason ?? new errors.ErrorQUICStreamCancel();
    void Promise.all([
      !this._recvClosed ? this.closeRecvError(reason) : undefined,
      !this._sendClosed ? this.closeSendError(reason) : undefined,
    ]).then(async () => {
        // triggering send after destruction
        await this.connection.send();
    });
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
  public async read(): Promise<void> {
    // If we're readable then we need to un-pause the readable stream.
    // We also need to check for an early end condition here.
    this.logger.debug(`desired size ${this.readableController.desiredSize}`);
    if (this.conn.streamFinished(this.streamId)) {
      this.logger.debug(
        'stream is finished and readable, processing end condition',
      );
      // If we're finished and read was called then we need to read out the last message
      // to check if it's a fin frame or an error.
      // This duplicates some of the pull logic for processing an error or a fin frame.
      // No actual data is expected in this case.
      const buf = Buffer.alloc(1024);
      let fin: boolean;
      try {
        [, fin] = this.conn.streamRecv(this.streamId, buf);
        if (fin) {
          // Closing the readable stream
          await this.closeRecv();
          this.readableController.close();
        }
      } catch (e) {
        if (e.message !== 'Done') {
          this.logger.debug(`Stream recv reported: error ${e.message}`);
          if (!this._recvClosed) {
            const reason = (await this.processSendStreamError(e, 'recv')) ?? e;
            // Only the readable stream needs to end since the quiche stream errored
            this.readableController.error(reason);
            await this.closeRecv();
            // It is possible the stream was cancelled, let's check the writable state
            try {
              this.conn.streamWritable(this.streamId, 0);
            } catch (e) {
              const match = e.message.match(/InvalidStreamState\((.+)\)/);
              if (match == null) {
                return never(
                  'Errors besides [InvalidStreamState(StreamId)] are not expected here',
                );
              }
              // Only writable stream needs to end since quiche stream errored
              this.writableController.error(reason);
              await this.closeSend();
            }
          }
        }
      }
      // Clean up the readable block so any waiting read can finish
      if (this.resolveReadableP != null) this.resolveReadableP();
    }
    // Check if the readable is waiting for data and resolve the block
    if (
      this.readableController.desiredSize != null &&
      this.readableController.desiredSize > 0
    ) {
      if (this.resolveReadableP != null) this.resolveReadableP();
    }
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
  public async write(): Promise<void> {
    try {
      // Checking if the writable had an error
      this.conn.streamWritable(this.streamId, 0);
    } catch (e) {
      // If it threw an error, then the stream was closed with an error
      // We need to attempt a write to trigger state change and remove stream from writable iterator
      await this.streamSend(Buffer.from('dummy data'), true).catch(() => {});
    }
    // Resolve the write blocking promise
    if (this.resolveWritableP != null) {
      this.resolveWritableP();
    }
  }

  /**
   * This will process sending bytes from the writable stream to quiche.
   *
   * If quiche writable stream has failed in some way then this will process the error and clean up the writable stream.
   *
   * @param chunk - data to be sent.
   * @param fin - Signal if the stream has ended.
   */
  protected async streamSend(chunk: Uint8Array, fin = false): Promise<void> {
    // Check if we have capacity to send. Doing so will signal to quiche how many bytes are waiting and the stream will
    //  not become writable until there is room. So we can wait for the space before sending.
    try {
      // Checking if stream has capacity and wait for room.
      if (!this.conn.streamWritable(this.streamId, chunk.byteLength)) {
        this.logger.debug(
          `stream does not have capacity for ${chunk.byteLength} bytes, waiting for capacity`,
        );
        const { p: writableP, resolveP: resolveWritableP } = utils.promise();
        this.resolveWritableP = resolveWritableP;
        await writableP;
      }

      const sentLength = this.conn.streamSend(this.streamId, chunk, fin);
      // Since we are checking beforehand, we never not send the whole message
      if (sentLength < chunk.byteLength) never();
      this.logger.debug(`stream wrote ${sentLength} bytes with fin(${fin})`);
    } catch (e) {
      // We can fail with an error. Likely a `StreamStopped(u64)` exception indicating the stream has
      //  failed in some way. We need to process the error and propagate it to the web-stream.
      const reason = (await this.processSendStreamError(e, 'send')) ?? e;
      // Only writable stream needs to end since quiche stream errored
      this.writableController.error(reason);
      await this.closeSend();
      // Throws the exception back to the writer
      throw reason;
    }
  }

  /**
   * This will trigger the shutdown of the quiche read stream.
   * The reason is converted to a code, and sent in a `STOP_SENDING` frame.
   * Will close the readable stream with the given reason.
   */
  protected async closeRecvError(reason: any) {
    this.logger.debug(`recv closed with error ${reason.message}`);
    if (this._recvClosed) return;
    try {
      const code = await this.reasonToCode('send', reason);
      // This will send a `STOP_SENDING` frame with the code
      // When the other peer sends, they will get a `StreamStopped(u64)` exception
      this.conn.streamShutdown(this.streamId, quiche.Shutdown.Read, code);
      // we need to send after a shutdown but that's handled in the web streams or connection processing
    } catch (e) {
      // Ignore if already shutdown
      if (e.message !== 'Done') throw e;
    }
    this.readableController.error(reason);
    await this.closeRecv();
  }

  /**
   * This is used to indicate that the recv has closed.
   * It will trigger destruction of the stream if both readable and writable has ended.
   */
  protected async closeRecv(): Promise<void> {
    // Further closes are NOPs
    if (this._recvClosed) return;
    this.logger.debug(`Close Recv`);
    // Indicate that the receiving side is closed
    this._recvClosed = true;
    if (this._recvClosed && this._sendClosed) {
      // Only destroy if we are not already destroying
      // and that both recv and send is closed
      this.destroyProm.resolveP();
      if (this[status] !== 'destroying') await this.destroy();
    }
    this.logger.debug(`Closed Recv`);
  }

  /**
   * This will trigger the shutdown of the quiche writable stream.
   * The reason is converted to a code, and sent in a `RESET_STREAM` frame.
   *
   * This should only be used to trigger the shutdown of the writable stream in response to cancellation or an error.
   */
  protected async closeSendError(reason: any) {
    this.logger.debug(`send closed with error ${reason.message}`);
    try {
      const code = await this.reasonToCode('send', reason);
      // This will send a `RESET_STREAM` frame with the code
      // When the other peer receives, they will get a `StreamReset(u64)` exception
      this.conn.streamShutdown(this.streamId, quiche.Shutdown.Write, code);
      // we need to trigger send after a shutdown but that's handled in the web streams or connection processing
    } catch (e) {
      // Ignore if already shutdown
      if (e.message !== 'Done') throw e;
    }
    this.writableController.error(reason);
    await this.closeSend();
  }

  /**
   * This is used to indicate that the send has closed.
   * It will trigger destruction of the stream if both readable and writable has ended.
   *
   * This should only be used to trigger the shutdown of the readable stream in response to cancellation or an error.
   */
  protected async closeSend(): Promise<void> {
    // Further closes are NOPs
    if (this._sendClosed) return;
    this.logger.debug(`Close Send`);
    // Indicate that the sending side is closed
    this._sendClosed = true;
    if (this._recvClosed && this._sendClosed) {
      // Only destroy if we are not already destroying
      // and that both recv and send is closed
      this.destroyProm.resolveP();
      if (this[status] !== 'destroying') await this.destroy();
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
      return never('Should never reach an [InvalidState(StreamId)] error');
    }
    return null;
  }
}

export default QUICStream;
