import type { ClientCrypto, Host, Port, ServerCrypto } from '@/types';
import type * as events from '@/events';
import type QUICConnection from '@/QUICConnection';
import type { KeyTypes, TLSConfigs } from './utils';
import Logger, { LogLevel, StreamHandler, formatting } from '@matrixai/logger';
import { fc, testProp } from '@fast-check/jest';
import { running } from '@matrixai/async-init';
import { Timer } from '@matrixai/timer';
import QUICSocket from '@/QUICSocket';
import QUICClient from '@/QUICClient';
import QUICServer from '@/QUICServer';
import * as errors from '@/errors';
import { promise } from '@/utils';
import * as testsUtils from './utils';
import { generateConfig, sleep } from './utils';

describe(QUICClient.name, () => {
  const logger = new Logger(`${QUICClient.name} Test`, LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  const localhost = '127.0.0.1' as Host;
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

  const types: Array<KeyTypes> = ['RSA', 'ECDSA', 'ED25519'];
  const defaultType = types[0];

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
    test('to ipv4 server succeeds', async () => {
      const tlsConfigServer = await testsUtils.generateConfig(defaultType);

      const connectionEventProm = promise<events.QUICServerConnectionEvent>();
      const server = new QUICServer({
        crypto: {
          key,
          ops: serverCrypto,
        },
        logger: logger.getChild(QUICServer.name),
        config: {
          key: tlsConfigServer.key,
          cert: tlsConfigServer.cert,
          verifyPeer: false,
        },
      });
      testsUtils.extractSocket(server, sockets);
      server.addEventListener(
        'serverConnection',
        (e: events.QUICServerConnectionEvent) =>
          connectionEventProm.resolveP(e),
      );
      await server.start({
        host: localhost,
      });
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
        },
      });
      testsUtils.extractSocket(client, sockets);
      const conn = (await connectionEventProm.p).detail;
      expect(conn.localHost).toBe('127.0.0.1');
      expect(conn.localPort).toBe(server.port);
      expect(conn.remoteHost).toBe('127.0.0.1');
      expect(conn.remotePort).toBe(client.port);
      await client.destroy();
      await server.stop();
    });
    test('to ipv6 server succeeds', async () => {
      const connectionEventProm = promise<events.QUICServerConnectionEvent>();
      const tlsConfigServer = await testsUtils.generateConfig(defaultType);
      const server = new QUICServer({
        crypto: {
          key,
          ops: serverCrypto,
        },
        logger: logger.getChild(QUICServer.name),
        config: {
          key: tlsConfigServer.key,
          cert: tlsConfigServer.cert,
          verifyPeer: false,
        },
      });
      testsUtils.extractSocket(server, sockets);
      server.addEventListener(
        'serverConnection',
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
        crypto: {
          ops: clientCrypto,
        },
        logger: logger.getChild(QUICClient.name),
        config: {
          verifyPeer: false,
        },
      });
      testsUtils.extractSocket(client, sockets);
      const conn = (await connectionEventProm.p).detail;
      expect(conn.localHost).toBe('::1');
      expect(conn.localPort).toBe(server.port);
      expect(conn.remoteHost).toBe('::1');
      expect(conn.remotePort).toBe(client.port);
      await client.destroy();
      await server.stop();
    });
    test('to dual stack server succeeds', async () => {
      const connectionEventProm = promise<events.QUICServerConnectionEvent>();
      const tlsConfigServer = await testsUtils.generateConfig(defaultType);
      const server = new QUICServer({
        crypto: {
          key,
          ops: serverCrypto,
        },
        logger: logger.getChild(QUICServer.name),
        config: {
          key: tlsConfigServer.key,
          cert: tlsConfigServer.cert,
          verifyPeer: false,
        },
      });
      testsUtils.extractSocket(server, sockets);
      server.addEventListener(
        'serverConnection',
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
        crypto: {
          ops: clientCrypto,
        },
        logger: logger.getChild(QUICClient.name),
        config: {
          verifyPeer: false,
        },
      });
      testsUtils.extractSocket(client, sockets);
      const conn = (await connectionEventProm.p).detail;
      expect(conn.localHost).toBe('::');
      expect(conn.localPort).toBe(server.port);
      expect(conn.remoteHost).toBe('::1');
      expect(conn.remotePort).toBe(client.port);
      await client.destroy();
      await server.stop();
    });
  });
  describe('hard connection failures', () => {
    test('times out with maxIdleTimeout when there is no server', async () => {
      // QUICClient repeatedly dials until the connection timeout
      await expect(
        QUICClient.createQUICClient({
          host: localhost,
          port: 56666 as Port,
          localHost: localhost,
          crypto: {
            ops: clientCrypto,
          },
          logger: logger.getChild(QUICClient.name),
          config: {
            maxIdleTimeout: 200,
            verifyPeer: false,
          },
        }),
      ).rejects.toThrow(errors.ErrorQUICConnectionStartTimeOut);
    });
    test('intervalTimeoutTime must be less than maxIdleTimeout', async () => {
      // Larger keepAliveIntervalTime throws
      await expect(
        QUICClient.createQUICClient({
          host: localhost,
          port: 56666 as Port,
          localHost: localhost,
          crypto: {
            ops: clientCrypto,
          },
          logger: logger.getChild(QUICClient.name),
          config: {
            maxIdleTimeout: 200,
            keepAliveIntervalTime: 1000,
            verifyPeer: false,
          },
        }),
      ).rejects.toThrow(errors.ErrorQUICConnectionInvalidConfig);
      // Smaller keepAliveIntervalTime doesn't cause a problem
      await expect(
        QUICClient.createQUICClient({
          host: localhost,
          port: 56666 as Port,
          localHost: localhost,
          crypto: {
            ops: clientCrypto,
          },
          logger: logger.getChild(QUICClient.name),
          config: {
            maxIdleTimeout: 200,
            keepAliveIntervalTime: 100,
            verifyPeer: false,
          },
        }),
      ).rejects.not.toThrow(errors.ErrorQUICConnectionInvalidConfig);
      // Not setting an interval doesn't cause a problem either
      await expect(
        QUICClient.createQUICClient({
          host: localhost,
          port: 56666 as Port,
          localHost: localhost,
          crypto: {
            ops: clientCrypto,
          },
          logger: logger.getChild(QUICClient.name),
          config: {
            maxIdleTimeout: 200,
            verifyPeer: false,
          },
        }),
      ).rejects.not.toThrow(errors.ErrorQUICConnectionInvalidConfig);
    });
    test('client times out with ctx timer while starting', async () => {
      // QUICClient repeatedly dials until the connection timeout
      await expect(
        QUICClient.createQUICClient(
          {
            host: localhost,
            port: 56666 as Port,
            localHost: localhost,
            crypto: {
              ops: clientCrypto,
            },
            logger: logger.getChild(QUICClient.name),
            config: {
              // Prevent `maxIdleTimeout` timeout
              maxIdleTimeout: 100000,
              verifyPeer: false,
            },
          },
          { timer: new Timer({ delay: 100 }) },
        ),
      ).rejects.toThrow(errors.ErrorQUICClientCreateTimeOut);
    });
    test('ctx timer must be less than maxIdleTimeout', async () => {
      // Larger timer throws
      await expect(
        QUICClient.createQUICClient(
          {
            host: localhost,
            port: 56666 as Port,
            localHost: localhost,
            crypto: {
              ops: clientCrypto,
            },
            logger: logger.getChild(QUICClient.name),
            config: {
              maxIdleTimeout: 200,
              verifyPeer: false,
            },
          },
          { timer: new Timer({ delay: 1000 }) },
        ),
      ).rejects.toThrow(errors.ErrorQUICConnectionInvalidConfig);
      // Smaller keepAliveIntervalTime doesn't cause a problem
      await expect(
        QUICClient.createQUICClient(
          {
            host: localhost,
            port: 56666 as Port,
            localHost: localhost,
            crypto: {
              ops: clientCrypto,
            },
            logger: logger.getChild(QUICClient.name),
            config: {
              maxIdleTimeout: 200,
              verifyPeer: false,
            },
          },
          { timer: new Timer({ delay: 100 }) },
        ),
      ).rejects.not.toThrow(errors.ErrorQUICConnectionInvalidConfig);
      // Not setting an interval doesn't cause a problem either
      await expect(
        QUICClient.createQUICClient({
          host: localhost,
          port: 56666 as Port,
          localHost: localhost,
          crypto: {
            ops: clientCrypto,
          },
          logger: logger.getChild(QUICClient.name),
          config: {
            maxIdleTimeout: 200,
            verifyPeer: false,
          },
        }),
      ).rejects.not.toThrow(errors.ErrorQUICConnectionInvalidConfig);
    });
    test('client times out with ctx signal while starting', async () => {
      // QUICClient repeatedly dials until the connection timeout
      const abortController = new AbortController();
      const clientProm = QUICClient.createQUICClient(
        {
          host: localhost,
          port: 56666 as Port,
          localHost: localhost,
          crypto: {
            ops: clientCrypto,
          },
          logger: logger.getChild(QUICClient.name),
          config: {
            // Prevent `maxIdleTimeout` timeout
            maxIdleTimeout: 100000,
            verifyPeer: false,
          },
        },
        { signal: abortController.signal },
      );
      await sleep(100);
      abortController.abort(Error('abort error'));
      await expect(clientProm).rejects.toThrow(Error('abort error'));
    });
    test.todo('server handles socket error');
    test.todo('client handles socket error');
  });
  describe.each(types)('TLS rotation with %s', (type) => {
    test('existing connections config is unchanged and still function', async () => {
      const tlsConfig1 = await testsUtils.generateConfig(type);
      const tlsConfig2 = await testsUtils.generateConfig(type);
      const server = new QUICServer({
        crypto: {
          key,
          ops: serverCrypto,
        },
        logger: logger.getChild(QUICServer.name),
        config: {
          key: tlsConfig1.key,
          cert: tlsConfig1.cert,
        },
      });
      testsUtils.extractSocket(server, sockets);
      await server.start({
        host: localhost,
      });
      const client1 = await QUICClient.createQUICClient({
        host: localhost,
        port: server.port,
        localHost: localhost,
        crypto: {
          ops: clientCrypto,
        },
        logger: logger.getChild(QUICClient.name),
        config: {
          verifyPeer: true,
          verifyAllowFail: true,
        },
      });
      testsUtils.extractSocket(client1, sockets);
      const peerCertChainInitial = client1.connection.conn.peerCertChain();
      server.updateConfig({
        key: tlsConfig2.key,
        cert: tlsConfig2.cert,
      });
      // The existing connection's certs should be unchanged
      const peerCertChainNew = client1.connection.conn.peerCertChain();
      expect(peerCertChainNew![0].toString()).toStrictEqual(
        peerCertChainInitial![0].toString(),
      );
      await client1.destroy();
      await server.stop();
    });
    test('new connections use new config', async () => {
      const tlsConfig1 = await testsUtils.generateConfig(type);
      const tlsConfig2 = await testsUtils.generateConfig(type);
      const server = new QUICServer({
        crypto: {
          key,
          ops: serverCrypto,
        },
        logger: logger.getChild(QUICServer.name),
        config: {
          key: tlsConfig1.key,
          cert: tlsConfig1.cert,
        },
      });
      testsUtils.extractSocket(server, sockets);
      await server.start({
        host: localhost,
      });
      const client1 = await QUICClient.createQUICClient({
        host: localhost,
        port: server.port,
        localHost: localhost,
        crypto: {
          ops: clientCrypto,
        },
        logger: logger.getChild(QUICClient.name),
        config: {
          verifyPeer: true,
          verifyAllowFail: true,
        },
      });
      testsUtils.extractSocket(client1, sockets);
      const peerCertChainInitial = client1.connection.conn.peerCertChain();
      server.updateConfig({
        key: tlsConfig2.key,
        cert: tlsConfig2.cert,
      });
      // Starting a new connection has a different peerCertChain
      const client2 = await QUICClient.createQUICClient({
        host: localhost,
        port: server.port,
        localHost: localhost,
        crypto: {
          ops: clientCrypto,
        },
        logger: logger.getChild(QUICClient.name),
        config: {
          verifyPeer: true,
          verifyAllowFail: true,
        },
      });
      testsUtils.extractSocket(client2, sockets);
      const peerCertChainNew = client2.connection.conn.peerCertChain();
      expect(peerCertChainNew![0].toString()).not.toStrictEqual(
        peerCertChainInitial![0].toString(),
      );
      await client1.destroy();
      await client2.destroy();
      await server.stop();
    });
  });
  describe.each(types)('graceful tls handshake with %s certs', (type) => {
    test('server verification succeeds', async () => {
      const tlsConfigs = await testsUtils.generateConfig(type);
      const server = new QUICServer({
        crypto: {
          key,
          ops: serverCrypto,
        },
        logger: logger.getChild(QUICServer.name),
        config: {
          key: tlsConfigs.key,
          cert: tlsConfigs.cert,
          verifyPeer: false,
        },
      });
      testsUtils.extractSocket(server, sockets);
      const handleConnectionEventProm = promise<any>();
      server.addEventListener(
        'serverConnection',
        handleConnectionEventProm.resolveP,
      );
      await server.start({
        host: localhost,
      });
      // Connection should succeed
      const client = await QUICClient.createQUICClient({
        host: localhost,
        port: server.port,
        localHost: localhost,
        crypto: {
          ops: clientCrypto,
        },
        logger: logger.getChild(QUICClient.name),
        config: {
          verifyPeer: true,
          ca: tlsConfigs.ca,
        },
      });
      testsUtils.extractSocket(client, sockets);
      await handleConnectionEventProm.p;
      await client.destroy();
      await server.stop();
    });
    test('client verification succeeds', async () => {
      const tlsConfigs1 = await testsUtils.generateConfig(type);
      const tlsConfigs2 = await testsUtils.generateConfig(type);
      const server = new QUICServer({
        crypto: {
          key,
          ops: serverCrypto,
        },
        logger: logger.getChild(QUICServer.name),
        config: {
          key: tlsConfigs1.key,
          cert: tlsConfigs1.cert,
          verifyPeer: true,
          ca: tlsConfigs2.ca,
        },
      });
      const handleConnectionEventProm = promise<any>();
      server.addEventListener(
        'serverConnection',
        handleConnectionEventProm.resolveP,
      );
      await server.start({
        host: localhost,
      });
      // Connection should succeed
      const client = await QUICClient.createQUICClient({
        host: localhost,
        port: server.port,
        localHost: localhost,
        crypto: {
          ops: clientCrypto,
        },
        logger: logger.getChild(QUICClient.name),
        config: {
          key: tlsConfigs2.key,
          cert: tlsConfigs2.cert,
          verifyPeer: false,
        },
      });
      await client.destroy();
      await server.stop();
    });
    test('client and server verification succeeds', async () => {
      const tlsConfigs1 = await testsUtils.generateConfig(type);
      const tlsConfigs2 = await testsUtils.generateConfig(type);
      const server = new QUICServer({
        crypto: {
          key,
          ops: serverCrypto,
        },
        logger: logger.getChild(QUICServer.name),
        config: {
          key: tlsConfigs1.key,
          cert: tlsConfigs1.cert,
          ca: tlsConfigs2.ca,
          verifyPeer: true,
        },
      });
      testsUtils.extractSocket(server, sockets);
      const handleConnectionEventProm = promise<any>();
      server.addEventListener(
        'serverConnection',
        handleConnectionEventProm.resolveP,
      );
      await server.start({
        host: localhost,
      });
      // Connection should succeed
      const client = await QUICClient.createQUICClient({
        host: localhost,
        port: server.port,
        localHost: localhost,
        crypto: {
          ops: clientCrypto,
        },
        logger: logger.getChild(QUICClient.name),
        config: {
          key: tlsConfigs2.key,
          cert: tlsConfigs2.cert,
          ca: tlsConfigs1.ca,
          verifyPeer: true,
        },
      });
      testsUtils.extractSocket(client, sockets);
      await handleConnectionEventProm.p;
      await client.destroy();
      await server.stop();
    });
    test('graceful failure verifying server', async () => {
      const tlsConfigs1 = await testsUtils.generateConfig(type);
      const server = new QUICServer({
        crypto: {
          key,
          ops: serverCrypto,
        },
        logger: logger.getChild(QUICServer.name),
        config: {
          key: tlsConfigs1.key,
          cert: tlsConfigs1.cert,
          verifyPeer: false,
        },
      });
      testsUtils.extractSocket(server, sockets);
      await server.start({
        host: localhost,
      });
      // Connection should fail
      await expect(
        QUICClient.createQUICClient({
          host: localhost,
          port: server.port,
          localHost: localhost,
          crypto: {
            ops: clientCrypto,
          },
          logger: logger.getChild(QUICClient.name),
          config: {
            verifyPeer: true,
          },
        }),
      ).toReject();
      await server.stop();
    });
    test('graceful failure verifying client', async () => {
      const tlsConfigs1 = await testsUtils.generateConfig(type);
      const tlsConfigs2 = await testsUtils.generateConfig(type);
      const server = new QUICServer({
        crypto: {
          key,
          ops: serverCrypto,
        },
        logger: logger.getChild(QUICServer.name),
        config: {
          key: tlsConfigs1.key,
          cert: tlsConfigs1.cert,
          verifyPeer: true,
        },
      });
      testsUtils.extractSocket(server, sockets);
      await server.start({
        host: localhost,
      });
      // Connection should fail
      await expect(
        QUICClient.createQUICClient({
          host: localhost,
          port: server.port,
          localHost: localhost,
          crypto: {
            ops: clientCrypto,
          },
          logger: logger.getChild(QUICClient.name),
          config: {
            key: tlsConfigs2.key,
            cert: tlsConfigs2.cert,
            verifyPeer: false,
          },
        }),
      ).toReject();
      await server.stop();
    });
    test('graceful failure verifying client and server', async () => {
      const tlsConfigs1 = await testsUtils.generateConfig(type);
      const tlsConfigs2 = await testsUtils.generateConfig(type);
      const server = new QUICServer({
        crypto: {
          key,
          ops: serverCrypto,
        },
        logger: logger.getChild(QUICServer.name),
        config: {
          key: tlsConfigs1.key,
          cert: tlsConfigs1.cert,
          verifyPeer: true,
        },
      });
      testsUtils.extractSocket(server, sockets);
      await server.start({
        host: localhost,
      });
      // Connection should fail
      await expect(
        QUICClient.createQUICClient({
          host: localhost,
          port: server.port,
          localHost: localhost,
          crypto: {
            ops: clientCrypto,
          },
          logger: logger.getChild(QUICClient.name),
          config: {
            key: tlsConfigs2.key,
            cert: tlsConfigs2.cert,
            verifyPeer: true,
          },
        }),
      ).toReject();

      await server.stop();
    });
  });
  describe('handles random packets', () => {
    testProp(
      'client handles random noise from server',
      [
        fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
        fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
      ],
      async (data, messages) => {
        const tlsConfig = await testsUtils.generateConfig('RSA');
        const socket = new QUICSocket({
          logger: logger.getChild('socket'),
        });
        await socket.start({
          host: localhost,
        });
        const server = new QUICServer({
          crypto: {
            key,
            ops: serverCrypto,
          },
          logger: logger.getChild(QUICServer.name),
          config: {
            key: tlsConfig.key,
            cert: tlsConfig.cert,
            verifyPeer: false,
          },
          socket,
        });
        testsUtils.extractSocket(server, sockets);
        const connectionEventProm = promise<events.QUICServerConnectionEvent>();
        server.addEventListener(
          'serverConnection',
          (e: events.QUICServerConnectionEvent) =>
            connectionEventProm.resolveP(e),
        );
        await server.start({
          host: localhost,
        });
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
          },
        });
        testsUtils.extractSocket(client, sockets);
        const conn = (await connectionEventProm.p).detail;
        // Do the test
        const serverStreamProms: Array<Promise<void>> = [];
        conn.addEventListener(
          'connectionStream',
          (streamEvent: events.QUICConnectionStreamEvent) => {
            const stream = streamEvent.detail;
            const streamProm = stream.readable.pipeTo(stream.writable);
            serverStreamProms.push(streamProm);
          },
        );
        // Sending random data to client from the perspective of the server
        let running = true;
        const randomDataProm = (async () => {
          let count = 0;
          while (running) {
            await socket.send(
              data[count % data.length],
              client.port,
              '127.0.0.1',
            );
            await sleep(5);
            count += 1;
          }
        })();
        // We want to check that things function fine between bad data
        const randomActivityProm = (async () => {
          const stream = await client.connection.streamNew();
          await Promise.all([
            (async () => {
              // Write data
              const writer = stream.writable.getWriter();
              for (const message of messages) {
                await writer.write(message);
                await sleep(7);
              }
              await writer.close();
            })(),
            (async () => {
              // Consume readable
              for await (const _ of stream.readable) {
                // Do nothing
              }
            })(),
          ]);
          running = false;
        })();
        // Wait for running activity to finish, should complete without error
        await Promise.all([
          randomActivityProm,
          serverStreamProms,
          randomDataProm,
        ]);
        await client.destroy({ force: true });
        await server.stop();
        await socket.stop();
      },
      { numRuns: 1 },
    );
    testProp(
      'client handles random noise from external',
      [
        fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
        fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
      ],
      async (data, messages) => {
        const tlsConfig = await testsUtils.generateConfig('RSA');
        const socket = new QUICSocket({
          logger: logger.getChild('socket'),
        });
        await socket.start({
          host: localhost,
        });
        const server = new QUICServer({
          crypto: {
            key,
            ops: serverCrypto,
          },
          logger: logger.getChild(QUICServer.name),
          config: {
            key: tlsConfig.key,
            cert: tlsConfig.cert,
            verifyPeer: false,
          },
        });
        testsUtils.extractSocket(server, sockets);
        const connectionEventProm = promise<events.QUICServerConnectionEvent>();
        server.addEventListener(
          'serverConnection',
          (e: events.QUICServerConnectionEvent) =>
            connectionEventProm.resolveP(e),
        );
        await server.start({
          host: localhost,
        });
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
          },
        });
        testsUtils.extractSocket(client, sockets);
        const conn = (await connectionEventProm.p).detail;
        // Do the test
        const serverStreamProms: Array<Promise<void>> = [];
        conn.addEventListener(
          'connectionStream',
          (streamEvent: events.QUICConnectionStreamEvent) => {
            const stream = streamEvent.detail;
            const streamProm = stream.readable.pipeTo(stream.writable);
            serverStreamProms.push(streamProm);
          },
        );
        // Sending random data to client from the perspective of the server
        let running = true;
        const randomDataProm = (async () => {
          let count = 0;
          while (running) {
            await socket.send(
              data[count % data.length],
              client.port,
              '127.0.0.1',
            );
            await sleep(5);
            count += 1;
          }
        })();
        // We want to check that things function fine between bad data
        const randomActivityProm = (async () => {
          const stream = await client.connection.streamNew();
          await Promise.all([
            (async () => {
              // Write data
              const writer = stream.writable.getWriter();
              for (const message of messages) {
                await writer.write(message);
                await sleep(7);
              }
              await writer.close();
            })(),
            (async () => {
              // Consume readable
              for await (const _ of stream.readable) {
                // Do nothing
              }
            })(),
          ]);
          running = false;
        })();
        // Wait for running activity to finish, should complete without error
        await Promise.all([
          randomActivityProm,
          serverStreamProms,
          randomDataProm,
        ]);
        await client.destroy({ force: true });
        await server.stop();
        await socket.stop();
      },
      { numRuns: 1 },
    );
    testProp(
      'server handles random noise from client',
      [
        fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
        fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
      ],
      async (data, messages) => {
        const tlsConfig = await testsUtils.generateConfig('RSA');
        const socket = new QUICSocket({
          logger: logger.getChild('socket'),
        });
        await socket.start({
          host: localhost,
        });
        const server = new QUICServer({
          crypto: {
            key,
            ops: serverCrypto,
          },
          logger: logger.getChild(QUICServer.name),
          config: {
            key: tlsConfig.key,
            cert: tlsConfig.cert,
            verifyPeer: false,
          },
        });
        testsUtils.extractSocket(server, sockets);
        const connectionEventProm = promise<events.QUICServerConnectionEvent>();
        server.addEventListener(
          'serverConnection',
          (e: events.QUICServerConnectionEvent) =>
            connectionEventProm.resolveP(e),
        );
        await server.start({
          host: localhost,
        });
        const client = await QUICClient.createQUICClient({
          host: localhost,
          port: server.port,
          socket,
          crypto: {
            ops: clientCrypto,
          },
          logger: logger.getChild(QUICClient.name),
          config: {
            verifyPeer: false,
          },
        });
        testsUtils.extractSocket(client, sockets);
        const conn = (await connectionEventProm.p).detail;
        // Do the test
        const serverStreamProms: Array<Promise<void>> = [];
        conn.addEventListener(
          'connectionStream',
          (streamEvent: events.QUICConnectionStreamEvent) => {
            const stream = streamEvent.detail;
            const streamProm = stream.readable.pipeTo(stream.writable);
            serverStreamProms.push(streamProm);
          },
        );
        // Sending random data to client from the perspective of the server
        let running = true;
        const randomDataProm = (async () => {
          let count = 0;
          while (running) {
            await socket.send(
              data[count % data.length],
              server.port,
              '127.0.0.1',
            );
            await sleep(5);
            count += 1;
          }
        })();
        // We want to check that things function fine between bad data
        const randomActivityProm = (async () => {
          const stream = await client.connection.streamNew();
          await Promise.all([
            (async () => {
              // Write data
              const writer = stream.writable.getWriter();
              for (const message of messages) {
                await writer.write(message);
                await sleep(7);
              }
              await writer.close();
            })(),
            (async () => {
              // Consume readable
              for await (const _ of stream.readable) {
                // Do nothing
              }
            })(),
          ]);
          running = false;
        })();
        // Wait for running activity to finish, should complete without error
        await Promise.all([
          randomActivityProm,
          serverStreamProms,
          randomDataProm,
        ]);
        await client.destroy({ force: true });
        await server.stop();
        await socket.stop();
      },
      { numRuns: 1 },
    );
    testProp(
      'server handles random noise from external',
      [
        fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
        fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 5 }).noShrink(),
      ],
      async (data, messages) => {
        const tlsConfig = await testsUtils.generateConfig('RSA');
        const socket = new QUICSocket({
          logger: logger.getChild('socket'),
        });
        await socket.start({
          host: localhost,
        });
        const server = new QUICServer({
          crypto: {
            key,
            ops: serverCrypto,
          },
          logger: logger.getChild(QUICServer.name),
          config: {
            key: tlsConfig.key,
            cert: tlsConfig.cert,
            verifyPeer: false,
          },
        });
        testsUtils.extractSocket(server, sockets);
        const connectionEventProm = promise<events.QUICServerConnectionEvent>();
        server.addEventListener(
          'serverConnection',
          (e: events.QUICServerConnectionEvent) =>
            connectionEventProm.resolveP(e),
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
        testsUtils.extractSocket(client, sockets);
        const conn = (await connectionEventProm.p).detail;
        // Do the test
        const serverStreamProms: Array<Promise<void>> = [];
        conn.addEventListener(
          'connectionStream',
          (streamEvent: events.QUICConnectionStreamEvent) => {
            const stream = streamEvent.detail;
            const streamProm = stream.readable.pipeTo(stream.writable);
            serverStreamProms.push(streamProm);
          },
        );
        // Sending random data to client from the perspective of the server
        let running = true;
        const randomDataProm = (async () => {
          let count = 0;
          while (running) {
            await socket.send(
              data[count % data.length],
              server.port,
              '127.0.0.1',
            );
            await sleep(5);
            count += 1;
          }
        })();
        // We want to check that things function fine between bad data
        const randomActivityProm = (async () => {
          const stream = await client.connection.streamNew();
          await Promise.all([
            (async () => {
              // Write data
              const writer = stream.writable.getWriter();
              for (const message of messages) {
                await writer.write(message);
                await sleep(7);
              }
              await writer.close();
            })(),
            (async () => {
              // Consume readable
              for await (const _ of stream.readable) {
                // Do nothing
              }
            })(),
          ]);
          running = false;
        })();
        // Wait for running activity to finish, should complete without error
        await Promise.all([
          randomActivityProm,
          serverStreamProms,
          randomDataProm,
        ]);
        await client.destroy({ force: true });
        await server.stop();
        await socket.stop();
      },
      { numRuns: 1 },
    );
  });
  describe('keepalive', () => {
    let tlsConfig: TLSConfigs;
    beforeEach(async () => {
      tlsConfig = await testsUtils.generateConfig('RSA');
    });
    test('connection can time out on client', async () => {
      const connectionEventProm = promise<QUICConnection>();
      const server = new QUICServer({
        crypto: {
          key,
          ops: serverCrypto,
        },
        logger: logger.getChild(QUICServer.name),
        config: {
          key: tlsConfig.key,
          cert: tlsConfig.cert,
          verifyPeer: false,
          maxIdleTimeout: 1000,
        },
      });
      testsUtils.extractSocket(server, sockets);
      server.addEventListener(
        'serverConnection',
        (e: events.QUICServerConnectionEvent) =>
          connectionEventProm.resolveP(e.detail),
      );
      await server.start({
        host: localhost,
      });
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
          maxIdleTimeout: 100,
        },
      });
      testsUtils.extractSocket(client, sockets);
      // Setting no keepalive should cause the connection to time out
      // It has cleaned up due to timeout
      const clientConnection = client.connection;
      const clientTimeoutProm = promise<void>();
      clientConnection.addEventListener(
        'connectionError',
        (event: events.QUICConnectionErrorEvent) => {
          if (event.detail instanceof errors.ErrorQUICConnectionIdleTimeOut) {
            clientTimeoutProm.resolveP();
          }
        },
      );
      await clientTimeoutProm.p;
      const serverConnection = await connectionEventProm.p;
      await sleep(100);
      // Server and client has cleaned up
      expect(clientConnection[running]).toBeFalse();
      expect(serverConnection[running]).toBeFalse();

      await client.destroy();
      await server.stop();
    });
    test('connection can time out on server', async () => {
      const connectionEventProm = promise<QUICConnection>();
      const server = new QUICServer({
        crypto: {
          key,
          ops: serverCrypto,
        },
        logger: logger.getChild(QUICServer.name),
        config: {
          key: tlsConfig.key,
          cert: tlsConfig.cert,
          verifyPeer: false,
          maxIdleTimeout: 100,
        },
      });
      testsUtils.extractSocket(server, sockets);
      server.addEventListener(
        'serverConnection',
        (e: events.QUICServerConnectionEvent) =>
          connectionEventProm.resolveP(e.detail),
      );
      await server.start({
        host: localhost,
      });
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
          maxIdleTimeout: 1000,
        },
      });
      testsUtils.extractSocket(client, sockets);
      // Setting no keepalive should cause the connection to time out
      // It has cleaned up due to timeout
      const clientConnection = client.connection;
      const serverConnection = await connectionEventProm.p;
      const serverTimeoutProm = promise<void>();
      serverConnection.addEventListener(
        'connectionError',
        (event: events.QUICConnectionErrorEvent) => {
          if (event.detail instanceof errors.ErrorQUICConnectionIdleTimeOut) {
            serverTimeoutProm.resolveP();
          }
        },
      );
      await serverTimeoutProm.p;
      await sleep(100);
      // Server and client has cleaned up
      expect(clientConnection[running]).toBeFalse();
      expect(serverConnection[running]).toBeFalse();

      await client.destroy();
      await server.stop();
    });
    test('keep alive prevents timeout on client', async () => {
      const connectionEventProm = promise<QUICConnection>();
      const server = new QUICServer({
        crypto: {
          key,
          ops: serverCrypto,
        },
        logger: logger.getChild(QUICServer.name),
        config: {
          key: tlsConfig.key,
          cert: tlsConfig.cert,
          verifyPeer: false,
          maxIdleTimeout: 20000,
        },
      });
      testsUtils.extractSocket(server, sockets);
      server.addEventListener(
        'serverConnection',
        (e: events.QUICServerConnectionEvent) =>
          connectionEventProm.resolveP(e.detail),
      );
      await server.start({
        host: localhost,
      });
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
          maxIdleTimeout: 100,
          keepAliveIntervalTime: 50,
        },
      });
      testsUtils.extractSocket(client, sockets);
      // Setting no keepalive should cause the connection to time out
      // It has cleaned up due to timeout
      const clientConnection = client.connection;
      const clientTimeoutProm = promise<void>();
      clientConnection.addEventListener(
        'connectionError',
        (event: events.QUICConnectionErrorEvent) => {
          if (event.detail instanceof errors.ErrorQUICConnectionIdleTimeOut) {
            clientTimeoutProm.resolveP();
          }
        },
      );
      await connectionEventProm.p;
      // Connection would timeout after 100ms if keep alive didn't work
      await Promise.race([
        sleep(300),
        clientTimeoutProm.p.then(() => {
          throw Error('Connection timed out');
        }),
      ]);
      await client.destroy();
      await server.stop();
    });
    test('keep alive prevents timeout on server', async () => {
      const connectionEventProm = promise<QUICConnection>();
      const server = new QUICServer({
        crypto: {
          key,
          ops: serverCrypto,
        },
        logger: logger.getChild(QUICServer.name),
        config: {
          key: tlsConfig.key,
          cert: tlsConfig.cert,
          verifyPeer: false,
          maxIdleTimeout: 100,
          keepAliveIntervalTime: 50,
        },
      });
      testsUtils.extractSocket(server, sockets);
      server.addEventListener(
        'serverConnection',
        (e: events.QUICServerConnectionEvent) =>
          connectionEventProm.resolveP(e.detail),
      );
      await server.start({
        host: localhost,
      });
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
          maxIdleTimeout: 20000,
        },
      });
      testsUtils.extractSocket(client, sockets);
      // Setting no keepalive should cause the connection to time out
      // It has cleaned up due to timeout
      const serverConnection = await connectionEventProm.p;
      const serverTimeoutProm = promise<void>();
      serverConnection.addEventListener(
        'connectionError',
        (event: events.QUICConnectionErrorEvent) => {
          if (event.detail instanceof errors.ErrorQUICConnectionIdleTimeOut) {
            serverTimeoutProm.resolveP();
          }
        },
      );
      // Connection would time out after 100ms if keep alive didn't work
      await Promise.race([
        sleep(300),
        serverTimeoutProm.p.then(() => {
          throw Error('Connection timed out');
        }),
      ]);
      await client.destroy();
      await server.stop();
    });
    test('client keep alive prevents timeout on server', async () => {
      const connectionEventProm = promise<QUICConnection>();
      const server = new QUICServer({
        crypto: {
          key,
          ops: serverCrypto,
        },
        logger: logger.getChild(QUICServer.name),
        config: {
          key: tlsConfig.key,
          cert: tlsConfig.cert,
          verifyPeer: false,
          maxIdleTimeout: 100,
        },
      });
      testsUtils.extractSocket(server, sockets);
      server.addEventListener(
        'serverConnection',
        (e: events.QUICServerConnectionEvent) =>
          connectionEventProm.resolveP(e.detail),
      );
      await server.start({
        host: localhost,
      });
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
          maxIdleTimeout: 20000,
          keepAliveIntervalTime: 50,
        },
      });
      testsUtils.extractSocket(client, sockets);
      // Setting no keepalive should cause the connection to time out
      // It has cleaned up due to timeout
      const serverConnection = await connectionEventProm.p;
      const serverTimeoutProm = promise<void>();
      serverConnection.addEventListener(
        'connectionError',
        (event: events.QUICConnectionErrorEvent) => {
          if (event.detail instanceof errors.ErrorQUICConnectionIdleTimeOut) {
            serverTimeoutProm.resolveP();
          }
        },
      );
      // Connection would time out after 100ms if keep alive didn't work
      await Promise.race([
        sleep(300),
        serverTimeoutProm.p.then(() => {
          throw Error('Connection timed out');
        }),
      ]);
      await client.destroy();
      await server.stop();
    });
    test('Keep alive does not prevent connection timeout', async () => {
      const clientProm = QUICClient.createQUICClient({
        host: '::ffff:127.0.0.1' as Host,
        port: 54444 as Port,
        localHost: '::' as Host,
        crypto: {
          ops: clientCrypto,
        },
        logger: logger.getChild(QUICClient.name),
        config: {
          verifyPeer: false,
          maxIdleTimeout: 100,
          keepAliveIntervalTime: 50,
        },
      });
      await expect(clientProm).rejects.toThrow(
        errors.ErrorQUICConnectionStartTimeOut,
      );
    });
  });
  describe.each(types)('custom TLS verification with %s', (type) => {
    test('server succeeds custom verification', async () => {
      const tlsConfigs = await generateConfig(type);
      const server = new QUICServer({
        crypto: {
          key,
          ops: serverCrypto,
        },
        logger: logger.getChild(QUICServer.name),
        config: {
          key: tlsConfigs.key,
          cert: tlsConfigs.cert,
          verifyPeer: false,
        },
      });
      testsUtils.extractSocket(server, sockets);
      const handleConnectionEventProm = promise<any>();
      server.addEventListener(
        'serverConnection',
        handleConnectionEventProm.resolveP,
      );
      await server.start({
        host: localhost,
      });
      // Connection should succeed
      const verifyProm = promise<Array<string> | undefined>();
      const client = await QUICClient.createQUICClient({
        host: localhost,
        port: server.port,
        localHost: localhost,
        crypto: {
          ops: clientCrypto,
        },
        logger: logger.getChild(QUICClient.name),
        config: {
          verifyPeer: true,
          verifyAllowFail: true,
        },
        verifyCallback: (certs) => {
          verifyProm.resolveP(certs);
        },
      });
      testsUtils.extractSocket(client, sockets);
      await handleConnectionEventProm.p;
      await expect(verifyProm.p).toResolve();
      await client.destroy();
      await server.stop();
    });
    test('server fails custom verification', async () => {
      const tlsConfigs = await generateConfig(type);
      const server = new QUICServer({
        crypto: {
          key,
          ops: serverCrypto,
        },
        logger: logger.getChild(QUICServer.name),
        config: {
          key: tlsConfigs.key,
          cert: tlsConfigs.cert,
          verifyPeer: false,
        },
      });
      testsUtils.extractSocket(server, sockets);
      const handleConnectionEventProm = promise<QUICConnection>();
      server.addEventListener(
        'serverConnection',
        (event: events.QUICServerConnectionEvent) =>
          handleConnectionEventProm.resolveP(event.detail),
      );
      await server.start({
        host: localhost,
      });
      // Connection should fail
      const clientProm = QUICClient.createQUICClient({
        host: localhost,
        port: server.port,
        localHost: localhost,
        crypto: {
          ops: clientCrypto,
        },
        logger: logger.getChild(QUICClient.name),
        config: {
          verifyPeer: true,
          verifyAllowFail: true,
        },
        verifyCallback: () => {
          throw Error('SOME ERROR');
        },
      });
      clientProm.catch(() => {});

      // Server connection is never emitted
      await Promise.race([
        handleConnectionEventProm.p.then(() => {
          throw Error('Server connection should not be emitted');
        }),
        // Allow some time
        sleep(200),
      ]);

      await expect(clientProm).rejects.toThrow(
        errors.ErrorQUICConnectionInternal,
      );

      await server.stop();
    });
    test('client succeeds custom verification', async () => {
      const tlsConfigs = await generateConfig(type);
      const verifyProm = promise<Array<string> | undefined>();
      const server = new QUICServer({
        crypto: {
          key,
          ops: serverCrypto,
        },
        logger: logger.getChild(QUICServer.name),
        config: {
          key: tlsConfigs.key,
          cert: tlsConfigs.cert,
          verifyPeer: true,
          verifyAllowFail: true,
        },
        verifyCallback: (certs) => {
          verifyProm.resolveP(certs);
        },
      });
      testsUtils.extractSocket(server, sockets);
      const handleConnectionEventProm = promise<any>();
      server.addEventListener(
        'serverConnection',
        handleConnectionEventProm.resolveP,
      );
      await server.start({
        host: localhost,
      });
      // Connection should succeed
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
          key: tlsConfigs.key,
          cert: tlsConfigs.cert,
        },
      });
      testsUtils.extractSocket(client, sockets);
      await handleConnectionEventProm.p;
      await expect(verifyProm.p).toResolve();
      await client.destroy();
      await server.stop();
    });
    test('client fails custom verification', async () => {
      const tlsConfigs = await generateConfig(type);
      const server = new QUICServer({
        crypto: {
          key,
          ops: serverCrypto,
        },
        logger: logger.getChild(QUICServer.name),
        config: {
          key: tlsConfigs.key,
          cert: tlsConfigs.cert,
          verifyPeer: true,
          verifyAllowFail: true,
        },
        verifyCallback: () => {
          throw Error('SOME ERROR');
        },
      });
      testsUtils.extractSocket(server, sockets);
      const handleConnectionEventProm = promise<QUICConnection>();
      server.addEventListener(
        'serverConnection',
        (event: events.QUICServerConnectionEvent) =>
          handleConnectionEventProm.resolveP(event.detail),
      );
      await server.start({
        host: localhost,
        port: 55555 as Port,
      });
      // Connection should fail
      const clientProm = QUICClient.createQUICClient({
        host: localhost,
        port: server.port,
        localHost: localhost,
        crypto: {
          ops: clientCrypto,
        },
        logger: logger.getChild(QUICClient.name),
        config: {
          key: tlsConfigs.key,
          cert: tlsConfigs.cert,
          verifyPeer: false,
        },
      });
      clientProm.catch(() => {});

      // Server connection is never emitted
      await Promise.race([
        handleConnectionEventProm.p.then(() => {
          throw Error('Server connection should not be emitted');
        }),
        // Allow some time
        sleep(200),
      ]);

      await expect(clientProm).rejects.toThrow(
        errors.ErrorQUICConnectionInternal,
      );

      await server.stop();
    });
  });
  test('Connections are established and secured quickly', async () => {
    const tlsConfigServer = await testsUtils.generateConfig(defaultType);

    const connectionEventProm = promise<events.QUICServerConnectionEvent>();
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfigServer.key,
        cert: tlsConfigServer.cert,
        verifyPeer: false,
      },
    });
    testsUtils.extractSocket(server, sockets);
    server.addEventListener(
      'serverConnection',
      (e: events.QUICServerConnectionEvent) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: localhost,
      port: 55555 as Port,
    });
    // If the server is slow to respond then this will time out.
    //  Then main cause of this was the server not processing the inititial packet
    //  that creates the `QUICConnection`, as a result, the whole creation waited
    //  an extra 1 second for the client to retry the initial packet.
    const client = await QUICClient.createQUICClient(
      {
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
      },
      { timer: new Timer({ delay: 500 }) },
    );
    testsUtils.extractSocket(client, sockets);
    await connectionEventProm.p;
    await server.stop();
  });
});
