import b from 'benny';
import { summaryName, suiteCommon } from '../../utils';

async function main() {
  return;
  const summary = await b.suite(
    summaryName(__filename),
    b.add('Buffer.alloc', () => {
      Buffer.alloc(1350);
    }),
    b.add('Buffer.allocUnsafe', () => {
      Buffer.allocUnsafe(1350);
    }),
    b.add('Buffer.allocUnsafeSlow', () => {
      Buffer.allocUnsafeSlow(1350);
    }),
    b.add('Buffer.from subarray', () => {
      const b = Buffer.allocUnsafe(1350);
      return () => {
        Buffer.from(b.subarray(0, b.byteLength));
      };
    }),
    b.add('Buffer.copyBytesFrom', () => {
      const b = Buffer.allocUnsafe(1350);
      return () => {
        Buffer.copyBytesFrom(b, 0, b.byteLength);
      };
    }),
    b.add('Uint8Array', () => {
      new Uint8Array(1350);
    }),
    b.add('Uint8Array slice', () => {
      const b = new Uint8Array(1350);
      return () => {
        b.slice(0, b.byteLength);
      };
    }),
    ...suiteCommon,
  );
  return summary;
}

if (require.main === module) {
  void main();
}

export default main;
