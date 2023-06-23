import type { ClientCrypto, Host, Port, ServerCrypto } from '@/types';
import type * as events from '@/events';
import type QUICConnection from '@/QUICConnection';
import Logger, { LogLevel, StreamHandler, formatting } from '@matrixai/logger';
import { fc, testProp } from '@fast-check/jest';
import { destroyed } from '@matrixai/async-init';
import QUICClient from '@/QUICClient';
import QUICServer from '@/QUICServer';
import * as errors from '@/errors';
import { promise } from '@/utils';
import QUICSocket from '@/QUICSocket';
import * as testsUtils from './utils';
import { generateCertificate, sleep } from './utils';

// TODO: Planed changes...
//  1. convert to a describe each and run tests for each kind of cert. Just for better grouping
//  2. Almost none of the tests need to be fast check, convert to standard tests.

describe(QUICClient.name, () => {
  const logger = new Logger(`${QUICClient.name} Test`, LogLevel.INFO, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  // This has to be setup asynchronously due to key generation
  const serverCrypto: ServerCrypto = {
    sign: testsUtils.signHMAC,
    verify: testsUtils.verifyHMAC,
  };
  let key: ArrayBuffer;
  const clientCrypto: ClientCrypto = {
    randomBytes: testsUtils.randomBytes,
  };
  let sockets: Set<QUICSocket>;

  let tlsConfigServer : {
    key: string,
    cert: string,
  };
  let tlsConfigClient : {
    key: string,
    cert: string,
  };

  // We need to test the stream making
  beforeEach(async () => {
    key = await testsUtils.generateKeyHMAC();
    sockets = new Set();
  });
  afterEach(async () => {
    const stopProms: Array<Promise<void>> = [];
    for (const socket of sockets) {
      stopProms.push(socket.stop({ force: true }));
    }
    await Promise.allSettled(stopProms);
  });
  // Are we describing a dual stack client!?
  describe('dual stack client', () => {
    test(
      'to ipv4 server succeeds',
      async () => {
        const keys = await testsUtils.generateKeyPairRSA();
        const privateKeyPem = (await testsUtils.keyPairRSAToPEM(keys)).privateKey;
        const cert = await testsUtils.generateCertificate({
          certId: '0',
          duration: 100000,
          issuerPrivateKey: keys.privateKey,
          subjectKeyPair: keys,
        })
        console.log('asd');
        const connectionEventProm = promise<events.QUICServerConnectionEvent>();
        console.log('asd');
        const server = new QUICServer({
          crypto: {
            key,
            ops: serverCrypto,
          },
          logger: logger.getChild(QUICServer.name),
          config: {
            key: privateKeyPem,
            cert: testsUtils.certToPEM(cert),
            verifyPeer: false,
          },
        });
        console.log('asd');
        testsUtils.extractSocket(server, sockets);
        console.log('asd');
        server.addEventListener(
          'serverConnection',
          (e: events.QUICServerConnectionEvent) =>
            connectionEventProm.resolveP(e),
        );
        console.log('asd');
        await server.start({
          host: '127.0.0.1' as Host,
        });
        console.log('asd');
        const client = await QUICClient.createQUICClient({
          host: '::ffff:127.0.0.1' as Host,
          port: server.port,
          localHost: '::' as Host,
          crypto: {
            ops: clientCrypto,
          },
          logger: logger.getChild(QUICClient.name),
          config: {
            verifyPeer: false,
            logKeys: './tmp/key.log'
          },
        });
        console.log('asd');
        testsUtils.extractSocket(client, sockets);
        console.log('asd');
        const conn = (await connectionEventProm.p).detail;
        console.log('asd');
        expect(conn.localHost).toBe('127.0.0.1');
        expect(conn.localPort).toBe(server.port);
        expect(conn.remoteHost).toBe('127.0.0.1');
        expect(conn.remotePort).toBe(client.port);
        console.log('asd');
        // await client.destroy();
        // console.log('asd');
        // await server.stop();
        // console.log('asd');
      });
    // testProp(
    //   'to ipv6 server succeeds',
    //   [tlsConfigWithCaArb],
    //   async (tlsConfigProm) => {
    //     const connectionEventProm = promise<events.QUICServerConnectionEvent>();
    //     const tlsConfig = await tlsConfigProm;
    //     const server = new QUICServer({
    //       crypto: {
    //         key,
    //         ops: serverCrypto,
    //       },
    //       logger: logger.getChild(QUICServer.name),
    //       config: {
    //         ...tlsConfigServer,
    //         verifyPeer: false,
    //       },
    //     });
    //     testsUtils.extractSocket(server, sockets);
    //     server.addEventListener(
    //       'connection',
    //       (e: events.QUICServerConnectionEvent) =>
    //         connectionEventProm.resolveP(e),
    //     );
    //     await server.start({
    //       host: '::1' as Host,
    //       port: 0 as Port,
    //     });
    //     const client = await QUICClient.createQUICClient({
    //       host: '::1' as Host,
    //       port: server.port,
    //       localHost: '::' as Host,
    //       crypto: {
    //         ops: clientCrypto,
    //       },
    //       logger: logger.getChild(QUICClient.name),
    //       config: {
    //         verifyPeer: false,
    //       },
    //     });
    //     testsUtils.extractSocket(client, sockets);
    //     const conn = (await connectionEventProm.p).detail;
    //     expect(conn.localHost).toBe('::1');
    //     expect(conn.localPort).toBe(server.port);
    //     expect(conn.remoteHost).toBe('::1');
    //     expect(conn.remotePort).toBe(client.port);
    //     await client.destroy();
    //     await server.stop();
    //   },
    //   { numRuns: 10 },
    // );
    // testProp(
    //   'to dual stack server succeeds',
    //   [tlsConfigWithCaArb],
    //   async (tlsConfigProm) => {
    //     const connectionEventProm = promise<events.QUICServerConnectionEvent>();
    //     const tlsConfig = await tlsConfigProm;
    //     const server = new QUICServer({
    //       crypto: {
    //         key,
    //         ops: serverCrypto,
    //       },
    //       logger: logger.getChild(QUICServer.name),
    //       config: {
    //         ...tlsConfigServer,
    //         verifyPeer: false,
    //       },
    //     });
    //     testsUtils.extractSocket(server, sockets);
    //     server.addEventListener(
    //       'connection',
    //       (e: events.QUICServerConnectionEvent) =>
    //         connectionEventProm.resolveP(e),
    //     );
    //     await server.start({
    //       host: '::' as Host,
    //       port: 0 as Port,
    //     });
    //     const client = await QUICClient.createQUICClient({
    //       host: '::' as Host, // Will resolve to ::1
    //       port: server.port,
    //       localHost: '::' as Host,
    //       crypto: {
    //         ops: clientCrypto,
    //       },
    //       logger: logger.getChild(QUICClient.name),
    //       config: {
    //         verifyPeer: false,
    //       },
    //     });
    //     testsUtils.extractSocket(client, sockets);
    //     const conn = (await connectionEventProm.p).detail;
    //     expect(conn.localHost).toBe('::');
    //     expect(conn.localPort).toBe(server.port);
    //     expect(conn.remoteHost).toBe('::1');
    //     expect(conn.remotePort).toBe(client.port);
    //     await client.destroy();
    //     await server.stop();
    //   },
    //   { numRuns: 10 },
    // );
  });
  // test('times out when there is no server', async () => {
  //   // QUICClient repeatedly dials until the connection timeout
  //   await expect(
  //     QUICClient.createQUICClient({
  //       host: '127.0.0.1' as Host,
  //       port: 56666 as Port,
  //       localHost: '127.0.0.1' as Host,
  //       crypto: {
  //         ops: clientCrypto,
  //       },
  //       logger: logger.getChild(QUICClient.name),
  //       config: {
  //         maxIdleTimeout: 1000,
  //         verifyPeer: false,
  //       },
  //     }),
  //   ).rejects.toThrow(errors.ErrorQUICConnectionTimeout);
  // });
  // test.todo('client times out after connection stops responding');
  // test.todo('server times out after connection stops responding');
  // test.todo('server handles socket error');
  // test.todo('client handles socket error');
  // describe('TLS rotation', () => {
  //   testProp(
  //     'existing connections config is unchanged and still function',
  //     [tlsConfigWithCaArb, tlsConfigWithCaArb],
  //     async (tlsConfigProm1, tlsConfigProm2) => {
  //       const tlsConfig1 = await tlsConfigProm1;
  //       const tlsConfig2 = await tlsConfigProm2;
  //       fc.pre(
  //         JSON.stringify(tlsConfig1.tlsConfig) !==
  //           JSON.stringify(tlsConfig2.tlsConfig),
  //       );
  //       const server = new QUICServer({
  //         crypto: {
  //           key,
  //           ops: serverCrypto,
  //         },
  //         logger: logger.getChild(QUICServer.name),
  //         config: {
  //           ...tlsConfigServer,
  //         },
  //       });
  //       testsUtils.extractSocket(server, sockets);
  //       await server.start({
  //         host: '127.0.0.1' as Host,
  //       });
  //       const client1 = await QUICClient.createQUICClient({
  //         host: '::ffff:127.0.0.1' as Host,
  //         port: server.port,
  //         localHost: '::' as Host,
  //         crypto: {
  //           ops: clientCrypto,
  //         },
  //         logger: logger.getChild(QUICClient.name),
  //         config: {
  //           verifyPeer: true,
  //           verifyPem: tlsConfig1.ca.certChainPem,
  //         },
  //       });
  //       testsUtils.extractSocket(client1, sockets);
  //       const peerCertChainInitial = client1.connection.conn.peerCertChain();
  //       server.updateConfig({
  //         tlsConfig: tlsConfig2.tlsConfig,
  //       });
  //       // The existing connection's certs should be unchanged
  //       const peerCertChainNew = client1.connection.conn.peerCertChain();
  //       expect(peerCertChainNew![0].toString()).toStrictEqual(
  //         peerCertChainInitial![0].toString(),
  //       );
  //       await client1.destroy();
  //       await server.stop();
  //     },
  //     { numRuns: 10 },
  //   );
  //   testProp(
  //     'new connections use new config',
  //     [tlsConfigWithCaGENOKPArb, tlsConfigWithCaGENOKPArb],
  //     async (tlsConfigProm1, tlsConfigProm2) => {
  //       const tlsConfig1 = await tlsConfigProm1;
  //       const tlsConfig2 = await tlsConfigProm2;
  //       fc.pre(
  //         JSON.stringify(tlsConfig1.tlsConfig) !==
  //           JSON.stringify(tlsConfig2.tlsConfig),
  //       );
  //       const server = new QUICServer({
  //         crypto: {
  //           key,
  //           ops: serverCrypto,
  //         },
  //         logger: logger.getChild(QUICServer.name),
  //         config: {
  //           tlsConfig: tlsConfig1.tlsConfig,
  //         },
  //       });
  //       testsUtils.extractSocket(server, sockets);
  //       await server.start({
  //         host: '127.0.0.1' as Host,
  //       });
  //       const client1 = await QUICClient.createQUICClient({
  //         host: '::ffff:127.0.0.1' as Host,
  //         port: server.port,
  //         localHost: '::' as Host,
  //         crypto: {
  //           ops: clientCrypto,
  //         },
  //         logger: logger.getChild(QUICClient.name),
  //         config: {
  //           verifyPem: tlsConfig1.ca.certChainPem,
  //         },
  //       });
  //       testsUtils.extractSocket(client1, sockets);
  //       const peerCertChainInitial = client1.connection.conn.peerCertChain();
  //       server.updateConfig({
  //         tlsConfig: tlsConfig2.tlsConfig,
  //       });
  //       // Starting a new connection has a different peerCertChain
  //       const client2 = await QUICClient.createQUICClient({
  //         host: '::ffff:127.0.0.1' as Host,
  //         port: server.port,
  //         localHost: '::' as Host,
  //         crypto: {
  //           ops: clientCrypto,
  //         },
  //         logger: logger.getChild(QUICClient.name),
  //         config: {
  //           verifyPeer: true,
  //           verifyPem: tlsConfig2.ca.certChainPem,
  //         },
  //       });
  //       testsUtils.extractSocket(client2, sockets);
  //       const peerCertChainNew = client2.connection.conn.peerCertChain();
  //       expect(peerCertChainNew![0].toString()).not.toStrictEqual(
  //         peerCertChainInitial![0].toString(),
  //       );
  //       await client1.destroy();
  //       await client2.destroy();
  //       await server.stop();
  //     },
  //     { numRuns: 10 },
  //   );
  // });
  // describe('graceful tls handshake', () => {
  //   testProp(
  //     'server verification succeeds',
  //     [tlsConfigWithCaArb],
  //     async (tlsConfigsProm) => {
  //       const tlsConfigs = await tlsConfigsProm;
  //       const server = new QUICServer({
  //         crypto: {
  //           key,
  //           ops: serverCrypto,
  //         },
  //         logger: logger.getChild(QUICServer.name),
  //         config: {
  //           tlsConfig: tlsConfigs.tlsConfig,
  //           verifyPeer: false,
  //         },
  //       });
  //       testsUtils.extractSocket(server, sockets);
  //       const handleConnectionEventProm = promise<any>();
  //       server.addEventListener(
  //         'connection',
  //         handleConnectionEventProm.resolveP,
  //       );
  //       await server.start({
  //         host: '127.0.0.1' as Host,
  //       });
  //       // Connection should succeed
  //       const client = await QUICClient.createQUICClient({
  //         host: '::ffff:127.0.0.1' as Host,
  //         port: server.port,
  //         localHost: '::' as Host,
  //         crypto: {
  //           ops: clientCrypto,
  //         },
  //         logger: logger.getChild(QUICClient.name),
  //         config: {
  //           verifyPeer: true,
  //           verifyPem: tlsConfigs.ca.certChainPem,
  //         },
  //       });
  //       testsUtils.extractSocket(client, sockets);
  //       await handleConnectionEventProm.p;
  //       await client.destroy();
  //       await server.stop();
  //     },
  //     { numRuns: 10 },
  //   );
  //   // Fixme: client verification works regardless of certs
  //   testProp.skip(
  //     'client verification succeeds',
  //     [tlsConfigWithCaArb, tlsConfigWithCaArb],
  //     async (tlsConfigProm1, tlsConfigProm2) => {
  //       const tlsConfigs1 = await tlsConfigProm1;
  //       const tlsConfigs2 = await tlsConfigProm2;
  //       const server = new QUICServer({
  //         crypto: {
  //           key,
  //           ops: serverCrypto,
  //         },
  //         logger: logger.getChild(QUICServer.name),
  //         config: {
  //           tlsConfig: tlsConfigs1.tlsConfig,
  //           verifyPem: tlsConfigs2.ca.certChainPem,
  //           verifyPeer: true,
  //         },
  //       });
  //       const handleConnectionEventProm = promise<any>();
  //       server.addEventListener(
  //         'connection',
  //         handleConnectionEventProm.resolveP,
  //       );
  //       await server.start({
  //         host: '127.0.0.1' as Host,
  //       });
  //       // Connection should succeed
  //       const client = await QUICClient.createQUICClient({
  //         host: '::ffff:127.0.0.1' as Host,
  //         port: server.port,
  //         localHost: '::' as Host,
  //         crypto: {
  //           ops: clientCrypto,
  //         },
  //         logger: logger.getChild(QUICClient.name),
  //         config: {
  //           tlsConfig: tlsConfigs2.tlsConfig,
  //           verifyPeer: false,
  //         },
  //       });
  //       await client.destroy();
  //       await server.stop();
  //     },
  //     { numRuns: 10 },
  //   );
  //   testProp(
  //     'client and server verification succeeds',
  //     [tlsConfigWithCaArb, tlsConfigWithCaArb],
  //     async (tlsConfigProm1, tlsConfigProm2) => {
  //       const tlsConfigs1 = await tlsConfigProm1;
  //       const tlsConfigs2 = await tlsConfigProm2;
  //       const server = new QUICServer({
  //         crypto: {
  //           key,
  //           ops: serverCrypto,
  //         },
  //         logger: logger.getChild(QUICServer.name),
  //         config: {
  //           tlsConfig: tlsConfigs1.tlsConfig,
  //           verifyPem: tlsConfigs2.ca.certChainPem,
  //           verifyPeer: true,
  //         },
  //       });
  //       testsUtils.extractSocket(server, sockets);
  //       const handleConnectionEventProm = promise<any>();
  //       server.addEventListener(
  //         'connection',
  //         handleConnectionEventProm.resolveP,
  //       );
  //       await server.start({
  //         host: '127.0.0.1' as Host,
  //       });
  //       // Connection should succeed
  //       const client = await QUICClient.createQUICClient({
  //         host: '::ffff:127.0.0.1' as Host,
  //         port: server.port,
  //         localHost: '::' as Host,
  //         crypto: {
  //           ops: clientCrypto,
  //         },
  //         logger: logger.getChild(QUICClient.name),
  //         config: {
  //           tlsConfig: tlsConfigs2.tlsConfig,
  //           verifyPem: tlsConfigs1.ca.certChainPem,
  //           verifyPeer: true,
  //         },
  //       });
  //       testsUtils.extractSocket(client, sockets);
  //       await handleConnectionEventProm.p;
  //       await client.destroy();
  //       await server.stop();
  //     },
  //     { numRuns: 10 },
  //   );
  //   testProp(
  //     'graceful failure verifying server',
  //     [tlsConfigWithCaArb],
  //     async (tlsConfigsProm) => {
  //       const tlsConfigs1 = await tlsConfigsProm;
  //       const server = new QUICServer({
  //         crypto: {
  //           key,
  //           ops: serverCrypto,
  //         },
  //         logger: logger.getChild(QUICServer.name),
  //         config: {
  //           tlsConfig: tlsConfigs1.tlsConfig,
  //           verifyPeer: false,
  //         },
  //       });
  //       testsUtils.extractSocket(server, sockets);
  //       const handleConnectionEventProm = promise<any>();
  //       server.addEventListener(
  //         'connection',
  //         handleConnectionEventProm.resolveP,
  //       );
  //       await server.start({
  //         host: '127.0.0.1' as Host,
  //       });
  //       // Connection should succeed
  //       await expect(
  //         QUICClient.createQUICClient({
  //           host: '::ffff:127.0.0.1' as Host,
  //           port: server.port,
  //           localHost: '::' as Host,
  //           crypto: {
  //             ops: clientCrypto,
  //           },
  //           logger: logger.getChild(QUICClient.name),
  //           config: {
  //             verifyPeer: true,
  //           },
  //         }),
  //       ).toReject();
  //       await handleConnectionEventProm.p;
  //       // Expect connection on the server to have ended
  //       // @ts-ignore: kidnap protected property
  //       // const connectionMap = server.connectionMap;
  //       // Expect(connectionMap.serverConnections.size).toBe(0);
  //       await server.stop();
  //     },
  //     { numRuns: 3 },
  //   );
  //   // Fixme: client verification works regardless of certs
  //   testProp.skip(
  //     'graceful failure verifying client',
  //     [tlsConfigWithCaArb, tlsConfigWithCaArb],
  //     async (tlsConfigProm1, tlsConfigProm2) => {
  //       const tlsConfigs1 = await tlsConfigProm1;
  //       const tlsConfigs2 = await tlsConfigProm2;
  //       const server = new QUICServer({
  //         crypto: {
  //           key,
  //           ops: serverCrypto,
  //         },
  //         logger: logger.getChild(QUICServer.name),
  //         config: {
  //           tlsConfig: tlsConfigs1.tlsConfig,
  //           verifyPeer: true,
  //         },
  //       });
  //       testsUtils.extractSocket(server, sockets);
  //       const handleConnectionEventProm = promise<any>();
  //       server.addEventListener(
  //         'connection',
  //         handleConnectionEventProm.resolveP,
  //       );
  //       await server.start({
  //         host: '127.0.0.1' as Host,
  //       });
  //       // Connection should succeed
  //       await expect(
  //         QUICClient.createQUICClient({
  //           host: '::ffff:127.0.0.1' as Host,
  //           port: server.port,
  //           localHost: '::' as Host,
  //           crypto: {
  //             ops: clientCrypto,
  //           },
  //           logger: logger.getChild(QUICClient.name),
  //           config: {
  //             tlsConfig: tlsConfigs2.tlsConfig,
  //             verifyPeer: false,
  //           },
  //         }),
  //       ).toReject();
  //       await handleConnectionEventProm.p;
  //       // Expect connection on the server to have ended
  //       // @ts-ignore: kidnap protected property
  //       const connectionMap = server.connectionMap;
  //       expect(connectionMap.serverConnections.size).toBe(0);
  //       await server.stop();
  //     },
  //     { numRuns: 3 },
  //   );
  //   testProp(
  //     'graceful failure verifying client and server',
  //     [tlsConfigWithCaArb, tlsConfigWithCaArb],
  //     async (tlsConfigProm1, tlsConfigProm2) => {
  //       const tlsConfigs1 = await tlsConfigProm1;
  //       const tlsConfigs2 = await tlsConfigProm2;
  //       const server = new QUICServer({
  //         crypto: {
  //           key,
  //           ops: serverCrypto,
  //         },
  //         logger: logger.getChild(QUICServer.name),
  //         config: {
  //           tlsConfig: tlsConfigs1.tlsConfig,
  //           verifyPeer: true,
  //         },
  //       });
  //       testsUtils.extractSocket(server, sockets);
  //       const handleConnectionEventProm = promise<any>();
  //       server.addEventListener(
  //         'connection',
  //         handleConnectionEventProm.resolveP,
  //       );
  //       await server.start({
  //         host: '127.0.0.1' as Host,
  //       });
  //       // Connection should succeed
  //       await expect(
  //         QUICClient.createQUICClient({
  //           host: '::ffff:127.0.0.1' as Host,
  //           port: server.port,
  //           localHost: '::' as Host,
  //           crypto: {
  //             ops: clientCrypto,
  //           },
  //           logger: logger.getChild(QUICClient.name),
  //           config: {
  //             tlsConfig: tlsConfigs2.tlsConfig,
  //             verifyPeer: true,
  //           },
  //         }),
  //       ).toReject();
  //       await handleConnectionEventProm.p;
  //       // Expect connection on the server to have ended
  //       // @ts-ignore: kidnap protected property
  //       // const connectionMap = server.connectionMap;
  //       // Expect(connectionMap.serverConnections.size).toBe(0);
  //       await server.stop();
  //     },
  //     { numRuns: 3 },
  //   );
  // });
  // describe('UDP nat punching', () => {
  //   test('server can send init packets', async () => {
  //     const server = new QUICServer({
  //       crypto: {
  //         key,
  //         ops: serverCrypto,
  //       },
  //       logger: logger.getChild(QUICServer.name),
  //       config: {
  //         tlsConfig: fixtures.tlsConfigMemRSA1,
  //         verifyPeer: false,
  //       },
  //     });
  //     await server.start({
  //       host: '127.0.0.1' as Host,
  //     });
  //     testsUtils.extractSocket(server, sockets);
  //     // @ts-ignore: kidnap protected property
  //     const socket = server.socket;
  //     const mockedSend = jest.spyOn(socket, 'send');
  //     // The server can send packets
  //     // Should send 4 packets in 2 seconds
  //     const result = await server.initHolePunch(
  //       {
  //         host: '127.0.0.1' as Host,
  //         port: 52222 as Port,
  //       },
  //       2000,
  //     );
  //     expect(mockedSend).toHaveBeenCalledTimes(4);
  //     expect(result).toBeFalse();
  //     await server.stop();
  //   });
  //   test('init ends when connection establishes', async () => {
  //     const server = new QUICServer({
  //       crypto: {
  //         key,
  //         ops: serverCrypto,
  //       },
  //       logger: logger.getChild(QUICServer.name),
  //       config: {
  //         tlsConfig: fixtures.tlsConfigMemRSA1,
  //         verifyPeer: false,
  //       },
  //     });
  //     testsUtils.extractSocket(server, sockets);
  //     await server.start({
  //       host: '127.0.0.1' as Host,
  //     });
  //     // The server can send packets
  //     // Should send 4 packets in 2 seconds
  //     const clientProm = sleep(1000)
  //       .then(async () => {
  //         const client = await QUICClient.createQUICClient({
  //           host: '::ffff:127.0.0.1' as Host,
  //           port: server.port,
  //           localHost: '::' as Host,
  //           localPort: 55556 as Port,
  //           crypto: {
  //             ops: clientCrypto,
  //           },
  //           logger: logger.getChild(QUICClient.name),
  //           config: {
  //             verifyPeer: false,
  //           },
  //         });
  //         testsUtils.extractSocket(client, sockets);
  //         await client.destroy({ force: true });
  //       })
  //       .catch(() => {});
  //     const result = await server.initHolePunch(
  //       {
  //         host: '127.0.0.1' as Host,
  //         port: 55556 as Port,
  //       },
  //       2000,
  //     );
  //     await clientProm;
  //     expect(result).toBeTrue();
  //     await server.stop();
  //   });
  //   test('init returns with existing connections', async () => {
  //     const server = new QUICServer({
  //       crypto: {
  //         key,
  //         ops: serverCrypto,
  //       },
  //       logger: logger.getChild(QUICServer.name),
  //       config: {
  //         tlsConfig: fixtures.tlsConfigMemRSA1,
  //         verifyPeer: false,
  //       },
  //     });
  //     testsUtils.extractSocket(server, sockets);
  //     await server.start({
  //       host: '127.0.0.1' as Host,
  //     });
  //     const client = await QUICClient.createQUICClient({
  //       host: '::ffff:127.0.0.1' as Host,
  //       port: server.port,
  //       localHost: '::' as Host,
  //       localPort: 55556 as Port,
  //       crypto: {
  //         ops: clientCrypto,
  //       },
  //       logger: logger.getChild(QUICClient.name),
  //       config: {
  //         verifyPeer: false,
  //       },
  //     });
  //     testsUtils.extractSocket(client, sockets);
  //     const result = await Promise.race([
  //       server.initHolePunch(
  //         {
  //           host: '127.0.0.1' as Host,
  //           port: 55556 as Port,
  //         },
  //         2000,
  //       ),
  //       sleep(10).then(() => {
  //         throw Error('timed out');
  //       }),
  //     ]);
  //     expect(result).toBeTrue();
  //     await client.destroy({ force: true });
  //     await server.stop();
  //   });
  // });
  // describe('handles random packets', () => {
  //   testProp(
  //     'client handles random noise from server',
  //     [
  //       fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
  //       fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
  //     ],
  //     async (data, messages) => {
  //       const socket = new QUICSocket({
  //         logger: logger.getChild('socket'),
  //       });
  //       await socket.start({
  //         host: '127.0.0.1' as Host,
  //       });
  //       const server = new QUICServer({
  //         crypto: {
  //           key,
  //           ops: serverCrypto,
  //         },
  //         logger: logger.getChild(QUICServer.name),
  //         config: {
  //           tlsConfig: fixtures.tlsConfigMemRSA1,
  //           verifyPeer: false,
  //         },
  //         socket,
  //       });
  //       testsUtils.extractSocket(server, sockets);
  //       const connectionEventProm = promise<events.QUICServerConnectionEvent>();
  //       server.addEventListener(
  //         'connection',
  //         (e: events.QUICServerConnectionEvent) =>
  //           connectionEventProm.resolveP(e),
  //       );
  //       await server.start({
  //         host: '127.0.0.1' as Host,
  //       });
  //       const client = await QUICClient.createQUICClient({
  //         host: '::ffff:127.0.0.1' as Host,
  //         port: server.port,
  //         localHost: '::' as Host,
  //         crypto: {
  //           ops: clientCrypto,
  //         },
  //         logger: logger.getChild(QUICClient.name),
  //         config: {
  //           verifyPeer: false,
  //         },
  //       });
  //       testsUtils.extractSocket(client, sockets);
  //       const conn = (await connectionEventProm.p).detail;
  //       // Do the test
  //       const serverStreamProms: Array<Promise<void>> = [];
  //       conn.addEventListener(
  //         'stream',
  //         (streamEvent: events.QUICConnectionStreamEvent) => {
  //           const stream = streamEvent.detail;
  //           const streamProm = stream.readable.pipeTo(stream.writable);
  //           serverStreamProms.push(streamProm);
  //         },
  //       );
  //       // Sending random data to client from the perspective of the server
  //       let running = true;
  //       const randomDataProm = (async () => {
  //         let count = 0;
  //         while (running) {
  //           await socket.send(
  //             data[count % data.length],
  //             client.port,
  //             '127.0.0.1',
  //           );
  //           await sleep(5);
  //           count += 1;
  //         }
  //       })();
  //       // We want to check that things function fine between bad data
  //       const randomActivityProm = (async () => {
  //         const stream = await client.connection.streamNew();
  //         await Promise.all([
  //           (async () => {
  //             // Write data
  //             const writer = stream.writable.getWriter();
  //             for (const message of messages) {
  //               await writer.write(message);
  //               await sleep(7);
  //             }
  //             await writer.close();
  //           })(),
  //           (async () => {
  //             // Consume readable
  //             for await (const _ of stream.readable) {
  //               // Do nothing
  //             }
  //           })(),
  //         ]);
  //         running = false;
  //       })();
  //       // Wait for running activity to finish, should complete without error
  //       await Promise.all([
  //         randomActivityProm,
  //         serverStreamProms,
  //         randomDataProm,
  //       ]);
  //       await client.destroy({ force: true });
  //       await server.stop();
  //       await socket.stop();
  //     },
  //     { numRuns: 1 },
  //   );
  //   testProp(
  //     'client handles random noise from external',
  //     [
  //       fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
  //       fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
  //     ],
  //     async (data, messages) => {
  //       const socket = new QUICSocket({
  //         logger: logger.getChild('socket'),
  //       });
  //       await socket.start({
  //         host: '127.0.0.1' as Host,
  //       });
  //       const server = new QUICServer({
  //         crypto: {
  //           key,
  //           ops: serverCrypto,
  //         },
  //         logger: logger.getChild(QUICServer.name),
  //         config: {
  //           tlsConfig: fixtures.tlsConfigMemRSA1,
  //           verifyPeer: false,
  //         },
  //       });
  //       testsUtils.extractSocket(server, sockets);
  //       const connectionEventProm = promise<events.QUICServerConnectionEvent>();
  //       server.addEventListener(
  //         'connection',
  //         (e: events.QUICServerConnectionEvent) =>
  //           connectionEventProm.resolveP(e),
  //       );
  //       await server.start({
  //         host: '127.0.0.1' as Host,
  //       });
  //       const client = await QUICClient.createQUICClient({
  //         host: '::ffff:127.0.0.1' as Host,
  //         port: server.port,
  //         localHost: '::' as Host,
  //         crypto: {
  //           ops: clientCrypto,
  //         },
  //         logger: logger.getChild(QUICClient.name),
  //         config: {
  //           verifyPeer: false,
  //         },
  //       });
  //       testsUtils.extractSocket(client, sockets);
  //       const conn = (await connectionEventProm.p).detail;
  //       // Do the test
  //       const serverStreamProms: Array<Promise<void>> = [];
  //       conn.addEventListener(
  //         'stream',
  //         (streamEvent: events.QUICConnectionStreamEvent) => {
  //           const stream = streamEvent.detail;
  //           const streamProm = stream.readable.pipeTo(stream.writable);
  //           serverStreamProms.push(streamProm);
  //         },
  //       );
  //       // Sending random data to client from the perspective of the server
  //       let running = true;
  //       const randomDataProm = (async () => {
  //         let count = 0;
  //         while (running) {
  //           await socket.send(
  //             data[count % data.length],
  //             client.port,
  //             '127.0.0.1',
  //           );
  //           await sleep(5);
  //           count += 1;
  //         }
  //       })();
  //       // We want to check that things function fine between bad data
  //       const randomActivityProm = (async () => {
  //         const stream = await client.connection.streamNew();
  //         await Promise.all([
  //           (async () => {
  //             // Write data
  //             const writer = stream.writable.getWriter();
  //             for (const message of messages) {
  //               await writer.write(message);
  //               await sleep(7);
  //             }
  //             await writer.close();
  //           })(),
  //           (async () => {
  //             // Consume readable
  //             for await (const _ of stream.readable) {
  //               // Do nothing
  //             }
  //           })(),
  //         ]);
  //         running = false;
  //       })();
  //       // Wait for running activity to finish, should complete without error
  //       await Promise.all([
  //         randomActivityProm,
  //         serverStreamProms,
  //         randomDataProm,
  //       ]);
  //       await client.destroy({ force: true });
  //       await server.stop();
  //       await socket.stop();
  //     },
  //     { numRuns: 1 },
  //   );
  //   testProp(
  //     'server handles random noise from client',
  //     [
  //       fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
  //       fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
  //     ],
  //     async (data, messages) => {
  //       const socket = new QUICSocket({
  //         logger: logger.getChild('socket'),
  //       });
  //       await socket.start({
  //         host: '127.0.0.1' as Host,
  //       });
  //       const server = new QUICServer({
  //         crypto: {
  //           key,
  //           ops: serverCrypto,
  //         },
  //         logger: logger.getChild(QUICServer.name),
  //         config: {
  //           tlsConfig: fixtures.tlsConfigMemRSA1,
  //           verifyPeer: false,
  //         },
  //       });
  //       testsUtils.extractSocket(server, sockets);
  //       const connectionEventProm = promise<events.QUICServerConnectionEvent>();
  //       server.addEventListener(
  //         'connection',
  //         (e: events.QUICServerConnectionEvent) =>
  //           connectionEventProm.resolveP(e),
  //       );
  //       await server.start({
  //         host: '127.0.0.1' as Host,
  //       });
  //       const client = await QUICClient.createQUICClient({
  //         host: '127.0.0.1' as Host,
  //         port: server.port,
  //         socket,
  //         crypto: {
  //           ops: clientCrypto,
  //         },
  //         logger: logger.getChild(QUICClient.name),
  //         config: {
  //           verifyPeer: false,
  //         },
  //       });
  //       testsUtils.extractSocket(client, sockets);
  //       const conn = (await connectionEventProm.p).detail;
  //       // Do the test
  //       const serverStreamProms: Array<Promise<void>> = [];
  //       conn.addEventListener(
  //         'stream',
  //         (streamEvent: events.QUICConnectionStreamEvent) => {
  //           const stream = streamEvent.detail;
  //           const streamProm = stream.readable.pipeTo(stream.writable);
  //           serverStreamProms.push(streamProm);
  //         },
  //       );
  //       // Sending random data to client from the perspective of the server
  //       let running = true;
  //       const randomDataProm = (async () => {
  //         let count = 0;
  //         while (running) {
  //           await socket.send(
  //             data[count % data.length],
  //             server.port,
  //             '127.0.0.1',
  //           );
  //           await sleep(5);
  //           count += 1;
  //         }
  //       })();
  //       // We want to check that things function fine between bad data
  //       const randomActivityProm = (async () => {
  //         const stream = await client.connection.streamNew();
  //         await Promise.all([
  //           (async () => {
  //             // Write data
  //             const writer = stream.writable.getWriter();
  //             for (const message of messages) {
  //               await writer.write(message);
  //               await sleep(7);
  //             }
  //             await writer.close();
  //           })(),
  //           (async () => {
  //             // Consume readable
  //             for await (const _ of stream.readable) {
  //               // Do nothing
  //             }
  //           })(),
  //         ]);
  //         running = false;
  //       })();
  //       // Wait for running activity to finish, should complete without error
  //       await Promise.all([
  //         randomActivityProm,
  //         serverStreamProms,
  //         randomDataProm,
  //       ]);
  //       await client.destroy({ force: true });
  //       await server.stop();
  //       await socket.stop();
  //     },
  //     { numRuns: 1 },
  //   );
  //   testProp(
  //     'server handles random noise from external',
  //     [
  //       fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
  //       fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
  //     ],
  //     async (data, messages) => {
  //       const socket = new QUICSocket({
  //         logger: logger.getChild('socket'),
  //       });
  //       await socket.start({
  //         host: '127.0.0.1' as Host,
  //       });
  //       const server = new QUICServer({
  //         crypto: {
  //           key,
  //           ops: serverCrypto,
  //         },
  //         logger: logger.getChild(QUICServer.name),
  //         config: {
  //           tlsConfig: fixtures.tlsConfigMemRSA1,
  //           verifyPeer: false,
  //         },
  //       });
  //       testsUtils.extractSocket(server, sockets);
  //       const connectionEventProm = promise<events.QUICServerConnectionEvent>();
  //       server.addEventListener(
  //         'connection',
  //         (e: events.QUICServerConnectionEvent) =>
  //           connectionEventProm.resolveP(e),
  //       );
  //       await server.start({
  //         host: '127.0.0.1' as Host,
  //       });
  //       const client = await QUICClient.createQUICClient({
  //         host: '127.0.0.1' as Host,
  //         port: server.port,
  //         localHost: '127.0.0.1' as Host,
  //         crypto: {
  //           ops: clientCrypto,
  //         },
  //         logger: logger.getChild(QUICClient.name),
  //         config: {
  //           verifyPeer: false,
  //         },
  //       });
  //       testsUtils.extractSocket(client, sockets);
  //       const conn = (await connectionEventProm.p).detail;
  //       // Do the test
  //       const serverStreamProms: Array<Promise<void>> = [];
  //       conn.addEventListener(
  //         'stream',
  //         (streamEvent: events.QUICConnectionStreamEvent) => {
  //           const stream = streamEvent.detail;
  //           const streamProm = stream.readable.pipeTo(stream.writable);
  //           serverStreamProms.push(streamProm);
  //         },
  //       );
  //       // Sending random data to client from the perspective of the server
  //       let running = true;
  //       const randomDataProm = (async () => {
  //         let count = 0;
  //         while (running) {
  //           await socket.send(
  //             data[count % data.length],
  //             server.port,
  //             '127.0.0.1',
  //           );
  //           await sleep(5);
  //           count += 1;
  //         }
  //       })();
  //       // We want to check that things function fine between bad data
  //       const randomActivityProm = (async () => {
  //         const stream = await client.connection.streamNew();
  //         await Promise.all([
  //           (async () => {
  //             // Write data
  //             const writer = stream.writable.getWriter();
  //             for (const message of messages) {
  //               await writer.write(message);
  //               await sleep(7);
  //             }
  //             await writer.close();
  //           })(),
  //           (async () => {
  //             // Consume readable
  //             for await (const _ of stream.readable) {
  //               // Do nothing
  //             }
  //           })(),
  //         ]);
  //         running = false;
  //       })();
  //       // Wait for running activity to finish, should complete without error
  //       await Promise.all([
  //         randomActivityProm,
  //         serverStreamProms,
  //         randomDataProm,
  //       ]);
  //       await client.destroy({ force: true });
  //       await server.stop();
  //       await socket.stop();
  //     },
  //     { numRuns: 1 },
  //   );
  // });
  // describe('keepalive', () => {
  //   const tlsConfig = fixtures.tlsConfigMemRSA1;
  //   test('connection can time out on client', async () => {
  //     const connectionEventProm = promise<QUICConnection>();
  //     const server = new QUICServer({
  //       crypto: {
  //         key,
  //         ops: serverCrypto,
  //       },
  //       logger: logger.getChild(QUICServer.name),
  //       config: {
  //         tlsConfig,
  //         verifyPeer: false,
  //         maxIdleTimeout: 1000,
  //       },
  //     });
  //     testsUtils.extractSocket(server, sockets);
  //     server.addEventListener(
  //       'connection',
  //       (e: events.QUICServerConnectionEvent) =>
  //         connectionEventProm.resolveP(e.detail),
  //     );
  //     await server.start({
  //       host: '127.0.0.1' as Host,
  //     });
  //     const client = await QUICClient.createQUICClient({
  //       host: '::ffff:127.0.0.1' as Host,
  //       port: server.port,
  //       localHost: '::' as Host,
  //       crypto: {
  //         ops: clientCrypto,
  //       },
  //       logger: logger.getChild(QUICClient.name),
  //       config: {
  //         verifyPeer: false,
  //         maxIdleTimeout: 100,
  //       },
  //     });
  //     testsUtils.extractSocket(client, sockets);
  //     // Setting no keepalive should cause the connection to time out
  //     // It has cleaned up due to timeout
  //     const clientConnection = client.connection;
  //     const clientTimeoutProm = promise<void>();
  //     clientConnection.addEventListener(
  //       'error',
  //       (event: events.QUICConnectionErrorEvent) => {
  //         if (event.detail instanceof errors.ErrorQUICConnectionTimeout) {
  //           clientTimeoutProm.resolveP();
  //         }
  //       },
  //     );
  //     await clientTimeoutProm.p;
  //     const serverConnection = await connectionEventProm.p;
  //     await sleep(100);
  //     // Server and client has cleaned up
  //     expect(clientConnection[destroyed]).toBeTrue();
  //     expect(serverConnection[destroyed]).toBeTrue();
  //
  //     await client.destroy();
  //     await server.stop();
  //   });
  //   test('connection can time out on server', async () => {
  //     const connectionEventProm = promise<QUICConnection>();
  //     const server = new QUICServer({
  //       crypto: {
  //         key,
  //         ops: serverCrypto,
  //       },
  //       logger: logger.getChild(QUICServer.name),
  //       config: {
  //         tlsConfig,
  //         verifyPeer: false,
  //         maxIdleTimeout: 100,
  //       },
  //     });
  //     testsUtils.extractSocket(server, sockets);
  //     server.addEventListener(
  //       'connection',
  //       (e: events.QUICServerConnectionEvent) =>
  //         connectionEventProm.resolveP(e.detail),
  //     );
  //     await server.start({
  //       host: '127.0.0.1' as Host,
  //     });
  //     const client = await QUICClient.createQUICClient({
  //       host: '::ffff:127.0.0.1' as Host,
  //       port: server.port,
  //       localHost: '::' as Host,
  //       crypto: {
  //         ops: clientCrypto,
  //       },
  //       logger: logger.getChild(QUICClient.name),
  //       config: {
  //         verifyPeer: false,
  //         maxIdleTimeout: 1000,
  //       },
  //     });
  //     testsUtils.extractSocket(client, sockets);
  //     // Setting no keepalive should cause the connection to time out
  //     // It has cleaned up due to timeout
  //     const clientConnection = client.connection;
  //     const serverConnection = await connectionEventProm.p;
  //     const serverTimeoutProm = promise<void>();
  //     serverConnection.addEventListener(
  //       'error',
  //       (event: events.QUICConnectionErrorEvent) => {
  //         if (event.detail instanceof errors.ErrorQUICConnectionTimeout) {
  //           serverTimeoutProm.resolveP();
  //         }
  //       },
  //     );
  //     await serverTimeoutProm.p;
  //     await sleep(100);
  //     // Server and client has cleaned up
  //     expect(clientConnection[destroyed]).toBeTrue();
  //     expect(serverConnection[destroyed]).toBeTrue();
  //
  //     await client.destroy();
  //     await server.stop();
  //   });
  //   test('keep alive prevents timeout on client', async () => {
  //     const connectionEventProm = promise<QUICConnection>();
  //     const server = new QUICServer({
  //       crypto: {
  //         key,
  //         ops: serverCrypto,
  //       },
  //       logger: logger.getChild(QUICServer.name),
  //       config: {
  //         tlsConfig,
  //         verifyPeer: false,
  //         maxIdleTimeout: 20000,
  //         logKeys: './tmp/key1.log',
  //       },
  //     });
  //     testsUtils.extractSocket(server, sockets);
  //     server.addEventListener(
  //       'connection',
  //       (e: events.QUICServerConnectionEvent) =>
  //         connectionEventProm.resolveP(e.detail),
  //     );
  //     await server.start({
  //       host: '127.0.0.1' as Host,
  //     });
  //     const client = await QUICClient.createQUICClient({
  //       host: '::ffff:127.0.0.1' as Host,
  //       port: server.port,
  //       localHost: '::' as Host,
  //       crypto: {
  //         ops: clientCrypto,
  //       },
  //       logger: logger.getChild(QUICClient.name),
  //       config: {
  //         verifyPeer: false,
  //         maxIdleTimeout: 100,
  //       },
  //       keepaliveIntervalTime: 50,
  //     });
  //     testsUtils.extractSocket(client, sockets);
  //     // Setting no keepalive should cause the connection to time out
  //     // It has cleaned up due to timeout
  //     const clientConnection = client.connection;
  //     const clientTimeoutProm = promise<void>();
  //     clientConnection.addEventListener(
  //       'error',
  //       (event: events.QUICConnectionErrorEvent) => {
  //         if (event.detail instanceof errors.ErrorQUICConnectionTimeout) {
  //           clientTimeoutProm.resolveP();
  //         }
  //       },
  //     );
  //     await connectionEventProm.p;
  //     // Connection would timeout after 100ms if keep alive didn't work
  //     await Promise.race([
  //       sleep(300),
  //       clientTimeoutProm.p.then(() => {
  //         throw Error('Connection timed out');
  //       }),
  //     ]);
  //     await client.destroy();
  //     await server.stop();
  //   });
  //   test('keep alive prevents timeout on server', async () => {
  //     const connectionEventProm = promise<QUICConnection>();
  //     const server = new QUICServer({
  //       crypto: {
  //         key,
  //         ops: serverCrypto,
  //       },
  //       logger: logger.getChild(QUICServer.name),
  //       config: {
  //         tlsConfig,
  //         verifyPeer: false,
  //         maxIdleTimeout: 100,
  //         logKeys: './tmp/key1.log',
  //       },
  //       keepaliveIntervalTime: 50,
  //     });
  //     testsUtils.extractSocket(server, sockets);
  //     server.addEventListener(
  //       'connection',
  //       (e: events.QUICServerConnectionEvent) =>
  //         connectionEventProm.resolveP(e.detail),
  //     );
  //     await server.start({
  //       host: '127.0.0.1' as Host,
  //     });
  //     const client = await QUICClient.createQUICClient({
  //       host: '::ffff:127.0.0.1' as Host,
  //       port: server.port,
  //       localHost: '::' as Host,
  //       crypto: {
  //         ops: clientCrypto,
  //       },
  //       logger: logger.getChild(QUICClient.name),
  //       config: {
  //         verifyPeer: false,
  //         maxIdleTimeout: 20000,
  //       },
  //     });
  //     testsUtils.extractSocket(client, sockets);
  //     // Setting no keepalive should cause the connection to time out
  //     // It has cleaned up due to timeout
  //     const serverConnection = await connectionEventProm.p;
  //     const serverTimeoutProm = promise<void>();
  //     serverConnection.addEventListener(
  //       'error',
  //       (event: events.QUICConnectionErrorEvent) => {
  //         if (event.detail instanceof errors.ErrorQUICConnectionTimeout) {
  //           serverTimeoutProm.resolveP();
  //         }
  //       },
  //     );
  //     // Connection would time out after 100ms if keep alive didn't work
  //     await Promise.race([
  //       sleep(300),
  //       serverTimeoutProm.p.then(() => {
  //         throw Error('Connection timed out');
  //       }),
  //     ]);
  //     await client.destroy();
  //     await server.stop();
  //   });
  //   test('client keep alive prevents timeout on server', async () => {
  //     const connectionEventProm = promise<QUICConnection>();
  //     const server = new QUICServer({
  //       crypto: {
  //         key,
  //         ops: serverCrypto,
  //       },
  //       logger: logger.getChild(QUICServer.name),
  //       config: {
  //         tlsConfig,
  //         verifyPeer: false,
  //         maxIdleTimeout: 100,
  //         logKeys: './tmp/key1.log',
  //       },
  //     });
  //     testsUtils.extractSocket(server, sockets);
  //     server.addEventListener(
  //       'connection',
  //       (e: events.QUICServerConnectionEvent) =>
  //         connectionEventProm.resolveP(e.detail),
  //     );
  //     await server.start({
  //       host: '127.0.0.1' as Host,
  //     });
  //     const client = await QUICClient.createQUICClient({
  //       host: '::ffff:127.0.0.1' as Host,
  //       port: server.port,
  //       localHost: '::' as Host,
  //       crypto: {
  //         ops: clientCrypto,
  //       },
  //       logger: logger.getChild(QUICClient.name),
  //       config: {
  //         verifyPeer: false,
  //         maxIdleTimeout: 20000,
  //       },
  //       keepaliveIntervalTime: 50,
  //     });
  //     testsUtils.extractSocket(client, sockets);
  //     // Setting no keepalive should cause the connection to time out
  //     // It has cleaned up due to timeout
  //     const serverConnection = await connectionEventProm.p;
  //     const serverTimeoutProm = promise<void>();
  //     serverConnection.addEventListener(
  //       'error',
  //       (event: events.QUICConnectionErrorEvent) => {
  //         if (event.detail instanceof errors.ErrorQUICConnectionTimeout) {
  //           serverTimeoutProm.resolveP();
  //         }
  //       },
  //     );
  //     // Connection would time out after 100ms if keep alive didn't work
  //     await Promise.race([
  //       sleep(300),
  //       serverTimeoutProm.p.then(() => {
  //         throw Error('Connection timed out');
  //       }),
  //     ]);
  //     await client.destroy();
  //     await server.stop();
  //   });
  //   test('Keep alive does not prevent connection timeout', async () => {
  //     const clientProm = QUICClient.createQUICClient({
  //       host: '::ffff:127.0.0.1' as Host,
  //       port: 54444 as Port,
  //       localHost: '::' as Host,
  //       crypto: {
  //         ops: clientCrypto,
  //       },
  //       logger: logger.getChild(QUICClient.name),
  //       config: {
  //         verifyPeer: false,
  //         maxIdleTimeout: 100,
  //       },
  //       keepaliveIntervalTime: 50,
  //     });
  //     await expect(clientProm).rejects.toThrow(
  //       errors.ErrorQUICConnectionTimeout,
  //     );
  //   });
  // });
});
