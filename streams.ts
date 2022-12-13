import {
  ReadableStream,
  WritableStream,
  TransformStream,
  ByteLengthQueuingStrategy,
  CountQueuingStrategy
} from 'stream/web';

// It seems we could also just implement both readable stream and writable stream
// Promise returning property
// Or async construction...

// We are going to construct the stream
// In this case we know what the bytes are going to be
// They are going to be Uint8Array or we can even support ArrayBuffer

// And we now know what these have to do

// The actual quic stream is a "push source"
// Because data arrives on the socket, we don't ask for it
// Plus we don't actually have an event necessarily
// Instead onmessage is called on the UDP socket
// then that data may translate to data on one of the streams
// Which exact stream that is relevant is another thing you need to check
// By using the `client.conn.readable()`
// That tells you which ones is relevant

// Do we create separate event targets FOR each stream?
// I think we do... every time a stream is created, you create a new event target
// On the other hand iti sp ossible to create 1 event target and separate listeners
// Based on the stream ID

type StreamId = number;

class QUICDataEvent extends Event {
  public detail?: Uint8Array;
  constructor(
    options: EventInit & {
      detail?: Uint8Array
    }
  ) {
    super('data', options);
    this.detail = options.detail;
  }
}


class QUICErrorEvent extends Event {
  public detail: Error;
  constructor(
    options: EventInit & {
      detail: Error
    }
  ) {
    super('error', options);
    this.detail = options.detail;
  }
}

// Let's say the system closes
// How does one even know this?

class QUICEvents extends EventTarget {
  paused: boolean = false;
  // Return type of setTimeout
  source?: ReturnType<typeof setTimeout>;

  public constructor() {
    super();
  }

  public scheduleEvent() {
    this.source = setTimeout(() => {
      this.scheduleEvent();
    }, 100);
    // Immediately dispatches the data
    // This is SYNCHRONOUS - remember that
    // This will end up enqueueing the data
    // And it will end PAUSING the thing
    this.dispatchEvent(
      new QUICDataEvent({
        detail: new Uint8Array([1, 2, 3])
      })
    );
  }

  public pause() {
    clearTimeout(this.source);
    delete this.source;
    this.paused = true;
  }

  public resume() {
    // Resume reading from the socket
    this.paused = false;
    // Reschedule the events... which will immediately dispatch
    if (this.source == null) {
      this.scheduleEvent();
    }
  }

  public destroy() {

  }
}

class QUICStream implements ReadableWritablePair<Uint8Array, Uint8Array> {

  public streamId: number;
  public readable: ReadableStream<Uint8Array>;
  public writable: WritableStream<Uint8Array>;

  // It would end up requiring a new event object for each one
  // Although that might also be easier, if you can just identify by the object
  // And raise it to that level
  // Here one object has multiple things

  public constructor(
    streamId: StreamId,
    events: QUICEvents,
  ) {

    // Use count queuing strategy because
    // the chunks are already properly sized
    // according to the configuration of the QUIC streams
    // we do not need a further byte length queueing strategy here


    this.streamId = streamId;
    // Start is called during construction
    // Pull is called whenever there's room in the readable stream
    // It is called repeatedly until the queue is full
    // It is only called after start is finished
    // If pull doesn't enqueue naything, it won't be called again
    // Cancel is called if the consumer cancels the stream

    // const strategy = new CountQueuingStrategy({ highWaterMark: 1});

    this.readable = new ReadableStream(
      {
        type: 'bytes',
        start(controller) {

          // @ts-ignore
          events.addEventListener('data', (event: QUICDataEvent) => {
            controller.enqueue(event.detail!);

            // The desiredSize would exist right?
            if (controller.desiredSize! <= 0) {
              console.log('DESIRED SIZE IS LESS OR EQUAL THAN 0');
              // Tell the the system to stop reading from the socket
              events.pause();
            }
          });

          // @ts-ignore
          events.addEventListener('error', (event: QUICErrorEvent) => {
            controller.error(event.detail);
          }, { once: true });

          events.addEventListener('end', () => {
            controller.close();
          }, { once: true });

          events.scheduleEvent();

        },
        pull() {
          events.resume();
        },
        cancel() {
          // QUIC events is not a socket
          // it's a virtual abstraction
          // "a derived" event emitter from the UDP socket after processing
          // It's more like an observable really
          events.destroy();
        }
      },
      // This is the default
      // new CountQueuingStrategy({ highWaterMark: 1})
      // strategy
    );
    this.writable = new WritableStream({
      write(chunk) {
        console.log(chunk);
      }
    });
  }
}

async function main () {
  console.log('START');

  const streamId = 1;
  const streamEvents = new QUICEvents();
  const stream = new QUICStream(streamId, streamEvents);

  // const writer = stream.writable.getWriter();
  // writer.write(Buffer.from('A'));
  // // We want this to SEND the data out...
  // // But we still need to enqueue the data

  // // console.log(stream);

  // // Ok so we are able to read something
  const reader = stream.readable.getReader();
  reader.read().then(console.log);
  reader.read().then(console.log);
  reader.read().then(console.log);
  reader.read().then(console.log);
  reader.read().then(console.log);
  reader.read().then(console.log);

  // Because it gets "paused" when the queue is full
  // the data source which is a infinite settimeout loop
  // gets cleared, and there's nothing referencing the event loop and no async operations exist
  // This allows the program to exit
  // The problem was the order of operations

  // console.log('READ', await reader.read());
  // console.log('READ', await reader.read());

  console.log('END');
}

void main();
