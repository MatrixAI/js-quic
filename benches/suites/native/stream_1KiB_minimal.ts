import b from 'benny';
import Logger, { LogLevel, StreamHandler, formatting } from '@matrixai/logger';
import * as utils from '@/utils';
import * as testsUtils from '../../../tests/utils';
import { summaryName, suiteCommon } from '../../utils';
import { Connection, quiche } from '@/native';
import { buildQuicheConfig, clientDefault, serverDefault } from '@/config';
import QUICConnectionId from '@/QUICConnectionId';
import { Host, Port } from '@';

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

function setupStreamState(
  connectionSource: Connection,
  connectionDestination: Connection,
  streamId: number,
) {
  const message = Buffer.from('Message');
  connectionSource.streamSend(streamId, message, false);
  sendPacket(connectionSource, connectionDestination);
  sendPacket(connectionDestination, connectionSource);
  // Clearing message buffer
  const buffer = Buffer.allocUnsafe(1024);
  connectionDestination.streamRecv(streamId, buffer);
}

const setupConnectionsRSA = async () => {

};

async function main() {
  const logger = new Logger(`stream_1KiB Bench`, LogLevel.INFO, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  const data1KiB = Buffer.alloc(1024);
  const tlsConfig = await testsUtils.generateTLSConfig('RSA');
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
  let clientConn: Connection;
  let serverConn: Connection;

  // Setting up connection state
  const clientConfig = buildQuicheConfig({
    ...clientDefault,
    verifyPeer: false,
  });
  const tlsConfigServer = await testsUtils.generateConfig('RSA');
  const serverConfig = buildQuicheConfig({
    ...serverDefault,

    key: tlsConfigServer.key,
    cert: tlsConfigServer.cert,
  });

  // Randomly generate the client SCID
  const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
  await crypto.ops.randomBytes(scidBuffer);
  const clientScid = new QUICConnectionId(scidBuffer);
  clientConn = quiche.Connection.connect(
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
  serverConn = quiche.Connection.accept(
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

  const clientBuf = Buffer.allocUnsafe(1024);

  logger.warn('Starting test');
  const summary = await b.suite(
    summaryName(__filename),
    b.add(
      'send 1Kib of data over QUICStream with minimal operations',
      async () => {
        // Doing nothing - 12 896 010 ops/s, ±1.05%
        clientConn.streamSend(0, data1KiB, false);
        // Just passing data to `streamSend` - 451 088 ops/s, ±1.22% | 2.22 ,, 0.88%
        while(true) {
          const result = clientConn.send(dataBuffer);
          if (result === null) break;
          // Doing clientConn.send inside loop -  89 343 ops/s, ±0.91% | 11.2, 9, 3.6%
        const [serverSendLength, sendInfo] = result;
          serverConn.recv(dataBuffer.subarray(0, serverSendLength), {
            to: sendInfo.to,
            from: sendInfo.from,
          });
          // Passing data to serverConn.recv - 82 360 ops/s, ±1.45% | 12.2, 1, 0.4%
        }
        for (const streamId of serverConn.readable()){
          // Just iterating readable - 17 924 ops/s, ±6.38% | 55.6, 43.4, 17.4%
          while(true) {
            // read and ditch information
            if (serverConn.streamRecv(0, clientBuf) === null) break;
            // Checking streamRecv inside loop - 21 113 ops/s, ±5.68% | 47.6, 35.4, 14.2%
          }
        }
        while(true) {
          const result = serverConn.send(dataBuffer);
          if (result === null) break;
          // Doing serverConn.send inside loop - 19 118 ops/s, ±3.26% | 52.6, 5.0, 2.0%
          const [serverSendLength, sendInfo] = result;
          clientConn.recv(dataBuffer.subarray(0, serverSendLength), {
            to: sendInfo.to,
            from: sendInfo.from,
          });
          // Passing data to clientConn.recv - 3 871 ops/s, ±0.88% | 250, 197.4, 79.0%
        }
      },
    ),
    ...suiteCommon,
  );
  // logger.warn('test done, closing');
  // clientConn.close(true, 0, Buffer.from([]));
  // serverConn.close(true, 0, Buffer.from([]));
  // clientSend();
  // serverSend();
  // logger.warn('waiting for runtimes');
  // await Promise.all([
  //   clientRuntime.finally(() => logger.warn('client runtime ended')),
  //   serverRuntime.finally(() => logger.warn('server runtime ended')),
  // ]);
  // logger.warn('runtimes ended')
  return summary;
}

if (require.main === module) {
  void main();
}

export default main;
