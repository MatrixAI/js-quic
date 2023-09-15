import b from 'benny';
import Logger, { LogLevel, StreamHandler, formatting } from '@matrixai/logger';
import QUICClient from '@/QUICClient';
import QUICServer from '@/QUICServer';
import * as events from '@/events';
import * as utils from '@/utils';
import * as suitesUtils from '../utils';
import { summaryName, suiteCommon } from '../../utils';

async function main() {
  const logger = new Logger(`stream_1KiB Bench`, LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  const data1KiB = Buffer.alloc(1024);
  const tlsConfig = await suitesUtils.generateTLSConfig('RSA');
  const quicServer = new QUICServer({
    config: {
      verifyPeer: false,
      key: tlsConfig.leafKeyPairPEM.privateKey,
      cert: tlsConfig.leafCertPEM,
    },
    crypto: {
      key: await suitesUtils.generateKeyHMAC(),
      ops: {
        sign: suitesUtils.signHMAC,
        verify: suitesUtils.verifyHMAC,
      },
    },
    logger,
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
        randomBytes: suitesUtils.randomBytes,
      },
    },
    logger
  });

  const stream = await quicClient.connection.newStream();
  const writer = stream.writable.getWriter();

  const summary = await b.suite(
    summaryName(__filename),
    b.add('send 1Kib of data over QUICStream', async () => {
      // No way to clean up the stream and writer unfortunately inside a bench
      // Ideally we want to want to clean up the stream each time, we run this
      await writer.write(data1KiB);
    }),
    ...suiteCommon,
  );

  await writer.close();
  await quicClient.destroy({ force: true });
  await quicServer.stop({ force: true });
  return summary;
}

if (require.main === module) {
  void main();
}

export default main;
