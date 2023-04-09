import type { Crypto, Host, Hostname, Port } from '@/types';
import Logger, { LogLevel, StreamHandler } from '@matrixai/logger';
import QUICClient from '@/QUICClient';
import QUICServer from '@/QUICServer';
import * as events from '@/events';
import * as testsUtils from './utils';

// No need for the the quickcheck yet
// we are testing basic behaviour here
// but we may need some testing structure
// const data = new ArrayBuffer(32);
// await crypto.ops.randomBytes(data);
// console.log(data)
// const signature = await crypto.ops.sign(crypto.key, data);
// console.log(signature);
// const verified = await crypto.ops.verify(crypto.key, data, signature);
// console.log(verified);
// It's time to run a server to test against

describe(QUICClient.name, () => {
  const logger = new Logger(`${QUICClient.name} Test`, LogLevel.WARN, [
    new StreamHandler(),
  ]);
  // This has to be setup asynchronously due to key generation
  let crypto: {
    key: ArrayBuffer;
    ops: Crypto;
  };
  beforeEach(async () => {
    crypto = {
      key: await testsUtils.generateKey(),
      ops: {
        sign: testsUtils.sign,
        verify: testsUtils.verify,
        randomBytes: testsUtils.randomBytes,
      },
    };
  });
  afterEach(async () => {
  });
  test('', async () => {
    const server = new QUICServer({
      crypto,
      logger: logger.getChild(QUICServer.name)
    });
    await server.start({
      host: '::' as Host,
      port: 0 as Port
    });

    console.log('SERVER PORT', server.port);

    server.addEventListener(
      'connection',
      (e: events.QUICServerConnectionEvent) => {
        const conn = e.detail;
        console.log('I GOT A CONNECTION');
        // conn.addEventListener('stream', (e: events.QUICConnectionStreamEvent) => {
        //   const stream = e.detail;
        // }, { once: true });
      },
      { once: true }
    );


    let client;
    try {
      // We have a dual stack server
      // we can actually connect  either way
      // But if we use `::` that doesn't make sense
      client = await QUICClient.createQUICClient({
        // host: server.host,
        // host: '::ffff:127.0.0.1' as Host,
        host: '::1' as Host,
        port: server.port,
        // This is a dual stack client
        localHost: '::' as Host,
        crypto,
        logger: logger.getChild(QUICClient.name)
      });
    } catch (e) {
      console.log(e);
      throw e;
    }

    // The connection should be created
    // Note that we aren't telling what to do with TLS?
    // Ah yes, right now the TLS is still hardcoded on the SERVER SIDE
    // technically the client side does not need to present anything
    // Since we have disabled it
    // We are connected
    console.log('WE ARE CONNECTED');
    console.log('CLIENT LOCAL HOST', client.host);
    console.log('CLIENT LOCAL PORT', client.port);

    // we should have a generic type here
    // cause the QUICClient propagates the error event
    // We may want to "rewrap" it so it's more clearer
    client.addEventListener(
      'error',
      (e: events.QUICSocketErrorEvent) => {
        console.log('I GOT AN ERROR!?');
      },
      { once: true }
    );

    client.addEventListener(
      'destroy',
      (e: events.QUICClientDestroyEvent) => {
        console.log('CLIENT got destroyed');
      },
      { once: true }
    );

    await testsUtils.sleep(1000);

    // console.log('THE CONNECTION', client.connection);
    // console.log('LOCAL HOST', client.connection.localHost);
    // console.log('LOCAL PORT', client.connection.localPort);
    // console.log('REMOTE HOST', client.connection.remoteHost);
    // console.log('REMOTE PORT', client.connection.remotePort);

    // Destruction is failing because the connection hasn't been closed
    await client.destroy();
    await server.stop();
  });
  // We need to test shared socket later
});
