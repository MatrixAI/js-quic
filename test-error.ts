import net from 'net';

async function main() {
  const server = net.createServer((conn) => {
    console.log(conn);
  });
  server.listen(55555, () => {
    server.emit('error');
    // server.emit('error');
  });
  server.once('error', () => {
    console.log('error');
  });
}

void main();

  // // const et = new EventTarget();
  // // et.dispatchEvent(new Event('error'));

  // const ee = new events.EventEmitter();
  // // ee.on('x', () => {
  // //   console.log('yea?');
  // // });
  // // ee.emit('x', 'abc');

  // ee.emit('error');
// import events from 'events';
