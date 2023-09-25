import type { Host, Port, QUICStream } from '@';
import type { Connection } from '@/native';
import b from 'benny';
import Logger, { LogLevel, StreamHandler, formatting } from '@matrixai/logger';
import QUICClient from '@/QUICClient';
import QUICServer from '@/QUICServer';
import * as events from '@/events';
import * as utils from '@/utils';
import { quiche } from '@/native';
import { buildQuicheConfig, clientDefault, serverDefault } from '@/config';
import QUICConnectionId from '@/QUICConnectionId';
import { summaryName, suiteCommon } from '../../utils';
import * as testsUtils from '../../../tests/utils';

async function main() {
  const logger = new Logger(`stream_1KiB Bench`, LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);

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

  let test1Cleanup: (() => Promise<void>) | undefined;
  const test1 = async () => {
    const data1KiB = Buffer.alloc(1024);
    const tlsConfig = await testsUtils.generateTLSConfig('RSA');
    const quicServer = new QUICServer({
      config: {
        verifyPeer: false,
        key: tlsConfig.leafKeyPairPEM.privateKey,
        cert: tlsConfig.leafCertPEM,
      },
      crypto: {
        key: await testsUtils.generateKeyHMAC(),
        ops: {
          sign: testsUtils.signHMAC,
          verify: testsUtils.verifyHMAC,
        },
      },
      logger: logger.getChild('QUICServer'),
    });
    let serverStream: QUICStream | undefined;
    quicServer.addEventListener(
      events.EventQUICServerConnection.name,
      (evt: events.EventQUICServerConnection) => {
        const connection = evt.detail;
        connection.addEventListener(
          events.EventQUICConnectionStream.name,
          async (evt: events.EventQUICConnectionStream) => {
            const stream = evt.detail;
            serverStream = stream;
            // Graceful close of writable
            process.stderr.write('>>>>>>>>> HANDLING THE QUIC SERVER STREAM\n');
            await stream.writable.close();
            // Consume until graceful close of readable
            for await (const _ of stream.readable) {
              // Do nothing, only consume
            }
            process.stderr.write('<<<<<<<< HANDLED THE QUIC SERVER STREAM\n');
          },
        );
      },
    );
    await quicServer.start();
    const quicClient = await QUICClient.createQUICClient({
      host: utils.resolvesZeroIP(quicServer.host),
      port: quicServer.port,
      config: {
        verifyPeer: false,
      },
      crypto: {
        ops: {
          randomBytes: testsUtils.randomBytes,
        },
      },
      logger: logger.getChild('QUICClient'),
    });

    const clientStream = quicClient.connection.newStream();
    const reader = clientStream.readable.getReader();
    const writer = clientStream.writable.getWriter();

    test1Cleanup = async () => {
      // This should already be done, because it was closed
      await reader?.cancel();
      await writer?.close();
      await clientStream?.closedP;
      await serverStream?.closedP;
      // No need to force, streams should already be closed
      // If your force is true by default, then we are technically force closing streams
      // It will cause an error
      await quicClient?.destroy({ force: false });
      // If the connections are all gone, we shouldn't need to do this
      await quicServer?.stop({ force: false });
    };

    return async () => {
      await writer.write(data1KiB);
    };
  };

  let test2Cleanup: (() => Promise<void>) | undefined;
  const test2 = async () => {
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

    test2Cleanup = async () => {
      clientConn.close(true, 0, Buffer.from([]));
      serverConn.close(true, 0, Buffer.from([]));
      clientSend();
      serverSend();
      await Promise.all([clientRuntime, serverRuntime]);
    };

    return async () => {
      clientWrite(data1KiB);
    };
  };

  let test3Cleanup: (() => Promise<void>) | undefined;
  const test3 = async () => {
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

    const clientBuf = Buffer.allocUnsafe(1024);

    test3Cleanup = async () => {
      clientConn.close(true, 0, Buffer.from([]));
      serverConn.close(true, 0, Buffer.from([]));
    };

    return async () => {
      // Doing nothing - 12 896 010 ops/s, ±1.05%
      clientConn.streamSend(0, data1KiB, false);
      // Just passing data to `streamSend` - 451 088 ops/s, ±1.22% | 2.22 ,, 0.88%
      while (true) {
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
      for (const streamId of serverConn.readable()) {
        // Just iterating readable - 17 924 ops/s, ±6.38% | 55.6, 43.4, 17.4%
        while (true) {
          // Read and ditch information
          if (serverConn.streamRecv(streamId, clientBuf) === null) break;
          // Checking streamRecv inside loop - 21 113 ops/s, ±5.68% | 47.6, 35.4, 14.2%
        }
      }
      while (true) {
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
    };
  };

  const summary = await b.suite(
    summaryName(__filename),
    b.add('send 1Kib of data over QUICStream', test1),
    b.add('send 1Kib of data over native with simple async runtime', test2),
    b.add('send 1Kib of data over native with minimal sync runtime', test3),
    ...suiteCommon,
  );

  await test1Cleanup?.();
  await test2Cleanup?.();
  await test3Cleanup?.();
  return summary;
}

if (require.main === module) {
  void main();
}

export default main;
