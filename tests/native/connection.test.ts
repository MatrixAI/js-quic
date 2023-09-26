import type { X509Certificate } from '@peculiar/x509';
import type {
  QUICConfig,
  Host,
  ClientCryptoOps,
  ServerCryptoOps,
} from '@/types';
import type { Config, Connection, SendInfo } from '@/native/types';
import { quiche } from '@/native';
import { clientDefault, serverDefault, buildQuicheConfig } from '@/config';
import QUICConnectionId from '@/QUICConnectionId';
import * as utils from '@/utils';
import * as testsUtils from '../utils';

describe('native/connection', () => {
  let crypto: {
    key: ArrayBuffer;
    ops: ClientCryptoOps & ServerCryptoOps;
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
  });
  describe('connection lifecycle', () => {
    describe('connect and close client', () => {
      // These tests run in-order, and each step is a state transition
      const clientHost = {
        host: '127.0.0.1',
        port: 55555,
      };
      const serverHost = {
        host: '127.0.0.1',
        port: 55556,
      };
      let clientQuicheConfig: Config;
      let clientScid: QUICConnectionId;
      let clientConn: Connection;
      beforeAll(async () => {
        const clientConfig: QUICConfig = {
          ...clientDefault,
          verifyPeer: false,
          maxIdleTimeout: 0,
        };
        clientQuicheConfig = buildQuicheConfig(clientConfig);
      });
      test('client connect', async () => {
        // Randomly generate the client SCID
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
          reason: new Uint8Array(),
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
        clientConn.recv(randomPacket, {
          to: clientHost,
          from: serverHost,
        });
        // You can receive multiple times without any problems
        clientConn.recv(randomPacket, {
          to: clientHost,
          from: serverHost,
        });
        clientConn.recv(randomPacket, {
          to: clientHost,
          from: serverHost,
        });
        const clientBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        expect(clientConn.send(clientBuffer)).toBeNull();
        expect(clientConn.isClosed()).toBeTrue();
      });
    });
    describe('connection timeouts', () => {
      describe('dialing timeout', () => {
        // These tests run in-order, and each step is a state transition
        const clientHost = {
          host: '127.0.0.1',
          port: 55555,
        };
        const serverHost = {
          host: '127.0.0.1',
          port: 55556,
        };
        // These buffers will be used between the tests and will be mutated
        let _clientSendLength: number, _clientSendInfo: SendInfo;
        const clientBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        let clientQuicheConfig: Config;
        let _serverQuicheConfig: Config;
        let clientScid: QUICConnectionId;
        let clientConn: Connection;
        beforeAll(async () => {
          const clientConfig: QUICConfig = {
            ...clientDefault,
            verifyPeer: false,
            maxIdleTimeout: 2000,
          };
          const serverConfig: QUICConfig = {
            ...serverDefault,
            key: keyPairRSAPEM.privateKey,
            cert: certRSAPEM,
            maxIdleTimeout: 2000,
          };
          clientQuicheConfig = buildQuicheConfig(clientConfig);
          _serverQuicheConfig = buildQuicheConfig(serverConfig);
        });
        test('client connect', async () => {
          // Randomly generate the client SCID
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
          const result = clientConn.send(clientBuffer);
          expect(result).not.toBeNull();
          [_clientSendLength, _clientSendInfo] = result!;
          expect(clientConn.send(clientBuffer)).toBeNull();
          // Exhaust the timeout
          await testsUtils.waitForTimeoutNull(clientConn);
          // After max idle timeout, you cannot artificially close the connection
          expect(clientConn.close(true, 0, Buffer.from('abc'))).toBeNull();
          // Connection has timed out
          expect(clientConn.isTimedOut()).toBeTrue();
          expect(clientConn.isInEarlyData()).toBeFalse();
          expect(clientConn.isEstablished()).toBeFalse();
          expect(clientConn.isResumed()).toBeFalse();
          expect(clientConn.isReadable()).toBeFalse();
          // Connection is closed
          expect(clientConn.isClosed()).toBeTrue();
          expect(clientConn.isDraining()).toBeFalse();
          // No errors after max idle timeout
          expect(clientConn.localError()).toBeNull();
          expect(clientConn.peerError()).toBeNull();
        });
      });
      describe('initial timeout', () => {
        // These tests run in-order, and each step is a state transition
        const clientHost = {
          host: '127.0.0.1',
          port: 55555,
        };
        const serverHost = {
          host: '127.0.0.1',
          port: 55556,
        };
        // These buffers will be used between the tests and will be mutated
        let clientSendLength: number, _clientSendInfo: SendInfo;
        const clientBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        let _serverSendLength: number, _serverSendInfo: SendInfo;
        const serverBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        let clientQuicheConfig: Config;
        let serverQuicheConfig: Config;
        let clientScid: QUICConnectionId;
        let clientDcid: QUICConnectionId;
        let serverScid: QUICConnectionId;
        let _serverDcid: QUICConnectionId;
        let clientConn: Connection;
        let serverConn: Connection;
        beforeAll(async () => {
          const clientConfig: QUICConfig = {
            ...clientDefault,
            verifyPeer: false,
            maxIdleTimeout: 2000,
          };
          const serverConfig: QUICConfig = {
            ...serverDefault,
            key: keyPairRSAPEM.privateKey,
            cert: certRSAPEM,
            maxIdleTimeout: 2000,
          };
          clientQuicheConfig = buildQuicheConfig(clientConfig);
          serverQuicheConfig = buildQuicheConfig(serverConfig);
        });
        test('client connect', async () => {
          // Randomly generate the client SCID
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
          const result = clientConn.send(clientBuffer);
          expect(result).not.toBeNull();
          [clientSendLength, _clientSendInfo] = result!;
        });
        test('client and server negotiation', async () => {
          const clientHeaderInitial = quiche.Header.fromSlice(
            clientBuffer.subarray(0, clientSendLength),
            quiche.MAX_CONN_ID_LEN,
          );
          clientDcid = new QUICConnectionId(clientHeaderInitial.dcid);
          serverScid = new QUICConnectionId(
            await crypto.ops.sign(crypto.key, clientDcid),
            0,
            quiche.MAX_CONN_ID_LEN,
          );
          const token = await utils.mintToken(
            clientDcid,
            clientHost.host as Host,
            crypto,
          );
          const retryDatagram = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
          const retryDatagramLength = quiche.retry(
            clientScid,
            clientDcid,
            serverScid,
            token,
            clientHeaderInitial.version,
            retryDatagram,
          );
          // Retry gets sent back to be processed by the client
          clientConn.recv(retryDatagram.subarray(0, retryDatagramLength), {
            to: clientHost,
            from: serverHost,
          });
          const result = clientConn.send(clientBuffer);
          expect(result).not.toBeNull();
          [clientSendLength, _clientSendInfo] = result!;
          const clientHeaderInitialRetry = quiche.Header.fromSlice(
            clientBuffer.subarray(0, clientSendLength),
            quiche.MAX_CONN_ID_LEN,
          );
          const dcidOriginal = await utils.validateToken(
            Buffer.from(clientHeaderInitialRetry.token!),
            clientHost.host as Host,
            crypto,
          );
          expect(dcidOriginal).toEqual(clientDcid);
        });
        test('server accept', async () => {
          serverConn = quiche.Connection.accept(
            serverScid,
            clientDcid,
            serverHost,
            clientHost,
            serverQuicheConfig,
          );
          clientDcid = serverScid;
          _serverDcid = clientScid;
          expect(serverConn.timeout()).toBeNull();
          serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
            to: serverHost,
            from: clientHost,
          });
          // Once an idle max timeout is set, this timeout is no longer null
          // Either the client or server or both can set the idle timeout
          expect(serverConn.timeout()).not.toBeNull();
        });
        test('client <-initial- server timeout', async () => {
          // Server tries sending the initial frame
          const result = serverConn.send(serverBuffer);
          expect(result).not.toBeNull();
          [_serverSendLength, _serverSendInfo] = result!;
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
          // After both are timed out, there's no local error nor peer error
          expect(serverConn.localError()).toBeNull();
          expect(serverConn.peerError()).toBeNull();
          expect(clientConn.localError()).toBeNull();
          expect(clientConn.peerError()).toBeNull();
        });
      });
      describe('handshake timeout', () => {
        // These tests run in-order, and each step is a state transition
        const clientHost = {
          host: '127.0.0.1',
          port: 55555,
        };
        const serverHost = {
          host: '127.0.0.1',
          port: 55556,
        };
        // These buffers will be used between the tests and will be mutated
        let clientSendLength: number, _clientSendInfo: SendInfo;
        const clientBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        let serverSendLength: number, _serverSendInfo: SendInfo;
        const serverBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        let clientQuicheConfig: Config;
        let serverQuicheConfig: Config;
        let clientScid: QUICConnectionId;
        let clientDcid: QUICConnectionId;
        let serverScid: QUICConnectionId;
        let _serverDcid: QUICConnectionId;
        let clientConn: Connection;
        let serverConn: Connection;
        beforeAll(async () => {
          const clientConfig: QUICConfig = {
            ...clientDefault,
            verifyPeer: false,
            maxIdleTimeout: 2000,
          };
          const serverConfig: QUICConfig = {
            ...serverDefault,
            key: keyPairRSAPEM.privateKey,
            cert: certRSAPEM,
            maxIdleTimeout: 2000,
          };
          clientQuicheConfig = buildQuicheConfig(clientConfig);
          serverQuicheConfig = buildQuicheConfig(serverConfig);
        });
        test('client connect', async () => {
          // Randomly generate the client SCID
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
          const result = clientConn.send(clientBuffer);
          expect(result).not.toBeNull();
          [clientSendLength, _clientSendInfo] = result!;
        });
        test('client and server negotiation', async () => {
          const clientHeaderInitial = quiche.Header.fromSlice(
            clientBuffer.subarray(0, clientSendLength),
            quiche.MAX_CONN_ID_LEN,
          );
          clientDcid = new QUICConnectionId(clientHeaderInitial.dcid);
          serverScid = new QUICConnectionId(
            await crypto.ops.sign(crypto.key, clientDcid),
            0,
            quiche.MAX_CONN_ID_LEN,
          );
          const token = await utils.mintToken(
            clientDcid,
            clientHost.host as Host,
            crypto,
          );
          const retryDatagram = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
          const retryDatagramLength = quiche.retry(
            clientScid,
            clientDcid,
            serverScid,
            token,
            clientHeaderInitial.version,
            retryDatagram,
          );
          // Retry gets sent back to be processed by the client
          clientConn.recv(retryDatagram.subarray(0, retryDatagramLength), {
            to: clientHost,
            from: serverHost,
          });
          const result = clientConn.send(clientBuffer);
          expect(result).not.toBeNull();
          [clientSendLength, _clientSendInfo] = result!;
          const clientHeaderInitialRetry = quiche.Header.fromSlice(
            clientBuffer.subarray(0, clientSendLength),
            quiche.MAX_CONN_ID_LEN,
          );
          const dcidOriginal = await utils.validateToken(
            Buffer.from(clientHeaderInitialRetry.token!),
            clientHost.host as Host,
            crypto,
          );
          expect(dcidOriginal).toEqual(clientDcid);
        });
        test('server accept', async () => {
          serverConn = quiche.Connection.accept(
            serverScid,
            clientDcid,
            serverHost,
            clientHost,
            serverQuicheConfig,
          );
          clientDcid = serverScid;
          _serverDcid = clientScid;
          expect(serverConn.timeout()).toBeNull();
          serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
            to: serverHost,
            from: clientHost,
          });
          // Once an idle max timeout is set, this timeout is no longer null
          // Either the client or server or both can set the idle timeout
          expect(serverConn.timeout()).not.toBeNull();
        });
        test('client <-initial- server', async () => {
          const result = serverConn.send(serverBuffer);
          expect(result).not.toBeNull();
          [serverSendLength, _serverSendInfo] = result!;
          clientConn.recv(serverBuffer.subarray(0, serverSendLength), {
            to: clientHost,
            from: serverHost,
          });
        });
        test('client -initial-> server', async () => {
          const result = clientConn.send(clientBuffer);
          expect(result).not.toBeNull();
          [clientSendLength, _clientSendInfo] = result!;
          serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
            to: serverHost,
            from: clientHost,
          });
        });
        test('client <-handshake- server timeout', async () => {
          const result = serverConn.send(serverBuffer);
          expect(result).not.toBeNull();
          [serverSendLength, _serverSendInfo] = result!;
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
          host: '127.0.0.1',
          port: 55555,
        };
        const serverHost = {
          host: '127.0.0.1',
          port: 55556,
        };
        // These buffers will be used between the tests and will be mutated
        let clientSendLength: number, _clientSendInfo: SendInfo;
        const clientBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        let serverSendLength: number, _serverSendInfo: SendInfo;
        const serverBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        let clientQuicheConfig: Config;
        let serverQuicheConfig: Config;
        let clientScid: QUICConnectionId;
        let clientDcid: QUICConnectionId;
        let serverScid: QUICConnectionId;
        let _serverDcid: QUICConnectionId;
        let clientConn: Connection;
        let serverConn: Connection;
        beforeAll(async () => {
          const clientConfig: QUICConfig = {
            ...clientDefault,
            verifyPeer: false,
            maxIdleTimeout: 2000,
          };
          const serverConfig: QUICConfig = {
            ...serverDefault,
            key: keyPairRSAPEM.privateKey,
            cert: certRSAPEM,
            maxIdleTimeout: 2000,
          };
          clientQuicheConfig = buildQuicheConfig(clientConfig);
          serverQuicheConfig = buildQuicheConfig(serverConfig);
        });
        test('client connect', async () => {
          // Randomly generate the client SCID
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
          const result = clientConn.send(clientBuffer);
          expect(result).not.toBeNull();
          [clientSendLength, _clientSendInfo] = result!;
        });
        test('client and server negotiation', async () => {
          const clientHeaderInitial = quiche.Header.fromSlice(
            clientBuffer.subarray(0, clientSendLength),
            quiche.MAX_CONN_ID_LEN,
          );
          clientDcid = new QUICConnectionId(clientHeaderInitial.dcid);
          serverScid = new QUICConnectionId(
            await crypto.ops.sign(crypto.key, clientDcid),
            0,
            quiche.MAX_CONN_ID_LEN,
          );
          const token = await utils.mintToken(
            clientDcid,
            clientHost.host as Host,
            crypto,
          );
          const retryDatagram = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
          const retryDatagramLength = quiche.retry(
            clientScid,
            clientDcid,
            serverScid,
            token,
            clientHeaderInitial.version,
            retryDatagram,
          );
          // Retry gets sent back to be processed by the client
          clientConn.recv(retryDatagram.subarray(0, retryDatagramLength), {
            to: clientHost,
            from: serverHost,
          });
          const result = clientConn.send(clientBuffer);
          expect(result).not.toBeNull();
          [clientSendLength, _clientSendInfo] = result!;
          const clientHeaderInitialRetry = quiche.Header.fromSlice(
            clientBuffer.subarray(0, clientSendLength),
            quiche.MAX_CONN_ID_LEN,
          );
          const dcidOriginal = await utils.validateToken(
            Buffer.from(clientHeaderInitialRetry.token!),
            clientHost.host as Host,
            crypto,
          );
          expect(dcidOriginal).toEqual(clientDcid);
        });
        test('server accept', async () => {
          serverConn = quiche.Connection.accept(
            serverScid,
            clientDcid,
            serverHost,
            clientHost,
            serverQuicheConfig,
          );
          clientDcid = serverScid;
          _serverDcid = clientScid;
          expect(serverConn.timeout()).toBeNull();
          serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
            to: serverHost,
            from: clientHost,
          });
          // Once an idle max timeout is set, this timeout is no longer null
          // Either the client or server or both can set the idle timeout
          expect(serverConn.timeout()).not.toBeNull();
        });
        test('client <-initial- server', async () => {
          const result = serverConn.send(serverBuffer);
          expect(result).not.toBeNull();
          [serverSendLength, _serverSendInfo] = result!;
          clientConn.recv(serverBuffer.subarray(0, serverSendLength), {
            to: clientHost,
            from: serverHost,
          });
        });
        test('client -initial-> server', async () => {
          const result = clientConn.send(clientBuffer);
          expect(result).not.toBeNull();
          [clientSendLength, _clientSendInfo] = result!;
          serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
            to: serverHost,
            from: clientHost,
          });
        });
        test('client <-handshake- server', async () => {
          const result = serverConn.send(serverBuffer);
          expect(result).not.toBeNull();
          [serverSendLength, _serverSendInfo] = result!;
          clientConn.recv(serverBuffer.subarray(0, serverSendLength), {
            to: clientHost,
            from: serverHost,
          });
        });
        test('client is established', async () => {
          expect(clientConn.isEstablished()).toBeTrue();
        });
        test('client -handshake-> sever', async () => {
          const result = clientConn.send(clientBuffer);
          expect(result).not.toBeNull();
          [clientSendLength, _clientSendInfo] = result!;
          serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
            to: serverHost,
            from: clientHost,
          });
        });
        test('server is established', async () => {
          expect(serverConn.isEstablished()).toBeTrue();
        });
        test('client <-short- server timeout', async () => {
          const result = serverConn.send(serverBuffer);
          expect(result).not.toBeNull();
          [serverSendLength, _serverSendInfo] = result!;
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
  });
});
