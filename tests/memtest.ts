import type { ClientCryptoOps, ServerCryptoOps } from '#types.js';
import Logger, {
  formatting,
  LogLevel,
  StreamHandler,
  tracer,
} from '@matrixai/logger';
import * as events from '#events.js';
import * as utils from '#utils.js';
import * as testsUtils from './utils.js';
import QUICServer from '#QUICServer.js';
import QUICClient from '#QUICClient.js';
import QUICStream from '#QUICStream.js';

const p = (async () => {
  const fs = await import('node:fs');
  const spanFile = await fs.promises.open('span.jsonl', 'w');
  const gen = tracer.streamEvents();
  for await (const event of gen) {
    await spanFile.write(JSON.stringify(event) + '\n');
  }
  await spanFile.close();
})();

const main = async () => {
  const logger = new Logger(`${QUICStream.name} Test`, LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  const localhost = '127.0.0.1';
  const key = await testsUtils.generateKeyHMAC();
  let socketCleanMethods = testsUtils.socketCleanupFactory();
  const serverCrypto: ServerCryptoOps = {
    sign: testsUtils.signHMAC,
    verify: testsUtils.verifyHMAC,
  };
  const clientCrypto: ClientCryptoOps = {
    randomBytes: testsUtils.randomBytes,
  };
  const message = Buffer.from('The Quick Brown Fox Jumped Over The Lazy Dog');
  const connectionEventProm = utils.promise<events.EventQUICServerConnection>();
  const tlsConfig = await testsUtils.generateTLSConfig('RSA');
  const server = new QUICServer({
    crypto: {
      key,
      ops: serverCrypto,
    },
    logger: logger.getChild(QUICServer.name),
    config: {
      key: tlsConfig.leafKeyPairPEM.privateKey,
      cert: tlsConfig.leafCertPEM,
      verifyPeer: false,
    },
  });
  socketCleanMethods.extractSocket(server);
  server.addEventListener(
    events.EventQUICServerConnection.name,
    (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  );
  await server.start({
    host: localhost,
  });
  const client = await QUICClient.createQUICClient({
    host: localhost,
    port: server.port,
    localHost: localhost,
    crypto: {
      ops: clientCrypto,
    },
    logger: logger.getChild(QUICClient.name),
    config: {
      verifyPeer: false,
    },
  });
  socketCleanMethods.extractSocket(client);
  const conn = (await connectionEventProm.p).detail;
  // Do the test
  const activeServerStreams: Array<Promise<void>> = [];
  conn.addEventListener(
    events.EventQUICConnectionStream.name,
    (streamEvent: events.EventQUICConnectionStream) => {
      const stream = streamEvent.detail;
      const streamProm = stream.readable.pipeTo(stream.writable);
      activeServerStreams.push(streamProm);
    },
  );

  // Let's make a new streams.
  for (let i = 0; i < 1000; i++) {
    const stream = client.connection.newStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    // Do write and read messages here.
    await writer.write(message);
    const readMessage = await reader.read();
    if (readMessage.done) {
      logger.error('readMessage is not false!');
      process.exit(1);
    } else if (readMessage.value.toString() != message.toString()) {
      logger.error('readMessage value does not match!');
      process.exit(1);
    }
    await writer.close();
    const value = await reader.read();
    if (!value.done) {
      logger.error('reader is not done!');
      process.exit(1);
    }
  }
  await Promise.all([Promise.all(activeServerStreams)]);

  await client.destroy({ force: true });
  await server.stop({ force: true });
  tracer.endTracing();
  await p;
  console.error('Test passed!');
};

void main();
