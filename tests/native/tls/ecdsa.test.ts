import type { X509Certificate } from '@peculiar/x509';
import type {
  QUICConfig,
  Host,
  Port,
  ClientCryptoOps,
  ServerCryptoOps,
} from '@/types';
import type { Config, Connection, SendInfo } from '@/native/types';
import { quiche } from '@/native';
import { clientDefault, serverDefault, buildQuicheConfig } from '@/config';
import QUICConnectionId from '@/QUICConnectionId';
import * as utils from '@/utils';
import { sleep } from '@/utils';
import * as testsUtils from '../../utils';

describe('native/tls/ecdsa', () => {
  let crypto: {
    key: ArrayBuffer;
    ops: ClientCryptoOps & ServerCryptoOps;
  };
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
  beforeAll(async () => {
    crypto = {
      key: await testsUtils.generateKeyHMAC(),
      ops: {
        sign: testsUtils.signHMAC,
        verify: testsUtils.verifyHMAC,
        randomBytes: testsUtils.randomBytes,
      },
    };
    keyPairECDSA = await testsUtils.generateKeyPairECDSA();
    certECDSA = await testsUtils.generateCertificate({
      certId: '0',
      subjectKeyPair: keyPairECDSA,
      issuerPrivateKey: keyPairECDSA.privateKey,
      duration: 60 * 60 * 24 * 365 * 10,
    });
    keyPairECDSAPEM = await testsUtils.keyPairECDSAToPEM(keyPairECDSA);
    certECDSAPEM = testsUtils.certToPEM(certECDSA);
  });
  describe('ECDSA success with both client and server certificates', () => {
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
    let clientSendLength: number, _clientSendInfo: SendInfo;
    const clientBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
    let serverSendLength: number, _serverSendInfo: SendInfo;
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
        verifyPeer: true,
        key: keyPairECDSAPEM.privateKey,
        cert: certECDSAPEM,
        ca: certECDSAPEM,
        maxIdleTimeout: 0,
      };
      const serverConfig: QUICConfig = {
        ...serverDefault,
        verifyPeer: true,
        key: keyPairECDSAPEM.privateKey,
        cert: certECDSAPEM,
        ca: certECDSAPEM,
        maxIdleTimeout: 0,
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
      [clientSendLength, _clientSendInfo] = clientConn.send(clientBuffer);
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
      // Stateless retry
      const token = await utils.mintToken(clientDcid, clientHost.host, crypto);
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
      // Client will retry the initial packet with the token
      [clientSendLength, _clientSendInfo] = clientConn.send(clientBuffer);
      const clientHeaderInitialRetry = quiche.Header.fromSlice(
        clientBuffer.subarray(0, clientSendLength),
        quiche.MAX_CONN_ID_LEN,
      );
      // Validate the token
      const dcidOriginal = await utils.validateToken(
        Buffer.from(clientHeaderInitialRetry.token!),
        clientHost.host,
        crypto,
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
        serverQuicheConfig,
      );
      clientDcid = serverScid;
      serverDcid = clientScid;
      serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
        to: serverHost,
        from: clientHost,
      });
    });
    test('client <-initial- server', async () => {
      [serverSendLength, _serverSendInfo] = serverConn.send(serverBuffer);
      clientConn.recv(serverBuffer.subarray(0, serverSendLength), {
        to: clientHost,
        from: serverHost,
      });
    });
    test('client is established', async () => {
      expect(clientConn.isEstablished()).toBeTrue();
      const clientPeerCertChain = clientConn.peerCertChain()!;
      expect(clientPeerCertChain).not.toBeNull();
      expect(clientPeerCertChain).toHaveLength(1);
      expect(typeof utils.certificateDERToPEM(clientPeerCertChain[0])).toBe(
        'string',
      );
    });
    test('client -initial-> server', async () => {
      [clientSendLength, _clientSendInfo] = clientConn.send(clientBuffer);
      serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
        to: serverHost,
        from: clientHost,
      });
    });
    test('server is established', async () => {
      expect(serverConn.isEstablished()).toBeTrue();
      const serverPeerCertChain = serverConn.peerCertChain()!;
      expect(serverPeerCertChain).not.toBeNull();
      expect(serverPeerCertChain).toHaveLength(1);
      expect(typeof utils.certificateDERToPEM(serverPeerCertChain[0])).toBe(
        'string',
      );
    });
    test('client <-short- server', async () => {
      [serverSendLength, _serverSendInfo] = serverConn.send(serverBuffer);
      const serverHeaderShort = quiche.Header.fromSlice(
        serverBuffer.subarray(0, serverSendLength),
        quiche.MAX_CONN_ID_LEN,
      );
      expect(serverHeaderShort.ty).toBe(quiche.Type.Short);
      clientConn.recv(serverBuffer.subarray(0, serverSendLength), {
        to: clientHost,
        from: serverHost,
      });
    });
    test('client -short-> server', async () => {
      [clientSendLength, _clientSendInfo] = clientConn.send(clientBuffer);
      const clientHeaderShort = quiche.Header.fromSlice(
        clientBuffer.subarray(0, clientSendLength),
        quiche.MAX_CONN_ID_LEN,
      );
      expect(clientHeaderShort.ty).toBe(quiche.Type.Short);
      serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
        to: serverHost,
        from: clientHost,
      });
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
      const clientPeerCertChain = clientConn.peerCertChain()!;
      expect(clientPeerCertChain).not.toBeNull();
      expect(clientPeerCertChain).toHaveLength(1);
      expect(typeof utils.certificateDERToPEM(clientPeerCertChain[0])).toBe(
        'string',
      );
      const serverPeerCertChain = serverConn.peerCertChain()!;
      expect(serverPeerCertChain).not.toBeNull();
      expect(serverPeerCertChain).toHaveLength(1);
      expect(typeof utils.certificateDERToPEM(serverPeerCertChain[0])).toBe(
        'string',
      );
    });
    test('client close', async () => {
      clientConn.close(true, 0, Buffer.from(''));
      [clientSendLength, _clientSendInfo] = clientConn.send(clientBuffer);
      await testsUtils.sleep(clientConn.timeout()!);
      clientConn.onTimeout();
      await testsUtils.waitForTimeoutNull(clientConn);
      expect(clientConn.timeout()).toBeNull();
      serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
        to: serverHost,
        from: clientHost,
      });
      await testsUtils.sleep(serverConn.timeout()!);
      serverConn.onTimeout();
      await testsUtils.waitForTimeoutNull(serverConn);
      expect(serverConn.timeout()).toBeNull();
      expect(clientConn.isClosed()).toBeTrue();
      expect(serverConn.isClosed()).toBeTrue();
    });
  });
  describe('ECDSA fail verifying client with bad client certificate (TlsFail 304)', () => {
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
    let clientSendLength: number, _clientSendInfo: SendInfo;
    const clientBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
    let serverSendLength: number, _serverSendInfo: SendInfo;
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
        verifyPeer: true,
        key: keyPairECDSAPEM.privateKey,
        cert: certECDSAPEM,
        ca: certECDSAPEM,
        maxIdleTimeout: 0,
      };
      const serverConfig: QUICConfig = {
        ...serverDefault,
        verifyPeer: true,
        key: keyPairECDSAPEM.privateKey,
        cert: certECDSAPEM,
        maxIdleTimeout: 0,
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
      [clientSendLength, _clientSendInfo] = clientConn.send(clientBuffer);
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
      // Stateless retry
      const token = await utils.mintToken(clientDcid, clientHost.host, crypto);
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
      // Client will retry the initial packet with the token
      [clientSendLength, _clientSendInfo] = clientConn.send(clientBuffer);
      const clientHeaderInitialRetry = quiche.Header.fromSlice(
        clientBuffer.subarray(0, clientSendLength),
        quiche.MAX_CONN_ID_LEN,
      );
      // Validate the token
      const dcidOriginal = await utils.validateToken(
        Buffer.from(clientHeaderInitialRetry.token!),
        clientHost.host,
        crypto,
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
        serverQuicheConfig,
      );
      clientDcid = serverScid;
      serverDcid = clientScid;
      serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
        to: serverHost,
        from: clientHost,
      });
    });
    test('client <-initial- server', async () => {
      [serverSendLength, _serverSendInfo] = serverConn.send(serverBuffer);
      clientConn.recv(serverBuffer.subarray(0, serverSendLength), {
        to: clientHost,
        from: serverHost,
      });
    });
    test('client is established', async () => {
      expect(clientConn.isEstablished()).toBeTrue();
    });
    test('client -initial-> server', async () => {
      [clientSendLength, _clientSendInfo] = clientConn.send(clientBuffer);
      expect(() =>
        serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
          to: serverHost,
          from: clientHost,
        }),
      ).toThrow('TlsFail');
      expect(serverConn.localError()).toEqual({
        isApp: false,
        // This code is unknown!
        errorCode: 304,
        reason: new Uint8Array(),
      });
      expect(serverConn.peerError()).toBeNull();
      expect(serverConn.isTimedOut()).toBeFalse();
      expect(serverConn.isInEarlyData()).toBeFalse();
      expect(serverConn.isEstablished()).toBeFalse();
      expect(serverConn.isResumed()).toBeFalse();
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.isClosed()).toBeFalse();
      expect(serverConn.isDraining()).toBeFalse();
    });
    test('client <-handshake- server', async () => {
      [serverSendLength, _serverSendInfo] = serverConn.send(serverBuffer);
      const serverHeaderHandshake = quiche.Header.fromSlice(
        serverBuffer.subarray(0, serverSendLength),
        quiche.MAX_CONN_ID_LEN,
      );
      expect(serverHeaderHandshake.ty).toBe(quiche.Type.Handshake);
      expect(serverConn.timeout()).not.toBeNull();
      expect(serverConn.isTimedOut()).toBeFalse();
      expect(serverConn.isInEarlyData()).toBeFalse();
      expect(serverConn.isEstablished()).toBeFalse();
      expect(serverConn.isResumed()).toBeFalse();
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.isClosed()).toBeFalse();
      // Server is in draining state now
      expect(serverConn.isDraining()).toBeTrue();
      clientConn.recv(serverBuffer.subarray(0, serverSendLength), {
        to: clientHost,
        from: serverHost,
      });
      expect(clientConn.localError()).toBeNull();
      expect(clientConn.peerError()).toEqual({
        isApp: false,
        // This code is unknown!
        errorCode: 304,
        reason: new Uint8Array(),
      });
      expect(clientConn.timeout()).not.toBeNull();
      expect(clientConn.isTimedOut()).toBeFalse();
      expect(clientConn.isInEarlyData()).toBeFalse();
      expect(clientConn.isEstablished()).toBeTrue();
      expect(clientConn.isResumed()).toBeFalse();
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.isClosed()).toBeFalse();
      // Client is in draining state now
      expect(clientConn.isDraining()).toBeTrue();
    });
    test('client and server close', async () => {
      expect(() => clientConn.send(clientBuffer)).toThrow('Done');
      expect(() => serverConn.send(serverBuffer)).toThrow('Done');
      expect(clientConn.timeout()).not.toBeNull();
      expect(serverConn.timeout()).not.toBeNull();
      await testsUtils.waitForTimeoutNull(clientConn);
      await testsUtils.waitForTimeoutNull(serverConn);
      expect(clientConn.isClosed()).toBeTrue();
      expect(serverConn.isClosed()).toBeTrue();
    });
  });
  describe('ECDSA fail verifying server bad server certificate (TlsFail 304)', () => {
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
    let clientSendLength: number, _clientSendInfo: SendInfo;
    const clientBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
    let serverSendLength: number, _serverSendInfo: SendInfo;
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
        verifyPeer: true,
        key: keyPairECDSAPEM.privateKey,
        cert: certECDSAPEM,
        maxIdleTimeout: 0,
      };
      const serverConfig: QUICConfig = {
        ...serverDefault,
        verifyPeer: true,
        key: keyPairECDSAPEM.privateKey,
        cert: certECDSAPEM,
        ca: certECDSAPEM,
        maxIdleTimeout: 0,
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
      [clientSendLength, _clientSendInfo] = clientConn.send(clientBuffer);
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
      // Stateless retry
      const token = await utils.mintToken(clientDcid, clientHost.host, crypto);
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
      // Client will retry the initial packet with the token
      [clientSendLength, _clientSendInfo] = clientConn.send(clientBuffer);
      const clientHeaderInitialRetry = quiche.Header.fromSlice(
        clientBuffer.subarray(0, clientSendLength),
        quiche.MAX_CONN_ID_LEN,
      );
      // Validate the token
      const dcidOriginal = await utils.validateToken(
        Buffer.from(clientHeaderInitialRetry.token!),
        clientHost.host,
        crypto,
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
        serverQuicheConfig,
      );
      clientDcid = serverScid;
      serverDcid = clientScid;
      serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
        to: serverHost,
        from: clientHost,
      });
    });
    test('client <-initial- server', async () => {
      [serverSendLength, _serverSendInfo] = serverConn.send(serverBuffer);
      // Client rejects server initial
      expect(() =>
        clientConn.recv(serverBuffer.subarray(0, serverSendLength), {
          to: clientHost,
          from: serverHost,
        }),
      ).toThrow('TlsFail');
      expect(clientConn.localError()).toEqual({
        isApp: false,
        // This code is unknown!
        errorCode: 304,
        reason: new Uint8Array(),
      });
      expect(clientConn.peerError()).toBeNull();
      expect(clientConn.isTimedOut()).toBeFalse();
      expect(clientConn.isInEarlyData()).toBeFalse();
      expect(clientConn.isEstablished()).toBeFalse();
      expect(clientConn.isResumed()).toBeFalse();
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.isClosed()).toBeFalse();
      expect(clientConn.isDraining()).toBeFalse();
    });
    test('client -initial-> server', async () => {
      [clientSendLength, _clientSendInfo] = clientConn.send(clientBuffer);
      const clientHeaderInitial = quiche.Header.fromSlice(
        clientBuffer.subarray(0, clientSendLength),
        quiche.MAX_CONN_ID_LEN,
      );
      expect(clientHeaderInitial.ty).toBe(quiche.Type.Initial);
      expect(clientConn.timeout()).not.toBeNull();
      expect(clientConn.isTimedOut()).toBeFalse();
      expect(clientConn.isInEarlyData()).toBeFalse();
      expect(clientConn.isEstablished()).toBeFalse();
      expect(clientConn.isResumed()).toBeFalse();
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.isClosed()).toBeFalse();
      // Client is in draining state now
      expect(clientConn.isDraining()).toBeTrue();
      serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
        to: serverHost,
        from: clientHost,
      });
      expect(serverConn.localError()).toBeNull();
      expect(serverConn.peerError()).toEqual({
        isApp: false,
        // This code is unknown!
        errorCode: 304,
        reason: new Uint8Array(),
      });
      expect(serverConn.timeout()).not.toBeNull();
      expect(serverConn.isTimedOut()).toBeFalse();
      expect(serverConn.isInEarlyData()).toBeFalse();
      expect(serverConn.isEstablished()).toBeFalse();
      expect(serverConn.isResumed()).toBeFalse();
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.isClosed()).toBeFalse();
      // Server is in draining state now
      expect(serverConn.isDraining()).toBeTrue();
    });
    test('client and server close', async () => {
      expect(() => clientConn.send(clientBuffer)).toThrow('Done');
      expect(() => serverConn.send(serverBuffer)).toThrow('Done');
      expect(clientConn.timeout()).not.toBeNull();
      expect(serverConn.timeout()).not.toBeNull();
      await testsUtils.waitForTimeoutNull(clientConn);
      await testsUtils.waitForTimeoutNull(serverConn);
      expect(clientConn.isClosed()).toBeTrue();
      expect(serverConn.isClosed()).toBeTrue();
    });
  });
  describe('ECDSA with custom verify callback', () => {
    describe('ECDSA success with both client and server certificates', () => {
    });
    describe('ECDSA success with only server certificates', () => {
    });
    describe('ECDSA fail verifying client with bad client certificate (TLS 304)', () => {
    });
    describe('ECDSA fail verifying server with bad server certificate (TLS 304)', () => {
    });
  });
});
