const native = require('../index.node');

const config = new native.Config();

// console.log(config);
// console.log(config.verifyPeer(false));
// console.log(config.setMaxIdleTimeout(1000));

const connection = new native.Connection(
  config,
  'localhost',
  55551,
  '127.0.0.2',
  55552
);

// console.log(connection);

const buf = Buffer.alloc(native.MAX_DATAGRAM_SIZE);
const s = connection.send(buf);
console.log(s);
console.log(buf);

// console.log(sendData.out.length);

const s2 = connection.send(buf);
console.log(s2);
console.log(buf);

// console.log(sendData2);
// console.log(sendData2.out.length);
