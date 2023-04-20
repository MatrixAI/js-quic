import type { Crypto, Host, Port } from '@/types';
import type * as events from '@/events';
import Logger, { LogLevel, StreamHandler, formatting } from '@matrixai/logger';
import { fc, testProp } from '@fast-check/jest';
import QUICClient from '@/QUICClient';
import QUICServer from '@/QUICServer';
import * as errors from '@/errors';
import { promise } from '@/utils';
import * as testsUtils from './utils';
import * as certFixtures from './fixtures/certFixtures';
import * as tlsUtils from './tlsUtils';

const tlsConfigWithCaArb = fc
  .oneof(
    fc.record({
      type: fc.constant('RSA'),
      ca: fc.constant(certFixtures.tlsConfigMemRSACa),
      tlsConfig: certFixtures.tlsConfigRSAExampleArb,
    }),
    fc.record({
      type: fc.constant('OKP'),
      ca: fc.constant(certFixtures.tlsConfigMemOKPCa),
      tlsConfig: certFixtures.tlsConfigOKPExampleArb,
    }),
    fc.record({
      type: fc.constant('ECDSA'),
      ca: fc.constant(certFixtures.tlsConfigMemECDSACa),
      tlsConfig: certFixtures.tlsConfigECDSAExampleArb,
    }),
    tlsUtils.tlsConfigArb().map(async (configProm) => {
      const config = await configProm;
      return {
        type: fc.constant('GEN-OKP'),
        tlsConfig: {
          certChainPem: config.certChainPem,
          privKeyPem: config.privKeyPem,
        },
        ca: {
          certChainPem: config.caPem,
          privKeyPem: '',
        },
      };
    }),
  )
  .noShrink();

