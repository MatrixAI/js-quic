import type * as events from '../src/events';
import type { Host } from '../src/types';
import path from 'path';
import b from 'benny';
import Logger, { formatting, LogLevel, StreamHandler } from '@matrixai/logger';
import { suiteCommon } from './utils';
import QUICServer from '../src/QUICServer';
import * as testsUtils from '../tests/utils';
import QUICClient from '../src/QUICClient';

const logger = new Logger(`stream_1KiB Bench`, LogLevel.WARN, [
  new StreamHandler(),
]);

async function main() {
  const data1KiB = Buffer.alloc(1024);
  const crypto = {
    key: await testsUtils.generateKeyHMAC(),
    ops: {
      sign: testsUtils.signHMAC,
      verify: testsUtils.verifyHMAC,
      randomBytes: testsUtils.randomBytes,
    },
  };
  const keyPairRSA = await testsUtils.generateKeyPairRSA();
  const certRSA = await testsUtils.generateCertificate({
    certId: '0',
    subjectKeyPair: keyPairRSA,
    issuerPrivateKey: keyPairRSA.privateKey,
    duration: 60 * 60 * 24 * 365 * 10,
  });
  const keyPairRSAPEM = await testsUtils.keyPairRSAToPEM(keyPairRSA);
  const certRSAPEM = testsUtils.certToPEM(certRSA);
  const quicServerConfig = {
    verifyPeer: false,
    key: keyPairRSAPEM.privateKey,
    cert: certRSAPEM,
  };
  const quicServerCrypto = {
    key: await testsUtils.generateKeyHMAC(),
    ops: {
      sign: testsUtils.signHMAC,
      verify: testsUtils.verifyHMAC,
    },
  };
  const quicServer = new QUICServer({
    config: quicServerConfig,
    crypto: quicServerCrypto,
    logger,
  });
  await quicServer.start({
    host: 'localhost',
  });


  // Create a new QUIC connection in the bootstrapping
  // const client = await QUICClient.createQUICClient({
  //   config: {
  //     verifyPeer: false,
  //   },
  //   host,
  //   port: quicServer.port,
  //   localHost: host,
  //   crypto: {
  //     ops: {
  //       randomBytes: testsUtils.randomBytes,
  //     },
  //   },
  //   logger,
  // });



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

  // Running benchmark
  const summary = await b.suite(
    path.basename(__filename, path.extname(__filename)),
    b.add('send 1 KiB of data over UDP', async () => {

    }),
    b.add('send 1 KiB of data over QUICConnection', async () => {
      // how do you do this on just the connection?
      // i don't think it's possible

    }),
    b.add('send 1Kib of data over QUICStream', async () => {
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
