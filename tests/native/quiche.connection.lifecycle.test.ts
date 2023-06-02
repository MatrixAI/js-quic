import type { X509Certificate } from '@peculiar/x509';
import type { QUICConfig, Crypto, Host, Hostname, Port } from '@/types';
import type { Config, Connection, SendInfo } from '@/native/types';
import { quiche } from '@/native';
import { clientDefault, serverDefault, buildQuicheConfig } from '@/config';
import QUICConnectionId from '@/QUICConnectionId';
import * as utils from '@/utils';
import * as testsUtils from '../utils';

describe('quiche connection lifecycle', () => {
  let crypto: {
    key: ArrayBuffer;
    ops: Crypto;
  };
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
    crypto = {
      key: await testsUtils.generateKeyHMAC(),
      ops: {
        sign: testsUtils.signHMAC,
        verify: testsUtils.verifyHMAC,
        randomBytes: testsUtils.randomBytes,
      },
    };
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
  describe('connection lifecycle', () => {
    describe('connect and close client', () => {
      // These tests run in-order, and each step is a state transition
      const clientHost = {
        host: '127.0.0.1' as Host,
        port: 55555 as Port,
      };
      const serverHost = {
        host: '127.0.0.1' as Host,
        port: 55556,
      };
      let clientQuicheConfig: Config;
      let clientScid: QUICConnectionId;
      let clientConn: Connection;
      beforeAll(async () => {
        const clientConfig: QUICConfig = {
          ...clientDefault,
          verifyPeer: false,
        };
        clientQuicheConfig = buildQuicheConfig(clientConfig);
      });
      test('client connect', async () => {
        // Randomly genrate the client SCID
        const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
        await crypto.ops.randomBytes(scidBuffer);
        clientScid = new QUICConnectionId(scidBuffer);
        clientConn = quiche.Connection.connect(
          null,
          clientScid,
          clientHost,
          serverHost,
          clientQuicheConfig,
        );
        expect(clientConn.timeout()).toBeNull();
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeFalse();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();
      });
      test('client close', async () => {
        clientConn.close(true, 0, Buffer.from('Hello World'));
        expect(clientConn.peerError()).toBeNull();
        // According to RFC9000, if the connection is not in a position
        // to send the connection close frame, then the local error
        // is changed to be a protocol level error with the `ApplicationError`
        // code and a cleared reason.
        // If this connection was in a position to send the error, then
        // we would expect the `isApp` to be `true`.
        expect(clientConn.localError()).toEqual({
          isApp: false,
          errorCode: quiche.ConnectionErrorCode.ApplicationError,
          reason: new Uint8Array()
        });
        expect(clientConn.timeout()).toBeNull();
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeFalse();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        // Client connection is closed (this is not true if there is draining)
        expect(clientConn.isClosed()).toBeTrue();
        expect(clientConn.isDraining()).toBeFalse();
      });
      test('after client close', async () => {
        const randomPacketBuffer = new ArrayBuffer(1000);
        await testsUtils.randomBytes(randomPacketBuffer);
        const randomPacket = new Uint8Array(randomPacketBuffer);
        // Random packets are received after the connection is closed
        // However they are just dropped automatically
        clientConn.recv(
          randomPacket,
          {
            to: clientHost,
            from: serverHost
          }
        );
        // You can receive multiple times without any problems
        clientConn.recv(
          randomPacket,
          {
            to: clientHost,
            from: serverHost
          }
        );
        clientConn.recv(
          randomPacket,
          {
            to: clientHost,
            from: serverHost
          }
        );
        const clientBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        expect(() => clientConn.send(clientBuffer)).toThrow('Done');
        expect(clientConn.isClosed()).toBeTrue();
      });
    });
    describe('connection timeouts', () => {
      describe('dialing timeout', () => {
        // These tests run in-order, and each step is a state transition
        const clientHost = {
          host: '127.0.0.1' as Host,
          port: 55555 as Port,
        };
        const serverHost = {
          host: '127.0.0.1' as Host,
          port: 55556,
        };
        // These buffers will be used between the tests and will be mutated
        let clientSendLength: number, clientSendInfo: SendInfo;
        const clientBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        let clientQuicheConfig: Config;
        let serverQuicheConfig: Config;
        let clientScid: QUICConnectionId;
        let clientConn: Connection;
        beforeAll(async () => {
          const clientConfig: QUICConfig = {
            ...clientDefault,
            verifyPeer: false,
            maxIdleTimeout: 2000
          };
          const serverConfig: QUICConfig = {
            ...serverDefault,
            key: keyPairRSAPEM.privateKey,
            cert: certRSAPEM,
            maxIdleTimeout: 2000
          };
          clientQuicheConfig = buildQuicheConfig(clientConfig);
          serverQuicheConfig = buildQuicheConfig(serverConfig);
        });
        test('client connect', async () => {
          // Randomly genrate the client SCID
          const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
          await crypto.ops.randomBytes(scidBuffer);
          clientScid = new QUICConnectionId(scidBuffer);
          clientConn = quiche.Connection.connect(
            null,
            clientScid,
            clientHost,
            serverHost,
            clientQuicheConfig,
          );
        });
        test('client dialing timeout', async () => {
          [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
          expect(() => clientConn.send(clientBuffer)).toThrow('Done');
          // Exahust the timeout
          await testsUtils.waitForTimeoutNull(clientConn);
          // Connection has timed out
          expect(clientConn.isTimedOut()).toBeTrue();
          expect(clientConn.isInEarlyData()).toBeFalse();
          expect(clientConn.isEstablished()).toBeFalse();
          expect(clientConn.isResumed()).toBeFalse();
          expect(clientConn.isReadable()).toBeFalse();
          // Connection is closed
          expect(clientConn.isClosed()).toBeTrue();
          expect(clientConn.isDraining()).toBeFalse();
          // No errors during idle timeout
          expect(clientConn.localError()).toBeNull();
          expect(clientConn.peerError()).toBeNull();
        });
      });
      describe('initial timeout', () => {
        // These tests run in-order, and each step is a state transition
        const clientHost = {
          host: '127.0.0.1' as Host,
          port: 55555 as Port,
        };
        const serverHost = {
          host: '127.0.0.1' as Host,
          port: 55556,
        };
        // These buffers will be used between the tests and will be mutated
        let clientSendLength: number, clientSendInfo: SendInfo;
        const clientBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        let serverSendLength: number, serverSendInfo: SendInfo;
        const serverBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        let clientQuicheConfig: Config;
        let serverQuicheConfig: Config;
        let clientScid: QUICConnectionId;
        let clientDcid: QUICConnectionId;
        let serverScid: QUICConnectionId;
        let serverDcid: QUICConnectionId;
        let clientConn: Connection;
        let serverConn: Connection;
        beforeAll(async () => {
          const clientConfig: QUICConfig = {
            ...clientDefault,
            verifyPeer: false,
            maxIdleTimeout: 2000
          };
          const serverConfig: QUICConfig = {
            ...serverDefault,
            key: keyPairRSAPEM.privateKey,
            cert: certRSAPEM,
            maxIdleTimeout: 2000
          };
          clientQuicheConfig = buildQuicheConfig(clientConfig);
          serverQuicheConfig = buildQuicheConfig(serverConfig);
        });
        test('client connect', async () => {
          // Randomly genrate the client SCID
          const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
          await crypto.ops.randomBytes(scidBuffer);
          clientScid = new QUICConnectionId(scidBuffer);
          clientConn = quiche.Connection.connect(
            null,
            clientScid,
            clientHost,
            serverHost,
            clientQuicheConfig,
          );
        });
        test('client dialing', async () => {
          [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
        });
        test('client and server negotiation', async () => {
          const clientHeaderInitial = quiche.Header.fromSlice(
            clientBuffer.subarray(0, clientSendLength),
            quiche.MAX_CONN_ID_LEN
          );
          clientDcid = new QUICConnectionId(clientHeaderInitial.dcid);
          serverScid = new QUICConnectionId(
            await crypto.ops.sign(
              crypto.key,
              clientDcid,
            ),
            0,
            quiche.MAX_CONN_ID_LEN
          );
          const token = await utils.mintToken(clientDcid, clientHost.host, crypto);
          const retryDatagram = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
          const retryDatagramLength = quiche.retry(
            clientScid,
            clientDcid,
            serverScid,
            token,
            clientHeaderInitial.version,
            retryDatagram
          );
          // Retry gets sent back to be processed by the client
          clientConn.recv(
            retryDatagram.subarray(0, retryDatagramLength),
            {
              to: clientHost,
              from: serverHost
            }
          );
          [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
          const clientHeaderInitialRetry = quiche.Header.fromSlice(
            clientBuffer.subarray(0, clientSendLength),
            quiche.MAX_CONN_ID_LEN
          );
          const dcidOriginal = await utils.validateToken(
            Buffer.from(clientHeaderInitialRetry.token!),
            clientHost.host,
            crypto
          );
          expect(dcidOriginal).toEqual(clientDcid);
        });
        test('server accept', async () => {
          serverConn = quiche.Connection.accept(
            serverScid,
            clientDcid,
            serverHost,
            clientHost,
            serverQuicheConfig
          );
          clientDcid = serverScid;
          serverDcid = clientScid;
          expect(serverConn.timeout()).toBeNull();
          serverConn.recv(
            clientBuffer.subarray(0, clientSendLength),
            {
              to: serverHost,
              from: clientHost
            }
          );
          // Once an idle max timeout is set, this timeout is no longer null
          // Either the client or server or both can set the idle timeout
          expect(serverConn.timeout()).not.toBeNull();
        });
        test('client <-initial- server timeout', async () => {
          // Server tries sending the initial frame
          [serverSendLength, serverSendInfo] = serverConn.send(serverBuffer);
          expect(clientConn.timeout()).not.toBeNull();
          expect(serverConn.timeout()).not.toBeNull();
          expect(clientConn.isTimedOut()).toBeFalse();
          expect(serverConn.isTimedOut()).toBeFalse();
          // Let's assume the initial frame never gets received by the client
          await testsUtils.sleep(serverConn.timeout()!);
          serverConn.onTimeout();
          await testsUtils.waitForTimeoutNull(serverConn);
          expect(serverConn.isTimedOut()).toBeTrue();
          expect(serverConn.isInEarlyData()).toBeFalse();
          expect(serverConn.isEstablished()).toBeFalse();
          expect(serverConn.isResumed()).toBeFalse();
          expect(serverConn.isReadable()).toBeFalse();
          expect(serverConn.isClosed()).toBeTrue();
          expect(serverConn.isDraining()).toBeFalse();
          await testsUtils.sleep(clientConn.timeout()!);
          clientConn.onTimeout();
          await testsUtils.waitForTimeoutNull(clientConn);
          expect(clientConn.isTimedOut()).toBeTrue();
          expect(clientConn.isInEarlyData()).toBeFalse();
          expect(clientConn.isEstablished()).toBeFalse();
          expect(clientConn.isResumed()).toBeFalse();
          expect(clientConn.isReadable()).toBeFalse();
          expect(clientConn.isClosed()).toBeTrue();
          expect(clientConn.isDraining()).toBeFalse();
        });
      });
      describe('handshake timeout', () => {
        // These tests run in-order, and each step is a state transition
        const clientHost = {
          host: '127.0.0.1' as Host,
          port: 55555 as Port,
        };
        const serverHost = {
          host: '127.0.0.1' as Host,
          port: 55556,
        };
        // These buffers will be used between the tests and will be mutated
        let clientSendLength: number, clientSendInfo: SendInfo;
        const clientBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        let serverSendLength: number, serverSendInfo: SendInfo;
        const serverBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        let clientQuicheConfig: Config;
        let serverQuicheConfig: Config;
        let clientScid: QUICConnectionId;
        let clientDcid: QUICConnectionId;
        let serverScid: QUICConnectionId;
        let serverDcid: QUICConnectionId;
        let clientConn: Connection;
        let serverConn: Connection;
        beforeAll(async () => {
          const clientConfig: QUICConfig = {
            ...clientDefault,
            verifyPeer: false,
            maxIdleTimeout: 2000
          };
          const serverConfig: QUICConfig = {
            ...serverDefault,
            key: keyPairRSAPEM.privateKey,
            cert: certRSAPEM,
            maxIdleTimeout: 2000
          };
          clientQuicheConfig = buildQuicheConfig(clientConfig);
          serverQuicheConfig = buildQuicheConfig(serverConfig);
        });
        test('client connect', async () => {
          // Randomly genrate the client SCID
          const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
          await crypto.ops.randomBytes(scidBuffer);
          clientScid = new QUICConnectionId(scidBuffer);
          clientConn = quiche.Connection.connect(
            null,
            clientScid,
            clientHost,
            serverHost,
            clientQuicheConfig,
          );
        });
        test('client dialing', async () => {
          [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
        });
        test('client and server negotiation', async () => {
          const clientHeaderInitial = quiche.Header.fromSlice(
            clientBuffer.subarray(0, clientSendLength),
            quiche.MAX_CONN_ID_LEN
          );
          clientDcid = new QUICConnectionId(clientHeaderInitial.dcid);
          serverScid = new QUICConnectionId(
            await crypto.ops.sign(
              crypto.key,
              clientDcid,
            ),
            0,
            quiche.MAX_CONN_ID_LEN
          );
          const token = await utils.mintToken(clientDcid, clientHost.host, crypto);
          const retryDatagram = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
          const retryDatagramLength = quiche.retry(
            clientScid,
            clientDcid,
            serverScid,
            token,
            clientHeaderInitial.version,
            retryDatagram
          );
          // Retry gets sent back to be processed by the client
          clientConn.recv(
            retryDatagram.subarray(0, retryDatagramLength),
            {
              to: clientHost,
              from: serverHost
            }
          );
          [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
          const clientHeaderInitialRetry = quiche.Header.fromSlice(
            clientBuffer.subarray(0, clientSendLength),
            quiche.MAX_CONN_ID_LEN
          );
          const dcidOriginal = await utils.validateToken(
            Buffer.from(clientHeaderInitialRetry.token!),
            clientHost.host,
            crypto
          );
          expect(dcidOriginal).toEqual(clientDcid);
        });
        test('server accept', async () => {
          serverConn = quiche.Connection.accept(
            serverScid,
            clientDcid,
            serverHost,
            clientHost,
            serverQuicheConfig
          );
          clientDcid = serverScid;
          serverDcid = clientScid;
          expect(serverConn.timeout()).toBeNull();
          serverConn.recv(
            clientBuffer.subarray(0, clientSendLength),
            {
              to: serverHost,
              from: clientHost
            }
          );
          // Once an idle max timeout is set, this timeout is no longer null
          // Either the client or server or both can set the idle timeout
          expect(serverConn.timeout()).not.toBeNull();
        });
        test('client <-initial- server', async () => {
          [serverSendLength, serverSendInfo] = serverConn.send(serverBuffer);
          clientConn.recv(
            serverBuffer.subarray(0, serverSendLength),
            {
              to: clientHost,
              from: serverHost
            }
          );
        });
        test('client -initial-> server', async () => {
          [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
          serverConn.recv(
            clientBuffer.subarray(0, clientSendLength),
            {
              to: serverHost,
              from: clientHost
            }
          );
        });
        test('client <-handshake- server timeout', async () => {
          [serverSendLength, serverSendInfo] = serverConn.send(serverBuffer);
          expect(clientConn.timeout()).not.toBeNull();
          expect(serverConn.timeout()).not.toBeNull();
          expect(clientConn.isTimedOut()).toBeFalse();
          expect(serverConn.isTimedOut()).toBeFalse();
          // Let's assume the handshake frame never gets received by the client
          await testsUtils.sleep(serverConn.timeout()!);
          serverConn.onTimeout();
          await testsUtils.waitForTimeoutNull(serverConn);
          expect(serverConn.isTimedOut()).toBeTrue();
          expect(serverConn.isInEarlyData()).toBeFalse();
          expect(serverConn.isEstablished()).toBeFalse();
          expect(serverConn.isResumed()).toBeFalse();
          expect(serverConn.isReadable()).toBeFalse();
          expect(serverConn.isClosed()).toBeTrue();
          expect(serverConn.isDraining()).toBeFalse();
          await testsUtils.sleep(clientConn.timeout()!);
          clientConn.onTimeout();
          await testsUtils.waitForTimeoutNull(clientConn);
          expect(clientConn.isTimedOut()).toBeTrue();
          expect(clientConn.isInEarlyData()).toBeFalse();
          expect(clientConn.isEstablished()).toBeFalse();
          expect(clientConn.isResumed()).toBeFalse();
          expect(clientConn.isReadable()).toBeFalse();
          expect(clientConn.isClosed()).toBeTrue();
          expect(clientConn.isDraining()).toBeFalse();
        });
      });
      describe('established timeout', () => {
        // These tests run in-order, and each step is a state transition
        const clientHost = {
          host: '127.0.0.1' as Host,
          port: 55555 as Port,
        };
        const serverHost = {
          host: '127.0.0.1' as Host,
          port: 55556,
        };
        // These buffers will be used between the tests and will be mutated
        let clientSendLength: number, clientSendInfo: SendInfo;
        const clientBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        let serverSendLength: number, serverSendInfo: SendInfo;
        const serverBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        let clientQuicheConfig: Config;
        let serverQuicheConfig: Config;
        let clientScid: QUICConnectionId;
        let clientDcid: QUICConnectionId;
        let serverScid: QUICConnectionId;
        let serverDcid: QUICConnectionId;
        let clientConn: Connection;
        let serverConn: Connection;
        beforeAll(async () => {
          const clientConfig: QUICConfig = {
            ...clientDefault,
            verifyPeer: false,
            maxIdleTimeout: 2000
          };
          const serverConfig: QUICConfig = {
            ...serverDefault,
            key: keyPairRSAPEM.privateKey,
            cert: certRSAPEM,
            maxIdleTimeout: 2000
          };
          clientQuicheConfig = buildQuicheConfig(clientConfig);
          serverQuicheConfig = buildQuicheConfig(serverConfig);
        });
        test('client connect', async () => {
          // Randomly genrate the client SCID
          const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
          await crypto.ops.randomBytes(scidBuffer);
          clientScid = new QUICConnectionId(scidBuffer);
          clientConn = quiche.Connection.connect(
            null,
            clientScid,
            clientHost,
            serverHost,
            clientQuicheConfig,
          );
        });
        test('client dialing', async () => {
          [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
        });
        test('client and server negotiation', async () => {
          const clientHeaderInitial = quiche.Header.fromSlice(
            clientBuffer.subarray(0, clientSendLength),
            quiche.MAX_CONN_ID_LEN
          );
          clientDcid = new QUICConnectionId(clientHeaderInitial.dcid);
          serverScid = new QUICConnectionId(
            await crypto.ops.sign(
              crypto.key,
              clientDcid,
            ),
            0,
            quiche.MAX_CONN_ID_LEN
          );
          const token = await utils.mintToken(clientDcid, clientHost.host, crypto);
          const retryDatagram = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
          const retryDatagramLength = quiche.retry(
            clientScid,
            clientDcid,
            serverScid,
            token,
            clientHeaderInitial.version,
            retryDatagram
          );
          // Retry gets sent back to be processed by the client
          clientConn.recv(
            retryDatagram.subarray(0, retryDatagramLength),
            {
              to: clientHost,
              from: serverHost
            }
          );
          [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
          const clientHeaderInitialRetry = quiche.Header.fromSlice(
            clientBuffer.subarray(0, clientSendLength),
            quiche.MAX_CONN_ID_LEN
          );
          const dcidOriginal = await utils.validateToken(
            Buffer.from(clientHeaderInitialRetry.token!),
            clientHost.host,
            crypto
          );
          expect(dcidOriginal).toEqual(clientDcid);
        });
        test('server accept', async () => {
          serverConn = quiche.Connection.accept(
            serverScid,
            clientDcid,
            serverHost,
            clientHost,
            serverQuicheConfig
          );
          clientDcid = serverScid;
          serverDcid = clientScid;
          expect(serverConn.timeout()).toBeNull();
          serverConn.recv(
            clientBuffer.subarray(0, clientSendLength),
            {
              to: serverHost,
              from: clientHost
            }
          );
          // Once an idle max timeout is set, this timeout is no longer null
          // Either the client or server or both can set the idle timeout
          expect(serverConn.timeout()).not.toBeNull();
        });
        test('client <-initial- server', async () => {
          [serverSendLength, serverSendInfo] = serverConn.send(serverBuffer);
          clientConn.recv(
            serverBuffer.subarray(0, serverSendLength),
            {
              to: clientHost,
              from: serverHost
            }
          );
        });
        test('client -initial-> server', async () => {
          [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
          serverConn.recv(
            clientBuffer.subarray(0, clientSendLength),
            {
              to: serverHost,
              from: clientHost
            }
          );
        });
        test('client <-handshake- server', async () => {
          [serverSendLength, serverSendInfo] = serverConn.send(serverBuffer);
          clientConn.recv(
            serverBuffer.subarray(0, serverSendLength),
            {
              to: clientHost,
              from: serverHost
            }
          );
        });
        test('client is established', async () => {
          expect(clientConn.isEstablished()).toBeTrue();
        });
        test('client -handshake-> sever', async () => {
          [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
          serverConn.recv(
            clientBuffer.subarray(0, clientSendLength),
            {
              to: serverHost,
              from: clientHost
            }
          );
        });
        test('server is established', async () => {
          expect(serverConn.isEstablished()).toBeTrue();
        });
        test('client <-short- server timeout', async () => {
          [serverSendLength, serverSendInfo] = serverConn.send(serverBuffer);
          expect(clientConn.timeout()).not.toBeNull();
          expect(serverConn.timeout()).not.toBeNull();
          expect(clientConn.isTimedOut()).toBeFalse();
          expect(serverConn.isTimedOut()).toBeFalse();
          // Let's assume the handshake frame never gets received by the client
          await testsUtils.sleep(serverConn.timeout()!);
          serverConn.onTimeout();
          await testsUtils.waitForTimeoutNull(serverConn);
          expect(serverConn.isTimedOut()).toBeTrue();
          expect(serverConn.isInEarlyData()).toBeFalse();
          expect(serverConn.isEstablished()).toBeTrue();
          expect(serverConn.isResumed()).toBeFalse();
          expect(serverConn.isReadable()).toBeFalse();
          expect(serverConn.isClosed()).toBeTrue();
          expect(serverConn.isDraining()).toBeFalse();
          await testsUtils.sleep(clientConn.timeout()!);
          clientConn.onTimeout();
          await testsUtils.waitForTimeoutNull(clientConn);
          expect(clientConn.isTimedOut()).toBeTrue();
          expect(clientConn.isInEarlyData()).toBeFalse();
          expect(clientConn.isEstablished()).toBeTrue();
          expect(clientConn.isResumed()).toBeFalse();
          expect(clientConn.isReadable()).toBeFalse();
          expect(clientConn.isClosed()).toBeTrue();
          expect(clientConn.isDraining()).toBeFalse();
        });
      });
    });
    describe('connection between client and server with RSA', () => {
      // These tests run in-order, and each step is a state transition
      const clientHost = {
        host: '127.0.0.1' as Host,
        port: 55555 as Port,
      };
      const serverHost = {
        host: '127.0.0.1' as Host,
        port: 55556,
      };
      // These buffers will be used between the tests and will be mutated
      let clientSendLength: number, clientSendInfo: SendInfo;
      const clientBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
      let serverSendLength: number, serverSendInfo: SendInfo;
      const serverBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
      let clientQuicheConfig: Config;
      let serverQuicheConfig: Config;
      let clientScid: QUICConnectionId;
      let clientDcid: QUICConnectionId;
      let serverScid: QUICConnectionId;
      let serverDcid: QUICConnectionId;
      let clientConn: Connection;
      let serverConn: Connection;
      beforeAll(async () => {
        const clientConfig: QUICConfig = {
          ...clientDefault,
          verifyPeer: false,
        };
        const serverConfig: QUICConfig = {
          ...serverDefault,
          key: keyPairRSAPEM.privateKey,
          cert: certRSAPEM,
        };
        clientQuicheConfig = buildQuicheConfig(clientConfig);
        serverQuicheConfig = buildQuicheConfig(serverConfig);
      });
      test('client connect', async () => {
        // Randomly genrate the client SCID
        const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
        await crypto.ops.randomBytes(scidBuffer);
        clientScid = new QUICConnectionId(scidBuffer);
        clientConn = quiche.Connection.connect(
          null,
          clientScid,
          clientHost,
          serverHost,
          clientQuicheConfig,
        );
        expect(clientConn.timeout()).toBeNull();
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeFalse();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();
      });
      test('client dialing', async () => {
        // Send the initial packet
        [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
        // The initial frame will always be 1200 bytes
        expect(clientSendLength).toBe(1200);
        expect(clientSendInfo.from).toEqual(clientHost);
        expect(clientSendInfo.to).toEqual(serverHost);
        // This is the initial delay for the dialing procedure
        // Quiche will repeatedly send the initial packet until it is received
        // or exhausted the idle timeout, which in this case is 0 (disabled)
        expect(typeof clientConn.timeout()!).toBe('number');
        // The initial delay starts at roughly 1 second
        // Round to the nearest 1000
        expect(clientConn.timeout()).toBeCloseTo(1000, -3);
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeFalse();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();
        // Repeating send will throw `Done`
        // This proves that only 1 send is necessary at the beginning
        expect(() => clientConn.send(clientBuffer)).toThrow('Done');
        // Wait out the delay (add 50ms for non-determinism)
        await testsUtils.sleep(clientConn.timeout()! + 50);
        // Connection has not timed out because idle timeout defaults to infinity
        expect(clientConn.isTimedOut()).toBeFalse();
        // The delay is exhausted, and therefore should be 0
        expect(clientConn.timeout()).toBe(0);
        // The `onTimeout` must be called to transition state
        clientConn.onTimeout();
        // The delay is repeated immediately after `onTimeout`
        // It is still 1 second
        // Round to the nearest 1000
        expect(clientConn.timeout()).toBeCloseTo(1000, -3);
        // Retry the initial packet
        const clientBuffer_ = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer_);
        expect(clientSendLength).toBe(1200);
        expect(clientSendInfo.from).toEqual(clientHost);
        expect(clientSendInfo.to).toEqual(serverHost);
        // Retried initial frame is not an exact copy
        expect(clientBuffer_).not.toEqual(clientBuffer);
        // Upon the retry, the delay now doubles
        // Round to the nearest 1000
        expect(clientConn.timeout()).toBeCloseTo(2000, -3);
        // This dialing process will repeat max idle timeout is exhausted
        // Copy sendBuffer_ into sendBuffer
        clientBuffer.set(clientBuffer_);
      });
      test('client and server negotiation', async () => {
        // Process the initial frame
        const clientHeaderInitial = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        // It will be an initial packet
        expect(clientHeaderInitial.ty).toBe(quiche.Type.Initial);
        // The SCID is what was generated above
        expect(new QUICConnectionId(clientHeaderInitial.scid)).toEqual(clientScid);
        // The DCID is randomly generated by the client
        clientDcid = new QUICConnectionId(clientHeaderInitial.dcid);
        expect(clientDcid).not.toEqual(clientScid);
        // The token will be empty
        expect(clientHeaderInitial.token).toHaveLength(0);
        // The version should be 1
        expect(clientHeaderInitial.version).toBe(quiche.PROTOCOL_VERSION);
        expect(clientHeaderInitial.versions).toBeNull();
        // Version negotiation
        // The version is supported, we don't need to change
        expect(quiche.versionIsSupported(clientHeaderInitial.version)).toBeTrue();
        // Derives a new SCID by signing the client's generated DCID
        // This is only used during the stateless retry
        serverScid = new QUICConnectionId(
          await crypto.ops.sign(
            crypto.key,
            clientDcid,
          ),
          0,
          quiche.MAX_CONN_ID_LEN
        );
        // Stateless retry
        const token = await utils.mintToken(clientDcid, clientHost.host, crypto);
        const retryDatagram = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        const retryDatagramLength = quiche.retry(
          clientScid,
          clientDcid,
          serverScid,
          token,
          clientHeaderInitial.version,
          retryDatagram
        );
        const timeoutBeforeRecv = clientConn.timeout();
        const serverHeaderRetry = quiche.Header.fromSlice(
          retryDatagram.subarray(0, retryDatagramLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(serverHeaderRetry.ty).toBe(quiche.Type.Retry);
        // Retry packet's SCID is the derived SCID
        expect(new QUICConnectionId(serverHeaderRetry.scid)).toEqual(
          serverScid
        );
        expect(new QUICConnectionId(serverHeaderRetry.dcid)).toEqual(
          clientScid
        );
        // Retry gets sent back to be processed by the client
        clientConn.recv(
          retryDatagram.subarray(0, retryDatagramLength),
          {
            to: clientHost,
            from: serverHost
          }
        );
        const timeoutAfterRecv = clientConn.timeout();
        // The timeout is only reset after `recv` is called
        expect(timeoutAfterRecv).toBeGreaterThan(timeoutBeforeRecv!);
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeFalse();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();
        // Client will retry the initial packet with the token
        [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
        const clientHeaderInitialRetry = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(clientHeaderInitialRetry.ty).toBe(quiche.Type.Initial);
        expect(
          new QUICConnectionId(clientHeaderInitialRetry.scid)
        ).toEqual(clientScid);
        // The DCID is now updated to the server generated one
        expect(
          new QUICConnectionId(clientHeaderInitialRetry.dcid)
        ).toEqual(serverScid);
        // The retried initial packet has the signed token
        expect(Buffer.from(clientHeaderInitialRetry.token!)).toEqual(token);
        expect(clientHeaderInitialRetry.version).toBe(quiche.PROTOCOL_VERSION);
        expect(clientHeaderInitialRetry.versions).toBeNull();
        // Validate the token
        const dcidOriginal = await utils.validateToken(
          Buffer.from(clientHeaderInitialRetry.token!),
          clientHost.host,
          crypto
        );
        // The original randomly generated DCID was embedded in the token
        expect(dcidOriginal).toEqual(clientDcid);
      });
      test('server accept', async () => {
        serverConn = quiche.Connection.accept(
          serverScid,
          clientDcid,
          serverHost,
          clientHost,
          serverQuicheConfig
        );
        expect(serverConn.timeout()).toBeNull();
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        expect(serverConn.isEstablished()).toBeFalse();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.isClosed()).toBeFalse();
        expect(serverConn.isDraining()).toBeFalse();
        // Now that both the client and server has selected their own SCID, where
        // the server derived its SCID from the initial client's randomly
        // generated DCID, we can update their respective DCID
        // This means that the client's connection ID is still the randomly
        // generated SCID at the beginning, while the server's connection ID
        // is the derived SCID when it sent the retry packet.
        clientDcid = serverScid;
        serverDcid = clientScid;
        // Server receives the retried initial frame
        serverConn.recv(
          clientBuffer.subarray(0, clientSendLength),
          {
            to: serverHost,
            from: clientHost
          }
        );
        // The timeout is still null upon the first recv for the server
        // This is only true because timeout is `0` which is `Infinity`
        expect(serverConn.timeout()).toBeNull();
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        expect(serverConn.isEstablished()).toBeFalse();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.isClosed()).toBeFalse();
        expect(serverConn.isDraining()).toBeFalse();
      });
      test('client <-initial- server', async () => {
        [serverSendLength, serverSendInfo] = serverConn.send(serverBuffer);
        // Server's responds with an initial frame
        expect(serverSendLength).toBe(1200);
        // The server is now setting its timeout to start at 1 second
        expect(serverConn.timeout()).toBeCloseTo(1000, -3);
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        // At this point the server connection is still not established
        expect(serverConn.isEstablished()).toBeFalse();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.isClosed()).toBeFalse();
        expect(serverConn.isDraining()).toBeFalse();
        const serverHeaderInitial = quiche.Header.fromSlice(
          serverBuffer.subarray(0, serverSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(serverHeaderInitial.ty).toBe(quiche.Type.Initial);
        expect(new QUICConnectionId(serverHeaderInitial.scid)).toEqual(serverScid);
        expect(new QUICConnectionId(serverHeaderInitial.dcid)).toEqual(serverDcid);
        expect(serverHeaderInitial.token).toHaveLength(0);
        expect(serverHeaderInitial.version).toBe(quiche.PROTOCOL_VERSION);
        expect(serverHeaderInitial.versions).toBeNull();
        clientConn.recv(
          serverBuffer.subarray(0, serverSendLength),
          {
            to: clientHost,
            from: serverHost
          }
        );
      });
      test('client -initial-> server', async () => {
        [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
        const clientHeaderInitial = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(clientHeaderInitial.ty).toBe(quiche.Type.Initial);
        // Timeout is lowered
        expect(clientConn.timeout()).toBeLessThan(100);
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeFalse();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();
        serverConn.recv(
          clientBuffer.subarray(0, clientSendLength),
          {
            to: serverHost,
            from: clientHost
          }
        );
      });
      test('client <-handshake- server', async () => {
        [serverSendLength, serverSendInfo] = serverConn.send(serverBuffer);
        const serverHeaderHandshake = quiche.Header.fromSlice(
          serverBuffer.subarray(0, serverSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(serverHeaderHandshake.ty).toBe(quiche.Type.Handshake);
        expect(new QUICConnectionId(serverHeaderHandshake.scid)).toEqual(serverScid);
        expect(new QUICConnectionId(serverHeaderHandshake.dcid)).toEqual(serverDcid);
        // Timeout is lowered
        expect(serverConn.timeout()).toBeLessThan(100);
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        expect(serverConn.isEstablished()).toBeFalse();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.isClosed()).toBeFalse();
        expect(serverConn.isDraining()).toBeFalse();
        expect(() => serverConn.send(serverBuffer)).toThrow('Done');
        // Client receives server's handshake frame
        clientConn.recv(
          serverBuffer.subarray(0, serverSendLength),
          {
            to: clientHost,
            from: serverHost
          }
        );
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeTrue();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();
      });
      test('client is established', async () => {
        expect(clientConn.isEstablished()).toBeTrue();
      });
      test('client -handshake-> server', async () => {
        [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
        const clientHeaderHandshake = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(clientHeaderHandshake.ty).toBe(quiche.Type.Handshake);
        expect(() => clientConn.send(clientBuffer)).toThrow('Done');
        expect(clientConn.timeout()).not.toBeNull();
        expect(serverConn.timeout()).not.toBeNull();
        serverConn.recv(
          clientBuffer.subarray(0, clientSendLength),
          {
            to: serverHost,
            from: clientHost
          }
        );
        expect(serverConn.timeout()).toBeNull();
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        expect(serverConn.isEstablished()).toBeTrue();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.isClosed()).toBeFalse();
        expect(serverConn.isDraining()).toBeFalse();
      });
      test('server is established', async () => {
        expect(serverConn.isEstablished()).toBeTrue();
      });
      test('client <-short- server', async () => {
        [serverSendLength, serverSendInfo] = serverConn.send(serverBuffer);
        const serverHeaderShort = quiche.Header.fromSlice(
          serverBuffer.subarray(0, serverSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(serverHeaderShort.ty).toBe(quiche.Type.Short);
        // SCID is dropped on the short frame
        expect(serverHeaderShort.scid).toHaveLength(0);
        expect(new QUICConnectionId(serverHeaderShort.dcid)).toEqual(
          clientScid
        );
        clientConn.recv(
          serverBuffer.subarray(0, serverSendLength),
          {
            to: clientHost,
            from: serverHost
          }
        );
        // Client connection timeout is now null
        // Both client and server is established
        // This is due to max idle timeout of 0
        expect(clientConn.timeout()).toBeNull();
        expect(serverConn.timeout()).not.toBeNull();
        // Timeout is lowered
        expect(serverConn.timeout()).toBeLessThan(100);
      });
      test('client -short-> server', async () => {
        [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
        const clientHeaderShort = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(clientHeaderShort.ty).toBe(quiche.Type.Short);
        // SCID is dropped on the short frame
        expect(clientHeaderShort.scid).toHaveLength(0);
        expect(new QUICConnectionId(clientHeaderShort.dcid)).toEqual(
          serverScid
        );
        expect(() => clientConn.send(clientBuffer)).toThrow('Done');
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeTrue();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();
        serverConn.recv(
          clientBuffer.subarray(0, clientSendLength),
          {
            to: serverHost,
            from: clientHost
          }
        );
        expect(() => serverConn.send(serverBuffer)).toThrow('Done');
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        expect(serverConn.isEstablished()).toBeTrue();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.isClosed()).toBeFalse();
        expect(serverConn.isDraining()).toBeFalse();
      });
      test('client and server established', async () => {
        // Both client and server is established
        // Server connection timeout is now null
        // Note that this occurs after the server has received the last short frame
        // This is due to max idle timeout of 0
        // need to check the timeout
        expect(clientConn.isEstablished()).toBeTrue();
        expect(serverConn.isEstablished()).toBeTrue();
        expect(clientConn.timeout()).toBeNull();
        expect(serverConn.timeout()).toBeNull();
      });
      test('client close', async () => {
        clientConn.close(true, 0, Buffer.from('Application Close'));
        expect(clientConn.localError()).toEqual({
          isApp: true,
          errorCode: 0,
          reason: new Uint8Array(Buffer.from('Application Close'))
        });
        expect(clientConn.timeout()).toBeNull();
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeTrue();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();
        [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
        const clientHeaderShort = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(clientHeaderShort.ty).toBe(quiche.Type.Short);
        // The timeout begins again
        expect(clientConn.timeout()).not.toBeNull();
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        // Connection is still established
        expect(clientConn.isEstablished()).toBeTrue();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        // Connection however begins draining
        expect(clientConn.isDraining()).toBeTrue();
        expect(() => clientConn.send(clientBuffer)).toThrow('Done');
        // Client connection now waits to be closed
        await testsUtils.sleep(clientConn.timeout()!);
        clientConn.onTimeout();
        await testsUtils.waitForTimeoutNull(clientConn);
        // Timeout is finally null
        expect(clientConn.timeout()).toBeNull();
        // Connection did not timeout from idleness
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        // Connection is left as established
        expect(clientConn.isEstablished()).toBeTrue();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        // Connection is fully closed
        expect(clientConn.isClosed()).toBeTrue();
        // Connection is left as draining
        expect(clientConn.isDraining()).toBeTrue();
        // -short-> SERVER
        serverConn.recv(
          clientBuffer.subarray(0, clientSendLength),
          {
            to: serverHost,
            from: clientHost
          }
        );
        // The server receives the client's error
        expect(serverConn.peerError()).toEqual({
          isApp: true,
          errorCode: 0,
          reason: new Uint8Array(Buffer.from('Application Close'))
        });
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        expect(serverConn.isEstablished()).toBeTrue();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.isClosed()).toBeFalse();
        // SERVER draining
        expect(serverConn.isDraining()).toBeTrue();
        // Once the server is in draining, it does not need to respond
        // it just waits to timeout, during that time, it is in "draining" state
        // We need to exhaust the server's timeout to be fully closed
        // Unlike TCP, there is no half-closed state for QUIC connections
        expect(() => serverConn.send(serverBuffer)).toThrow('Done');
        await testsUtils.sleep(serverConn.timeout()!);
        serverConn.onTimeout();
        await testsUtils.waitForTimeoutNull(serverConn);
        expect(serverConn.timeout()).toBeNull();
        // Connection did not timeout from idleness
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        // Connection is left as established
        expect(serverConn.isEstablished()).toBeTrue();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        // Connection is fully closed
        expect(serverConn.isClosed()).toBeTrue();
        // Connection is left as draining
        expect(serverConn.isDraining()).toBeTrue();
      });
    });
    describe('connection between client and server with ECDSA', () => {
      // These tests run in-order, and each step is a state transition
      const clientHost = {
        host: '127.0.0.1' as Host,
        port: 55555 as Port,
      };
      const serverHost = {
        host: '127.0.0.1' as Host,
        port: 55556,
      };
      // These buffers will be used between the tests and will be mutated
      let clientSendLength: number, clientSendInfo: SendInfo;
      const clientBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
      let serverSendLength: number, serverSendInfo: SendInfo;
      const serverBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
      let clientQuicheConfig: Config;
      let serverQuicheConfig: Config;
      let clientScid: QUICConnectionId;
      let clientDcid: QUICConnectionId;
      let serverScid: QUICConnectionId;
      let serverDcid: QUICConnectionId;
      let clientConn: Connection;
      let serverConn: Connection;
      beforeAll(async () => {
        const clientConfig: QUICConfig = {
          ...clientDefault,
          verifyPeer: false,
        };
        const serverConfig: QUICConfig = {
          ...serverDefault,
          key: keyPairECDSAPEM.privateKey,
          cert: certECDSAPEM,
        };
        clientQuicheConfig = buildQuicheConfig(clientConfig);
        serverQuicheConfig = buildQuicheConfig(serverConfig);
      });
      test('client connect', async () => {
        // Randomly genrate the client SCID
        const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
        await crypto.ops.randomBytes(scidBuffer);
        clientScid = new QUICConnectionId(scidBuffer);
        clientConn = quiche.Connection.connect(
          null,
          clientScid,
          clientHost,
          serverHost,
          clientQuicheConfig,
        );
        expect(clientConn.timeout()).toBeNull();
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeFalse();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();
      });
      test('client dialing', async () => {
        // Send the initial packet
        [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
        // The initial frame will always be 1200 bytes
        expect(clientSendLength).toBe(1200);
        expect(clientSendInfo.from).toEqual(clientHost);
        expect(clientSendInfo.to).toEqual(serverHost);
        // This is the initial delay for the dialing procedure
        // Quiche will repeatedly send the initial packet until it is received
        // or exhausted the idle timeout, which in this case is 0 (disabled)
        expect(typeof clientConn.timeout()!).toBe('number');
        // The initial delay starts at roughly 1 second
        // Round to the nearest 1000
        expect(clientConn.timeout()).toBeCloseTo(1000, -3);
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeFalse();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();
        // Repeating send will throw `Done`
        // This proves that only 1 send is necessary at the beginning
        expect(() => clientConn.send(clientBuffer)).toThrow('Done');
        // Wait out the delay (add 50ms for non-determinism)
        await testsUtils.sleep(clientConn.timeout()! + 50);
        // Connection has not timed out because idle timeout defaults to infinity
        expect(clientConn.isTimedOut()).toBeFalse();
        // The delay is exhausted, and therefore should be 0
        expect(clientConn.timeout()).toBe(0);
        // The `onTimeout` must be called to transition state
        clientConn.onTimeout();
        // The delay is repeated immediately after `onTimeout`
        // It is still 1 second
        // Round to the nearest 1000
        expect(clientConn.timeout()).toBeCloseTo(1000, -3);
        // Retry the initial packet
        const clientBuffer_ = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer_);
        expect(clientSendLength).toBe(1200);
        expect(clientSendInfo.from).toEqual(clientHost);
        expect(clientSendInfo.to).toEqual(serverHost);
        // Retried initial frame is not an exact copy
        expect(clientBuffer_).not.toEqual(clientBuffer);
        // Upon the retry, the delay now doubles
        // Round to the nearest 1000
        expect(clientConn.timeout()).toBeCloseTo(2000, -3);
        // This dialing process will repeat max idle timeout is exhausted
        // Copy sendBuffer_ into sendBuffer
        clientBuffer.set(clientBuffer_);
      });
      test('client and server negotiation', async () => {
        // Process the initial frame
        const clientHeaderInitial = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        // It will be an initial packet
        expect(clientHeaderInitial.ty).toBe(quiche.Type.Initial);
        // The SCID is what was generated above
        expect(new QUICConnectionId(clientHeaderInitial.scid)).toEqual(clientScid);
        // The DCID is randomly generated by the client
        clientDcid = new QUICConnectionId(clientHeaderInitial.dcid);
        expect(clientDcid).not.toEqual(clientScid);
        // The token will be empty
        expect(clientHeaderInitial.token).toHaveLength(0);
        // The version should be 1
        expect(clientHeaderInitial.version).toBe(quiche.PROTOCOL_VERSION);
        expect(clientHeaderInitial.versions).toBeNull();
        // Version negotiation
        // The version is supported, we don't need to change
        expect(quiche.versionIsSupported(clientHeaderInitial.version)).toBeTrue();
        // Derives a new SCID by signing the client's generated DCID
        // This is only used during the stateless retry
        serverScid = new QUICConnectionId(
          await crypto.ops.sign(
            crypto.key,
            clientDcid,
          ),
          0,
          quiche.MAX_CONN_ID_LEN
        );
        // Stateless retry
        const token = await utils.mintToken(clientDcid, clientHost.host, crypto);
        const retryDatagram = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        const retryDatagramLength = quiche.retry(
          clientScid,
          clientDcid,
          serverScid,
          token,
          clientHeaderInitial.version,
          retryDatagram
        );
        const timeoutBeforeRecv = clientConn.timeout();
        // Retry gets sent back to be processed by the client
        clientConn.recv(
          retryDatagram.subarray(0, retryDatagramLength),
          {
            to: clientHost,
            from: serverHost
          }
        );
        const timeoutAfterRecv = clientConn.timeout();
        // The timeout is only reset after `recv` is called
        expect(timeoutAfterRecv).toBeGreaterThan(timeoutBeforeRecv!);
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeFalse();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();
        // Client will retry the initial packet with the token
        [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
        const clientHeaderInitialRetry = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(clientHeaderInitialRetry.ty).toBe(quiche.Type.Initial);
        expect(
          new QUICConnectionId(clientHeaderInitialRetry.scid)
        ).toEqual(clientScid);
        // The DCID is now updated to the server generated one
        expect(
          new QUICConnectionId(clientHeaderInitialRetry.dcid)
        ).toEqual(serverScid);
        // The retried initial packet has the signed token
        expect(Buffer.from(clientHeaderInitialRetry.token!)).toEqual(token);
        expect(clientHeaderInitialRetry.version).toBe(quiche.PROTOCOL_VERSION);
        expect(clientHeaderInitialRetry.versions).toBeNull();
        // Validate the token
        const dcidOriginal = await utils.validateToken(
          Buffer.from(clientHeaderInitialRetry.token!),
          clientHost.host,
          crypto
        );
        // The original randomly generated DCID was embedded in the token
        expect(dcidOriginal).toEqual(clientDcid);
      });
      test('server accept', async () => {
        serverConn = quiche.Connection.accept(
          serverScid,
          clientDcid,
          serverHost,
          clientHost,
          serverQuicheConfig
        );
        expect(serverConn.timeout()).toBeNull();
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        expect(serverConn.isEstablished()).toBeFalse();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.isClosed()).toBeFalse();
        expect(serverConn.isDraining()).toBeFalse();
        // Now that both the client and server has selected their own SCID, where
        // the server derived its SCID from the initial client's randomly
        // generated DCID, we can update their respective DCID
        clientDcid = serverScid;
        serverDcid = clientScid;
        serverConn.recv(
          clientBuffer.subarray(0, clientSendLength),
          {
            to: serverHost,
            from: clientHost
          }
        );
        // The timeout is still null upon the first recv for the server
        expect(serverConn.timeout()).toBeNull();
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        expect(serverConn.isEstablished()).toBeFalse();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.isClosed()).toBeFalse();
        expect(serverConn.isDraining()).toBeFalse();
      });
      test('client <-initial- server', async () => {
        [serverSendLength, serverSendInfo] = serverConn.send(serverBuffer);
        // Server's responds with an initial frame
        expect(serverSendLength).toBe(1200);
        // The server is now setting its timeout to start at 1 second
        expect(serverConn.timeout()).toBeCloseTo(1000, -3);
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        expect(serverConn.isEstablished()).toBeFalse();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.isClosed()).toBeFalse();
        expect(serverConn.isDraining()).toBeFalse();
        // At this point the server connection is still not established
        const serverHeaderInitial = quiche.Header.fromSlice(
          serverBuffer.subarray(0, serverSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(serverHeaderInitial.ty).toBe(quiche.Type.Initial);
        expect(new QUICConnectionId(serverHeaderInitial.scid)).toEqual(serverScid);
        expect(new QUICConnectionId(serverHeaderInitial.dcid)).toEqual(serverDcid);
        expect(serverHeaderInitial.token).toHaveLength(0);
        expect(serverHeaderInitial.version).toBe(quiche.PROTOCOL_VERSION);
        expect(serverHeaderInitial.versions).toBeNull();
        clientConn.recv(
          serverBuffer.subarray(0, serverSendLength),
          {
            to: clientHost,
            from: serverHost
          }
        );
      });
      test('client is established', async () => {
        expect(clientConn.isEstablished()).toBeTrue();
      });
      test('client -initial-> server', async () => {
        [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
        const clientHeaderInitial = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(clientHeaderInitial.ty).toBe(quiche.Type.Initial);
        // Timeout is lowered
        expect(clientConn.timeout()).toBeLessThan(100);
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeTrue();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();
        serverConn.recv(
          clientBuffer.subarray(0, clientSendLength),
          {
            to: serverHost,
            from: clientHost
          }
        );
      });
      test('server is established', async () => {
        expect(serverConn.isEstablished()).toBeTrue();
      });
      test('client <-short- server', async () => {
        [serverSendLength, serverSendInfo] = serverConn.send(serverBuffer);
        const serverHeaderShort = quiche.Header.fromSlice(
          serverBuffer.subarray(0, serverSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(serverHeaderShort.ty).toBe(quiche.Type.Short);
        clientConn.recv(
          serverBuffer.subarray(0, serverSendLength),
          {
            to: clientHost,
            from: serverHost
          }
        );
        // Client connection timeout is now null
        // Both client and server is established
        // This is due to max idle timeout of 0
        expect(clientConn.timeout()).toBeNull();
        expect(serverConn.timeout()).not.toBeNull();
        // Timeout is lowered
        expect(serverConn.timeout()).toBeLessThan(100);
      });
      test('client -short-> server', async () => {
        [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
        const clientHeaderShort = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(clientHeaderShort.ty).toBe(quiche.Type.Short);
        expect(() => clientConn.send(clientBuffer)).toThrow('Done');
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeTrue();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();
        serverConn.recv(
          clientBuffer.subarray(0, clientSendLength),
          {
            to: serverHost,
            from: clientHost
          }
        );
        expect(() => serverConn.send(serverBuffer)).toThrow('Done');
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        expect(serverConn.isEstablished()).toBeTrue();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.isClosed()).toBeFalse();
        expect(serverConn.isDraining()).toBeFalse();
      });
      test('client and server established', async () => {
        // Both client and server is established
        // Server connection timeout is now null
        // Note that this occurs after the server has received the last short frame
        // This is due to max idle timeout of 0
        // need to check the timeout
        expect(clientConn.isEstablished()).toBeTrue();
        expect(serverConn.isEstablished()).toBeTrue();
        expect(clientConn.timeout()).toBeNull();
        expect(serverConn.timeout()).toBeNull();
      });
      test('client close', async () => {
        clientConn.close(false, 2, new Uint8Array());
        expect(clientConn.localError()).toEqual({
          isApp: false,
          errorCode: 2,
          reason: new Uint8Array()
        });
        expect(clientConn.timeout()).toBeNull();
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeTrue();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();
        [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
        const clientHeaderShort = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(clientHeaderShort.ty).toBe(quiche.Type.Short);
        // The timeout begins again
        expect(clientConn.timeout()).not.toBeNull();
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        // Connection is still established
        expect(clientConn.isEstablished()).toBeTrue();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        // Connection however begins draining
        expect(clientConn.isDraining()).toBeTrue();
        expect(() => clientConn.send(clientBuffer)).toThrow('Done');
        // Client connection now waits to be closed
        await testsUtils.sleep(clientConn.timeout()!);
        clientConn.onTimeout();
        await testsUtils.waitForTimeoutNull(clientConn);
        // Timeout is finally null
        expect(clientConn.timeout()).toBeNull();
        // Connection did not timeout from idleness
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        // Connection is left as established
        expect(clientConn.isEstablished()).toBeTrue();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        // Connection is fully closed
        expect(clientConn.isClosed()).toBeTrue();
        // Connection is left as draining
        expect(clientConn.isDraining()).toBeTrue();
        // -short-> SERVER
        serverConn.recv(
          clientBuffer.subarray(0, clientSendLength),
          {
            to: serverHost,
            from: clientHost
          }
        );
        expect(serverConn.peerError()).toEqual({
          isApp: false,
          errorCode: 2,
          reason: new Uint8Array()
        });
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        expect(serverConn.isEstablished()).toBeTrue();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.isClosed()).toBeFalse();
        // SERVER draining
        expect(serverConn.isDraining()).toBeTrue();
        // Once the server is in draining, it does not need to respond
        // it just waits to timeout, during that time, it is in "draining" state
        // We need to exhaust the server's timeout to be fully closed
        // Unlike TCP, there is no half-closed state for QUIC connections
        expect(() => serverConn.send(serverBuffer)).toThrow('Done');
        await testsUtils.sleep(serverConn.timeout()!);
        serverConn.onTimeout();
        await testsUtils.waitForTimeoutNull(serverConn);
        expect(serverConn.timeout()).toBeNull();
        // Connection did not timeout from idleness
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        // Connection is left as established
        expect(serverConn.isEstablished()).toBeTrue();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        // Connection is fully closed
        expect(serverConn.isClosed()).toBeTrue();
        // Connection is left as draining
        expect(serverConn.isDraining()).toBeTrue();
      });
    });
    describe('connection between client and server with Ed25519', () => {
      // These tests run in-order, and each step is a state transition
      const clientHost = {
        host: '127.0.0.1' as Host,
        port: 55555 as Port,
      };
      const serverHost = {
        host: '127.0.0.1' as Host,
        port: 55556,
      };
      // These buffers will be used between the tests and will be mutated
      let clientSendLength: number, clientSendInfo: SendInfo;
      const clientBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
      let serverSendLength: number, serverSendInfo: SendInfo;
      const serverBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
      let clientQuicheConfig: Config;
      let serverQuicheConfig: Config;
      let clientScid: QUICConnectionId;
      let clientDcid: QUICConnectionId;
      let serverScid: QUICConnectionId;
      let serverDcid: QUICConnectionId;
      let clientConn: Connection;
      let serverConn: Connection;
      beforeAll(async () => {
        const clientConfig: QUICConfig = {
          ...clientDefault,
          verifyPeer: false,
        };
        const serverConfig: QUICConfig = {
          ...serverDefault,
          key: keyPairEd25519PEM.privateKey,
          cert: certEd25519PEM,
        };
        clientQuicheConfig = buildQuicheConfig(clientConfig);
        serverQuicheConfig = buildQuicheConfig(serverConfig);
      });
      test('client connect', async () => {
        // Randomly genrate the client SCID
        const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
        await crypto.ops.randomBytes(scidBuffer);
        clientScid = new QUICConnectionId(scidBuffer);
        clientConn = quiche.Connection.connect(
          null,
          clientScid,
          clientHost,
          serverHost,
          clientQuicheConfig,
        );
        expect(clientConn.timeout()).toBeNull();
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeFalse();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();
      });
      test('client dialing', async () => {
        // Send the initial packet
        [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
        // The initial frame will always be 1200 bytes
        expect(clientSendLength).toBe(1200);
        expect(clientSendInfo.from).toEqual(clientHost);
        expect(clientSendInfo.to).toEqual(serverHost);
        // This is the initial delay for the dialing procedure
        // Quiche will repeatedly send the initial packet until it is received
        // or exhausted the idle timeout, which in this case is 0 (disabled)
        expect(typeof clientConn.timeout()!).toBe('number');
        // The initial delay starts at roughly 1 second
        // Round to the nearest 1000
        expect(clientConn.timeout()).toBeCloseTo(1000, -3);
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeFalse();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();
        // Repeating send will throw `Done`
        // This proves that only 1 send is necessary at the beginning
        expect(() => clientConn.send(clientBuffer)).toThrow('Done');
        // Wait out the delay (add 50ms for non-determinism)
        await testsUtils.sleep(clientConn.timeout()! + 50);
        // Connection has not timed out because idle timeout defaults to infinity
        expect(clientConn.isTimedOut()).toBeFalse();
        // The delay is exhausted, and therefore should be 0
        expect(clientConn.timeout()).toBe(0);
        // The `onTimeout` must be called to transition state
        clientConn.onTimeout();
        // The delay is repeated immediately after `onTimeout`
        // It is still 1 second
        // Round to the nearest 1000
        expect(clientConn.timeout()).toBeCloseTo(1000, -3);
        // Retry the initial packet
        const clientBuffer_ = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer_);
        expect(clientSendLength).toBe(1200);
        expect(clientSendInfo.from).toEqual(clientHost);
        expect(clientSendInfo.to).toEqual(serverHost);
        // Retried initial frame is not an exact copy
        expect(clientBuffer_).not.toEqual(clientBuffer);
        // Upon the retry, the delay now doubles
        // Round to the nearest 1000
        expect(clientConn.timeout()).toBeCloseTo(2000, -3);
        // This dialing process will repeat max idle timeout is exhausted
        // Copy sendBuffer_ into sendBuffer
        clientBuffer.set(clientBuffer_);
      });
      test('client and server negotiation', async () => {
        // Process the initial frame
        const clientHeaderInitial = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        // It will be an initial packet
        expect(clientHeaderInitial.ty).toBe(quiche.Type.Initial);
        // The SCID is what was generated above
        expect(new QUICConnectionId(clientHeaderInitial.scid)).toEqual(clientScid);
        // The DCID is randomly generated by the client
        clientDcid = new QUICConnectionId(clientHeaderInitial.dcid);
        expect(clientDcid).not.toEqual(clientScid);
        // The token will be empty
        expect(clientHeaderInitial.token).toHaveLength(0);
        // The version should be 1
        expect(clientHeaderInitial.version).toBe(quiche.PROTOCOL_VERSION);
        expect(clientHeaderInitial.versions).toBeNull();
        // Version negotiation
        // The version is supported, we don't need to change
        expect(quiche.versionIsSupported(clientHeaderInitial.version)).toBeTrue();
        // Derives a new SCID by signing the client's generated DCID
        // This is only used during the stateless retry
        serverScid = new QUICConnectionId(
          await crypto.ops.sign(
            crypto.key,
            clientDcid,
          ),
          0,
          quiche.MAX_CONN_ID_LEN
        );
        // Stateless retry
        const token = await utils.mintToken(clientDcid, clientHost.host, crypto);
        const retryDatagram = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        const retryDatagramLength = quiche.retry(
          clientScid,
          clientDcid,
          serverScid,
          token,
          clientHeaderInitial.version,
          retryDatagram
        );
        const timeoutBeforeRecv = clientConn.timeout();
        // Retry gets sent back to be processed by the client
        clientConn.recv(
          retryDatagram.subarray(0, retryDatagramLength),
          {
            to: clientHost,
            from: serverHost
          }
        );
        const timeoutAfterRecv = clientConn.timeout();
        // The timeout is only reset after `recv` is called
        expect(timeoutAfterRecv).toBeGreaterThan(timeoutBeforeRecv!);
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeFalse();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();
        // Client will retry the initial packet with the token
        [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
        const clientHeaderInitialRetry = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(clientHeaderInitialRetry.ty).toBe(quiche.Type.Initial);
        expect(
          new QUICConnectionId(clientHeaderInitialRetry.scid)
        ).toEqual(clientScid);
        // The DCID is now updated to the server generated one
        expect(
          new QUICConnectionId(clientHeaderInitialRetry.dcid)
        ).toEqual(serverScid);
        // The retried initial packet has the signed token
        expect(Buffer.from(clientHeaderInitialRetry.token!)).toEqual(token);
        expect(clientHeaderInitialRetry.version).toBe(quiche.PROTOCOL_VERSION);
        expect(clientHeaderInitialRetry.versions).toBeNull();
        // Validate the token
        const dcidOriginal = await utils.validateToken(
          Buffer.from(clientHeaderInitialRetry.token!),
          clientHost.host,
          crypto
        );
        // The original randomly generated DCID was embedded in the token
        expect(dcidOriginal).toEqual(clientDcid);
      });
      test('server accept', async () => {
        serverConn = quiche.Connection.accept(
          serverScid,
          clientDcid,
          serverHost,
          clientHost,
          serverQuicheConfig
        );
        expect(serverConn.timeout()).toBeNull();
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        expect(serverConn.isEstablished()).toBeFalse();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.isClosed()).toBeFalse();
        expect(serverConn.isDraining()).toBeFalse();
        // Now that both the client and server has selected their own SCID, where
        // the server derived its SCID from the initial client's randomly
        // generated DCID, we can update their respective DCID
        clientDcid = serverScid;
        serverDcid = clientScid;
        serverConn.recv(
          clientBuffer.subarray(0, clientSendLength),
          {
            to: serverHost,
            from: clientHost
          }
        );
        // The timeout is still null upon the first recv for the server
        expect(serverConn.timeout()).toBeNull();
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        expect(serverConn.isEstablished()).toBeFalse();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.isClosed()).toBeFalse();
        expect(serverConn.isDraining()).toBeFalse();
      });
      test('client <-initial- server', async () => {
        [serverSendLength, serverSendInfo] = serverConn.send(serverBuffer);
        // Server's responds with an initial frame
        expect(serverSendLength).toBe(1200);
        // The server is now setting its timeout to start at 1 second
        expect(serverConn.timeout()).toBeCloseTo(1000, -3);
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        expect(serverConn.isEstablished()).toBeFalse();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.isClosed()).toBeFalse();
        expect(serverConn.isDraining()).toBeFalse();
        // At this point the server connection is still not established
        const serverHeaderInitial = quiche.Header.fromSlice(
          serverBuffer.subarray(0, serverSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(serverHeaderInitial.ty).toBe(quiche.Type.Initial);
        expect(new QUICConnectionId(serverHeaderInitial.scid)).toEqual(serverScid);
        expect(new QUICConnectionId(serverHeaderInitial.dcid)).toEqual(serverDcid);
        expect(serverHeaderInitial.token).toHaveLength(0);
        expect(serverHeaderInitial.version).toBe(quiche.PROTOCOL_VERSION);
        expect(serverHeaderInitial.versions).toBeNull();
        clientConn.recv(
          serverBuffer.subarray(0, serverSendLength),
          {
            to: clientHost,
            from: serverHost
          }
        );
      });
      test('client is established', async () => {
        expect(clientConn.isEstablished()).toBeTrue();
      });
      test('client -initial-> server', async () => {
        [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
        const clientHeaderInitial = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(clientHeaderInitial.ty).toBe(quiche.Type.Initial);
        // Timeout is lowered
        expect(clientConn.timeout()).toBeLessThan(100);
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeTrue();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();
        serverConn.recv(
          clientBuffer.subarray(0, clientSendLength),
          {
            to: serverHost,
            from: clientHost
          }
        );
      });
      test('server is established', async () => {
        expect(serverConn.isEstablished()).toBeTrue();
      });
      test('client <-short- server', async () => {
        [serverSendLength, serverSendInfo] = serverConn.send(serverBuffer);
        const serverHeaderShort = quiche.Header.fromSlice(
          serverBuffer.subarray(0, serverSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(serverHeaderShort.ty).toBe(quiche.Type.Short);
        clientConn.recv(
          serverBuffer.subarray(0, serverSendLength),
          {
            to: clientHost,
            from: serverHost
          }
        );
        // Client connection timeout is now null
        // Both client and server is established
        // This is due to max idle timeout of 0
        expect(clientConn.timeout()).toBeNull();
        expect(serverConn.timeout()).not.toBeNull();
        // Timeout is lowered
        expect(serverConn.timeout()).toBeLessThan(100);
      });
      test('client -short-> server', async () => {
        [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
        const clientHeaderShort = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(clientHeaderShort.ty).toBe(quiche.Type.Short);
        expect(() => clientConn.send(clientBuffer)).toThrow('Done');
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeTrue();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();
        serverConn.recv(
          clientBuffer.subarray(0, clientSendLength),
          {
            to: serverHost,
            from: clientHost
          }
        );
        expect(() => serverConn.send(serverBuffer)).toThrow('Done');
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        expect(serverConn.isEstablished()).toBeTrue();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.isClosed()).toBeFalse();
        expect(serverConn.isDraining()).toBeFalse();
      });
      test('client and server established', async () => {
        // Both client and server is established
        // Server connection timeout is now null
        // Note that this occurs after the server has received the last short frame
        // This is due to max idle timeout of 0
        // need to check the timeout
        expect(clientConn.isEstablished()).toBeTrue();
        expect(serverConn.isEstablished()).toBeTrue();
        expect(clientConn.timeout()).toBeNull();
        expect(serverConn.timeout()).toBeNull();
      });
      test('client close', async () => {
        clientConn.close(false, 1, Buffer.from(''));
        expect(clientConn.localError()).toEqual({
          isApp: false,
          errorCode: 1,
          reason: new Uint8Array()
        });
        expect(clientConn.timeout()).toBeNull();
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeTrue();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();
        [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
        const clientHeaderShort = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(clientHeaderShort.ty).toBe(quiche.Type.Short);
        // The timeout begins again
        expect(clientConn.timeout()).not.toBeNull();
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        // Connection is still established
        expect(clientConn.isEstablished()).toBeTrue();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        // Connection however begins draining
        expect(clientConn.isDraining()).toBeTrue();
        expect(() => clientConn.send(clientBuffer)).toThrow('Done');
        // Client connection now waits to be closed
        await testsUtils.sleep(clientConn.timeout()!);
        clientConn.onTimeout();
        await testsUtils.waitForTimeoutNull(clientConn);
        // Timeout is finally null
        expect(clientConn.timeout()).toBeNull();
        // Connection did not timeout from idleness
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        // Connection is left as established
        expect(clientConn.isEstablished()).toBeTrue();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        // Connection is fully closed
        expect(clientConn.isClosed()).toBeTrue();
        // Connection is left as draining
        expect(clientConn.isDraining()).toBeTrue();
        serverConn.recv(
          clientBuffer.subarray(0, clientSendLength),
          {
            to: serverHost,
            from: clientHost
          }
        );
        expect(serverConn.peerError()).toEqual({
          isApp: false,
          errorCode: 1,
          reason: new Uint8Array()
        });
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        expect(serverConn.isEstablished()).toBeTrue();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.isClosed()).toBeFalse();
        // SERVER draining
        expect(serverConn.isDraining()).toBeTrue();
        // Once the server is in draining, it does not need to respond
        // it just waits to timeout, during that time, it is in "draining" state
        // We need to exhaust the server's timeout to be fully closed
        // Unlike TCP, there is no half-closed state for QUIC connections
        expect(() => serverConn.send(serverBuffer)).toThrow('Done');
        await testsUtils.sleep(serverConn.timeout()!);
        serverConn.onTimeout();
        await testsUtils.waitForTimeoutNull(serverConn);
        expect(serverConn.timeout()).toBeNull();
        // Connection did not timeout from idleness
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        // Connection is left as established
        expect(serverConn.isEstablished()).toBeTrue();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        // Connection is fully closed
        expect(serverConn.isClosed()).toBeTrue();
        // Connection is left as draining
        expect(serverConn.isDraining()).toBeTrue();
      });
    });
  });
});
