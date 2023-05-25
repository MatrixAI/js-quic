import type { X509Certificate } from '@peculiar/x509';
import type { QUICConfig, Crypto, Host, Hostname, Port } from './src/types';
import dgram from 'dgram';
import Logger, { LogLevel, StreamHandler, formatting } from '@matrixai/logger';
import QUICServer from './src/QUICServer';
import QUICConnectionId from './src/QUICConnectionId';
import QUICConnection from './src/QUICConnection';
import QUICSocket from './src/QUICSocket';
import { clientDefault, buildQuicheConfig } from './src/config';
import { quiche } from './src/native';
import * as utils from './src/utils';
import * as testsUtils from './tests/utils';

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

async function main() {
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

  // This has to be setup asynchronously due to key generation
  let crypto: {
    key: ArrayBuffer;
    ops: Crypto;
  };
    crypto = {
      key: await testsUtils.generateKeyHMAC(),
      ops: {
        sign: testsUtils.signHMAC,
        verify: testsUtils.verifyHMAC,
        randomBytes: testsUtils.randomBytes,
      },
    };
  const logger = new Logger(`${QUICServer.name} Test`, LogLevel.ERROR, [ new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
      const quicServer = new QUICServer({
        crypto,
        config: {
          key: keyPairRSAPEM.privateKey,
          cert: certRSAPEM,
          // key: keyPairECDSAPEM.privateKey,
          // cert: certECDSAPEM,
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
        logger: logger.getChild(QUICConnection.name + '--CLIENT CONNECTION--')
      });

      connection.addEventListener('error', (e) => {
        console.log('error', e);
      });

      // Trigger the connection
      await connection.send();

      // wait till it is established
      // console.log('BEFORE ESTABLISHED P');
      await connection.establishedP;
      // console.log('AFTER ESTABLISHED P');

      // You must destroy the connection
      // console.log('DESTROY CONNECTION');
      await connection.destroy();
      // console.log('DESTROYED CONNECTION');

      // console.log('STOP SOCKET');
      await socket.stop();
      console.time('STOP SERVER');
      await quicServer.stop();
      console.timeEnd('STOP SERVER');
}

void main();
