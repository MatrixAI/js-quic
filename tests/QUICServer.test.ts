import type { X509Certificate } from '@peculiar/x509';
import type { Host, ServerCryptoOps, ClientCryptoOps } from '#types.js';
import Logger, { LogLevel, StreamHandler, formatting } from '@matrixai/logger';
import * as testsUtils from './utils.js';
import QUICServer from '#QUICServer.js';
import QUICClient from '#QUICClient.js';
import * as utils from '#utils.js';
import * as events from '#events.js';
import * as errors from '#errors.js';

describe(QUICServer.name, () => {
  const logger = new Logger(`${QUICServer.name} Test`, LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  let keyPairRSA: {
    publicKey: JsonWebKey;
    privateKey: JsonWebKey;
  };
  let certRSA: X509Certificate;
  let keyPairRSAPEM: {
    publicKey: string;
    privateKey: string;
  };
  let certRSAPEM: string;
  let keyPairECDSA: {
    publicKey: JsonWebKey;
    privateKey: JsonWebKey;
  };
  let certECDSA: X509Certificate;
  let keyPairECDSAPEM: {
    publicKey: string;
    privateKey: string;
  };
  let certECDSAPEM: string;
  let keyPairEd25519: {
    publicKey: JsonWebKey;
    privateKey: JsonWebKey;
  };
  let certEd25519: X509Certificate;
  let keyPairEd25519PEM: {
    publicKey: string;
    privateKey: string;
  };
  let certEd25519PEM: string;
  beforeAll(async () => {
    keyPairRSA = await testsUtils.generateKeyPairRSA();
    certRSA = await testsUtils.generateCertificate({
      certId: '0',
      subjectKeyPair: keyPairRSA,
      issuerPrivateKey: keyPairRSA.privateKey,
      duration: 60 * 60 * 24 * 365 * 10,
    });
    keyPairRSAPEM = await testsUtils.keyPairRSAToPEM(keyPairRSA);
    certRSAPEM = testsUtils.certToPEM(certRSA);
    keyPairECDSA = await testsUtils.generateKeyPairECDSA();
    certECDSA = await testsUtils.generateCertificate({
      certId: '0',
      subjectKeyPair: keyPairECDSA,
      issuerPrivateKey: keyPairECDSA.privateKey,
      duration: 60 * 60 * 24 * 365 * 10,
    });
    keyPairECDSAPEM = await testsUtils.keyPairECDSAToPEM(keyPairECDSA);
    certECDSAPEM = testsUtils.certToPEM(certECDSA);
    keyPairEd25519 = await testsUtils.generateKeyPairEd25519();
    certEd25519 = await testsUtils.generateCertificate({
      certId: '0',
      subjectKeyPair: keyPairEd25519,
      issuerPrivateKey: keyPairEd25519.privateKey,
      duration: 60 * 60 * 24 * 365 * 10,
    });
    keyPairEd25519PEM = await testsUtils.keyPairEd25519ToPEM(keyPairEd25519);
    certEd25519PEM = testsUtils.certToPEM(certEd25519);
  });
  // This has to be setup asynchronously due to key generation
  let serverCryptoOps: ServerCryptoOps;
  let key: ArrayBuffer;
  let socketCleanMethods: ReturnType<typeof testsUtils.socketCleanupFactory>;
  beforeEach(async () => {
    key = await testsUtils.generateKeyHMAC();
    serverCryptoOps = {
      sign: testsUtils.signHMAC,
      verify: testsUtils.verifyHMAC,
    };
    socketCleanMethods = testsUtils.socketCleanupFactory();
  });
  afterEach(async () => {
    await socketCleanMethods.stopSockets();
  });
  describe('start and stop', () => {
    test('with RSA', async () => {
      const quicServer = new QUICServer({
        crypto: {
          key,
          ops: serverCryptoOps,
        },
        config: {
          key: keyPairRSAPEM.privateKey,
          cert: certRSAPEM,
        },
        logger: logger.getChild('QUICServer'),
      });
      socketCleanMethods.extractSocket(quicServer);
      await quicServer.start();
      // Default to dual-stack
      expect(quicServer.host).toBe('::');
      expect(typeof quicServer.port).toBe('number');
      await quicServer.stop();
    });
    test('with ECDSA', async () => {
      const quicServer = new QUICServer({
        crypto: {
          key,
          ops: serverCryptoOps,
        },
        config: {
          key: keyPairECDSAPEM.privateKey,
          cert: certECDSAPEM,
        },
        logger: logger.getChild('QUICServer'),
      });
      socketCleanMethods.extractSocket(quicServer);
      await quicServer.start();
      // Default to dual-stack
      expect(quicServer.host).toBe('::');
      expect(typeof quicServer.port).toBe('number');
      await quicServer.stop();
    });
    test('with Ed25519', async () => {
      const quicServer = new QUICServer({
        crypto: {
          key,
          ops: serverCryptoOps,
        },
        config: {
          key: keyPairEd25519PEM.privateKey,
          cert: certEd25519PEM,
        },
        logger: logger.getChild('QUICServer'),
      });
      socketCleanMethods.extractSocket(quicServer);
      await quicServer.start();
      // Default to dual-stack
      expect(quicServer.host).toBe('::');
      expect(typeof quicServer.port).toBe('number');
      await quicServer.stop();
    });
    test('repeated stop and start', async () => {
      const quicServer = new QUICServer({
        crypto: {
          key,
          ops: serverCryptoOps,
        },
        config: {
          key: keyPairRSAPEM.privateKey,
          cert: certRSAPEM,
        },
        logger: logger.getChild('QUICServer'),
      });
      socketCleanMethods.extractSocket(quicServer);
      await quicServer.start();
      // Default to dual-stack
      expect(quicServer.host).toBe('::');
      expect(typeof quicServer.port).toBe('number');
      await quicServer.stop();
      await quicServer.start();
      // Default to dual-stack
      expect(quicServer.host).toBe('::');
      expect(typeof quicServer.port).toBe('number');
      await quicServer.stop();
    });
  });
  describe('binding to host and port', () => {
    test('listen on IPv4', async () => {
      const quicServer = new QUICServer({
        crypto: {
          key,
          ops: serverCryptoOps,
        },
        config: {
          key: keyPairEd25519PEM.privateKey,
          cert: certEd25519PEM,
        },
        logger: logger.getChild('QUICServer'),
      });
      socketCleanMethods.extractSocket(quicServer);
      await quicServer.start({
        host: '127.0.0.1',
      });
      expect(quicServer.host).toBe('127.0.0.1');
      expect(typeof quicServer.port).toBe('number');
      await quicServer.stop();
    });
    test('listen on IPv6', async () => {
      const quicServer = new QUICServer({
        crypto: {
          key,
          ops: serverCryptoOps,
        },
        config: {
          key: keyPairEd25519PEM.privateKey,
          cert: certEd25519PEM,
        },
        logger: logger.getChild('QUICServer'),
      });
      socketCleanMethods.extractSocket(quicServer);
      await quicServer.start({
        host: '::1',
      });
      expect(quicServer.host).toBe('::1');
      expect(typeof quicServer.port).toBe('number');
      await quicServer.stop();
    });
    test('listen on dual stack', async () => {
      const quicServer = new QUICServer({
        crypto: {
          key,
          ops: serverCryptoOps,
        },
        config: {
          key: keyPairEd25519PEM.privateKey,
          cert: certEd25519PEM,
        },
        logger: logger.getChild('QUICServer'),
      });
      socketCleanMethods.extractSocket(quicServer);
      await quicServer.start({
        host: '::',
      });
      expect(quicServer.host).toBe('::');
      expect(typeof quicServer.port).toBe('number');
      await quicServer.stop();
    });
    test('listen on IPv4 mapped IPv6', async () => {
      // NOT RECOMMENDED, because send addresses will have to be mapped
      // addresses, which means you can ONLY connect to mapped addresses
      const quicServer = new QUICServer({
        crypto: {
          key,
          ops: serverCryptoOps,
        },
        config: {
          key: keyPairEd25519PEM.privateKey,
          cert: certEd25519PEM,
        },
        logger: logger.getChild('QUICServer'),
      });
      socketCleanMethods.extractSocket(quicServer);
      await quicServer.start({
        host: '::ffff:127.0.0.1',
      });
      expect(quicServer.host).toBe('::ffff:127.0.0.1');
      expect(typeof quicServer.port).toBe('number');
      await quicServer.stop();
      await quicServer.start({
        host: '::ffff:7f00:1',
      });
      // Will resolve to dotted-decimal variant
      expect(quicServer.host).toBe('::ffff:127.0.0.1');
      expect(typeof quicServer.port).toBe('number');
      await quicServer.stop();
    });
    test('listen on hostname', async () => {
      const quicServer = new QUICServer({
        crypto: {
          key,
          ops: serverCryptoOps,
        },
        config: {
          key: keyPairEd25519PEM.privateKey,
          cert: certEd25519PEM,
        },
        logger: logger.getChild('QUICServer'),
      });
      socketCleanMethods.extractSocket(quicServer);
      await quicServer.start({
        host: 'localhost',
      });
      // Default to using dns lookup, which uses the OS DNS resolver
      const host = await utils.resolveHostname('localhost');
      expect(quicServer.host).toBe(host);
      expect(typeof quicServer.port).toBe('number');
      await quicServer.stop();
    });
    test('listen on hostname and custom resolver', async () => {
      const quicServer = new QUICServer({
        crypto: {
          key,
          ops: serverCryptoOps,
        },
        config: {
          key: keyPairEd25519PEM.privateKey,
          cert: certEd25519PEM,
        },
        resolveHostname: () => '127.0.0.1' as Host,
        logger: logger.getChild('QUICServer'),
      });
      await quicServer.start({
        host: 'abcdef',
      });
      expect(quicServer.host).toBe('127.0.0.1');
      expect(typeof quicServer.port).toBe('number');
      await quicServer.stop();
    });
  });
  test('stopping server socket should result in server error and client timeout', async () => {
    const tlsConfigServer = await testsUtils.generateTLSConfig('RSA');
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCryptoOps,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfigServer.leafKeyPairPEM.privateKey,
        cert: tlsConfigServer.leafCertPEM,
        verifyPeer: false,
        maxIdleTimeout: 200,
      },
    });
    socketCleanMethods.extractSocket(server);
    const { p: quicServerErrorP, rejectP: rejectQuicServerErrorP } =
      utils.promise<Error>();
    server.addEventListener(
      events.EventQUICServerError.name,
      (e: events.EventQUICServerError) => {
        rejectQuicServerErrorP(e.detail);
      },
    );
    await server.start({
      host: '127.0.0.1',
    });
    const clientCryptoOps: ClientCryptoOps = {
      randomBytes: testsUtils.randomBytes,
    };
    const client = await QUICClient.createQUICClient({
      host: '127.0.0.1',
      port: server.port,
      localHost: '127.0.0.1',
      crypto: {
        ops: clientCryptoOps,
      },
      config: {
        verifyPeer: false,
        maxIdleTimeout: 200,
      },
      logger: logger.getChild(QUICClient.name),
    });
    const { p: quicClientErrorP, rejectP: rejectQuicClientErrorP } =
      utils.promise<Error>();
    client.addEventListener(
      events.EventQUICClientError.name,
      (e: events.EventQUICClientError) => {
        rejectQuicClientErrorP(e.detail);
      },
    );
    socketCleanMethods.extractSocket(client);
    // Force stop the server socket
    // @ts-ignore: protected property
    await server.socket.stop({ force: true });
    // Results in an error event on the server
    await expect(quicServerErrorP).rejects.toThrowError(
      errors.ErrorQUICServerSocketNotRunning,
    );
    await expect(quicClientErrorP).rejects.toThrowError(
      errors.ErrorQUICConnectionIdleTimeout,
    );
  });
});
