
import { quiche } from './src/native';

async function main() {
  // console.log(quiche);
  console.log('Making call')
  // @ts-ignore
  quiche.callThreadsafeFunction((_, num) => console.log(num))
}

void main().then(() => {});
