import type { Crypto, Host, Hostname, Port } from '@/types';
import { webcrypto } from 'crypto';
import Logger, { LogLevel, StreamHandler } from '@matrixai/logger';
import QUICClient from '@/QUICClient';
import QUICServer from '@/QUICServer';
import QUICConnection from '@/QUICConnection';
import * as events from '@/events';
import * as utils from '@/utils';
import * as testsUtils from './utils';

describe(QUICClient.name, () => {
  const logger = new Logger(`${QUICClient.name} Test`, LogLevel.WARN, [
    new StreamHandler(),
  ]);
  // This has to be setup asynchronously due to key generation
  let crypto: {
    key: ArrayBuffer;
    ops: Crypto;
  };

  // let clientErrorEventP;
  // let rejectClientErrorEventP;

  // let serverErrorEventP;
  // let rejectServerErrorEventP;

  // let serverStopEventP;
  // let resolveServerStopEventP;

  // let clientDestroyEventP;
  // let resolveClientDestroyEventP;

  // let connectionEventP;
  // let resolveConnectionEventP;

  // let streamEventP;
  // let resolveStreamEventP;


  // const handleServerErrorEvent = (e: events.QUICServerErrorEvent) => {
  //   rejectServerErrorEventP(e);
  //   // const { p, rejectP } = utils.promise<events.QUICServerErrorEvent>();
  //   // serverErrorEventP = p;
  //   // rejectServerErrorEventP = rejectP;
  // };

  // const handleClientErrorEvent = (e: events.QUICClientErrorEvent) => {
  //   rejectClientErrorEventP(e);
  //   // const { p, rejectP } = utils.promise<events.QUICClientErrorEvent>();
  //   // clientErrorEventP = p;
  //   // rejectClientErrorEventP = rejectP;
  // };

  // const handleServerStopEvent = (e: events.QUICServerStopEvent) => {
  //   resolveServerStopEventP(e);
  //   const { p, resolveP } = utils.promise<events.QUICServerStopEvent>();
  //   serverStopEventP = p;
  //   resolveServerStopEventP = resolveP;
  // };

  // const handleClientDestroyEvent = (e: events.QUICClientDestroyEvent) => {
  //   resolveClientDestroyEventP(e);
  //   const { p, resolveP } = utils.promise<events.QUICClientDestroyEvent>();
  //   clientDestroyEventP = p;
  //   resolveClientDestroyEventP = resolveP;
  // };

  // const handleConnectionEventP = (e: events.QUICServerConnectionEvent) => {
  //   resolveConnectionEventP(e);
  //   const { p, resolveP } = utils.promise<events.QUICServerConnectionEvent>();
  //   connectionEventP = p;
  //   resolveConnectionEventP = resolveP;
  // };

  // const handleStreamEventP = (e: events.QUICConnectionStreamEvent) => {
  //   resolveStreamEventP(e);
  //   const { p, resolveP } = utils.promise<events.QUICConnectionStreamEvent>();
  //   streamEventP = p;
  //   resolveStreamEventP = resolveP;
  // };




  // We need to test the stream making

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

  // Are we describing a dual stack client!?
  describe('dual stack client', () => {
    let connectionEventP;
    let resolveConnectionEventP;
    let handleConnectionEventP;
    beforeEach(async () => {
      const {
        p,
        resolveP
      } = utils.promise<events.QUICServerConnectionEvent>();
      connectionEventP = p;
      resolveConnectionEventP = resolveP;
      handleConnectionEventP = (e: events.QUICServerConnectionEvent) => {
        resolveConnectionEventP(e);
      };
    });
    test.only('to ipv4 server succeeds', async () => {
      const server = new QUICServer({
        crypto,
        logger: logger.getChild(QUICServer.name),
        config: {
          certChainFromPemFile: './tmp/localhost.crt',
          privKeyFromPemFile: './tmp/localhost.key',
        }
      });
      server.addEventListener('connection', handleConnectionEventP);
      await server.start({
        host: '127.0.0.1' as Host,
        port: 55555 as Port
      });
      const client = await QUICClient.createQUICClient({
        host: '::ffff:127.0.0.1' as Host,
        port: server.port,
        localHost: '::' as Host,
        crypto,
        logger: logger.getChild(QUICClient.name),
        config: {
          logKeys: './tmp/keylog.log',
        }
      });
      const conn = (await connectionEventP).detail;
      expect(conn.localHost).toBe('127.0.0.1');
      expect(conn.localPort).toBe(server.port);
      expect(conn.remoteHost).toBe('127.0.0.1');
      expect(conn.remotePort).toBe(client.port);
      await client.destroy();
      await server.stop();
    });
    test('to ipv6 server succeeds', async () => {
      const server = new QUICServer({
        crypto,
        logger: logger.getChild(QUICServer.name),
        config: {
          certChainFromPemFile: './tmp/localhost.crt',
          privKeyFromPemFile: './tmp/localhost.key',
        }
      });
      server.addEventListener('connection', handleConnectionEventP);
      await server.start({
        host: '::1' as Host,
        port: 0 as Port
      });
      const client = await QUICClient.createQUICClient({
        host: '::1' as Host,
        port: server.port,
        localHost: '::' as Host,
        crypto,
        logger: logger.getChild(QUICClient.name)
      });
      const conn = (await connectionEventP).detail;
      expect(conn.localHost).toBe('::1');
      expect(conn.localPort).toBe(server.port);
      expect(conn.remoteHost).toBe('::1');
      expect(conn.remotePort).toBe(client.port);
      await client.destroy();
      await server.stop();
    });
    test('to dual stack server succeeds', async () => {
      const server = new QUICServer({
        crypto,
        logger: logger.getChild(QUICServer.name),
        config: {
          certChainFromPemFile: './tmp/localhost.crt',
          privKeyFromPemFile: './tmp/localhost.key',
        }
      });
      server.addEventListener('connection', handleConnectionEventP);
      await server.start({
        host: '::' as Host,
        port: 0 as Port
      });
      const client = await QUICClient.createQUICClient({
        host: '::' as Host, // Will resolve to ::1
        port: server.port,
        localHost: '::' as Host,
        crypto,
        logger: logger.getChild(QUICClient.name)
      });
      const conn = (await connectionEventP).detail;
      expect(conn.localHost).toBe('::');
      expect(conn.localPort).toBe(server.port);
      expect(conn.remoteHost).toBe('::1');
      expect(conn.remotePort).toBe(client.port);
      await client.destroy();
      await server.stop();
    });
  });


  // test('dual stack to dual stack', async () => {

  //   const {
  //     p: clientErrorEventP,
  //     rejectP: rejectClientErrorEventP
  //   } = utils.promise<events.QUICClientErrorEvent>();

  //   const {
  //     p: serverErrorEventP,
  //     rejectP: rejectServerErrorEventP
  //   } = utils.promise<events.QUICServerErrorEvent>();

  //   const {
  //     p: serverStopEventP,
  //     resolveP: resolveServerStopEventP
  //   } = utils.promise<events.QUICServerStopEvent>();

  //   const {
  //     p: clientDestroyEventP,
  //     resolveP: resolveClientDestroyEventP
  //   } = utils.promise<events.QUICClientDestroyEvent>();

  //   const {
  //     p: connectionEventP,
  //     resolveP: resolveConnectionEventP
  //   } = utils.promise<events.QUICServerConnectionEvent>();

  //   const {
  //     p: streamEventP,
  //     resolveP: resolveStreamEventP
  //   } = utils.promise<events.QUICConnectionStreamEvent>();

  //   const server = new QUICServer({
  //     crypto,
  //     logger: logger.getChild(QUICServer.name)
  //   });
  //   server.addEventListener('error', handleServerErrorEvent);
  //   server.addEventListener('stop', handleServerStopEvent);

  //   // Every time I have a promise
  //   // I can attempt to await 4 promises
  //   // Then the idea is that this will resolve 4 times
  //   // Once for each time?
  //   // If you add once
  //   // Do you also

  //   // Fundamentally there could be multiple of these
  //   // This is not something I can put outside

  //   server.addEventListener(
  //     'connection',
  //     (e: events.QUICServerConnectionEvent) => {
  //       resolveConnectionEventP(e);

  //       // const conn = e.detail;
  //       // conn.addEventListener('stream', (e: events.QUICConnectionStreamEvent) => {
  //       //   resolveStreamEventP(e);
  //       // }, { once: true });
  //     },
  //     { once: true }
  //   );

  //   // Dual stack server
  //   await server.start({
  //     host: '::' as Host,
  //     port: 0 as Port
  //   });
  //   // Dual stack client
  //   const client = await QUICClient.createQUICClient({
  //     // host: server.host,
  //     // host: '::ffff:127.0.0.1' as Host,
  //     host: '::1' as Host,
  //     port: server.port,
  //     localHost: '::' as Host,
  //     crypto,
  //     logger: logger.getChild(QUICClient.name)
  //   });
  //   client.addEventListener('error', handleClientErrorEvent);
  //   client.addEventListener('destroy', handleClientDestroyEvent);



  //   // await testsUtils.sleep(1000);

  //   await expect(connectionEventP).resolves.toBeInstanceOf(events.QUICServerConnectionEvent);
  //   await client.destroy();
  //   await expect(clientDestroyEventP).resolves.toBeInstanceOf(events.QUICClientDestroyEvent);
  //   await server.stop();
  //   await expect(serverStopEventP).resolves.toBeInstanceOf(events.QUICServerStopEvent);


  //   // No errors occurred
  //   await expect(Promise.race([clientErrorEventP, Promise.resolve()])).resolves.toBe(undefined);
  //   await expect(Promise.race([serverErrorEventP, Promise.resolve()])).resolves.toBe(undefined);
  // });
  // test.only('', async () => {

  //   // const p = Promise.reject(new Error('Not implemented'));
  //   const { p, rejectP } = utils.promise();
  //   rejectP(new Error('oh no'));

  //   await expect(Promise.race([p, Promise.resolve()])).resolves.toBe(undefined);


  // });
  // We need to test shared socket later
});
