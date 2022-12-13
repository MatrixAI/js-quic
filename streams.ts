import { ReadableStream, WritableStream, TransformStream } from 'stream/web';

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

class QUICEvent extends Event {
  public detail?: Uint8Array;
  constructor(
    type: StreamId,
    options: EventInit & {
      detail?: Uint8Array
    }
  ) {
    super(type.toString(), options);
    this.detail = options.detail;
  }
}

// Let's say the system closes
// How does one even know this?
// We would need to indicate the event `data-123` and `close-123`

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
    events: EventTarget,
  ) {
    this.streamId = streamId;
    // Start is called during construction
    // Pull is called whenever there's room in the readable stream
    // It is called repeatedly until the queue is full
    // It is only called after start is finished
    // If pull doesn't enqueue naything, it won't be called again
    // Cancel is called if the consumer cancels the stream
    this.readable = new ReadableStream({
      start(controller) {

        // @ts-ignore
        events.addEventListener('data', (event: QUICEvent) => {
          controller.enqueue(event.detail!);
        });

        events.addEventListener('close', () => {
          controller.close();
        }, { once: true });

      },
    });
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
  const streamEvents = new EventTarget();
  const stream = new QUICStream(streamId, streamEvents);


  const writer = stream.writable.getWriter();
  writer.write(Buffer.from('A'));

  // We want this to SEND the data out...
  // But we still need to enqueue the data

  // console.log(stream);

  // Ok so we are able to read something
  const reader = stream.readable.getReader();
  reader.read().then(console.log);
  reader.read().then(console.log);
  // console.log('READ', await reader.read());
  // console.log('READ', await reader.read());

  console.log('END');
}

void main();
