import { sleep } from './src/utils';

const writableStream = new WritableStream({
  start(controller) {
    controller.error(new Error('LOL'));
  },
  write(chunk) {
    console.log(`Received chunk: ${chunk}`);
  },
  abort(reason) {
    console.log(`Stream aborted, reason: ${reason}`);
  },
});

const writer = writableStream.getWriter();

async function main() {
  console.log('LOL');

  try {
    await writer.write(Buffer.from('abc'));
  } catch (e) {
    console.log('WRITE', e.name, e.message);
  }
  try {
    await writer.write(Buffer.from('abc'));
  } catch (e) {
    console.log('WRITE', e.name, e.message);
  }
  try {
    await writer.write(Buffer.from('abc'));
  } catch (e) {
    console.log('WRITE', e.name, e.message);
  }


  // try {
  //   console.log(await writer.closed);
  // } catch(e) {
  //   // Closed turns into error
  //   console.log('CLOSED', e.message);
  // }
  // try {
  //   await writer.ready;
  // } catch(e) {
  //   console.log('READY', e.message);
  // }
  // try {
  //   await writer.close();
  // } catch(e) {
  //   console.log('CLOSE', e.name, e.message);
  // }
  // try {
  //   await writer.abort();
  //   console.log('SUCCEEDS');
  // } catch (e) {
  //   console.log('ABORT', e.message);
  // }
  console.log('DONE');
}

void main();
