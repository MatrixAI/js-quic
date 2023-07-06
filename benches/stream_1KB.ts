import type * as events from '../src/events';
import type { Host } from '../src/types';
import path from 'path';
import b from 'benny';
import Logger, { formatting, LogLevel, StreamHandler } from '@matrixai/logger';
import { suiteCommon } from './utils';
import QUICServer from '../src/QUICServer';
import * as testsUtils from '../tests/utils';
import QUICClient from '../src/QUICClient';

async function main() {
  const logger = new Logger(`Stream1KB Bench`, LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  // Setting up initial state
  const data1KiB = Buffer.alloc(1024, 0xf0);
  const host = '127.0.0.1' as Host;
  const tlsConfig = await testsUtils.generateConfig('RSA');

  const quicServer = new QUICServer({
    config: {
      key: tlsConfig.key,
      cert: tlsConfig.cert,
      verifyPeer: false,
      keepAliveIntervalTime: 1000,
    },
    crypto: {
      key: await testsUtils.generateKeyHMAC(),
      ops: {
        sign: testsUtils.signHMAC,
        verify: testsUtils.verifyHMAC,
      },
    },
    logger,
  });
  quicServer.addEventListener(
    'serverConnection',
    async (e: events.QUICServerConnectionEvent) => {
      const conn = e.detail;
      conn.addEventListener(
        'connectionStream',
        (streamEvent: events.QUICConnectionStreamEvent) => {
          const stream = streamEvent.detail;
          void Promise.allSettled([
            (async () => {
              // Consume data
              for await (const _ of stream.readable) {
                // Do nothing, only consume
              }
            })(),
            (async () => {
              // End writable immediately
              await stream.writable.close();
            })(),
          ]);
        },
      );
    },
  );
  await quicServer.start({
    host,
  });
  const client = await QUICClient.createQUICClient({
    config: {
      verifyPeer: false,
    },
    host,
    port: quicServer.port,
    localHost: host,
    crypto: {
      ops: {
        randomBytes: testsUtils.randomBytes,
      },
    },
    logger,
  });

  // Running benchmark
  const summary = await b.suite(
    path.basename(__filename, path.extname(__filename)),
    b.add('send 1Kib of data', async () => {
      const stream = await client.connection.streamNew();
      await Promise.all([
        (async () => {
          // Consume data
          for await (const _ of stream.readable) {
            // Do nothing, only consume
          }
        })(),
        (async () => {
          // Write data
          const writer = stream.writable.getWriter();
          await writer.write(data1KiB);
          await writer.close();
        })(),
      ]);
    }),
    ...suiteCommon,
  );
  await quicServer.stop({ force: true });
  await client.destroy({ force: true });
  return summary;
}

if (require.main === module) {
  void main();
}

export default main;
