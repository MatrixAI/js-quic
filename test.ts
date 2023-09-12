async function sleep(ms: number): Promise<void> {
  return await new Promise<void>((r) => setTimeout(r, ms));
}

async function run() {
  let c;
  let p;
  let resolve;
  let reject;
  // .catch((e) => {
  //   console.log('woopydoo');
  // });
  const stream = new ReadableStream({
    async start(controller) {
      c = controller;
      console.log('Stream started');
    },
    async pull(controller) {
      // controller.error(new Error('oh no'));
      // controller.enqueue('blah');
      // throw new Error('oh no');
      // console.log('Pull called');
      // p = new Promise((res, rej) => {
      //   resolve = res;
      //   reject = rej;
      // });
      // try {
      //   await p;
      // } catch (e) {
      //   console.log('ERROR!!!');
      //   throw e;
      // }
      // console.log('WAITED');
      // throw new Error('An error occurred in pull');
    },
    async cancel(r) {
      // So we get the reason here
      // But the stream isn't actually cancelled!
      // It's cause the error doesn't have anything to do with the reader
      // We have deliberately shutdown the reader...
      // And thus a reader should not throw an error!!!
      // console.log('called cancel', r.name);
      // reject?.(r);
      // if (reject) reject(r);
    }
  });

  // You cannot cancel if the reader  is locked on it

  const reader = stream.getReader();



  // await stream.cancel('oh no');

  try {
    await reader.cancel(new Error('oh no'));
    c.error(new Error('oh no'));
    // await stream.cancel(new Error('oh no'));
    // await reader.read();

    // await sleep(1);

    // // If you were able to cancel before read actually executed, then it pull is never executed
    // // If you end up cancelling AFTER pull is executed, it does in fact reject on the promise
    // // Which throws it up, but the error is discarded
    // // So instead... if you just don't bother rejecting at all
    // // Then the pull method just gets garbage collected
    // reader.cancel(new Error('SOMETHING HAPPENED'));

  } catch (e) {
    console.log('Caught an exception while reading:', e);
  }

  console.log('ALL GOOD');

  // // Trying to read again will yield the same error.
  // try {
  //   const { value, done } = await reader.read();
  // } catch (e) {
  //   console.log('Caught another exception:', e);
  // }
}

run();
