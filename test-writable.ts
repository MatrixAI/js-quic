async function run() {
  let resolve;
  let reject;
  const stream = new WritableStream({
    async write(chunk, controller) {
      const p = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      try {
        await p;
      } catch (e) {
        console.log('ERROR!', e);
        throw e;
      }
      console.log('writing', chunk);
    },
    async close() {
      console.log('called close');
      reject(new Error('it was closed!'));
    },
    async abort() {
      console.log('called abort');
    }
  });

  const writer = stream.getWriter();

  try {
    console.log('?');
    const writeP = writer.write('abc');
    console.log('?');
    const closeP = writer.close();
    console.log('?');
    // This never resolves!?
    await closeP;
    console.log('?');
    // await writeP;
  } catch (e) {
    // It's a `TypeError`
    console.log(e.name);
    // It's a message
    console.log(e.message);
    // There's a code `ERR_INVALID_STATE`
  }
}

void run();
