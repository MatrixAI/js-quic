import { ReadableStream, WritableStream, TransformStream } from 'stream/web';

async function main () {

  let cancelled = false;

  const inputStream = new ReadableStream({
    start(controller) {
      controller.enqueue('Hello ');
      controller.enqueue('World!');
      controller.close();
    },
    cancel: (reason) => {
      console.log('INPUT STREAM CANCELLED');
      cancelled = true;
    }
  });

  const f = inputStream.getReader.bind(inputStream);
  inputStream.getReader = (...args) => {
    console.log('reader is acquired');
    return f(...args);
  };

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk.toUpperCase());
    }
  });

  console.log('Input Stream is locked', inputStream.locked); // false

  const outputStream = inputStream.pipeThrough(
    transformStream,
    {
      preventClose: false,
      preventAbort: false,
      preventCancel: false
    }
  );

  // console.log('Input Stream is locked', inputStream.locked); // true
  // console.log('Output Stream is locked', outputStream.locked); // false

  // const reader = outputStream.getReader();

  // console.log('Input Stream is locked', inputStream.locked); // true
  // console.log('Output Stream is locked', outputStream.locked); // true

  // // await reader.cancel();
  // // await reader.closed;
  // // reader.releaseLock();

  // console.log('Input Stream is locked', inputStream.locked); // true
  // console.log('Output Stream is locked', outputStream.locked); // false

  // // outputStream.cancel();

  // console.log('Input Stream is locked', inputStream.locked); // true
  // console.log('Output Stream is locked', outputStream.locked); // false

  // // @ts-ignore
  // // inputStream.locked = false;

  // // try{
  //   await inputStream.cancel();
  // // } catch (e) {

  // // }

  // // console.log('CANCELLED', cancelled);
  // // if (!cancelled) {
  // //   console.log('Cancelled input stream');
  // // } else {
  // //   console.log('Input stream already cancelled');
  // // }

}

void main();
