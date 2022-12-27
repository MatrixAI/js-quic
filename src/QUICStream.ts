import { ReadableStream, WritableStream, } from 'stream/web';
import { quiche } from './native';
import type { StreamId } from './types';
import type { Connection } from './native/types';

function reasonToCode(reason?: any) {
  // The reason to code map must be supplied
  // If it is not a valid reason, we return an unknown reason
  // that is 0
  return 0;
}

class QUICStream extends EventTarget implements ReadableWritablePair<Uint8Array, Uint8Array> {

  public streamId: StreamId;
  public readable: ReadableStream<Uint8Array>;
  public writable: WritableStream<Uint8Array>;

  protected connection: Connection;

  public constructor(
    connection: Connection,
    streamId: StreamId,
  ) {
    super();
    this.streamId = streamId;

    // Try the BYOB later, it seems more performant
    let handleReadable : () => void;
    this.readable = new ReadableStream({
      type: 'bytes',
      // autoAllocateChunkSize: 1024,
      start(controller) {
        handleReadable = () => {
          if (this._recvPaused) {
            // Do nothing if we are paused
            return;
          }
          const buf = Buffer.alloc(1024);
          let recvLength, fin;
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
              return;
            }
          }
          // It's possible to get a 0-length buffer
          controller.enqueue(buf.subarray(0, recvLength));
          // If fin is true, then that means, the stream is CLOSED
          if (fin) {
            controller.close();
            // If finished, we won't bother doing anything else, we finished
            return;
          }
          // Now we paus receiving if the queue is full
          if (controller.desiredSize != null && controller.desiredSize <= 0) {
            this._recvPaused = true;
            // this.pauseRecv();
          }
        };
        this.addEventListener('readable', handleReadable);
      },
      pull() {
        // this.resumeRecv();
        // Unpausese
        this._recvPaused = false;
        // This causes the readable to run again
        // Because the stream was previously readable
        // The pull
        this.dispatchEvent(new Event('readable'));
      },
      cancel(reason) {
        this.removeEventListener('readable', handleReadable);
        this.conn.streamShutdown(
          this.streamId,
          quiche.Shutdown.Read,
          reasonToCode(reason)
        );
      }
    });

    this.writable = new WritableStream({
      start(controller) {
        // Here we start the stream
        // Called when the objectis constructed
        // It should aim to get access to the underlying SINK
        // So what does it really mean here?
        // We have nothing to do here for now
        // Since the server already received a "stream ID"
        // So it already exists, and so it's already ready to be used!!!
      },
      async write(chunk: Uint8Array) {
        await this.streamSendFully(chunk);
      },
      async close() {
        // Send an empty buffer and also `true` to indicate that it is finished!
        await this.streamSendFully(Buffer.from([]), true);
      },
      abort(reason?: any) {
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
      }
    });

  }

  async streamSendFully(chunk, fin = false) {
    // This means that the number of written bytes returned can be lower
    // than the length of the input buffer when the stream doesn’t have
    // enough capacity for the operation to complete. The application
    // should retry the operation once the stream is reported as writable again.
    let sentLength;
    try {
      sentLength = this.connection.streamSend(
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

}

export default QUICStream;
