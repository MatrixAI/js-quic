import type QUICConnection from './QUICConnection';
import type { QUICStreamMap, StreamId } from './types';
import type { Connection } from './native/types';
import Logger from '@matrixai/logger';
import { ReadableStream, WritableStream, } from 'stream/web';
import {
  CreateDestroy,
  ready,
} from '@matrixai/async-init/dist/CreateDestroy';
import { quiche } from './native';
import * as events from './events';
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

  protected connection: QUICConnection;
  protected conn: Connection;
  protected streamMap: QUICStreamMap;

  // QUIC SIDE
  // stream recv
  // stream send

  // WEBSTREAM SIDE
  // stream read
  // stream write


  protected _sendClosed: boolean = false;
  protected _recvClosed: boolean = false;

  protected _recvPaused: boolean = false;

  protected logger: Logger;

  /**
   * Error method of the readable controller
   */
  protected readableControllerError: (error?: any) => void;

  /**
   * Error method of the writable controller
   */
  protected writableControllerError: (error?: any) => void;

  protected shutdownReasonToCode: (reason?: any) => number | PromiseLike<number>;

  /**
   * For `shutdownReasonToCode`, return 0 means "unknown reason"
   * It is the catch all for codes.
   * So it is the default reason.
   *
   * It may receive any reason for cancellation.
   * It may receive an exception when streamRecv fails!
   */
  public static async createStream({
    streamId,
    connection,
    shutdownReasonToCode = () => 0,
    logger = new Logger(`${this.name} ${streamId}`)
  }: {
    streamId: StreamId;
    connection: QUICConnection;
    shutdownReasonToCode?: (reason?: any) => number | PromiseLike<number>;
    logger?: Logger;
  }): Promise<QUICStream> {
    logger.info(`Create ${this.name}`);
    const stream = new this({
      streamId,
      connection,
      shutdownReasonToCode,
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
      shutdownReasonToCode,
      logger,
    }: {
      streamId: StreamId;
      connection: QUICConnection;
      shutdownReasonToCode: (reason?: any) => number | PromiseLike<number>;
      logger: Logger;
    }
  ) {
    super();
    this.logger = logger;
    this.streamId = streamId;
    this.connection = connection;
    this.conn = connection.conn;
    this.streamMap = connection.streamMap;
    this.shutdownReasonToCode = shutdownReasonToCode;



    // Try the BYOB later, it seems more performant
    let handleReadable : () => void;
    this.readable = new ReadableStream({
      type: 'bytes',
      // autoAllocateChunkSize: 1024,
      start: (controller) => {

        this.readableControllerError = controller.error.bind(controller);

        handleReadable = async () => {
          if (this._recvPaused) {
            // Do nothing if we are paused
            return;
          }
          const buf = Buffer.alloc(1024);
          let recvLength: number, fin: boolean;
          try {
            [recvLength, fin] = this.conn.streamRecv(
              this.streamId,
              buf
            );
          } catch (e) {
            if (e.message === 'Done') {
              console.log('Stream reported: done');

              // We need to know why we would even have this?
              // If the handle readable is removed?


              // Do nothing if there was nothing to read

              // If it is done
              // should we consider the same as `fin`?
              // Well usually
              // The `fin` will be true prior
              // And should be `Done`

              return;
            } else {

              console.log('Stream reported: error');

              // If there is an error, we do not do anything else
              controller.error(e);
              this.removeEventListener('readable', handleReadable);
              await this.shutdownRecv(false, true, e);

              // this.shutdownRecv(await this.shutdownReasonToCode(e));
              // this._recvClosed = true;
              // await this.gcStream();

              return;
            }
          }

          // It's possible to get a 0-length buffer
          controller.enqueue(buf.subarray(0, recvLength));

          // If fin is true, then that means, the stream is CLOSED
          if (fin) {

            console.log('Stream reported: fin');

            // If the other peer signalled fin
            // we get fin her being true
            // and we close the controller, indicating the closing of the stream

            // IF YOU CLOSE the controller
            // then cancel has no effect
            // therenothing gets called there
            controller.close();
            this.removeEventListener('readable', handleReadable);
            await this.shutdownRecv(true, false);

            // this._recvClosed = true;
            // await this.gcStream();
            // If finished, we won't bother doing anything else, we finished
            return;
          }
          // Now we paus receiving if the queue is full
          if (controller.desiredSize != null && controller.desiredSize <= 0) {
            this._recvPaused = true;
          }
        };
        this.addEventListener('readable', handleReadable);
      },
      pull: () => {
        // this.resumeRecv();
        // Unpausese
        this._recvPaused = false;
        // This causes the readable to run again
        // Because the stream was previously readable
        // The pull
        this.dispatchEvent(new Event('readable'));
      },
      cancel: async (reason) => {

        console.log('----------THE cancel callback-------');

        this.removeEventListener('readable', handleReadable);
        await this.shutdownRecv(false, true, reason);

        // this.shutdownRecv(await this.shutdownReasonToCode(reason));
        // this._recvClosed = true;
        // await this.gcStream();

      }
    });

    this.writable = new WritableStream({
      start: (controller) => {

        this.writableControllerError = controller.error.bind(controller);

        // When the writable is finished
        // we can tell it to end
        // but to do so

        // Here we start the stream
        // Called when the objectis constructed
        // It should aim to get access to the underlying SINK
        // So what does it really mean here?
        // We have nothing to do here for now
        // Since the server already received a "stream ID"
        // So it already exists, and so it's already ready to be used!!!
      },
      write: async (chunk: Uint8Array) => {
        await this.streamSendFully(chunk);
      },
      close: async () => {
        console.log('----------THE close callback-------');

        // Send an empty buffer and also `true` to indicate that it is finished!

        // await this.streamSendFully(Buffer.from([]), true);
        // this._sendClosed = true;
        // await this.gcStream();

        await this.shutdownSend(false, false);

      },
      abort: async (reason?: any) => {
        // Abort can be called even if there are writes are queued up
        // The chunks are meant to be thrown away
        // We could tell it to shutdown
        // This sends a `RESET_STREAM` frame, this abruptly terminates the sending part of a stream
        // The receiver can discard any data it already received on that stream
        // We don't have "unidirectional" streams so that's not important...

        await this.shutdownSend(false, true, reason);

        // this.conn.streamShutdown(
        //   this.streamId,
        //   quiche.Shutdown.Write,
        //   reasonToCode(reason)
        // );
        // this._sendClosed = true;
        // await this.gcStream();

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
    if (
      (this.readable.locked && !this._recvClosed)
      ||
      (this.writable.locked && !this._sendClosed)
    ) {
      // The `QUICConnection` may then result in a partial destruction,
      // some of its `QUICStream` may be destroyed
      // This means the destruction may need to be retried.
      // However a proper destruction should destroy the users of
      // the `QUICStream` first before destroying the `QUICConnection`.

      // Wait a minute it sort of depends

      if (force) {
        // Force close the streams by erroring out
        if (!this._recvClosed) {
          this.readableControllerError();
          // we need to actually close the quic side
        }
        if (!this._sendClosed) {
          this.writableControllerError();
          // we need to actually close the quic side

        }
      } else {
        throw new errors.ErrorQUICStreamLockedAndActive();
      }
    }
    // If the streams are not locked, and they haven't been closed yet,
    // we can close them here.
    if (!this.readable.locked && !this._recvClosed) {
      console.warn('------ CANCEL READABLE -----');
      await this.readable.cancel();
    }
    if (!this.writable.locked && !this._sendClosed) {
      await this.writable.close();
    }
    this.streamMap.delete(this.streamId);
    this.dispatchEvent(new events.QUICStreamDestroyEvent());
    this.logger.info(`Destroyed ${this.constructor.name}`);
  }

  // TODO
  // Tell it to read
  public read() {
    // The QUICConnection says `stream.read()`
    // unpauses the read
  }

  // TODO
  // Tell it to write
  public write() {
    // The QUICConnection says `stream.write()`
    // unpauses the write
  }

  // protected async gcStream() {
  //   console.log('===========GC STREAM=============');
  //   // Only GC this stream if both recv is closed and send is closed
  //   // Once both sides are closed, this stream is no longer necessary
  //   // It can now be removed from the active streams
  //   if (this._recvClosed && this._sendClosed) {
  //     console.log('===========GC STREAM CALLS DESTROY=============');
  //     await this.destroy();
  //   }
  // }


  protected async streamSendFully(chunk, fin = false) {
    // This means that the number of written bytes returned can be lower
    // than the length of the input buffer when the stream doesn’t have
    // enough capacity for the operation to complete. The application
    // should retry the operation once the stream is reported as writable again.
    let sentLength;
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
      // That is equivalent here to being sent length of 0
      if (e.message === 'Done') {
        sentLength = 0;
      } else {
        throw e;
      }
    }
    if (sentLength < chunk.length) {
      // Could also use a LOCK... but this is sort of the same thing
      // We have to wait for the next event!
      await new Promise((resolve) => {
        this.addEventListener(
          'writable',
          resolve,
          { once: true }
        );
      });
      return await this.streamSendFully(
        chunk.subarray(sentLength)
      );
    }
  }

  /**
   * This is called from events on the stream
   */
  protected async closeRecv(
    isClosed: boolean = false,
    isError: boolean = false,
    reason?: any
  ) {
    this.logger.info(`Close Recv`);
    if (!isClosed) {
      if (isError) {
        const code = await this.shutdownReasonToCode(reason);
        this.conn.streamShutdown(
          this.streamId,
          quiche.Shutdown.Read,
          code
        );
      }
    }
    this._recvClosed = true;
    if (this._recvClosed && this._sendClosed) {
      await this.destroy();
    }
    this.logger.info(`Closed Recv`);
  }

  /**
   * This is called from events on the stream
   */
  protected async closeSend(
    isClosed: boolean = false,
    isError: boolean = false,
    reason?: any
  ) {
    this.logger.info(`Close Send`);
    // If the QUIC stream is already closed
    // there's nothign to do on the QUIC stream
    if (!isClosed) {
      if (isError) {
        // If there is an error, we will shutdown with a code
        const code = await this.shutdownReasonToCode(reason);
        this.conn.streamShutdown(
          this.streamId,
          quiche.Shutdown.Write,
          code
        );
      } else {
        // If there wasn't an error, we will send an empty frame
        // with the `fin` set to true
        await this.streamSendFully(new Uint8Array(), true);
      }
    }
    // Indicate that the sending side is closed
    this._sendClosed = true;
    if (this._recvClosed && this._sendClosed) {
      await this.destroy();
    }
    this.logger.info(`Closed Send`);
  }
}

export default QUICStream;
