const native = require('../index.node');

console.log(native.plus100(100));

const config = new native.Config();

console.log(config);
console.log(config.verifyPeer(false));
console.log(config.setMaxIdleTimeout(1000));

const connection = new native.Connection(
  config
);

console.log(connection);

const sendData = connection.send();

console.log(sendData);
console.log(sendData.out.length);

const sendData2 = connection.send();

console.log(sendData2);
console.log(sendData2.out.length);

// const config = native.configNew();

// console.log(config);

// console.log(native.configVerifyPeer(config, true));

// console.log(native.configSetMaxIdleTimeout(config, 1000));

// console.log('DONE');
