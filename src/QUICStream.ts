import type QUICConnection from './QUICConnection';
import type {
  QUICConfig,
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
  destroyed,
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
@CreateDestroy({
  eventDestroy: events.EventQUICStreamDestroy,
  eventDestroyed: events.EventQUICStreamDestroyed,
})
class QUICStream implements ReadableWritablePair<Uint8Array, Uint8Array> {
  /**
   * For `reasonToCode`, return 0 means "unknown reason"
   * It is the catch-all for codes.
   * So it is the default reason.
   *
   * It may receive any reason for cancellation.
   * It may receive an exception when streamRecv fails!
   *
   * Creation will create stream state locally in quiche.
   * Remote state is not created until data is sent.
   *
   * This happens when...
   * 1. The writable is written to.
   * 2. The readable is cancelled.
   * 3. The writable is aborted.
   * 4. The QUICStream is cancelled.
   *
   * In the case that the stream was ended before data was sent
   * the remote side will create state that has already ended.
   *
   * @internal Only used by {@link QUICConnection} to create a stream.
   */
  public static async createQUICStream({
    type,
    initiated,
    streamId,
    connection,
    config,
    reasonToCode = () => 0,
    codeToReason = (type, code) =>
      new Error(`${type.toString()} ${code.toString()}`),
    logger = new Logger(`${this.name} ${streamId}`),
  }: {
    type: 'bidi' | 'uni';
    initiated: 'local' | 'peer';
    streamId: StreamId;
    connection: QUICConnection;
    config: QUICConfig;
    reasonToCode?: StreamReasonToCode;
    codeToReason?: StreamCodeToReason;
    logger?: Logger;
  }): Promise<QUICStream> {
    logger.info(`Create ${this.name}`);
    const stream = new this({
      type,
      initiated,
      streamId,
      connection,
      config,
      reasonToCode,
      codeToReason,
      logger,
    });
    logger.info(`Created ${this.name}`);
    return stream;
  }

  /**
   * Type of the stream.
   * Currently unidirectional streams is not supported.
   */
  public readonly type: 'bidi' | 'uni';

  /**
   * Stream was initiated by who?
   * Whether the `QUICConnection` is client or server,
   * both can have streams that are either locally initiated or peer initiated.
   */
  public readonly initiated: 'local' | 'peer';

  public readonly streamId: StreamId;
  public readonly readable: ReadableStream<Uint8Array>;
  public readonly writable: WritableStream<Uint8Array>;

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

  protected readableChunk: Buffer;

  // Interestingly the promise, is something that a particular `pull` is awaiting
  // No other pulls are needed!

  protected resolveReadableP?: () => void;
  protected rejectReadableP?: (reason?: any) => void;

  protected resolveWritableP?: () => void;
  protected rejectWritableP?: (reason?: any) => void;

  protected destroyProm = utils.promise();

  /**
   * We expect QUIC stream error in 2 ways.
   * QUIC stream closure of the stream codes.
   * On read side
   * On write side
   * We are able to use exception classes to distinguish things
   * Because it's always about the error itself!A
   * Note that you must distinguish between actual internal errors, and errors on the stream itself
   */
  protected handleEventQUICStreamError = async (evt: events.EventQUICStreamError) => {
    const error = evt.detail;
    this.logger.error(
      `${error.name}${
        'description' in error ? `: ${error.description}` : ''
      }${error.message !== undefined ? `- ${error.message}` : ''}`,
    );
  };

  /**
   * Not sure if this is needed
   */
  protected handleEventQUICStreamCloseRead = async () => {
    if (this._recvClosed && this._sendClosed) {
      if (!this[destroyed] && this[status] !== 'destroying') {
        await this.destroy({ force: true });
      }
    }
  };

  /**
   * Not sure if this is needed
   */
  protected handleEventQUICStreamCloseWrite = async () => {
    if (this._recvClosed && this._sendClosed) {
      if (!this[destroyed] && this[status] !== 'destroying') {
        await this.destroy({ force: true });
      }
    }
  };

  /**
   * @internal
   */
  public constructor({
    type,
    initiated,
    streamId,
    connection,
    config,
    reasonToCode,
    codeToReason,
    logger,
  }: {
    type: 'bidi' | 'uni';
    initiated: 'local' | 'peer';
    streamId: StreamId;
    connection: QUICConnection;
    config: QUICConfig;
    reasonToCode: StreamReasonToCode;
    codeToReason: StreamCodeToReason;
    logger: Logger;
  }) {
    if (type === 'uni') {
      throw new TypeError('Unidirectional streams are not yet supported');
    }
    this.logger = logger;
    this.type = type;
    this.initiated = initiated;
    this.streamId = streamId;
    this.connection = connection;
    this.conn = connection.conn;
    this.streamMap = connection.streamMap;
    this.reasonToCode = reasonToCode;
    this.codeToReason = codeToReason;
    // This will setup the readable chunk buffer with the size set to the
    // configured per-stream buffer size. Note that this doubles the memory
    // usage of each stream due to maintaining both the Rust and JS buffers
    // @ts-ignore - Eventually we will support unidirectional streams
    if (type === 'uni') {
      this.readableChunk = Buffer.allocUnsafeSlow(config.initialMaxStreamDataUni);
    } else if (type === 'bidi' && initiated === 'local') {
      this.readableChunk = Buffer.allocUnsafeSlow(config.initialMaxStreamDataBidiLocal);
    } else if (type === 'bidi' && initiated === 'peer') {
      this.readableChunk = Buffer.allocUnsafeSlow(config.initialMaxStreamDataBidiRemote);
    }
    try {
      // Quiche stream state doesn't yet exist until data is either received
      // or sent on the stream. However in this QUIC library, one may want to
      // create a new stream to use. Therefore in order to maintain consistent
      // closing behaviour, we can prime the stream state in quiche by sending
      // a 0-length message. The data is not actually send to the peer.
      connection.conn.streamSend(streamId, new Uint8Array(0), false);
    } catch (e) {
      // Note that `conn.streamSend` does not throw `Done` when writing
      // a 0-length message
      throw new errors.ErrorQUICStreamCreate(
        'Failed to prime local stream state with a 0-length message',
        { cause: e }
      );
    }
    // Arrow methods are used to ensure that `this` refers to the class instance
    // and not the stream object itself

    // In the below methods you'll notice we trigger `this.connection.send();`
    // In addition to this, we actually need to translate the closure of streams
    // To the outsdie as well, as we may need to trigger destruction of `QUICStream`
    // If both readable side and writable side is closed
    // Right now I've removed the `closeRecvError` and `closeRecv` calls
    // To make it clearer what this is supposed to be doing!
    // And then I'll refactor those and bring them in

    // Actually I think I can change this around
    // QUICConnection pulls on QUICStream
    // But QUICStream pushes events to QUICConnection
    // Rather than QUICStream directly calling back `this.connection.send()`
    // We can have `QUICConnection` listen on events on `QUICStream`
    // And proceed to call `this.send()` internally in the event handler
    // This allows `QUICStream` to avoid knowledge of `QUICConnection`!
    // This works as long as we listen for messages

    // Note that close messages is one of those things
    // But we would need to expand to include events
    // for successful processing of data!

    this.readable = new ReadableStream(
      {
        start: (controller) => {
          this.readableController = controller;
        },
        pull: async (controller) => {
          // Block the pull if the quiche stream is not readable
          if (!this.conn.streamReadable(this.streamId)) {
            const {
              p: readableP,
              resolveP: resolveReadableP,
              rejectP: rejectReadableP
            } = utils.promise();
            // This will act as the signal to continue reading
            // What if it rejects? We could argue that when the stream is cancelled
            // Then anything blocking it should be cancelled too
            this.resolveReadableP = resolveReadableP;
            this.rejectReadableP = rejectReadableP;
            // If this rejects:
            // Case 1 is the stream readable side was closed with `STOP_SENDING`
            // Case 2 which is peer sends `STREAM_RESET` - this is handled afterwards
            // Case 3 is some internal error happened
            // In either case of 1 and 3, the error is thrown upwards
            // The stream enters an errored state, and any reader will
            // get the same exception
            // Note that in case 1, since it is cancelled... it's not necessary to do anything here
            // As the pull method will be blocked, and eventually be garbage collected
            await readableP;
          }
          let recvLength: number, fin: boolean;
          try {
            [recvLength, fin] = this.conn.streamRecv(this.streamId, this.readableChunk);
          } catch (e) {
            if (e instanceof Error) {
              const match = e.message.match(/StreamReset\((.+)\)/);
              if (match != null) {
                const code = parseInt(match[1]);
                const e_ = new errors.ErrorQUICStreamPeerRead(
                  'Peer reset the readable stream',
                  {
                    data: { code },
                    cause: e
                  }
                );
                controller.error(e_);
                this.dispatchEvent(
                  new events.EventQUICStreamError({
                    detail: e_
                  })
                );
                this.dispatchEvent(
                  new events.EventQUICStreamCloseRead({
                    detail: {
                      type: 'peer',
                      code
                    }
                  })
                );
              }
            }
            // In all other cases, this is an internal error
            // Error messages might be `Done`, `InvalidStreamState`
            const e_ = new errors.ErrorQUICStreamInternal(
              'Failed `streamRecv` on the readable stream',
              { cause: e }
            );
            controller.error(e_);
            this.dispatchEvent(
              new events.EventQUICStreamError({
                detail: e_
              })
            );
            // The default code is just `0`, due to the handler
            // If the handler wants to, it should handle the `ErrorQUICStreamInternal`
            this.conn.streamShutdown(
              this.streamId,
              quiche.Shutdown.Read,
              await this.reasonToCode('recv', e_)
            );
            this.dispatchEvent(
              new events.EventQUICStreamCloseRead({
                detail: {
                  type: 'local',
                  code: 0
                }
              })
            );
            this.dispatchEvent(
              new events.EventQUICStreamSend()
            );
            return;
          }
          // If it is 0-length message, the `fin` should be true
          // But even if it isn't, we can just ignore the chunk
          // Readers shouldn't be reading a 0-length message
          if (recvLength > 0) {
            controller.enqueue(this.readableChunk.subarray(0, recvLength));
          }
          // Generally a recv length of 0 will come with a fin being true
          // QUIC stream should not in fact give you a 0-length message with
          // fin being false, however if the implementation is buggy, we just
          // drop that frame
          if (fin) {
            // Reader will receive `{ value: undefined, done: true }`
            controller.close();
            // If fin is true, then that means, the stream is CLOSED
            this.dispatchEvent(
              new events.EventQUICStreamCloseRead({
                detail: { type: 'peer' }
              })
            );
          }
          // Trigger send after processing read
          // You would want to dispatch an event here
          // So that QUICConnection can call this.send to make this work
          // But it's not a close event
          // What could it be?
          // EventQUICStreamSend - event
          // means that data is "enqueued" onto the stream state to be sent
          // would you do then say that, that's true as long
          // it's not a close read or whatever?

          // Basically every time you were to call `send`
          // You dispatch the event instead
          // That saves the error handling to `QUICConnection` instead

          this.dispatchEvent(
            new events.EventQUICStreamSend()
          );
          return;
        },
        // ReadableStream ensures that this method is idempotent
        cancel: async (reason) => {
          const code = await this.reasonToCode('recv', reason);
          const e = new errors.ErrorQUICStreamLocalRead(
            'Closing readable stream locally',
            {
              data: { code },
              cause: reason
            }
          );
          // This rejects the readableP if it exists
          // The pull method may be blocked by `await readableP`
          // When rejected, it will throw up the exception
          // However because the stream is cancelled, then
          // the exception has no effect, and any reads of this stream
          // will simply return `{ value: undefined, done: true }`
          this.rejectReadableP?.(e);
          this.dispatchEvent(
            new events.EventQUICStreamError({
              detail: e
            })
          );
          this.conn.streamShutdown(this.streamId, quiche.Shutdown.Read, code);
          this.dispatchEvent(
            new events.EventQUICStreamCloseRead({
              detail: {
                type: 'local',
                code
              }
            })
          );
          this.dispatchEvent(
            new events.EventQUICStreamSend()
          );
          return;
        },
      },
      new CountQueuingStrategy({
        // Allow 1 buffered message, so we can know when data is desired, and we can know when to un-pause.
        highWaterMark: 1,
      }),
    );

    // Same issue here
    // I need to see how that interacts with everything
    // We are going to write to the system until we can do it

    this.writable = new WritableStream(
      {
        start: (controller) => {
          this.writableController = controller;
        },
        write: async (chunk: Uint8Array, controller: WritableStreamDefaultController) => {
          // What if you were to write 0 chunks?
          // If you write 0 bytes, nothing happens
          // Cause there's no such thing as a 0 byte chunk
          // We would not send a 0 byte chunk length to the outside world
          // It would only initialise local state

          if (chunk.byteLength === 0) {
            return;
          }

          // This should be a while loop
          try {
            while (true) {
              const sentLength = this.conn.streamSend(this.streamId, chunk, false);

              // Every time this succeeds, we need to dispatch
              this.dispatchEvent(
                new events.EventQUICStreamSend()
              );

              // Every time the sent length is less than the input length, then we must waiA
              if (sentLength < chunk.byteLength) {
                // Cause that means we still have data left to send, and we should
                // send in the remaining data afterwards by subtracting the sent length

              } else {
                // Nothing to do, we can return here
                return;
              }
            }
          } catch (e) {
            if (e.message === 'Done') {
              // In such a case, we have to wait as well
              // As that means there's no capacity
              // That means nothing got written
              // It's the same as sent length < chunk.bytelength
            } else {
              // We have issues here
              // InvalidStreamState
              // StreamStopped
              // Other possible issues
              // Handle all those cases
            }
          }



          // This is a synchronous call btw!
          // Is it possible that this call doesn't occur
          // And the stream is already closed?
          // If it is already closed, then we will get a `InvalidStreamState`
          // I wonder if that's possible
          // I think it is possible since someone might keep a reference to this stream
          // And try to write to it...
          // But if it is closed, they shouldn't be able to write to it

          let writable: boolean;
          try {
            writable = this.conn.streamWritable(this.streamId, chunk.byteLength);
          } catch (e) {
            if (e instanceof Error) {
              let match: RegExpMatchArray | null;
              if (e.message === 'InvalidStreamState') {
                // Stream is closed already!!!
                // Cause someone might hold onto the stream and try to write to ti
                // It's a bit weird... but it could happen
                // We consider this an internal error unfortunately!?
                const e_ = new errors.ErrorQUICStreamLocalWrite(
                  'Local stream writable is already closed',
                  { cause: e }
                );
                controller.error(e_);
                this.dispatchEvent(
                  new events.EventQUICStreamError({
                    detail: e_
                  })
                );
                this.dispatchEvent(
                  new events.EventQUICStreamCloseWrite({
                    detail: {
                      type: 'local',
                    }
                  })
                );
                // No need to dispatch send
                return;
              } else if (
                (match = e.message.match(/StreamStopped\((.+)\)/)) != null
              ) {
                // Stream was stopped by the peer
                const code = parseInt(match[1]);
                const e_ = new errors.ErrorQUICStreamPeerWrite(
                  'Peer stopped the writable stream',
                  {
                    data: { code },
                    cause: e
                  }
                );
                controller.error(e_);
                this.dispatchEvent(
                  new events.EventQUICStreamError({
                    detail: e_
                  })
                );
                this.dispatchEvent(
                  new events.EventQUICStreamCloseWrite({
                    detail: {
                      type: 'peer',
                      code
                    }
                  })
                );
                // No need to dispatch send
                return;
              }
            }
            // All other situations is a software error!
            throw e;
          }
          if (!writable) {
            const {
              p: writableP,
              resolveP: resolveWritableP,
              rejectP: rejectWritableP
            } = utils.promise();
            this.resolveWritableP = resolveWritableP;
            this.rejectWritableP = rejectWritableP;
            // Closes and writes has to be basically mutually exclusive
            // It's important to understand that `close` is in fact mutually exclusive
            // to the write operation here. So you cannot call `close` while this write
            // is blocked on `writableP`. The close method won't even execute while the
            // the write is still blocked on `writableP`. Therefore the only rejections here
            // can come from abort operation, and internal errors!
            await writableP;
          }

          // If upon waiting for it to be writable
          // Then arguably it is in fact writable
          // But it's possible that we are never writable...
          // Like what if 2 bytes were released, but we wanted to write 10 bytes
          // So actually this is still potentially a problem
          // The length of bytes may be less
          // So really we should be doing this until it is `Done`
          // Consider that we should be "chunking" this
          // By writing the chunk, and whatever we can into this
          // I think this is wrong
          // We should be using this to chunk the data into the stream!!
          // Multiple streams may have this ability
          this.conn.streamSend(this.streamId, chunk, false);

          this.dispatchEvent(
            new events.EventQUICStreamSend()
          );
          return;
        },
        /**
         * This is mutually exclusive with write.
         * It will be serialised!
         */
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

  // /**
  //  * This will trigger the shutdown of the quiche read stream.
  //  * The reason is converted to a code, and sent in a `STOP_SENDING` frame.
  //  * Will close the readable stream with the given reason.
  //  */
  // protected async closeRecvError(reason: any) {
  //   this.logger.debug(`recv closed with error ${reason.message}`);
  //   if (this._recvClosed) return;
  //   try {
  //     const code = await this.reasonToCode('send', reason);
  //     // This will send a `STOP_SENDING` frame with the code
  //     // When the other peer sends, they will get a `StreamStopped(u64)` exception
  //     this.conn.streamShutdown(this.streamId, quiche.Shutdown.Read, code);
  //     // we need to send after a shutdown but that's handled in the web streams or connection processing
  //   } catch (e) {
  //     // Ignore if already shutdown
  //     if (e.message !== 'Done') throw e;
  //   }
  //   this.readableController.error(reason);
  //   await this.closeRecv();
  // }

  // /**
  //  * This is used to indicate that the recv has closed.
  //  * It will trigger destruction of the stream if both readable and writable has ended.
  //  */
  // protected async closeRecv(): Promise<void> {
  //   // Further closes are NOPs
  //   if (this._recvClosed) return;
  //   this.logger.debug(`Close Recv`);
  //   // Indicate that the receiving side is closed
  //   this._recvClosed = true;
  //   if (this._recvClosed && this._sendClosed) {
  //     // Only destroy if we are not already destroying
  //     // and that both recv and send is closed
  //     this.destroyProm.resolveP();
  //     if (this[status] !== 'destroying') await this.destroy();
  //   }
  //   this.logger.debug(`Closed Recv`);
  // }

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
