import b from 'benny';
import Logger, { LogLevel, StreamHandler, formatting } from '@matrixai/logger';
import QUICClient from '@/QUICClient';
import QUICServer from '@/QUICServer';
import * as events from '@/events';
import * as utils from '@/utils';
import * as testsUtils from '../../../tests/utils';
import { summaryName, suiteCommon } from '../../utils';

async function main() {
  const logger = new Logger(`stream_1KiB Bench`, LogLevel.INFO, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
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
  quicServer.addEventListener(
    events.EventQUICServerConnection.name,
    (evt: events.EventQUICServerConnection) => {
      const connection = evt.detail;
      connection.addEventListener(
        events.EventQUICConnectionStream.name,
        async (evt: events.EventQUICConnectionStream) => {
          const stream = evt.detail;
          // Graceful close of writable
          process.stderr.write('>>>>>>>>> HANDLING THE QUIC SERVER STREAM\n');
          await stream.writable.close();
          // Consume until graceful close of readable
          for await (const _ of stream.readable) {
            // Do nothing, only consume
          }
          process.stderr.write('<<<<<<<< HANDLED THE QUIC SERVER STREAM\n');
        }
      );
    }
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

  const stream = quicClient.connection.newStream();
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();


  const summary = await b.suite(
    summaryName(__filename),
    b.add(
      'send 1Kib of data over QUICStream',
      async () => {
        await writer.write(data1KiB);
      },
    ),
    ...suiteCommon,
  );

  // This should already be done, because it was closed
  await reader.cancel();

  await writer.close();

  await testsUtils.sleep(1000);

  // No need to force, streams should already be closed
  // If your force is true by default, then we are technically force closing streams
  // It will cause an error
  await quicClient.destroy({ force: false });

  await testsUtils.sleep(1000);

  // If the connections are all gone, we shouldn't need to do this
  await quicServer.stop({ force: false });
  return summary;
}

if (require.main === module) {
  void main();
}

export default main;
