import type { X509Certificate } from '@peculiar/x509';
import type { QUICConfig, Crypto, Host, Hostname, Port } from '@/types';
import dgram from 'dgram';
import Logger, { LogLevel, StreamHandler, formatting } from '@matrixai/logger';
import QUICServer from '@/QUICServer';
import QUICConnectionId from '@/QUICConnectionId';
import QUICConnection from '@/QUICConnection';
import QUICSocket from '@/QUICSocket';
import { clientDefault, buildQuicheConfig } from '@/config';
import { quiche } from '@/native';
import * as utils from '@/utils';
import * as testsUtils from './utils';

describe(QUICServer.name, () => {
  const logger = new Logger(`${QUICServer.name} Test`, LogLevel.WARN, [ new StreamHandler(
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
  let crypto: {
    key: ArrayBuffer;
    ops: Crypto;
  };
  beforeEach(async () => {
    crypto = {
      key: await testsUtils.generateKeyHMAC(),
      ops: {
        sign: testsUtils.signHMAC,
        verify: testsUtils.verifyHMAC,
        randomBytes: testsUtils.randomBytes,
      },
    };
  });
  describe('start and stop', () => {
    test('with RSA', async () => {
      const quicServer = new QUICServer({
        crypto,
        config: {
          key: keyPairRSAPEM.privateKey,
          cert: certRSAPEM,
        },
        logger: logger.getChild('QUICServer'),
      });
      await quicServer.start();
      // Default to dual-stack
      expect(quicServer.host).toBe('::');
      expect(typeof quicServer.port).toBe('number');
      await quicServer.stop();
    });
    test('with ECDSA', async () => {
      const quicServer = new QUICServer({
        crypto,
        config: {
          key: keyPairECDSAPEM.privateKey,
          cert: certECDSAPEM,
        },
        logger: logger.getChild('QUICServer'),
      });
      await quicServer.start();
      // Default to dual-stack
      expect(quicServer.host).toBe('::');
      expect(typeof quicServer.port).toBe('number');
      await quicServer.stop();
    });
    test('with Ed25519', async () => {
      const quicServer = new QUICServer({
        crypto,
        config: {
          key: keyPairEd25519PEM.privateKey,
          cert: certEd25519PEM,
        },
        logger: logger.getChild('QUICServer'),
      });
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
        crypto,
        config: {
          key: keyPairEd25519PEM.privateKey,
          cert: certEd25519PEM,
        },
        logger: logger.getChild('QUICServer'),
      });
      await quicServer.start({
        host: '127.0.0.1' as Host
      });
      expect(quicServer.host).toBe('127.0.0.1');
      expect(typeof quicServer.port).toBe('number');
      await quicServer.stop();
    });
    test('listen on IPv6', async () => {
      const quicServer = new QUICServer({
        crypto,
        config: {
          key: keyPairEd25519PEM.privateKey,
          cert: certEd25519PEM,
        },
        logger: logger.getChild('QUICServer'),
      });
      await quicServer.start({
        host: '::1' as Host
      });
      expect(quicServer.host).toBe('::1');
      expect(typeof quicServer.port).toBe('number');
      await quicServer.stop();
    });
    test('listen on dual stack', async () => {
      const quicServer = new QUICServer({
        crypto,
        config: {
          key: keyPairEd25519PEM.privateKey,
          cert: certEd25519PEM,
        },
        logger: logger.getChild('QUICServer'),
      });
      await quicServer.start({
        host: '::' as Host
      });
      expect(quicServer.host).toBe('::');
      expect(typeof quicServer.port).toBe('number');
      await quicServer.stop();
    });
    test('listen on IPv4 mapped IPv6', async () => {
      // NOT RECOMMENDED, because send addresses will have to be mapped
      // addresses, which means you can ONLY connect to mapped addresses
      const quicServer = new QUICServer({
        crypto,
        config: {
          key: keyPairEd25519PEM.privateKey,
          cert: certEd25519PEM,
        },
        logger: logger.getChild('QUICServer'),
      });
      await quicServer.start({
        host: '::ffff:127.0.0.1' as Host
      });
      expect(quicServer.host).toBe('::ffff:127.0.0.1');
      expect(typeof quicServer.port).toBe('number');
      await quicServer.stop();
      await quicServer.start({
        host: '::ffff:7f00:1' as Host
      });
      // Will resolve to dotted-decimal variant
      expect(quicServer.host).toBe('::ffff:127.0.0.1');
      expect(typeof quicServer.port).toBe('number');
      await quicServer.stop();
    });
    test('listen on hostname', async () => {
      const quicServer = new QUICServer({
        crypto,
        config: {
          key: keyPairEd25519PEM.privateKey,
          cert: certEd25519PEM,
        },
        logger: logger.getChild('QUICServer'),
      });
      await quicServer.start({
        host: 'localhost' as Hostname
      });
      // Default to using dns lookup, which uses the OS DNS resolver
      const host = await utils.resolveHostname('localhost' as Hostname);
      expect(quicServer.host).toBe(host);
      expect(typeof quicServer.port).toBe('number');
      await quicServer.stop();
    });
    test('listen on hostname and custom resolver', async () => {
      const quicServer = new QUICServer({
        crypto,
        config: {
          key: keyPairEd25519PEM.privateKey,
          cert: certEd25519PEM,
        },
        resolveHostname: () => '127.0.0.1' as Host,
        logger: logger.getChild('QUICServer'),
      });
      await quicServer.start({
        host: 'abcdef' as Hostname
      });
      expect(quicServer.host).toBe('127.0.0.1');
      expect(typeof quicServer.port).toBe('number');
      await quicServer.stop();
    });
  });
  describe.only('connection bootstrap', () => {
    // Test without peer verification
    test.only('', async () => {
      const quicServer = new QUICServer({
        crypto,
        config: {
          // key: keyPairRSAPEM.privateKey,
          // cert: certRSAPEM,
          key: keyPairECDSAPEM.privateKey,
          cert: certECDSAPEM,
          verifyPeer: false
        },
        logger: logger.getChild('QUICServer'),
      });
      await quicServer.start({
        host: '127.0.0.1' as Host
      });

      const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
      await crypto.ops.randomBytes(scidBuffer);
      const scid = new QUICConnectionId(scidBuffer);

      // Verify peer
      // Note that you cannot send to IPv4 from dual stack socket
      // It must be sent as IPv4 mapped IPv6

      const socket = new QUICSocket({
        crypto,
        logger: logger.getChild(QUICSocket.name),
      });
      await socket.start({
        host: '127.0.0.1' as Host
      });

      // ???
      const clientConfig: QUICConfig = {
        ...clientDefault,
        verifyPeer: false
      };

      // This creates a connection state
      // We now need to trigger it
      const connection = await QUICConnection.connectQUICConnection({
        scid,
        socket,
        remoteInfo: {
          host: quicServer.host,
          port: quicServer.port,
        },
        config: clientConfig,
        logger: logger.getChild(QUICConnection.name)
      });

      connection.addEventListener('error', (e) => {
        console.log('error', e);
      });

      // Trigger the connection
      await connection.send();

      // wait till it is established
      console.log('BEFORE ESTABLISHED P');
      await connection.establishedP;
      console.log('AFTER ESTABLISHED P');

      // You must destroy the connection
      console.log('DESTROY CONNECTION');
      await connection.destroy();
      console.log('DESTROYED CONNECTION');

      console.log('STOP SOCKET');
      await socket.stop();
      console.time('STOPPED SOCKET');
      await quicServer.stop();
      console.timeEnd('STOPPED SOCKET');
    });
  });
  // test('bootstrapping a new connection', async () => {
  //   const quicServer = new QUICServer({
  //     crypto,
  //     config: {
  //       key: keyPairEd25519PEM.privateKey,
  //       cert: certEd25519PEM,
  //     },
  //     logger: logger.getChild('QUICServer'),
  //   });
  //   await quicServer.start();

  //   const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
  //   await crypto.ops.randomBytes(scidBuffer);
  //   const scid = new QUICConnectionId(scidBuffer);

  //   const socket = new QUICSocket({
  //     crypto,
  //     resolveHostname: utils.resolveHostname,
  //     logger: logger.getChild(QUICSocket.name),
  //   });
  //   await socket.start();

  //   // Const config = buildQuicheConfig({
  //   //   ...clientDefault
  //   // });
  //   // Here we want to VERIFY the peer
  //   // If we use the same certificate
  //   // then it should be consider as if it is trusted!

  //   const quicConfig: QUICConfig = {
  //     ...clientDefault,
  //     verifyPeer: true,
  //   };

  //   const connection = await QUICConnection.connectQUICConnection({
  //     scid,
  //     socket,

  //     remoteInfo: {
  //       host: utils.resolvesZeroIP(quicServer.host),
  //       port: quicServer.port,
  //     },

  //     config: quicConfig,
  //   });

  //   await socket.stop();
  //   await quicServer.stop();

  //   // We can run with several rsa keypairs and certificates
  // });
  describe('updating configuration', () => {
    // We want to test changing the configuration over time
  });
  // Test hole punching, there's an initiation function
  // We can make it start doing this, but technically it's the socket's duty to do this
  // not just the server side
});