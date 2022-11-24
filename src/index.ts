import { webcrypto } from 'crypto';

const native = require('../index.node');

// function getRandomValues(b: Buffer) {
//   return webcrypto.getRandomValues(b);
//   // return 1;
// }

// console.log(
//   native.createConnectionId(
//     webcrypto.getRandomValues.bind(webcrypto)
//   )
// );

const config = new native.Config();
config.verifyPeer(false);
config.setMaxIdleTimeout(1000);

const connId = Buffer.alloc(native.MAX_CONN_ID_LEN);
webcrypto.getRandomValues(connId);

const connection = native.Connection.connect(
  connId,
  'localhost',
  55551,
  '127.0.0.2',
  55552,
  config,
);

console.log(connection);

// const buf = Buffer.alloc(native.MAX_DATAGRAM_SIZE);

// const [l, info] = connection.send(buf);
// console.log(l, info);
// console.log(buf);

// console.log(sendData.out.length);

// const s2 = connection.send(buf);
// console.log(s2);
// console.log(buf);

// console.log(sendData2);
// console.log(sendData2.out.length);
