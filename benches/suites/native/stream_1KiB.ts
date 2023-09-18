import b from 'benny';
import Logger, { LogLevel, StreamHandler, formatting } from '@matrixai/logger';
import * as utils from '@/utils';
import * as testsUtils from '../../../tests/utils';
import { summaryName, suiteCommon } from '../../utils';
import { Connection, quiche } from '@/native';
import { buildQuicheConfig, clientDefault, serverDefault } from '@/config';
import QUICConnectionId from '@/QUICConnectionId';
import { Host, Port } from '@';

function sendPacket(
  connectionSource: Connection,
  connectionDestination: Connection,
) {
  const dataBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
  const [serverSendLength, sendInfo] = connectionSource.send(dataBuffer);
  connectionDestination.recv(dataBuffer.subarray(0, serverSendLength), {
    to: sendInfo.to,
    from: sendInfo.from,
  });
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
  let [clientSendLength] = clientConn.send(clientBuffer);
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
  [clientSendLength] = clientConn.send(clientBuffer);

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

  // Setting up runtimes

  // Resolved when client receives data
  let clientWaitRecvProm = utils.promise<void>();
  let serverWaitRecvProm = utils.promise<void>();
  const clientBuf = Buffer.allocUnsafe(1024);

  const clientSend = () => {
    let sent = false;
    while(true) {
      try {
        sendPacket(clientConn, serverConn);
        sent = true;
      } catch {
        break;
      }
    }
    if (sent) serverWaitRecvProm.resolveP();
  }
  const clientWrite = (buffer: Buffer) => {
    // write buffer to stream
    clientConn.streamSend(0, buffer, false);
    // trigger send
    clientSend();
  }
  const clientRuntime = (async () => {
    while (true) {
      await clientWaitRecvProm.p
      clientWaitRecvProm = utils.promise<void>();
      // Process streams.
      for (const streamId of clientConn.readable()) {
        while(true) {
          try {
            // read and ditch information
            clientConn.streamRecv(streamId, clientBuf);
          } catch {
            break;
          }
        }
      }
      // process sends.
      clientSend();
      // check state change,
      if (clientConn.isClosed() || clientConn.isDraining()) break;
    }
  })();

  const serverSend = () => {
    let sent = false;
    while(true) {
      try {
        sendPacket(serverConn, clientConn);
        sent = true;
      } catch {
        break;
      }
    }
    if (sent) clientWaitRecvProm.resolveP();
  }
  const serverRuntime = (async () => {
    while (true) {
      await serverWaitRecvProm.p
      serverWaitRecvProm = utils.promise<void>();
      // Process streams.
      for (const streamId of serverConn.readable()) {
        while(true) {
          try {
            // read and ditch information
            serverConn.streamRecv(streamId, clientBuf);
          } catch {
            break;
          }
        }
      }
      // process sends.
      serverSend();
      // check state change,
      if (serverConn.isClosed() || serverConn.isDraining()) break;
    }
  })();


  logger.warn('Starting test');
  const summary = await b.suite(
    summaryName(__filename),
    b.add(
      'send 1Kib of data over QUICStream',
      async () => {
        clientWrite(data1KiB);
      },
    ),
    ...suiteCommon,
  );
  logger.warn('test done, closing');
  clientConn.close(true, 0, Buffer.from([]));
  serverConn.close(true, 0, Buffer.from([]));
  clientSend();
  serverSend();
  logger.warn('waiting for runtimes');
  await Promise.all([
    clientRuntime.finally(() => logger.warn('client runtime ended')),
    serverRuntime.finally(() => logger.warn('server runtime ended')),
  ]);
  logger.warn('runtimes ended')
  return summary;
}

if (require.main === module) {
  void main();
}

export default main;
