import { native } from './src';

console.log(native.quiche);

// Build a buffer of random 20 bytes

console.log(native.quiche.negotiateVersion(
  Buffer.allocUnsafe(20),
  Buffer.allocUnsafe(20),
  Buffer.allocUnsafe(1300),
));
