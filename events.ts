// process.on('uncaughtException', () => {
//   console.log('was uncaught');
// });

async function main() {

  const events = new EventTarget();

  // events.addEventListener('error', (e) => {
  //   console.log('GOT THE E', e);
  // });

  events.addEventListener('abc', (e) => {
    events.dispatchEvent(new Event('error'));
  });

  events.dispatchEvent(new Event('abc'));

}

void main();
