const readableStream = new ReadableStream({
  start(controller) {
    controller.error(new Error('LOL'))
  },
});

const writableStream = new WritableStream({
  start(controller) {
    controller.error(new Error('LOL'));
  },
});

const reader = readableStream.getReader();

const writer = writableStream.getWriter();

async function main() {

  try {
    const r = await reader.read();
    console.log(r);
  } catch (e) {
    console.log('READ', e.name, e.message);
  }

  try {
    const r = await reader.read();
    console.log(r);
  } catch (e) {
    console.log('READ', e.name, e.message);
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

}

void main();
