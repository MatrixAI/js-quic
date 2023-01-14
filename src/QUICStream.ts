import type { QUICStreamMap, StreamId } from './types';
import type { Connection } from './native/types';
import Logger from '@matrixai/logger';
import { ReadableStream, WritableStream, } from 'stream/web';
import {
  CreateDestroy,
  ready,
} from '@matrixai/async-init/dist/CreateDestroy';
import { quiche } from './native';
import type QUICConnection from './QUICConnection';

function reasonToCode(reason?: any) {
  // The reason to code map must be supplied
  // If it is not a valid reason, we return an unknown reason
  // that is 0
  return 0;
}

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

  public get sendClosed(): boolean {
    return this._sendClosed;
  }

  public get recvClosed(): boolean {
    return this._recvClosed;
  }

  public get recvPaused(): boolean {
    return this._recvPaused;
  }

  public constructor(
    {
      streamId,
      connection,
      logger,
    }: {
      streamId: StreamId;
      connection: QUICConnection;
      logger?: Logger;
    }
  ) {
    super();
    this.logger = logger ?? new Logger(this.constructor.name);
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
        handleReadable = () => {
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
          // It's possible to get a 0-length buffer
          controller.enqueue(buf.subarray(0, recvLength));
          // If fin is true, then that means, the stream is CLOSED
          if (fin) {

            // If the other peer signalled fin
            // we get fin her being true
            // and we close the controller, indicating the closing of the stream

            controller.close();
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
      cancel: (reason) => {
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
        this.gcStream();


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
        // Send an empty buffer and also `true` to indicate that it is finished!
        await this.streamSendFully(Buffer.from([]), true);
        this._sendClosed = true;
        this.gcStream();
      },
      abort: (reason?: any) => {
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
        this.gcStream();
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

  protected gcStream() {
    // Only GC this stream if both recv is closed and send is closed
    // Once both sides are closed, this stream is no longer necessary
    // It can now be removed from the active streams
    if (this._recvClosed && this._sendClosed) {
      this.streamMap.delete(this.streamId);
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
      // That is equivalent here to being sent lenght of 0
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
   * Explicit destruction of the stream
   * In which case we must stop both the read and write side
   */
  public async destroy() {
    // Cancel the read
    this.readable.cancel();
    // But also graceful stop of the writable
    await this.writable.close();
  }

}

export default QUICStream;
