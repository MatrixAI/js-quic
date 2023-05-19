import path from 'path';
import b from 'benny';
import { suiteCommon } from './utils';

async function main() {
  // Running benchmark
  const summary = b.suite(
    path.basename(__filename, path.extname(__filename)),
    b.add('add 1 + 1', async () => {
      return 1 + 1;
    }),
    b.add('subtract 1 - 1', async () => {
      return 1 - 1;
    }),
    b.add('multiply 1 * 1', async () => {
      return 1 * 1;
    }),
    b.add('divide 1 / 1', async () => {
      return 1 / 1;
    }),
    ...suiteCommon,
  );
  return summary;
}

if (require.main === module) {
  void main();
}

export default main;
