import type QUICConnection from './QUICConnection.js';
import type Logger from '@matrixai/logger';
import { WritableStream, ReadableStream } from 'stream/web';
import { firstValueFrom, ReplaySubject, Subject } from 'rxjs';
import * as utils from './utils.js';
import { Shutdown } from './native/index.js';

const CHECK_STATES = true;
const CHUNK_SIZE = 1024;

class QUICStream {
  public readonly writable: WritableStream<Buffer>;
  public readonly readable: ReadableStream<Buffer>;
  public readonly readReady$: Subject<void> = new Subject();
  public readonly writeReady$: Subject<void> = new Subject();
  protected writableAborted = false;
  protected readableCancelled = false;

  protected writableStart: UnderlyingSinkStartCallback = () => {
    this.logger.warn(`start WritableStream ${this.id}`);
  };
  protected writableWrite: UnderlyingSinkWriteCallback<Buffer> = async (
    chunk,
    controller,
  ) => {
    this.logger.warn(`write stream ${this.id} with ${chunk.byteLength} bytes`);
    // Check if capacity matches
    let remaining = chunk;
    while (true) {
      if (this.writableAborted) break;
      if (remaining.byteLength <= 0) break;
      let sentBytes: number | null = null;
      try {
        sentBytes = this.connection.connection.streamSend(
          this.id,
          remaining,
          false,
        );
      } catch (e) {
        console.error('send failed with', e);
        controller.error(e);
        return;
      }
      this.logger.warn(`streamSend ${sentBytes} from stream ${this.id}`);
      if (sentBytes == null) {
        this.logger.warn(
          `write null from stream ${this.id} waiting for more capacity`,
        );
        // No bytes sent, wait for more capacity
        await firstValueFrom(this.writeReady$);
        this.logger.warn(`done waiting for more capacity ${this.id}`);
        continue;
      }
      if (sentBytes < remaining.byteLength) {
        // Partially sent, so we split the buffer
        remaining = remaining.subarray(sentBytes);
        this.logger.warn(
          `partial send of ${sentBytes} bytes from stream ${this.id} with ${remaining.byteLength} bytes remaining`,
        );
        // Wait for more capacity
        this.connection.processSend();
        continue;
      }
      if (sentBytes >= remaining.byteLength) {
        this.logger.warn(
          `full send of ${sentBytes} bytes from stream ${this.id}`,
        );
        console.log('id', this.id);
        this.connection.processSend();
        // Fully sent so break out and wait for more data
        break;
      }
      // Base case, if nothing happened, then we had some undefined logic
      utils.never('unexpected case happened and potential infinite loop');
    }
    this.logger.warn(`done writing pass for stream ${this.id}`);
  };
  protected writableClose: UnderlyingSinkCloseCallback = () => {
    this.logger.warn(`close stream ${this.id}`);
    this.connection.connection.streamSend(this.id, Buffer.alloc(0), true);
    this.connection.processSend();
  };
  protected writableAbort: UnderlyingSinkAbortCallback = (reason) => {
    this.logger.warn(`abort stream ${this.id} with reason ${reason}`);
    this.connection.connection.streamShutdown(this.id, Shutdown.Write, 42);
    this.writableAborted = true;
    this.writeReady$.next();
    this.connection.processSend();
  };
  protected readableStart: UnderlyingSourceStartCallback<Buffer> = () => {
    this.logger.warn(`start ReadableStream ${this.id}`);
  };
  protected readablePull: UnderlyingSourcePullCallback<Buffer> = async (
    controller,
  ) => {
    this.logger.warn(`pull ReadableStream ${this.id}`);
    // Attempt to read from the connection
    let chunks = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
      const result = this.connection.connection.streamRecv(this.id, buffer);
      if (result == null) {
        this.logger.warn(`read null from stream ${this.id}`);
        // If we enqueued any chunks then we need to wait for the readableStream to drain
        this.checkState();
        if (chunks > 0) break;
        // If no chunks queued then wait for more data
        await firstValueFrom(this.readReady$);
        continue;
      }
      const [bytesRead, finished] = result;
      this.logger.warn(
        `read ${bytesRead} bytes from stream ${this.id} with finished ${finished}`,
      );
      if (bytesRead > 0) controller.enqueue(buffer.subarray(0, bytesRead));
      chunks++;
      this.checkState();
      if (finished) {
        controller.close();
        this.logger.warn(`WE'RE DONE, GO HOME`);
        break;
      }
    }
  };
  protected readableCancel: UnderlyingSourceCancelCallback = () => {
    this.logger.warn(`cancel ReadableStream ${this.id}`);
    this.connection.connection.streamShutdown(this.id, Shutdown.Read, 42);
    this.writableAborted = true;
    this.connection.processSend();
  };

  constructor(
    public readonly id: number,
    public readonly connection: QUICConnection,
    protected logger: Logger,
  ) {
    this.writable = new WritableStream<Buffer>({
      start: this.writableStart,
      write: this.writableWrite,
      close: this.writableClose,
      abort: this.writableAbort,
    });
    this.readable = new ReadableStream<Buffer>({
      start: this.readableStart,
      pull: this.readablePull,
      cancel: this.readableCancel,
    });
    this.readReady$.subscribe(() => {
      this.logger.warn(`read ready ${this.id}`);
    });
    this.writeReady$.subscribe(() => {
      this.logger.warn(`write ready ${this.id}`);
    });

    this.readable$.subscribe(() =>
      this.logger.warn(`CHANGED readable$ ${this.id}`),
    );
    this.writable$.subscribe(() =>
      this.logger.warn(`CHANGED writable$ ${this.id}`),
    );
    this.finished$.subscribe(() =>
      this.logger.warn(`CHANGED finished$ ${this.id}`),
    );
  }

  protected checkState() {
    void this.isFinished;
    void this.isReadable;
    void this.isWritable;
  }

  protected isFinished_ = false;
  public readonly finished$: ReplaySubject<void> = new ReplaySubject(1);
  public get isFinished(): boolean {
    if (
      !this.isFinished_ &&
      this.connection.connection.streamFinished(this.id)
    ) {
      // Update and dispatch
      this.isFinished_ = true;
      this.finished$.next();
    }
    return this.isFinished_;
  }

  protected isReadable_ = false;
  public readonly readable$: ReplaySubject<boolean> = new ReplaySubject(1);
  public get isReadable(): boolean {
    const value = this.connection.connection.streamReadable(this.id);
    if (this.isReadable_ !== value) {
      // Update and dispatch
      this.readable$.next(value);
    }
    this.isReadable_ = value;
    return value;
  }

  protected isWritable_ = false;
  public readonly writable$: ReplaySubject<boolean> = new ReplaySubject(1);
  public get isWritable(): boolean {
    const value = this.connection.connection.streamReadable(this.id);
    if (this.isWritable_ !== value) {
      // Update and dispatch
      this.writable$.next(value);
    }
    this.isWritable_ = value;
    return value;
  }
}

export default QUICStream;
