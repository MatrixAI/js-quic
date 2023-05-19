import type { X509Certificate } from '@peculiar/x509';
import type { Crypto, Host, Port } from '@/types';
import type { QUICConfig } from '@/config';
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
});
