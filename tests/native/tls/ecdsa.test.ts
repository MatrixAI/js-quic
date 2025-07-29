import type { X509Certificate } from '@peculiar/x509';
import type {
  QUICConfig,
  Host,
  ClientCryptoOps,
  ServerCryptoOps,
  TLSVerifyCallback,
} from '#types.js';
import type { Config, Connection, SendInfo } from '#native/types.js';
import * as testsUtils from '../../utils.js';
import quiche from '#native/quiche.js';
import { clientDefault, serverDefault, buildQuicheConfig } from '#config.js';
import QUICConnectionId from '#QUICConnectionId.js';
import * as utils from '#utils.js';
import { CryptoError } from '#native/types.js';

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
      // Stateless retry
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
      // Client will retry the initial packet with the token
      const result = clientConn.send(clientBuffer);
      expect(result).not.toBeNull();
      [clientSendLength, _clientSendInfo] = result!;
      const clientHeaderInitialRetry = quiche.Header.fromSlice(
        clientBuffer.subarray(0, clientSendLength),
        quiche.MAX_CONN_ID_LEN,
      );
      // Validate the token
      const dcidOriginal = await utils.validateToken(
        Buffer.from(clientHeaderInitialRetry.token!),
        clientHost.host as Host,
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
      _serverDcid = clientScid;
      serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
        to: serverHost,
        from: clientHost,
      });
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
    test('client is established', async () => {
      expect(clientConn.isEstablished()).toBeTrue();
      const clientPeerCertChain = clientConn.peerCertChain()!;
      expect(clientPeerCertChain).not.toBeNull();
      expect(clientPeerCertChain).toHaveLength(1);
      expect(typeof utils.derToPEM(clientPeerCertChain[0])).toBe('string');
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
    test('server is established', async () => {
      expect(serverConn.isEstablished()).toBeTrue();
      const serverPeerCertChain = serverConn.peerCertChain()!;
      expect(serverPeerCertChain).not.toBeNull();
      expect(serverPeerCertChain).toHaveLength(1);
      expect(typeof utils.derToPEM(serverPeerCertChain[0])).toBe('string');
    });
    test('client <-short- server', async () => {
      const result = serverConn.send(serverBuffer);
      expect(result).not.toBeNull();
      [serverSendLength, _serverSendInfo] = result!;
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
      const result = clientConn.send(clientBuffer);
      expect(result).not.toBeNull();
      [clientSendLength, _clientSendInfo] = result!;
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
      expect(typeof utils.derToPEM(clientPeerCertChain[0])).toBe('string');
      const serverPeerCertChain = serverConn.peerCertChain()!;
      expect(serverPeerCertChain).not.toBeNull();
      expect(serverPeerCertChain).toHaveLength(1);
      expect(typeof utils.derToPEM(serverPeerCertChain[0])).toBe('string');
    });
    test('client close', async () => {
      clientConn.close(true, 0, Buffer.from(''));
      // Closing always results in local error
      expect(clientConn.localError()).toEqual({
        isApp: true,
        errorCode: 0,
        reason: new Uint8Array(),
      });
      expect(clientConn.peerError()).toBeNull();
      const result = clientConn.send(clientBuffer);
      expect(result).not.toBeNull();
      [clientSendLength, _clientSendInfo] = result!;
      const clientBufferCopy = Buffer.from(clientBuffer);
      expect(clientConn.isDraining()).toBeTrue();
      expect(clientConn.isClosed()).toBeFalse();
      await testsUtils.sleep(clientConn.timeout()!);
      clientConn.onTimeout();
      await testsUtils.waitForTimeoutNull(clientConn);
      expect(clientConn.timeout()).toBeNull();
      serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
        to: serverHost,
        from: clientHost,
      });
      expect(serverConn.localError()).toBeNull();
      // Receiving a close is always a peer error
      expect(serverConn.peerError()).toEqual({
        isApp: true,
        errorCode: 0,
        reason: new Uint8Array(),
      });
      expect(serverConn.isDraining()).toBeTrue();
      expect(serverConn.isClosed()).toBeFalse();
      // There is no acknowledgement after receiving close
      expect(serverConn.send(serverBuffer)).toBeNull();
      // Quiche has not implemented a stateless reset
      serverConn.recv(clientBufferCopy, {
        to: serverHost,
        from: clientHost,
      });
      expect(serverConn.send(serverBuffer)).toBeNull();
      await testsUtils.sleep(serverConn.timeout()!);
      serverConn.onTimeout();
      await testsUtils.waitForTimeoutNull(serverConn);
      expect(serverConn.timeout()).toBeNull();
      expect(clientConn.isClosed()).toBeTrue();
      expect(serverConn.isClosed()).toBeTrue();
    });
  });
  describe('ECDSA success with only server certificates', () => {
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
        verifyPeer: true,
        ca: certECDSAPEM,
        maxIdleTimeout: 0,
      };
      const serverConfig: QUICConfig = {
        ...serverDefault,
        verifyPeer: false,
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
      // Stateless retry
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
      // Client will retry the initial packet with the token
      const result = clientConn.send(clientBuffer);
      expect(result).not.toBeNull();
      [clientSendLength, _clientSendInfo] = result!;
      const clientHeaderInitialRetry = quiche.Header.fromSlice(
        clientBuffer.subarray(0, clientSendLength),
        quiche.MAX_CONN_ID_LEN,
      );
      // Validate the token
      const dcidOriginal = await utils.validateToken(
        Buffer.from(clientHeaderInitialRetry.token!),
        clientHost.host as Host,
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
      _serverDcid = clientScid;
      serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
        to: serverHost,
        from: clientHost,
      });
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
    test('client is established', async () => {
      expect(clientConn.isEstablished()).toBeTrue();
      const clientPeerCertChain = clientConn.peerCertChain()!;
      expect(clientPeerCertChain).not.toBeNull();
      expect(clientPeerCertChain).toHaveLength(1);
      expect(typeof utils.derToPEM(clientPeerCertChain[0])).toBe('string');
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
    test('server is established', async () => {
      expect(serverConn.isEstablished()).toBeTrue();
      // The client does not supply a certificate, it is expected to be null
      // This means there's no chance of having an empty array
      const serverPeerCertChain = serverConn.peerCertChain()!;
      expect(serverPeerCertChain).toBeNull();
    });
    test('client <-short- server', async () => {
      const result = serverConn.send(serverBuffer);
      expect(result).not.toBeNull();
      [serverSendLength, _serverSendInfo] = result!;
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
      const result = clientConn.send(clientBuffer);
      expect(result).not.toBeNull();
      [clientSendLength, _clientSendInfo] = result!;
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
      expect(typeof utils.derToPEM(clientPeerCertChain[0])).toBe('string');
      const serverPeerCertChain = serverConn.peerCertChain()!;
      expect(serverPeerCertChain).toBeNull();
    });
    test('client close', async () => {
      clientConn.close(true, 0, Buffer.from(''));
      const result = clientConn.send(clientBuffer);
      expect(result).not.toBeNull();
      [clientSendLength, _clientSendInfo] = result!;
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
  describe('ECDSA fail verifying client with bad client certificate (TlsFail CryptoError.BadCertificate)', () => {
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
      // Stateless retry
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
      // Client will retry the initial packet with the token
      const result = clientConn.send(clientBuffer);
      expect(result).not.toBeNull();
      [clientSendLength, _clientSendInfo] = result!;
      const clientHeaderInitialRetry = quiche.Header.fromSlice(
        clientBuffer.subarray(0, clientSendLength),
        quiche.MAX_CONN_ID_LEN,
      );
      // Validate the token
      const dcidOriginal = await utils.validateToken(
        Buffer.from(clientHeaderInitialRetry.token!),
        clientHost.host as Host,
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
      _serverDcid = clientScid;
      serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
        to: serverHost,
        from: clientHost,
      });
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
    test('client is established', async () => {
      expect(clientConn.isEstablished()).toBeTrue();
    });
    test('client -initial-> server', async () => {
      const result = clientConn.send(clientBuffer);
      expect(result).not.toBeNull();
      [clientSendLength, _clientSendInfo] = result!;
      expect(() =>
        serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
          to: serverHost,
          from: clientHost,
        }),
      ).toThrow('TlsFail');
      expect(serverConn.peerError()).toBeNull();
      expect(serverConn.isTimedOut()).toBeFalse();
      expect(serverConn.isInEarlyData()).toBeFalse();
      expect(serverConn.isEstablished()).toBeFalse();
      expect(serverConn.isResumed()).toBeFalse();
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.isClosed()).toBeFalse();
      expect(serverConn.isDraining()).toBeFalse();
    });
    test('server has local error TlsFail CryptoError.UnknownCA', async () => {
      // CryptoError.BadCertificate means the client supplied certificates that failed verification
      expect(serverConn.localError()).toEqual({
        isApp: false,
        errorCode: CryptoError.UnknownCA,
        reason: new Uint8Array(),
      });
    });
    test('client <-handshake- server', async () => {
      const result = serverConn.send(serverBuffer);
      expect(result).not.toBeNull();
      [serverSendLength, _serverSendInfo] = result!;
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
    test('client has peer error TlsFail CryptoError.UnknownCA', async () => {
      expect(clientConn.peerError()).toEqual({
        isApp: false,
        errorCode: CryptoError.UnknownCA,
        reason: new Uint8Array(),
      });
    });
    test('client and server close', async () => {
      expect(clientConn.send(clientBuffer)).toBeNull();
      expect(serverConn.send(serverBuffer)).toBeNull();
      expect(clientConn.timeout()).not.toBeNull();
      expect(serverConn.timeout()).not.toBeNull();
      await testsUtils.waitForTimeoutNull(clientConn);
      await testsUtils.waitForTimeoutNull(serverConn);
      expect(clientConn.isClosed()).toBeTrue();
      expect(serverConn.isClosed()).toBeTrue();
    });
  });
  describe('ECDSA fail verifying client with no client certificate (TlsFail 372)', () => {
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
        verifyPeer: true,
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
      // Stateless retry
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
      // Client will retry the initial packet with the token
      const result = clientConn.send(clientBuffer);
      expect(result).not.toBeNull();
      [clientSendLength, _clientSendInfo] = result!;
      const clientHeaderInitialRetry = quiche.Header.fromSlice(
        clientBuffer.subarray(0, clientSendLength),
        quiche.MAX_CONN_ID_LEN,
      );
      // Validate the token
      const dcidOriginal = await utils.validateToken(
        Buffer.from(clientHeaderInitialRetry.token!),
        clientHost.host as Host,
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
      _serverDcid = clientScid;
      serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
        to: serverHost,
        from: clientHost,
      });
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
    test('client is established', async () => {
      expect(clientConn.isEstablished()).toBeTrue();
      const clientPeerCertChain = clientConn.peerCertChain()!;
      expect(clientPeerCertChain).not.toBeNull();
      expect(clientPeerCertChain).toHaveLength(1);
      expect(typeof utils.derToPEM(clientPeerCertChain[0])).toBe('string');
    });
    test('client -initial-> server', async () => {
      const result = clientConn.send(clientBuffer);
      expect(result).not.toBeNull();
      [clientSendLength, _clientSendInfo] = result!;
      expect(() =>
        serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
          to: serverHost,
          from: clientHost,
        }),
      ).toThrow('TlsFail');
      expect(serverConn.peerError()).toBeNull();
      expect(serverConn.isTimedOut()).toBeFalse();
      expect(serverConn.isInEarlyData()).toBeFalse();
      expect(serverConn.isEstablished()).toBeFalse();
      expect(serverConn.isResumed()).toBeFalse();
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.isClosed()).toBeFalse();
      expect(serverConn.isDraining()).toBeFalse();
    });
    test('server has local error TlsFail 372', async () => {
      // 372 means the client did not supply any certificates
      expect(serverConn.localError()).toEqual({
        isApp: false,
        errorCode: 372,
        reason: new Uint8Array(),
      });
    });
    test('client <-handshake- server', async () => {
      const result = serverConn.send(serverBuffer);
      expect(result).not.toBeNull();
      [serverSendLength, _serverSendInfo] = result!;
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
    test('client has peer error TlsFail 372', async () => {
      expect(clientConn.peerError()).toEqual({
        isApp: false,
        errorCode: 372,
        reason: new Uint8Array(),
      });
    });
    test('client and server close', async () => {
      expect(clientConn.send(clientBuffer)).toBeNull();
      expect(serverConn.send(serverBuffer)).toBeNull();
      expect(clientConn.timeout()).not.toBeNull();
      expect(serverConn.timeout()).not.toBeNull();
      await testsUtils.waitForTimeoutNull(clientConn);
      await testsUtils.waitForTimeoutNull(serverConn);
      expect(clientConn.isClosed()).toBeTrue();
      expect(serverConn.isClosed()).toBeTrue();
    });
  });
  describe('ECDSA fail verifying server bad server certificate (TlsFail CryptoError.BadCertificate)', () => {
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
      // Stateless retry
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
      // Client will retry the initial packet with the token
      const result = clientConn.send(clientBuffer);
      expect(result).not.toBeNull();
      [clientSendLength, _clientSendInfo] = result!;
      const clientHeaderInitialRetry = quiche.Header.fromSlice(
        clientBuffer.subarray(0, clientSendLength),
        quiche.MAX_CONN_ID_LEN,
      );
      // Validate the token
      const dcidOriginal = await utils.validateToken(
        Buffer.from(clientHeaderInitialRetry.token!),
        clientHost.host as Host,
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
      _serverDcid = clientScid;
      serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
        to: serverHost,
        from: clientHost,
      });
    });
    test('client <-initial- server', async () => {
      const result = serverConn.send(serverBuffer);
      expect(result).not.toBeNull();
      [serverSendLength, _serverSendInfo] = result!;
      // Client rejects server initial
      expect(() =>
        clientConn.recv(serverBuffer.subarray(0, serverSendLength), {
          to: clientHost,
          from: serverHost,
        }),
      ).toThrow('TlsFail');
      expect(clientConn.peerError()).toBeNull();
      expect(clientConn.isTimedOut()).toBeFalse();
      expect(clientConn.isInEarlyData()).toBeFalse();
      expect(clientConn.isEstablished()).toBeFalse();
      expect(clientConn.isResumed()).toBeFalse();
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.isClosed()).toBeFalse();
      expect(clientConn.isDraining()).toBeFalse();
    });
    test('client has local error TlsFail CryptoError.UnknownCA', async () => {
      expect(clientConn.localError()).toEqual({
        isApp: false,
        errorCode: CryptoError.UnknownCA,
        reason: new Uint8Array(),
      });
    });
    test('client -initial-> server', async () => {
      const result = clientConn.send(clientBuffer);
      expect(result).not.toBeNull();
      [clientSendLength, _clientSendInfo] = result!;
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
    test('server has peer error TlsFail CryptoError.UnknownCA', async () => {
      expect(serverConn.peerError()).toEqual({
        isApp: false,
        errorCode: CryptoError.UnknownCA,
        reason: new Uint8Array(),
      });
    });
    test('client and server close', async () => {
      expect(clientConn.send(clientBuffer)).toBeNull();
      expect(serverConn.send(serverBuffer)).toBeNull();
      expect(clientConn.timeout()).not.toBeNull();
      expect(serverConn.timeout()).not.toBeNull();
      await testsUtils.waitForTimeoutNull(clientConn);
      await testsUtils.waitForTimeoutNull(serverConn);
      expect(clientConn.isClosed()).toBeTrue();
      expect(serverConn.isClosed()).toBeTrue();
    });
  });
  describe('ECDSA fail with no server certificates (InternalError 1)', () => {
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
        verifyPeer: true,
        key: keyPairECDSAPEM.privateKey,
        cert: certECDSAPEM,
        ca: certECDSAPEM,
        maxIdleTimeout: 0,
      };
      const serverConfig: QUICConfig = {
        ...serverDefault,
        verifyPeer: true,
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
      // Stateless retry
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
      // Client will retry the initial packet with the token
      const result = clientConn.send(clientBuffer);
      expect(result).not.toBeNull();
      [clientSendLength, _clientSendInfo] = result!;
      const clientHeaderInitialRetry = quiche.Header.fromSlice(
        clientBuffer.subarray(0, clientSendLength),
        quiche.MAX_CONN_ID_LEN,
      );
      // Validate the token
      const dcidOriginal = await utils.validateToken(
        Buffer.from(clientHeaderInitialRetry.token!),
        clientHost.host as Host,
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
      _serverDcid = clientScid;
      expect(() =>
        serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
          to: serverHost,
          from: clientHost,
        }),
      ).toThrow('TlsFail');
      expect(serverConn.peerError()).toBeNull();
      expect(serverConn.isTimedOut()).toBeFalse();
      expect(serverConn.isInEarlyData()).toBeFalse();
      expect(serverConn.isEstablished()).toBeFalse();
      expect(serverConn.isResumed()).toBeFalse();
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.isClosed()).toBeFalse();
      expect(serverConn.isDraining()).toBeFalse();
    });
    test('server has local error 1', async () => {
      expect(serverConn.localError()).toEqual({
        isApp: false,
        errorCode: 1,
        reason: new Uint8Array(),
      });
    });
    test('client <-initial- server', async () => {
      const result = serverConn.send(serverBuffer);
      expect(result).not.toBeNull();
      [serverSendLength, _serverSendInfo] = result!;
      const serverHeaderInitial = quiche.Header.fromSlice(
        serverBuffer.subarray(0, serverSendLength),
        quiche.MAX_CONN_ID_LEN,
      );
      expect(serverHeaderInitial.ty).toBe(quiche.Type.Initial);
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
      expect(clientConn.isTimedOut()).toBeFalse();
      expect(clientConn.isInEarlyData()).toBeFalse();
      expect(clientConn.isEstablished()).toBeFalse();
      expect(clientConn.isResumed()).toBeFalse();
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.isClosed()).toBeFalse();
      // Client is in draining state now
      expect(clientConn.isDraining()).toBeTrue();
    });
    test('client has peer error 1', async () => {
      expect(clientConn.peerError()).toEqual({
        isApp: false,
        errorCode: 1,
        reason: new Uint8Array(),
      });
    });
    test('client and server close', async () => {
      expect(clientConn.send(clientBuffer)).toBeNull();
      expect(serverConn.send(serverBuffer)).toBeNull();
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
      let clientConfig: QUICConfig;
      let serverConfig: QUICConfig;
      let clientQuicheConfig: Config;
      let serverQuicheConfig: Config;
      let clientScid: QUICConnectionId;
      let clientDcid: QUICConnectionId;
      let serverScid: QUICConnectionId;
      let _serverDcid: QUICConnectionId;
      let clientConn: Connection;
      let serverConn: Connection;
      const verifyCallback: TLSVerifyCallback = async (
        certs: Array<Uint8Array>,
        _ca,
      ) => {
        expect(certs).toHaveLength(1);
        return undefined;
      };
      beforeAll(async () => {
        clientConfig = {
          ...clientDefault,
          verifyPeer: true,
          verifyCallback,
          key: keyPairECDSAPEM.privateKey,
          cert: certECDSAPEM,
          ca: certECDSAPEM,
          maxIdleTimeout: 0,
        };
        serverConfig = {
          ...serverDefault,
          verifyPeer: true,
          verifyCallback,
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
        // Stateless retry
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
        // Client will retry the initial packet with the token
        const result = clientConn.send(clientBuffer);
        expect(result).not.toBeNull();
        [clientSendLength, _clientSendInfo] = result!;
        const clientHeaderInitialRetry = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN,
        );
        // Validate the token
        const dcidOriginal = await utils.validateToken(
          Buffer.from(clientHeaderInitialRetry.token!),
          clientHost.host as Host,
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
        _serverDcid = clientScid;
        serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
          to: serverHost,
          from: clientHost,
        });
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
      test('client is established', async () => {
        expect(clientConn.isEstablished()).toBeTrue();
        const clientPeerCertChain = clientConn.peerCertChain()!;
        expect(clientPeerCertChain).not.toBeNull();
        expect(clientPeerCertChain).toHaveLength(1);
        expect(typeof utils.derToPEM(clientPeerCertChain[0])).toBe('string');
        await verifyCallback(
          clientPeerCertChain,
          clientConfig.ca as Array<Uint8Array>,
        );
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
      test('server is established', async () => {
        expect(serverConn.isEstablished()).toBeTrue();
        const serverPeerCertChain = serverConn.peerCertChain()!;
        expect(serverPeerCertChain).not.toBeNull();
        expect(serverPeerCertChain).toHaveLength(1);
        expect(typeof utils.derToPEM(serverPeerCertChain[0])).toBe('string');
        await verifyCallback(
          serverPeerCertChain,
          serverConfig.ca as Array<Uint8Array>,
        );
      });
      test('client <-short- server', async () => {
        const result = serverConn.send(serverBuffer);
        expect(result).not.toBeNull();
        [serverSendLength, _serverSendInfo] = result!;
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
        const result = clientConn.send(clientBuffer);
        expect(result).not.toBeNull();
        [clientSendLength, _clientSendInfo] = result!;
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
        expect(typeof utils.derToPEM(clientPeerCertChain[0])).toBe('string');
        const serverPeerCertChain = serverConn.peerCertChain()!;
        expect(serverPeerCertChain).not.toBeNull();
        expect(serverPeerCertChain).toHaveLength(1);
        expect(typeof utils.derToPEM(serverPeerCertChain[0])).toBe('string');
      });
      test('client close', async () => {
        clientConn.close(true, 0, Buffer.from(''));
        const result = clientConn.send(clientBuffer);
        expect(result).not.toBeNull();
        [clientSendLength, _clientSendInfo] = result!;
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
    describe('ECDSA success with only server certificates', () => {
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
      let clientConfig: QUICConfig;
      let serverConfig: QUICConfig;
      let clientQuicheConfig: Config;
      let serverQuicheConfig: Config;
      let clientScid: QUICConnectionId;
      let clientDcid: QUICConnectionId;
      let serverScid: QUICConnectionId;
      let _serverDcid: QUICConnectionId;
      let clientConn: Connection;
      let serverConn: Connection;
      const verifyCallback = async (certs: Array<Uint8Array>, _ca) => {
        expect(certs).toHaveLength(1);
        return undefined;
      };
      beforeAll(async () => {
        clientConfig = {
          ...clientDefault,
          verifyPeer: true,
          ca: certECDSAPEM,
          maxIdleTimeout: 0,
        };
        serverConfig = {
          ...serverDefault,
          verifyPeer: false,
          verifyCallback,
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
        // Stateless retry
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
        // Client will retry the initial packet with the token
        const result = clientConn.send(clientBuffer);
        expect(result).not.toBeNull();
        [clientSendLength, _clientSendInfo] = result!;
        const clientHeaderInitialRetry = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN,
        );
        // Validate the token
        const dcidOriginal = await utils.validateToken(
          Buffer.from(clientHeaderInitialRetry.token!),
          clientHost.host as Host,
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
        _serverDcid = clientScid;
        serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
          to: serverHost,
          from: clientHost,
        });
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
      test('client is established', async () => {
        expect(clientConn.isEstablished()).toBeTrue();
        const clientPeerCertChain = clientConn.peerCertChain()!;
        expect(clientPeerCertChain).not.toBeNull();
        expect(clientPeerCertChain).toHaveLength(1);
        expect(typeof utils.derToPEM(clientPeerCertChain[0])).toBe('string');
        await verifyCallback(
          clientPeerCertChain,
          clientConfig.ca as Array<Uint8Array>,
        );
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
      test('server is established', async () => {
        expect(serverConn.isEstablished()).toBeTrue();
        // The client does not supply a certificate, it is expected to be null
        // This means there's no chance of having an empty array
        const serverPeerCertChain = serverConn.peerCertChain()!;
        expect(serverPeerCertChain).toBeNull();
      });
      test('client <-short- server', async () => {
        const result = serverConn.send(serverBuffer);
        expect(result).not.toBeNull();
        [serverSendLength, _serverSendInfo] = result!;
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
        const result = clientConn.send(clientBuffer);
        expect(result).not.toBeNull();
        [clientSendLength, _clientSendInfo] = result!;
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
        expect(typeof utils.derToPEM(clientPeerCertChain[0])).toBe('string');
        const serverPeerCertChain = serverConn.peerCertChain()!;
        expect(serverPeerCertChain).toBeNull();
      });
      test('client close', async () => {
        clientConn.close(true, 0, Buffer.from(''));
        const result = clientConn.send(clientBuffer);
        expect(result).not.toBeNull();
        [clientSendLength, _clientSendInfo] = result!;
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
    describe('ECDSA fail verifying client with bad client certificate (TlsFail CryptoError.BadCertificate)', () => {
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
      let clientConfig: QUICConfig;
      let serverConfig: QUICConfig;
      let clientQuicheConfig: Config;
      let serverQuicheConfig: Config;
      let clientScid: QUICConnectionId;
      let clientDcid: QUICConnectionId;
      let serverScid: QUICConnectionId;
      let _serverDcid: QUICConnectionId;
      let clientConn: Connection;
      let serverConn: Connection;
      const verifyCallback = async (certs: Array<Uint8Array>, _ca) => {
        expect(certs).toHaveLength(1);
        return CryptoError.BadCertificate;
      };
      beforeAll(async () => {
        clientConfig = {
          ...clientDefault,
          verifyPeer: true,
          verifyCallback,
          key: keyPairECDSAPEM.privateKey,
          cert: certECDSAPEM,
          ca: certECDSAPEM,
          maxIdleTimeout: 0,
        };
        serverConfig = {
          ...serverDefault,
          verifyPeer: true,
          verifyCallback,
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
        // Stateless retry
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
        // Client will retry the initial packet with the token
        const result = clientConn.send(clientBuffer);
        expect(result).not.toBeNull();
        [clientSendLength, _clientSendInfo] = result!;
        const clientHeaderInitialRetry = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN,
        );
        // Validate the token
        const dcidOriginal = await utils.validateToken(
          Buffer.from(clientHeaderInitialRetry.token!),
          clientHost.host as Host,
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
        _serverDcid = clientScid;
        serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
          to: serverHost,
          from: clientHost,
        });
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
      test('client is established', async () => {
        expect(clientConn.isEstablished()).toBeTrue();
      });
      test('client -initial-> server', async () => {
        const result = clientConn.send(clientBuffer);
        expect(result).not.toBeNull();
        [clientSendLength, _clientSendInfo] = result!;
        // Server will accept the client's bad certificate due to the verify callback
        serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
          to: serverHost,
          from: clientHost,
        });
        // Because the custom verify callback overrides the default verification function
        // The server connection is considered established
        expect(serverConn.isEstablished()).toBeTrue();
        const serverPeerCertChain = serverConn.peerCertChain()!;
        expect(serverPeerCertChain).not.toBeNull();
        expect(serverPeerCertChain).toHaveLength(1);
        expect(typeof utils.derToPEM(serverPeerCertChain[0])).toBe('string');
        // We can imagine that our verify callback fails on the bad certificate
        await expect(
          verifyCallback(
            serverPeerCertChain,
            serverConfig.ca as Array<Uint8Array>,
          ),
        ).resolves.toBe(CryptoError.BadCertificate);
        // Simulate a CryptoError.BadCertificate as it means the client supplied a bad certificate
        serverConn.close(false, CryptoError.BadCertificate, Buffer.from(''));
        expect(serverConn.peerError()).toBeNull();
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        expect(serverConn.isEstablished()).toBeTrue();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.isClosed()).toBeFalse();
        expect(serverConn.isDraining()).toBeFalse();
      });
      test('server has local error TlsFail BadCertificate', async () => {
        // CryptoError.BadCertificate means the client supplied certificates that failed verification
        expect(serverConn.localError()).toEqual({
          isApp: false,
          errorCode: CryptoError.BadCertificate,
          reason: new Uint8Array(),
        });
      });
      test('client <-short- server', async () => {
        const result = serverConn.send(serverBuffer);
        expect(result).not.toBeNull();
        [serverSendLength, _serverSendInfo] = result!;
        const serverHeaderShort = quiche.Header.fromSlice(
          serverBuffer.subarray(0, serverSendLength),
          quiche.MAX_CONN_ID_LEN,
        );
        expect(serverHeaderShort.ty).toBe(quiche.Type.Short);
        expect(serverConn.timeout()).not.toBeNull();
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        expect(serverConn.isEstablished()).toBeTrue();
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
      test('client has peer error TlsFail BadCertificate', async () => {
        expect(clientConn.peerError()).toEqual({
          isApp: false,
          errorCode: CryptoError.BadCertificate,
          reason: new Uint8Array(),
        });
      });
      test('client and server close', async () => {
        expect(clientConn.send(clientBuffer)).toBeNull();
        expect(serverConn.send(serverBuffer)).toBeNull();
        expect(clientConn.timeout()).not.toBeNull();
        expect(serverConn.timeout()).not.toBeNull();
        await testsUtils.waitForTimeoutNull(clientConn);
        await testsUtils.waitForTimeoutNull(serverConn);
        expect(clientConn.isClosed()).toBeTrue();
        expect(serverConn.isClosed()).toBeTrue();
      });
    });
    describe('ECDSA fail verifying client with no client certificate (TlsFail 372)', () => {
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
      let clientConfig: QUICConfig;
      let serverConfig: QUICConfig;
      let clientQuicheConfig: Config;
      let serverQuicheConfig: Config;
      let clientScid: QUICConnectionId;
      let clientDcid: QUICConnectionId;
      let serverScid: QUICConnectionId;
      let _serverDcid: QUICConnectionId;
      let clientConn: Connection;
      let serverConn: Connection;
      const verifyCallback = async (certs: Array<Uint8Array>, _ca) => {
        expect(certs).toHaveLength(0);
        return CryptoError.BadCertificate;
      };
      beforeAll(async () => {
        clientConfig = {
          ...clientDefault,
          verifyPeer: true,
          verifyCallback,
          ca: certECDSAPEM,
          maxIdleTimeout: 0,
        };
        serverConfig = {
          ...serverDefault,
          verifyPeer: true,
          verifyCallback,
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
        // Stateless retry
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
        // Client will retry the initial packet with the token
        const result = clientConn.send(clientBuffer);
        expect(result).not.toBeNull();
        [clientSendLength, _clientSendInfo] = result!;
        const clientHeaderInitialRetry = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN,
        );
        // Validate the token
        const dcidOriginal = await utils.validateToken(
          Buffer.from(clientHeaderInitialRetry.token!),
          clientHost.host as Host,
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
        _serverDcid = clientScid;
        serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
          to: serverHost,
          from: clientHost,
        });
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
      test('client is established', async () => {
        expect(clientConn.isEstablished()).toBeTrue();
        const clientPeerCertChain = clientConn.peerCertChain()!;
        expect(clientPeerCertChain).not.toBeNull();
        expect(clientPeerCertChain).toHaveLength(1);
        expect(typeof utils.derToPEM(clientPeerCertChain[0])).toBe('string');
      });
      test('client -initial-> server', async () => {
        const result = clientConn.send(clientBuffer);
        expect(result).not.toBeNull();
        [clientSendLength, _clientSendInfo] = result!;
        // Even with the custom verify callback, requiring the certificates
        // will make the `recv` fail with `TlsFail`
        expect(() =>
          serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
            to: serverHost,
            from: clientHost,
          }),
        ).toThrow('TlsFail');
        // No certificates is available
        const serverPeerCertChain = serverConn.peerCertChain()!;
        expect(serverPeerCertChain).toBeNull();
        // There's no need to do this, but for symmetry
        await expect(
          verifyCallback(
            serverPeerCertChain ?? [],
            serverConfig.ca as Array<Uint8Array>,
          ),
        ).resolves.toBe(CryptoError.BadCertificate);
        expect(serverConn.peerError()).toBeNull();
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        expect(serverConn.isEstablished()).toBeFalse();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.isClosed()).toBeFalse();
        expect(serverConn.isDraining()).toBeFalse();
      });
      test('server has local error TlsFail 372', async () => {
        // 372 means the client did not supply any certificates
        expect(serverConn.localError()).toEqual({
          isApp: false,
          errorCode: 372,
          reason: new Uint8Array(),
        });
      });
      test('client <-handshake- server', async () => {
        const result = serverConn.send(serverBuffer);
        expect(result).not.toBeNull();
        [serverSendLength, _serverSendInfo] = result!;
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
      test('client has peer error TlsFail 372', async () => {
        expect(clientConn.peerError()).toEqual({
          isApp: false,
          errorCode: 372,
          reason: new Uint8Array(),
        });
      });
      test('client and server close', async () => {
        expect(clientConn.send(clientBuffer)).toBeNull();
        expect(serverConn.send(serverBuffer)).toBeNull();
        expect(clientConn.timeout()).not.toBeNull();
        expect(serverConn.timeout()).not.toBeNull();
        await testsUtils.waitForTimeoutNull(clientConn);
        await testsUtils.waitForTimeoutNull(serverConn);
        expect(clientConn.isClosed()).toBeTrue();
        expect(serverConn.isClosed()).toBeTrue();
      });
    });
    describe('ECDSA fail verifying server bad server certificate (TlsFail CryptoError.BadCertificate)', () => {
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
      let clientConfig: QUICConfig;
      let serverConfig: QUICConfig;
      let clientQuicheConfig: Config;
      let serverQuicheConfig: Config;
      let clientScid: QUICConnectionId;
      let clientDcid: QUICConnectionId;
      let serverScid: QUICConnectionId;
      let _serverDcid: QUICConnectionId;
      let clientConn: Connection;
      let serverConn: Connection;
      const verifyCallback = async (certs: Array<Uint8Array>, _ca) => {
        expect(certs).toHaveLength(1);
        return CryptoError.BadCertificate;
      };
      beforeAll(async () => {
        clientConfig = {
          ...clientDefault,
          verifyPeer: true,
          verifyCallback,
          key: keyPairECDSAPEM.privateKey,
          cert: certECDSAPEM,
          ca: certECDSAPEM,
          maxIdleTimeout: 0,
        };
        serverConfig = {
          ...serverDefault,
          verifyPeer: true,
          verifyCallback,
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
        // Stateless retry
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
        // Client will retry the initial packet with the token
        const result = clientConn.send(clientBuffer);
        expect(result).not.toBeNull();
        [clientSendLength, _clientSendInfo] = result!;
        const clientHeaderInitialRetry = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN,
        );
        // Validate the token
        const dcidOriginal = await utils.validateToken(
          Buffer.from(clientHeaderInitialRetry.token!),
          clientHost.host as Host,
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
        _serverDcid = clientScid;
        serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
          to: serverHost,
          from: clientHost,
        });
      });
      test('client <-initial- server', async () => {
        const result = serverConn.send(serverBuffer);
        expect(result).not.toBeNull();
        [serverSendLength, _serverSendInfo] = result!;
        // Client will accept the server's bad certificate due to the verify callback
        clientConn.recv(serverBuffer.subarray(0, serverSendLength), {
          to: clientHost,
          from: serverHost,
        });
        // Because the custom verify callback overrides the default verification function
        // The client connection is considered established
        expect(clientConn.isEstablished()).toBeTrue();
        const clientPeerCertChain = clientConn.peerCertChain()!;
        expect(clientPeerCertChain).not.toBeNull();
        expect(clientPeerCertChain).toHaveLength(1);
        expect(typeof utils.derToPEM(clientPeerCertChain[0])).toBe('string');
        // We can imagine that our verify callback fails on the bad certificate
        await expect(
          verifyCallback(
            clientPeerCertChain,
            serverConfig.ca as Array<Uint8Array>,
          ),
        ).resolves.toBe(CryptoError.BadCertificate);
        // Due to an upstream bug, if we were to simulate a close with CryptoError.BadCertificate code
        // it would actually break the server connection, the client connection
        // would successfully drain and then close, but the server connection is
        // left to idle until it times out.
        // Therefore instead of closing immediately here, we have to complete the
        // handshake by sending a handshake frame to the server, and then
        // simulate a close with CryptoError.BadCertificate as the code
      });
      test('client -initial-> server', async () => {
        const result = clientConn.send(clientBuffer);
        expect(result).not.toBeNull();
        [clientSendLength, _clientSendInfo] = result!;
        const clientHeaderInitial = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN,
        );
        expect(clientHeaderInitial.ty).toBe(quiche.Type.Initial);
        serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
          to: serverHost,
          from: clientHost,
        });
        // Simulate a TLS failure due to bad certificate
        clientConn.close(false, CryptoError.BadCertificate, Buffer.from(''));
        expect(clientConn.peerError()).toBeNull();
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeTrue();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();
      });
      test('client has local error TlsFail CryptoError.BadCertificate', async () => {
        expect(clientConn.localError()).toEqual({
          isApp: false,
          errorCode: CryptoError.BadCertificate,
          reason: new Uint8Array(),
        });
      });
      test('client -short-> server', async () => {
        const result = clientConn.send(clientBuffer);
        expect(result).not.toBeNull();
        [clientSendLength, _clientSendInfo] = result!;
        const clientHeaderShort = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN,
        );
        expect(clientHeaderShort.ty).toBe(quiche.Type.Short);
        expect(clientConn.timeout()).not.toBeNull();
        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeTrue();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        // Client is in draining state now
        expect(clientConn.isDraining()).toBeTrue();
        serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
          to: serverHost,
          from: clientHost,
        });
        expect(serverConn.timeout()).not.toBeNull();
        expect(serverConn.isTimedOut()).toBeFalse();
        expect(serverConn.isInEarlyData()).toBeFalse();
        expect(serverConn.isEstablished()).toBeTrue();
        expect(serverConn.isResumed()).toBeFalse();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.isClosed()).toBeFalse();
        // Client is in draining state now
        expect(serverConn.isDraining()).toBeTrue();
      });
      test('server has peer error TlsFail CryptoError.BadCertificate', async () => {
        expect(serverConn.peerError()).toEqual({
          isApp: false,
          errorCode: CryptoError.BadCertificate,
          reason: new Uint8Array(),
        });
      });
      test('client and server close', async () => {
        expect(clientConn.send(clientBuffer)).toBeNull();
        expect(serverConn.send(serverBuffer)).toBeNull();
        expect(clientConn.timeout()).not.toBeNull();
        expect(serverConn.timeout()).not.toBeNull();
        await testsUtils.waitForTimeoutNull(clientConn);
        await testsUtils.waitForTimeoutNull(serverConn);
        expect(clientConn.isClosed()).toBeTrue();
        expect(serverConn.isClosed()).toBeTrue();
      });
    });
  });
});
