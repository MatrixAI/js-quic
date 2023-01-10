// class Y {
//   async f() {
//     console.log('blah');
//     throw new Error('test');
//   }
// }
// const y = new Y();
// await y.f();

class X extends EventTarget {
  async f() {
    throw new Error('test');
  }

  async g(): Promise<string | undefined> {
    this.dispatchEvent(new Event('error'));
    return;
  }

  async h() {
    this.dispatchEvent(new Event('error'));
    throw new Error();
  }
}

async function main () {
  const x = new X();
  x.addEventListener('error', (e) => {
    console.log('got the error');
  });

  await x.f().catch(() => {});
  await x.g();

  x.h();

}

void main();