describe(QUICClient.name, () => {
  const logger = new Logger(`${QUICClient.name} Test`, LogLevel.DEBUG, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  // This has to be setup asynchronously due to key generation
  let crypto: {
    key: ArrayBuffer;
    ops: Crypto;
  };

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
  // Are we describing a dual stack client!?
  describe('dual stack client', () => {
    testProp(
      'to ipv4 server succeeds',
      [tlsConfigWithCaArb],
      async (tlsConfigProm) => {
        const connectionEventProm = promise<events.QUICServerConnectionEvent>();
        const tlsConfig = await tlsConfigProm;
        const server = new QUICServer({
          crypto,
          logger: logger.getChild(QUICServer.name),
          config: {
            tlsConfig: tlsConfig.tlsConfig,
            verifyPeer: false,
          },
        });
        server.addEventListener(
          'connection',
          (e: events.QUICServerConnectionEvent) =>
            connectionEventProm.resolveP(e),
        );
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
          },
        });
        const conn = (await connectionEventProm.p).detail;
        expect(conn.localHost).toBe('127.0.0.1');
        expect(conn.localPort).toBe(server.port);
        expect(conn.remoteHost).toBe('127.0.0.1');
        expect(conn.remotePort).toBe(client.port);
        await client.destroy();
        await server.stop();
      },
      { numRuns: 10 },
    );
    testProp(
      'to ipv6 server succeeds',
      [tlsConfigWithCaArb],
      async (tlsConfigProm) => {
        const connectionEventProm = promise<events.QUICServerConnectionEvent>();
        const tlsConfig = await tlsConfigProm;
        const server = new QUICServer({
          crypto,
          logger: logger.getChild(QUICServer.name),
          config: {
            tlsConfig: tlsConfig.tlsConfig,
            verifyPeer: false,
          },
        });
        server.addEventListener(
          'connection',
          (e: events.QUICServerConnectionEvent) =>
            connectionEventProm.resolveP(e),
        );
        await server.start({
          host: '::1' as Host,
          port: 0 as Port,
        });
        const client = await QUICClient.createQUICClient({
          host: '::1' as Host,
          port: server.port,
          localHost: '::' as Host,
          crypto,
          logger: logger.getChild(QUICClient.name),
          config: {
            verifyPeer: false,
          },
        });
        const conn = (await connectionEventProm.p).detail;
        expect(conn.localHost).toBe('::1');
        expect(conn.localPort).toBe(server.port);
        expect(conn.remoteHost).toBe('::1');
        expect(conn.remotePort).toBe(client.port);
        await client.destroy();
        await server.stop();
      },
      { numRuns: 10 },
    );
    testProp(
      'to dual stack server succeeds',
      [tlsConfigWithCaArb],
      async (tlsConfigProm) => {
        const connectionEventProm = promise<events.QUICServerConnectionEvent>();
        const tlsConfig = await tlsConfigProm;
        const server = new QUICServer({
          crypto,
          logger: logger.getChild(QUICServer.name),
          config: {
            tlsConfig: tlsConfig.tlsConfig,
            verifyPeer: false,
          },
        });
        server.addEventListener(
          'connection',
          (e: events.QUICServerConnectionEvent) =>
            connectionEventProm.resolveP(e),
        );
        await server.start({
          host: '::' as Host,
          port: 0 as Port,
        });
        const client = await QUICClient.createQUICClient({
          host: '::' as Host, // Will resolve to ::1
          port: server.port,
          localHost: '::' as Host,
          crypto,
          logger: logger.getChild(QUICClient.name),
          config: {
            verifyPeer: false,
          },
        });
        const conn = (await connectionEventProm.p).detail;
        expect(conn.localHost).toBe('::');
        expect(conn.localPort).toBe(server.port);
        expect(conn.remoteHost).toBe('::1');
        expect(conn.remotePort).toBe(client.port);
        await client.destroy();
        await server.stop();
      },
      { numRuns: 10 },
    );
  });
  test('times out when there is no server', async () => {
    // QUICClient repeatedly dials until the connection timeout
    await expect(
      QUICClient.createQUICClient({
        host: '127.0.0.1' as Host,
        port: 55555 as Port,
        localHost: '127.0.0.1' as Host,
        crypto,
        logger: logger.getChild(QUICClient.name),
        config: {
          maxIdleTimeout: 1000,
          verifyPeer: false,
        },
      }),
    ).rejects.toThrow(errors.ErrorQUICConnectionTimeout);
  });
  test.todo('client times out after connection stops responding');
  test.todo('server times out after connection stops responding');
  test.todo('server handles socket error');
  test.todo('client handles socket error');
  describe('TLS rotation', () => {
    testProp(
      'existing connections config is unchanged and still function',
      [tlsConfigWithCaArb, tlsConfigWithCaArb],
      async (tlsConfigProm1, tlsConfigProm2) => {
        const tlsConfig1 = await tlsConfigProm1;
        const tlsConfig2 = await tlsConfigProm2;
        fc.pre(
          JSON.stringify(tlsConfig1.tlsConfig) !==
            JSON.stringify(tlsConfig2.tlsConfig),
        );
        const server = new QUICServer({
          crypto,
          logger: logger.getChild(QUICServer.name),
          config: {
            tlsConfig: tlsConfig1.tlsConfig,
          },
        });
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
            verifyPeer: true,
            verifyPem: tlsConfig1.ca.certChainPem,
          },
        });
        const peerCertChainInitial = client1.connection.conn.peerCertChain();
        server.updateConfig({
          tlsConfig: tlsConfig2.tlsConfig,
        });
        // The existing connection's certs should be unchanged
        const peerCertChainNew = client1.connection.conn.peerCertChain();
        expect(peerCertChainNew![0].toString()).toStrictEqual(
          peerCertChainInitial![0].toString(),
        );
        await client1.destroy();
        await server.stop();
      },
      { numRuns: 10 },
    );
    testProp(
      'new connections use new config',
      [tlsConfigWithCaArb, tlsConfigWithCaArb],
      async (tlsConfigProm1, tlsConfigProm2) => {
        const tlsConfig1 = await tlsConfigProm1;
        const tlsConfig2 = await tlsConfigProm2;
        fc.pre(
          JSON.stringify(tlsConfig1.tlsConfig) !==
            JSON.stringify(tlsConfig2.tlsConfig),
        );
        const server = new QUICServer({
          crypto,
          logger: logger.getChild(QUICServer.name),
          config: {
            tlsConfig: tlsConfig1.tlsConfig,
          },
        });
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
            verifyPem: tlsConfig1.ca.certChainPem,
          },
        });
        const peerCertChainInitial = client1.connection.conn.peerCertChain();
        server.updateConfig({
          tlsConfig: tlsConfig2.tlsConfig,
        });
        // Starting a new connection has a different peerCertChain
        const client2 = await QUICClient.createQUICClient({
          host: '::ffff:127.0.0.1' as Host,
          port: server.port,
          localHost: '::' as Host,
          crypto,
          logger: logger.getChild(QUICClient.name),
          config: {
            verifyPeer: true,
            verifyPem: tlsConfig2.ca.certChainPem,
          },
        });
        const peerCertChainNew = client2.connection.conn.peerCertChain();
        expect(peerCertChainNew![0].toString()).not.toStrictEqual(
          peerCertChainInitial![0].toString(),
        );
        await client1.destroy();
        await client2.destroy();
        await server.stop();
      },
      { numRuns: 10 },
    );
  });
  describe('graceful tls handshake', () => {
    testProp(
      'server verification succeeds',
      [tlsConfigWithCaArb],
      async (tlsConfigsProm) => {
        const tlsConfigs = await tlsConfigsProm;
        const server = new QUICServer({
          crypto,
          logger: logger.getChild(QUICServer.name),
          config: {
            tlsConfig: tlsConfigs.tlsConfig,
            verifyPeer: false,
          },
        });
        const handleConnectionEventProm = promise<any>();
        server.addEventListener(
          'connection',
          handleConnectionEventProm.resolveP,
        );
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
            verifyPem: tlsConfigs.ca.certChainPem,
          },
        });
        await handleConnectionEventProm.p;
        await client.destroy();
        await server.stop();
      },
      { numRuns: 10 },
    );
    // Fixme: client verification works regardless of certs
    testProp(
      'client verification succeeds',
      [tlsConfigWithCaArb, tlsConfigWithCaArb],
      async (tlsConfigProm1, tlsConfigProm2) => {
        const tlsConfigs1 = await tlsConfigProm1;
        const tlsConfigs2 = await tlsConfigProm2;
        const server = new QUICServer({
          crypto,
          logger: logger.getChild(QUICServer.name),
          config: {
            tlsConfig: tlsConfigs1.tlsConfig,
            verifyPem: tlsConfigs2.ca.certChainPem,
            verifyPeer: true,
          },
        });
        const handleConnectionEventProm = promise<any>();
        server.addEventListener(
          'connection',
          handleConnectionEventProm.resolveP,
        );
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
            tlsConfig: tlsConfigs2.tlsConfig,
            verifyPeer: false,
          },
        });
        await handleConnectionEventProm.p;
        await client.destroy();
        await server.stop();
      },
      { numRuns: 10 },
    );
    testProp(
      'client and server verification succeeds',
      [tlsConfigWithCaArb, tlsConfigWithCaArb],
      async (tlsConfigProm1, tlsConfigProm2) => {
        const tlsConfigs1 = await tlsConfigProm1;
        const tlsConfigs2 = await tlsConfigProm2;
        const server = new QUICServer({
          crypto,
          logger: logger.getChild(QUICServer.name),
          config: {
            tlsConfig: tlsConfigs1.tlsConfig,
            verifyPem: tlsConfigs2.ca.certChainPem,
            verifyPeer: true,
          },
        });
        const handleConnectionEventProm = promise<any>();
        server.addEventListener(
          'connection',
          handleConnectionEventProm.resolveP,
        );
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
            tlsConfig: tlsConfigs2.tlsConfig,
            verifyPem: tlsConfigs1.ca.certChainPem,
            verifyPeer: true,
          },
        });
        await handleConnectionEventProm.p;
        await client.destroy();
        await server.stop();
      },
      { numRuns: 10 },
    );
    testProp(
      'graceful failure verifying server',
      [tlsConfigWithCaArb],
      async (tlsConfigsProm) => {
        const tlsConfigs1 = await tlsConfigsProm;
        const server = new QUICServer({
          crypto,
          logger: logger.getChild(QUICServer.name),
          config: {
            tlsConfig: tlsConfigs1.tlsConfig,
            verifyPeer: false,
          },
        });
        const handleConnectionEventProm = promise<any>();
        server.addEventListener(
          'connection',
          handleConnectionEventProm.resolveP,
        );
        await server.start({
          host: '127.0.0.1' as Host,
        });
        // Connection should succeed
        await expect(
          QUICClient.createQUICClient({
            host: '::ffff:127.0.0.1' as Host,
            port: server.port,
            localHost: '::' as Host,
            crypto,
            logger: logger.getChild(QUICClient.name),
            config: {
              verifyPeer: true,
            },
          }),
        ).toReject();
        await handleConnectionEventProm.p;
        // Expect connection on the server to have ended
        // @ts-ignore: kidnap protected property
        // const connectionMap = server.connectionMap;
        // Expect(connectionMap.serverConnections.size).toBe(0);
        await server.stop();
      },
      { numRuns: 3 },
    );
    // Fixme: client verification works regardless of certs
    testProp(
      'graceful failure verifying client',
      [tlsConfigWithCaArb, tlsConfigWithCaArb],
      async (tlsConfigProm1, tlsConfigProm2) => {
        const tlsConfigs1 = await tlsConfigProm1;
        const tlsConfigs2 = await tlsConfigProm2;
        const server = new QUICServer({
          crypto,
          logger: logger.getChild(QUICServer.name),
          config: {
            tlsConfig: tlsConfigs1.tlsConfig,
            verifyPeer: true,
          },
        });
        const handleConnectionEventProm = promise<any>();
        server.addEventListener(
          'connection',
          handleConnectionEventProm.resolveP,
        );
        await server.start({
          host: '127.0.0.1' as Host,
        });
        // Connection should succeed
        await expect(
          QUICClient.createQUICClient({
            host: '::ffff:127.0.0.1' as Host,
            port: server.port,
            localHost: '::' as Host,
            crypto,
            logger: logger.getChild(QUICClient.name),
            config: {
              tlsConfig: tlsConfigs2.tlsConfig,
              verifyPeer: false,
            },
          }),
        ).toReject();
        await handleConnectionEventProm.p;
        // Expect connection on the server to have ended
        // @ts-ignore: kidnap protected property
        const connectionMap = server.connectionMap;
        expect(connectionMap.serverConnections.size).toBe(0);
        await server.stop();
      },
      { numRuns: 3 },
    );
    testProp(
      'graceful failure verifying client and server',
      [tlsConfigWithCaArb, tlsConfigWithCaArb],
      async (tlsConfigProm1, tlsConfigProm2) => {
        const tlsConfigs1 = await tlsConfigProm1;
        const tlsConfigs2 = await tlsConfigProm2;
        const server = new QUICServer({
          crypto,
          logger: logger.getChild(QUICServer.name),
          config: {
            tlsConfig: tlsConfigs1.tlsConfig,
            verifyPeer: true,
          },
        });
        const handleConnectionEventProm = promise<any>();
        server.addEventListener(
          'connection',
          handleConnectionEventProm.resolveP,
        );
        await server.start({
          host: '127.0.0.1' as Host,
        });
        // Connection should succeed
        await expect(
          QUICClient.createQUICClient({
            host: '::ffff:127.0.0.1' as Host,
            port: server.port,
            localHost: '::' as Host,
            crypto,
            logger: logger.getChild(QUICClient.name),
            config: {
              tlsConfig: tlsConfigs2.tlsConfig,
              verifyPeer: true,
            },
          }),
        ).toReject();
        await handleConnectionEventProm.p;
        // Expect connection on the server to have ended
        // @ts-ignore: kidnap protected property
        // const connectionMap = server.connectionMap;
        // Expect(connectionMap.serverConnections.size).toBe(0);
        await server.stop();
      },
      { numRuns: 3 },
    );
  });
  // Test('dual stack to dual stack', async () => {
  //
  //   const {
  //     p: clientErrorEventP,
  //     rejectP: rejectClientErrorEventP
  //   } = utils.promise<events.QUICClientErrorEvent>();
  //
  //   const {
  //     p: serverErrorEventP,
  //     rejectP: rejectServerErrorEventP
  //   } = utils.promise<events.QUICServerErrorEvent>();
  //
  //   const {
  //     p: serverStopEventP,
  //     resolveP: resolveServerStopEventP
  //   } = utils.promise<events.QUICServerStopEvent>();
  //
  //   const {
  //     p: clientDestroyEventP,
  //     resolveP: resolveClientDestroyEventP
  //   } = utils.promise<events.QUICClientDestroyEvent>();
  //
  //   const {
  //     p: connectionEventP,
  //     resolveP: resolveConnectionEventP
  //   } = utils.promise<events.QUICServerConnectionEvent>();
  //
  //   const {
  //     p: streamEventP,
  //     resolveP: resolveStreamEventP
  //   } = utils.promise<events.QUICConnectionStreamEvent>();
  //
  //   const server = new QUICServer({
  //     crypto,
  //     logger: logger.getChild(QUICServer.name)
  //   });
  //   server.addEventListener('error', handleServerErrorEvent);
  //   server.addEventListener('stop', handleServerStopEvent);
  //
  //   // Every time I have a promise
  //   // I can attempt to await 4 promises
  //   // Then the idea is that this will resolve 4 times
  //   // Once for each time?
  //   // If you add once
  //   // Do you also
  //
  //   // Fundamentally there could be multiple of these
  //   // This is not something I can put outside
  //
  //   server.addEventListener(
  //     'connection',
  //     (e: events.QUICServerConnectionEvent) => {
  //       resolveConnectionEventP(e);
  //
  //       // const conn = e.detail;
  //       // conn.addEventListener('stream', (e: events.QUICConnectionStreamEvent) => {
  //       //   resolveStreamEventP(e);
  //       // }, { once: true });
  //     },
  //     { once: true }
  //   );
  //
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
  //
  //   // await testsUtils.sleep(1000);
  //
  //   await expect(connectionEventP).resolves.toBeInstanceOf(events.QUICServerConnectionEvent);
  //   await client.destroy();
  //   await expect(clientDestroyEventP).resolves.toBeInstanceOf(events.QUICClientDestroyEvent);
  //   await server.stop();
  //   await expect(serverStopEventP).resolves.toBeInstanceOf(events.QUICServerStopEvent);
  //
  //   // No errors occurred
  //   await expect(Promise.race([clientErrorEventP, Promise.resolve()])).resolves.toBe(undefined);
  //   await expect(Promise.race([serverErrorEventP, Promise.resolve()])).resolves.toBe(undefined);
  // });
});
