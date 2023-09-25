import type { Connection } from '@/native';
import type { Host, Port } from '@';
import b from 'benny';
import * as utils from '@/utils';
import { quiche } from '@/native';
import { buildQuicheConfig, clientDefault, serverDefault } from '@/config';
import QUICConnectionId from '@/QUICConnectionId';
import { summaryName, suiteCommon } from '../../utils';
import * as testsUtils from '../../../tests/utils';

const dataBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);

function sendPacket(
  connectionSource: Connection,
  connectionDestination: Connection,
): boolean {
  const result = connectionSource.send(dataBuffer);
  if (result === null) return false;
  const [serverSendLength, sendInfo] = result;
  connectionDestination.recv(dataBuffer.subarray(0, serverSendLength), {
    to: sendInfo.to,
    from: sendInfo.from,
  });
  return true;
}

async function main() {
  const data1KiB = Buffer.alloc(1024);
  const localHost = '127.0.0.1' as Host;
  const clientHost = {
    host: localHost,
    port: 55555 as Port,
  };
  const serverHost = {
    host: localHost,
    port: 55556,
  };

  const crypto = {
    key: await testsUtils.generateKeyHMAC(),
    ops: {
      sign: testsUtils.signHMAC,
      verify: testsUtils.verifyHMAC,
      randomBytes: testsUtils.randomBytes,
    },
  };

  // Setting up connection state
  const clientConfig = buildQuicheConfig({
    ...clientDefault,
    verifyPeer: false,
  });
  const tlsConfigServer = await testsUtils.generateTLSConfig('RSA');
  const serverConfig = buildQuicheConfig({
    ...serverDefault,

    key: tlsConfigServer.leafKeyPairPEM.privateKey,
    cert: tlsConfigServer.leafCertPEM,
  });

  // Randomly generate the client SCID
  const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
  await crypto.ops.randomBytes(scidBuffer);
  const clientScid = new QUICConnectionId(scidBuffer);
  const clientConn = quiche.Connection.connect(
    null,
    clientScid,
    clientHost,
    serverHost,
    clientConfig,
  );

  const clientBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
  const sendResult = clientConn.send(clientBuffer);
  if (sendResult === null) throw Error('unexpected send fail');
  let [clientSendLength] = sendResult;
  const clientHeaderInitial = quiche.Header.fromSlice(
    clientBuffer.subarray(0, clientSendLength),
    quiche.MAX_CONN_ID_LEN,
  );
  const clientDcid = new QUICConnectionId(clientHeaderInitial.dcid);

  // Derives a new SCID by signing the client's generated DCID
  // This is only used during the stateless retry
  const serverScid = new QUICConnectionId(
    await crypto.ops.sign(crypto.key, clientDcid),
    0,
    quiche.MAX_CONN_ID_LEN,
  );
  // Stateless retry
  const token = await utils.mintToken(clientDcid, clientHost.host, crypto);
  const retryDatagram = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
  const retryDatagramLength = quiche.retry(
    clientScid,
    clientDcid,
    serverScid,
    token,
    clientHeaderInitial.version,
    retryDatagram,
  );

  // Retry gets sent back to be processed by the client
  clientConn.recv(retryDatagram.subarray(0, retryDatagramLength), {
    to: clientHost,
    from: serverHost,
  });

  // Client will retry the initial packet with the token
  const sendResult2 = clientConn.send(clientBuffer);
  if (sendResult2 === null) throw Error('Unexpected send fail');
  [clientSendLength] = sendResult2;

  // Server accept
  const serverConn = quiche.Connection.accept(
    serverScid,
    clientDcid,
    serverHost,
    clientHost,
    serverConfig,
  );
  // Server receives the retried initial frame
  serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
    to: serverHost,
    from: clientHost,
  });

  // Client <-initial- server
  sendPacket(serverConn, clientConn);
  // Client -initial-> server
  sendPacket(clientConn, serverConn);
  // Client <-handshake- server
  sendPacket(serverConn, clientConn);
  // Client -handshake-> server
  sendPacket(clientConn, serverConn);
  // Client <-short- server
  sendPacket(serverConn, clientConn);
  // Client -short-> server
  sendPacket(clientConn, serverConn);
  // Both are established

  // Setting up runtimes

  // Resolved when client receives data
  let clientWaitRecvProm = utils.promise<void>();
  let serverWaitRecvProm = utils.promise<void>();
  const clientBuf = Buffer.allocUnsafe(1024);

  const clientSend = () => {
    let sent = false;
    while (true) {
      if (sendPacket(clientConn, serverConn)) {
        sent = true;
      } else {
        break;
      }
    }
    if (sent) serverWaitRecvProm.resolveP();
  };
  const clientWrite = (buffer: Buffer) => {
    // Write buffer to stream
    clientConn.streamSend(0, buffer, false);
    // Trigger send
    clientSend();
  };
  const clientRuntime = (async () => {
    while (true) {
      await clientWaitRecvProm.p;
      clientWaitRecvProm = utils.promise<void>();
      // Process streams.
      for (const streamId of serverConn.readable()) {
        while (true) {
          // Read and ditch information
          if (clientConn.streamRecv(streamId, clientBuf) === null) break;
        }
      }
      // Process sends.
      clientSend();
      // Check state change,
      if (clientConn.isClosed() || clientConn.isDraining()) break;
    }
  })();

  const serverSend = () => {
    let sent = false;
    while (true) {
      if (sendPacket(serverConn, clientConn)) {
        sent = true;
      } else {
        break;
      }
    }
    if (sent) clientWaitRecvProm.resolveP();
  };

  const serverRuntime = (async () => {
    while (true) {
      await serverWaitRecvProm.p;
      serverWaitRecvProm = utils.promise<void>();
      // Process streams.
      for (const streamId of serverConn.readable()) {
        while (true) {
          // Read and ditch information
          if (serverConn.streamRecv(streamId, clientBuf) === null) break;
        }
      }
      // Process sends.
      serverSend();
      // Check state change,
      if (serverConn.isClosed() || serverConn.isDraining()) break;
    }
  })();

  const summary = await b.suite(
    summaryName(__filename),
    b.add(
      'send 1Kib of data over QUICStream with simple async runtime',
      async () => {
        clientWrite(data1KiB);
      },
    ),
    ...suiteCommon,
  );
  clientConn.close(true, 0, Buffer.from([]));
  serverConn.close(true, 0, Buffer.from([]));
  clientSend();
  serverSend();
  await Promise.all([clientRuntime, serverRuntime]);
  return summary;
}

if (require.main === module) {
  void main();
}

export default main;
