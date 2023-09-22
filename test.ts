import Logger, { LogLevel, StreamHandler, formatting } from '@matrixai/logger';
import { CryptoError } from './src/native';
import QUICClient from './src/QUICClient';
import QUICServer from './src/QUICServer';
import * as events from './src/events';
import * as utils from './src/utils';
import * as testsUtils from './tests/utils';

// process.on('uncaughtExceptionMonitor', (err, origin) => {
//   console.log('Caught exception:', err);
//   console.log('Exception origin:', origin);
// });

// process.on('unhandledRejection', (reason, promise) => {
//   console.log('Unhandled Rejection at:', promise, 'reason:', reason);
// });

// IT"S AN UNCAUGHT EXCEPTION
process.on('uncaughtException', (err, origin) => {
  console.log('Caught exception:', err);
  console.log('Exception origin:', origin);
  // Custom logic can be added here as well
});

async function main() {
  const logger = new Logger(`stream_1KiB Bench`, LogLevel.INFO, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
      // formatting.format`${formatting.date}-${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  const data1KiB = Buffer.alloc(1024);
  const tlsConfig = await testsUtils.generateTLSConfig('RSA');
  const quicServer = new QUICServer({
    config: {
      verifyPeer: false,
      key: tlsConfig.leafKeyPairPEM.privateKey,
      cert: tlsConfig.leafCertPEM,
      ca: tlsConfig.caCertPEM
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
    // @ts-ignore
    (evt: events.EventQUICServerConnection) => {
      const connection = evt.detail;
      connection.addEventListener(
        events.EventQUICConnectionStream.name,
        // @ts-ignore
        async (evt: events.EventQUICConnectionStream) => {
          const stream = evt.detail;
          // Graceful close of writable
          process.stderr.write('>>>>>>>>> HANDLING THE QUIC SERVER STREAM\n');

          // await stream.writable.abort();

          // try {
          //   await stream.writable.close();
          // } catch (e) {
          //   console.log('ALREADY CLOSED', e.name, e.message);
          // }

          // Consume until graceful close of readable
          try {
            // console.log('waht is this', stream, stream.readable);

            for await (const _ of stream.readable) {
              // Do nothing, only consume
            }
          } catch (e) {
            console.log('FROM THE STREAM', typeof e, e);
            throw e;
          }

          process.stderr.write('<<<<<<<< HANDLED THE QUIC SERVER STREAM\n');
        }
      );
    }
  );

  quicServer.addEventListener(
    events.EventQUICConnectionStopped.name,
    () => {
      console.log('CONNECTION ON SERVER STOPPED');
    }
  );

  await quicServer.start();
  let quicClient: QUICClient;
  try {
    const host = utils.resolvesZeroIP(quicServer.host);
    quicClient = await QUICClient.createQUICClient({
      host: host,
      port: quicServer.port,
      config: {
        verifyPeer: true,
        ca: tlsConfig.caCertPEM
      },
      crypto: {
        ops: {
          randomBytes: testsUtils.randomBytes,
        },
      },
      logger: logger.getChild('QUICClient'),
    });
  } catch (e) {
    console.log('FAILED TO CREATE QUIC CLIENT', e.name, e.data);
    console.log('CRYPTO ERROR', CryptoError[e.data.errorCode]);
    throw e;
  }

  const stream = quicClient.connection.newStream();
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();

  // Remember to test out of order here
  // await reader.cancel();

  // Write some bytes!
  for (let i = 0; i < 100; i++) {
    await writer.write(data1KiB);
  }

  // await writer.close();

  // So let's say you don't allow any time to process the stream closures
  // You go straight to connection closing
  // Then no delay here
  // await testsUtils.sleep(1000);
  // We need to ensure that this in fact works

  // No need to force, streams should already be closed
  // If your force is true by default, then we are technically force closing streams
  // It will cause an error

  // This would mean... that we don't force it... we wait gracefully for the streams to just close
  // And it should still work
  // So graceful closing works
  // await quicClient.destroy({ force: false });

  // What about non-graceful close?
  // What if I force destruction of the QUIC client?
  // Then what?
  // In this case, it won't wait for the streams to be closed gracefully
  // It cancels and aborts the streams
  // And then proceeds to immediately send connection close frame but allows the server to clean up

  // await quicClient.destroy({ force: true, applicationError: false, errorCode: 1 });

  // Ok this works too, and it's because the stream was in fact already closed earlier

  // Now what if we don't wait for the client to destroy?
  // await testsUtils.sleep(1000);
  // In that case client is destroying force
  // Sending out and timing out
  // And the server is process and graceful close
  // It should still work too

  // If the connections are all gone, we shouldn't need to do this
  // await quicServer.stop({ force: false });

  // What if we now try to force it here too?
  // await quicServer.stop({ force: true });
  // It works

  // let's see what happens if we shutdown both at the same time
  // await Promise.all([
  //   quicClient.destroy({ force: true, applicationError: false, errorCode: 1 }),
  //   quicServer.stop({ force: true }),
  // ]);
  // It works

  // What about gracefully stopping both concurrently?
  // await Promise.all([
  //   quicClient.destroy({ force: false }),
  //   quicServer.stop({ force: false }),
  // ]);
  // It works

  // Let's try not closing the streams properly
  // await Promise.all([
  //   quicClient.destroy({ force: true }),
  //   quicServer.stop({ force: true }),
  // ]);
  // That works too, so that will force close stuff

  // What about if graceful close, without closing any of the streams
  console.log('-----------------------------');
  // await Promise.all([
  //   quicClient.destroy({ force: false }),
  //   quicServer.stop({ force: false }),
  // ]);

  //oh boy it is stuck!!
  // It is precisely stuck on quic client destruction
  // because the quic client stream exists
  // but the server does not... funnily enough
  // so the server's connection is immediately started and stopped
  // but the quic stream is still not fully resolved
  // which makes sense here

  await quicClient.destroy({ force: true });

  console.log('I AM DONE WITH THE CLIENT');

  // await quicServer.stop({ force: false });


}

void main();
