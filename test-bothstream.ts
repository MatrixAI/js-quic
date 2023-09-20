let readableController;
const readableStream = new ReadableStream({
  start(controller) {
    readableController = controller;
    // controller.error(new Error('LOL'))
  },
});

let writableController;
const writableStream = new WritableStream({
  start(controller) {
    writableController = controller;
    // controller.error(new Error('LOL'));
  },
});




async function main() {
  // readableController.close();
  // await readableStream.cancel();
  // This is not entirely syncrhonous
  // void writableStream.close().catch((e) => {
  //   console.log('WRITE', e);
  // });
  // await writableStream.close();
  // await writableStream.abort();

  const reader = readableStream.getReader();
  const writer = writableStream.getWriter();

  // try {
  //   const r = await reader.read();
  //   console.log(r);
  // } catch (e) {
  //   console.log('READ', e.name, e.message);
  // }

  // try {
  //   const r = await reader.read();
  //   console.log(r);
  // } catch (e) {
  //   console.log('READ', e.name, e.message);
  // }

  try {
    const r = await reader.cancel();
    console.log(r, 'succeed');
  } catch (e) {
    console.log('READ', e.name, e.message);
  }

  // try {
  //   await writer.write(Buffer.from('abc'));
  // } catch (e) {
  //   console.log('WRITE', e.name, e.message);
  // }

  // try {
  //   await writer.write(Buffer.from('abc'));
  // } catch (e) {
  //   console.log('WRITE', e.name, e.message);
  // }

  // try {
  //   await writer.close();
  // } catch (e) {
  //   console.log('WRITE', e.name, e.message);
  // }

  // try {
  //   await writer.abort();
  //   console.log('succeed');
  // } catch (e) {
  //   console.log('WRITE', e.name, e.message);
  // }

}

void main();
