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

function reasonToCode(reason?: any) {
  // The reason to code map must be supplied
  // If it is not a valid reason, we return an unknown reason
  // that is 0
  return 0;
}

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

  protected _sendClosed: boolean = false;
  protected _recvClosed: boolean = false;

  protected _recvPaused: boolean = false;

  protected logger: Logger;

  public static async createStream({
    streamId,
    connection,
    logger = new Logger(`${this.name} ${streamId}`)
  }: {
    streamId: StreamId;
    connection: QUICConnection;
    logger?: Logger;
  }): Promise<QUICStream> {
    logger.info(`Create ${this.name}`);
    const stream = new this({
      streamId,
      connection,
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
      logger,
    }: {
      streamId: StreamId;
      connection: QUICConnection;
      logger: Logger;
    }
  ) {
    super();
    this.logger = logger;
    this.streamId = streamId;
    this.connection = connection;
    this.conn = connection.conn;
    this.streamMap = connection.streamMap;

    // Try the BYOB later, it seems more performant
    let handleReadable : () => void;
    this.readable = new ReadableStream({
      type: 'bytes',
      // autoAllocateChunkSize: 1024,
      start: (controller) => {
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

            console.log('The e', e.message);

            if (e.message === 'Done') {
              // Do nothing if there was nothing to read
              return;
            } else {
              // If there is an error, we do not do anything else
              controller.error(e);

              // I am not sure if this is necessary
              // Let's see what happens
              this.conn.streamShutdown(
                this.streamId,
                quiche.Shutdown.Read,
                reasonToCode(e)
              );

              return;
            }
          }

          console.log('ENQUEUING');

          // It's possible to get a 0-length buffer
          controller.enqueue(buf.subarray(0, recvLength));
          // If fin is true, then that means, the stream is CLOSED
          if (fin) {

            console.log('FINISHED');

            // If the other peer signalled fin
            // we get fin her being true
            // and we close the controller, indicating the closing of the stream

            // IF YOU CLOSE the controller
            // then cancel has no effect
            // therenothing gets called there
            controller.close();

            this.removeEventListener('readable', handleReadable);
            this._recvClosed = true;
            await this.gcStream();

            // You have to do what you would be done
            // in the case of cancellation


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
        this.conn.streamShutdown(
          this.streamId,
          quiche.Shutdown.Read,
          reasonToCode(reason)
        );

        this._recvClosed = true;

        // At this point in the peer side
        // if they were to call `streamFinished()`
        // It would be true
        await this.gcStream();

      }
    });

    this.writable = new WritableStream({
      start: (controller) => {
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
        await this.streamSendFully(Buffer.from([]), true);
        this._sendClosed = true;
        await this.gcStream();
      },
      abort: async (reason?: any) => {
        // Abort can be called even if there are writes are queued up
        // The chunks are meant to be thrown away
        // We could tell it to shutdown
        // This sends a `RESET_STREAM` frame, this abruptly terminates the sending part of a stream
        // The receiver can discard any data it already received on that stream
        // We don't have "unidirectional" streams so that's not important...
        this.conn.streamShutdown(
          this.streamId,
          quiche.Shutdown.Write,
          reasonToCode(reason)
        );

        this._sendClosed = true;
        await this.gcStream();
      }
    });

    // If we shutdown a stream
    // we kind of need to garbage collect the streams
    // in quiche streams are just stream ids
    // but here we are objects
    // we must remove ourselves
    // but how do we know if we are fully closed
    // on the read/write?

    // If the child object dies
    // we have to have a destructor
    // that then is called
    // We can use this to "stop" the system
    // and when we do, we remove ourselves from the parent object
    // We could also emit an event to the parent in doing so
    // But that's not really necessary
    // No need to use events when function calls are sufficient
    // Since there's no pub/sub here
    // Each shutdown is one possible way of shutting down
    // Wiat if we are closing

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
   * Explicit destruction of the stream
   */
  public async destroy() {
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
      throw new errors.ErrorQUICStreamLockedAndActive();
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

  protected async gcStream() {
    console.log('===========GC STREAM=============');
    // Only GC this stream if both recv is closed and send is closed
    // Once both sides are closed, this stream is no longer necessary
    // It can now be removed from the active streams
    if (this._recvClosed && this._sendClosed) {
      console.log('===========GC STREAM CALLS DESTROY=============');
      await this.destroy();
    }
  }


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
}

export default QUICStream;
