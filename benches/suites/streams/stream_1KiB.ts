import b from 'benny';
import Logger, { LogLevel, StreamHandler, formatting } from '@matrixai/logger';
import QUICClient from '@/QUICClient';
import QUICServer from '@/QUICServer';
import * as events from '@/events';
import * as utils from '@/utils';
import { summaryName, suiteCommon } from '../../utils';
import * as testsUtils from '../../../tests/utils';

async function main() {
  const logger = new Logger(`stream_1KiB Bench`, LogLevel.DEBUG, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  const data1KiB = Buffer.allocUnsafe(1024);
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
          await stream.writable.abort();
          // Consume until graceful close of readable
          for await (const _ of stream.readable) {
            // Do nothing, only consume
          }
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
  await reader.cancel();
  const summary = await b.suite(
    summaryName(__filename),
    b.add('send 1Kib of data over QUICStream with UDP socket', async () => {
      await writer.write(data1KiB);
    }),
    ...suiteCommon,
  );
  await writer.close();
  await quicClient?.destroy({ force: false });
  await quicServer?.stop({ force: false });
  return summary;
}

if (require.main === module) {
  void main();
}

export default main;
