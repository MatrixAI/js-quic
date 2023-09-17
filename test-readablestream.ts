const readableStream = new ReadableStream({
  start(controller) {
    controller.error(new Error('LOL'))
  },
});

const reader = readableStream.getReader();

async function main() {

  try {
    const r = await reader.read();
    console.log(r);
  } catch (e) {
    console.log('ERROR', e.name, e.message);
  }

  try {
    const r = await reader.read();
    console.log(r);
  } catch (e) {
    console.log('ERROR', e.name, e.message);
  }

  console.log('DONE');

}

void main();
