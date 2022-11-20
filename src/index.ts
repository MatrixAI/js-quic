const native = require('../index.node');

// console.log(native.hello());
// console.log(native.getNumCpus());
// console.log(native);

// Here we go, we have the `quiche::Config` object now!
// console.log(native.configInit());
const config = native.configNew();

console.log(native.configVerifyPeer(config, true));

console.log(native.configSetMaxIdleTimeout(config, 1000));

console.log('DONE');
