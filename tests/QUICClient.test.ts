import type { Crypto, Host, Port } from '@/types';
import Logger, { LogLevel, StreamHandler, formatting } from '@matrixai/logger';
import QUICClient from '@/QUICClient';
import QUICServer from '@/QUICServer';
import * as events from '@/events';
import * as utils from '@/utils';
import * as testsUtils from './utils';
import * as errors from '@/errors';
import { fc } from '@fast-check/jest';
import * as certFixtures from './fixtures/certFixtures';
import { promise } from "@/utils";
import * as tlsUtils from './tlsUtils';

const tlsArb = fc.oneof(
  certFixtures.tlsConfigExampleArb,
  tlsUtils.tlsConfigArb(),
);
describe(QUICClient.name, () => {
  const logger = new Logger(`${QUICClient.name} Test`, LogLevel.DEBUG, [
    new StreamHandler(formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`),
  ]);
  // This has to be setup asynchronously due to key generation
  let crypto: {
    key: ArrayBuffer;
    ops: Crypto;
  };

  let tlsConfig: {
    certChainPem: string | null;
    privKeyPem: string | null;
  } | {
    certChainFromPemFile: string | null;
    privKeyFromPemFile: string | null;
  };

  // We need to test the stream making
  beforeEach(async () => {
    tlsConfig = await fc.sample(tlsArb, 1)[0]
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
    test('to ipv4 server succeeds', async () => {
      const server = new QUICServer({
        crypto,
        logger: logger.getChild(QUICServer.name),
        config: {
          tlsConfig,
          verifyPeer: false,
        }
      });
      server.addEventListener('connection', handleConnectionEventP);
      await server.start({
        host: '127.0.0.1' as Host,
      });
      const client = await QUICClient.createQUICClient({
        host: '::ffff:127.0.0.1' as Host,
        port: server.port,
        localHost: '::' as Host,
        crypto,
        logger: logger.getChild(QUICClient.name),
        config: {
          verifyPeer: false,
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
          tlsConfig,
          verifyPeer: false,
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
        logger: logger.getChild(QUICClient.name),
        config: {
          verifyPeer: false,
        }
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
          tlsConfig,
          verifyPeer: false,
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
        logger: logger.getChild(QUICClient.name),
        config: {
          verifyPeer: false,
        }
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
  test('times out when there is no server', async () => {
    // QUICClient repeatedly dials until the connection timesout
    await expect(QUICClient.createQUICClient({
      host: '127.0.0.1' as Host,
      port: 55555 as Port,
      localHost: '127.0.0.1' as Host,
      crypto,
      logger: logger.getChild(QUICClient.name),
      config: {
        maxIdleTimeout: 1000,
        verifyPeer: false,
      }
    })).rejects.toThrow(errors.ErrorQUICConnectionTimeout);
  });
  describe('TLS rotation', () => {
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
    test.todo('existing connections still function');
    test('existing connections config is unchanged and still function', async () => {
      const server = new QUICServer({
        crypto,
        logger: logger.getChild(QUICServer.name),
        config: {
          tlsConfig: certFixtures.tlsConfigFileRSA1,
          verifyPeer: false,
        }
      });
      server.addEventListener('connection', handleConnectionEventP);
      await server.start({
        host: '127.0.0.1' as Host,
      });
      const client1 = await QUICClient.createQUICClient({
        host: '::ffff:127.0.0.1' as Host,
        port: server.port,
        localHost: '::' as Host,
        crypto,
        logger: logger.getChild(QUICClient.name),
        config: {
          verifyPeer: false,
        }
      });
      const peerCertChainInitial = client1.connection.conn.peerCertChain()
      server.updateConfig({
        tlsConfig: certFixtures.tlsConfigFileRSA2
      })
      // The existing connection's certs should be unchanged
      const peerCertChainNew = client1.connection.conn.peerCertChain()
      expect(peerCertChainNew![0].toString()).toStrictEqual(peerCertChainInitial![0].toString());
      await client1.destroy();
      await server.stop();
    });
    test('new connections use new config', async () => {
      const server = new QUICServer({
        crypto,
        logger: logger.getChild(QUICServer.name),
        config: {
          tlsConfig: certFixtures.tlsConfigFileRSA1,
          verifyPeer: false,
        }
      });
      server.addEventListener('connection', handleConnectionEventP);
      await server.start({
        host: '127.0.0.1' as Host,
      });
      const client1 = await QUICClient.createQUICClient({
        host: '::ffff:127.0.0.1' as Host,
        port: server.port,
        localHost: '::' as Host,
        crypto,
        logger: logger.getChild(QUICClient.name),
        config: {
          verifyPeer: false,
        }
      });
      const peerCertChainInitial = client1.connection.conn.peerCertChain()
      server.updateConfig({
        tlsConfig: certFixtures.tlsConfigFileRSA2
      })
      // Starting a new connection has a different peerCertChain
      const client2 = await QUICClient.createQUICClient({
        host: '::ffff:127.0.0.1' as Host,
        port: server.port,
        localHost: '::' as Host,
        crypto,
        logger: logger.getChild(QUICClient.name),
        config: {
          verifyPeer: false,
        }
      });
      const peerCertChainNew = client2.connection.conn.peerCertChain()
      expect(peerCertChainNew![0].toString()).not.toStrictEqual(peerCertChainInitial![0].toString());
      await client1.destroy();
      await client2.destroy();
      await server.stop();
    });
  })
  describe('graceful tls handshake', () => {
    test('server verification succeeds', async () => {
      const server = new QUICServer({
        crypto,
        logger: logger.getChild(QUICServer.name),
        config: {
          tlsConfig: certFixtures.tlsConfigFileRSA1,
          verifyPeer: false,
        }
      });
      const handleConnectionEventProm = promise<any>()
      server.addEventListener('connection', handleConnectionEventProm.resolveP);
      await server.start({
        host: '127.0.0.1' as Host,
      });
      // Connection should succeed
      const client = await QUICClient.createQUICClient({
        host: '::ffff:127.0.0.1' as Host,
        port: server.port,
        localHost: '::' as Host,
        crypto,
        logger: logger.getChild(QUICClient.name),
        config: {
          verifyPeer: true,
          verifyFromPemFile: certFixtures.tlsConfigFileRSA1.certChainFromPemFile,
        }
      });
      await handleConnectionEventProm.p
      await client.destroy();
      await server.stop();
    })
    test('client verification succeeds', async () => {
      const server = new QUICServer({
        crypto,
        logger: logger.getChild(QUICServer.name),
        config: {
          tlsConfig: certFixtures.tlsConfigFileRSA1,
          verifyPeer: true,
          verifyFromPemFile: certFixtures.tlsConfigFileRSA2.certChainFromPemFile,
        }
      });
      const handleConnectionEventProm = promise<any>()
      server.addEventListener('connection', handleConnectionEventProm.resolveP);
      await server.start({
        host: '127.0.0.1' as Host,
      });
      // Connection should succeed
      const client = await QUICClient.createQUICClient({
        host: '::ffff:127.0.0.1' as Host,
        port: server.port,
        localHost: '::' as Host,
        crypto,
        logger: logger.getChild(QUICClient.name),
        config: {
          verifyPeer: false,
          tlsConfig: certFixtures.tlsConfigFileRSA2,
        }
      });
      await handleConnectionEventProm.p
      await client.destroy();
      await server.stop();
    })
    test('client and server verification succeeds', async () => {
      const server = new QUICServer({
        crypto,
        logger: logger.getChild(QUICServer.name),
        config: {
          tlsConfig: certFixtures.tlsConfigFileRSA1,
          verifyPeer: true,
          verifyFromPemFile: certFixtures.tlsConfigFileRSA2.certChainFromPemFile,
        }
      });
      const handleConnectionEventProm = promise<any>()
      server.addEventListener('connection', handleConnectionEventProm.resolveP);
      await server.start({
        host: '127.0.0.1' as Host,
      });
      // Connection should succeed
      const client = await QUICClient.createQUICClient({
        host: '::ffff:127.0.0.1' as Host,
        port: server.port,
        localHost: '::' as Host,
        crypto,
        logger: logger.getChild(QUICClient.name),
        config: {
          verifyPeer: true,
          tlsConfig: certFixtures.tlsConfigFileRSA2,
          verifyFromPemFile: certFixtures.tlsConfigFileRSA1.certChainFromPemFile,

        }
      });
      await handleConnectionEventProm.p
      await client.destroy();
      await server.stop();
    })
    test('graceful failure verifying server', async () => {
      const server = new QUICServer({
        crypto,
        logger: logger.getChild(QUICServer.name),
        config: {
          tlsConfig: certFixtures.tlsConfigFileRSA1,
          verifyPeer: false,
        }
      });
      const handleConnectionEventProm = promise<any>()
      server.addEventListener('connection', handleConnectionEventProm.resolveP);
      await server.start({
        host: '127.0.0.1' as Host,
      });
      // Connection should succeed
      await expect(QUICClient.createQUICClient({
        host: '::ffff:127.0.0.1' as Host,
        port: server.port,
        localHost: '::' as Host,
        crypto,
        logger: logger.getChild(QUICClient.name),
        config: {
          verifyPeer: true,
        }
      })).toReject();
      await handleConnectionEventProm.p
      await server.stop();
    })
    test('graceful failure verifying client', async () => {
      const server = new QUICServer({
        crypto,
        logger: logger.getChild(QUICServer.name),
        config: {
          tlsConfig: certFixtures.tlsConfigFileRSA1,
          verifyPeer: true,
        }
      });
      const handleConnectionEventProm = promise<any>()
      server.addEventListener('connection', handleConnectionEventProm.resolveP);
      await server.start({
        host: '127.0.0.1' as Host,
      });
      // Connection should succeed
      await expect(QUICClient.createQUICClient({
        host: '::ffff:127.0.0.1' as Host,
        port: server.port,
        localHost: '::' as Host,
        crypto,
        logger: logger.getChild(QUICClient.name),
        config: {
          verifyPeer: false,
          tlsConfig: certFixtures.tlsConfigFileRSA2,
        }
      })).toReject();
      await handleConnectionEventProm.p
      await server.stop();
    })
    test('graceful failure verifying client amd server', async () => {
      const server = new QUICServer({
        crypto,
        logger: logger.getChild(QUICServer.name),
        config: {
          tlsConfig: certFixtures.tlsConfigFileRSA1,
          verifyPeer: true,
          verifyFromPemFile: certFixtures.tlsConfigFileRSA2.certChainFromPemFile,
        }
      });
      const handleConnectionEventProm = promise<any>()
      server.addEventListener('connection', handleConnectionEventProm.resolveP);
      await server.start({
        host: '127.0.0.1' as Host,
      });
      // Connection should succeed
      await expect(QUICClient.createQUICClient({
        host: '::ffff:127.0.0.1' as Host,
        port: server.port,
        localHost: '::' as Host,
        crypto,
        logger: logger.getChild(QUICClient.name),
        config: {
          verifyPeer: true,
          tlsConfig: certFixtures.tlsConfigFileRSA2,
          verifyFromPemFile: certFixtures.tlsConfigFileRSA1.certChainFromPemFile,
        }
      })).toReject();
      await handleConnectionEventProm.p
      await server.stop();
    })
  })

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
