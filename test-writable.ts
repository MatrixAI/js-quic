import { ReadableStream, WritableStream, TransformStream } from 'stream/web';

async function main () {
  const writableStream = new WritableStream({
    write: async (chunk: Uint8Array) => {
      throw new Error('fail');
    },
  });
  const writer = writableStream.getWriter();
  try {
    await writer.write(new Uint8Array(0));
  } catch (e) {
    console.log(writableStream.locked);
    writer.releaseLock();
    console.log(writableStream.locked);
  }
}

void main();
