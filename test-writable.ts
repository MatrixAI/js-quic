async function run() {
  let resolve;
  let reject;
  let c: WritableStreamDefaultController;

  let writer: WritableStreamDefaultWriter;

  // async function doSomething() {
  //   console.log(await writer.close());
  // }

  const p = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const stream = new WritableStream({
    start: async (controller) => {
      c = controller;
      // console.log('CLOSED!');
    },
    // async write(chunk, controller) {
    //   // controller.error(new Error('oh no!'));
    //   // throw new Error('oh no!');
    //   try {
    //     await p;
    //   } catch (e) {
    //     console.log('ERROR!', e);
    //     throw e;
    //   }
    //   // console.log('writing', chunk);
    // },
    // async close() {

    //   console.log('called close');
    //   // const e = new Error('oh no!');
    //   // c.error(e);
    //   // throw e;
    //   // reject(new Error('it was closed!'));
    // },
    // async abort() {
    //   console.log('called abort');
    //   // const e = new Error('it was aborted!');
    //   // reject(e);
    //   // return;
    // }
  });



  // writer.closed

  try {

    await stream.close();
    console.log('??');
    writer = stream.getWriter();
    console.log('first');
    await writer.write('abc');
    console.log('second');

    // await writer.close();
    // c!.error(new Error("oh no"));

    // await stream.abort(new Error('oh no!'));

    // console.log('?');
    // const writeP = writer.write('abc');
    // console.log('?');
    // await writer.write('abc');
    // console.log('?');
    // // This never resolves!?
    // await closeP;
    // console.log('?');
    // await writeP;

    // await writer.abort();
    // console.log('HERE?');
    // await writeP;
    // console.log('HERE?');

  } catch (e) {
    console.log('BIG ERROR');
    // It's a `TypeError`
    console.log(e.name);
    // It's a message
    console.log(e.message);
    // There's a code `ERR_INVALID_STATE`
  }
  console.log('YAY');
  // await writer.write('balh');

  // try {
  //   await writer.close();
  // } catch (e) {
  //   console.log('??', e.name);
  // }

}

void run();
