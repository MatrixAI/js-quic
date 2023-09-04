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
import * as testsUtils from '../utils';

describe('quiche tls', () => {
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
  // established means - I am established (it doesn't mean both sides are established)
  // As soon as I am established, I can check for the peer certificates
  // If the peer certificates is NULL
  // That means there was no certificates supplied
  // It should not be possible for an empty array (if it is, use `never()`)

  // verifyPeer: true, verifyCallback: true
  //   - if peer doesn't supply certs, it's a TlsFail (local error: 327)
  //   - if peer supplies bad certificates - no TLS fail, but verifyCallback will run
  //   - if peer supplies good certificates - no TLS fail, but verifyCallback will run

  // verifyPeer: true, verifyCallback: false
  //   - if peer doesn't supply certs, it's a TlsFail (local error: 327)
  //   - if peer supplies bad certificates - it's a TlsFail (local error: 304)
  //   - if peer supplies good certificates - no TLS fail

  // verifyPeer: false, verifyCallback: true
  //   - if peer doesn't supply certs, no TLS fail
  //   - if peer supplies bad certificates - no TLS fail, ignore verifyCallback
  //   - if peer supplies good certificates - no TLS fail, ignore verifyCallback

  // verifyPeer: false, verifyCallback: false
  //   - if peer doesn't supply certs - no TLS fail
  //   - if peer supplies bad certficates - no TLS fail
  //   - if peer supplies good certificates - no TLS fail

  // verifyAllowFail will become a derived option of verifyCallback
  // calculate the option change in `config.ts`

  // That means during the recv() call, you want to do this:
  //   - check if you get a TlsFail exception
  //     - check the local error
  //     - connection is automatically closed
  //     - dispatch error event
  //     - throw error
  //   - check if we are established
  //     - if we are verifyPeer && verifyCallback true
  //       - check if peer certificates is null - if so, pass
  //       - otherwise, call verifyCallback
  //       - if fail, 304, dispatch error event, throw error
  //     - else
  //       - pass


  describe.only('RSA success allowing client with bad client certificate', () => {
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
        key: keyPairRSAPEM.privateKey,
        cert: certRSAPEM,
        ca: certRSAPEM,
        maxIdleTimeout: 0,
      };
      const serverConfig: QUICConfig = {
        ...serverDefault,
        verifyPeer: true,
        verifyAllowFail: true,
        key: keyPairRSAPEM.privateKey,
        cert: certRSAPEM,
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
    test('client -initial-> server', async () => {
      [clientSendLength, _clientSendInfo] = clientConn.send(clientBuffer);
      serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
        to: serverHost,
        from: clientHost,
      });
    });
    test('client <-handshake- server', async () => {
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
    test('client -handshake-> server', async () => {
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
  describe('RSA custom fail verifying client', () => {
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
        key: keyPairRSAPEM.privateKey,
        cert: certRSAPEM,
        ca: certRSAPEM,
        maxIdleTimeout: 0,
      };
      const serverConfig: QUICConfig = {
        ...serverDefault,
        verifyPeer: true,
        key: keyPairRSAPEM.privateKey,
        cert: certRSAPEM,
        ca: certRSAPEM,
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
    test('client -initial-> server', async () => {
      [clientSendLength, _clientSendInfo] = clientConn.send(clientBuffer);
      serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
        to: serverHost,
        from: clientHost,
      });
    });
    test('client <-handshake- server', async () => {
      [serverSendLength, _serverSendInfo] = serverConn.send(serverBuffer);
      clientConn.recv(serverBuffer.subarray(0, serverSendLength), {
        to: clientHost,
        from: serverHost,
      });
    });
    test('client is established', async () => {
      expect(clientConn.isEstablished()).toBeTrue();
    });
    test('client -handshake-> server', async () => {
      [clientSendLength, _clientSendInfo] = clientConn.send(clientBuffer);
      serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
        to: serverHost,
        from: clientHost,
      });
    });
    test('server is established', async () => {
      expect(serverConn.isEstablished()).toBeTrue();
    });
    test('server close early', async () => {
      serverConn.close(false, 304, Buffer.from('Custom TLS failed'));
      [serverSendLength, _serverSendInfo] = serverConn.send(serverBuffer);

      expect(serverConn.localError()).toEqual({
        isApp: false,
        // This code is unknown!
        errorCode: 304,
        reason: expect.any(Uint8Array),
      });
      expect(serverConn.peerError()).toBeNull();

      expect(serverConn.timeout()).not.toBeNull();
      expect(serverConn.isTimedOut()).toBeFalse();
      expect(serverConn.isInEarlyData()).toBeFalse();
      expect(serverConn.isEstablished()).toBeTrue();
      expect(serverConn.isResumed()).toBeFalse();
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.isClosed()).toBeFalse();
      // Should now be draining
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
        reason: expect.any(Uint8Array),
      });

      expect(clientConn.timeout()).not.toBeNull();
      expect(clientConn.isTimedOut()).toBeFalse();
      expect(clientConn.isInEarlyData()).toBeFalse();
      expect(clientConn.isEstablished()).toBeTrue();
      expect(clientConn.isResumed()).toBeFalse();
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.isClosed()).toBeFalse();
      // Should now be draining
      expect(clientConn.isDraining()).toBeTrue();
    });
    test('client ends after timeout', async () => {
      expect(() => clientConn.send(clientBuffer)).toThrow('Done');
      await testsUtils.waitForTimeoutNull(clientConn);
      await sleep((clientConn.timeout() ?? 0) + 1);
      clientConn.onTimeout();
      expect(clientConn.isClosed()).toBeTrue();
    });
    test('server ends after timeout', async () => {
      expect(() => serverConn.send(clientBuffer)).toThrow('Done');
      await testsUtils.waitForTimeoutNull(serverConn);
      expect(serverConn.isClosed()).toBeTrue();
    });
  });
  describe('RSA custom fail verifying server', () => {
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
        key: keyPairRSAPEM.privateKey,
        cert: certRSAPEM,
        ca: certRSAPEM,
        maxIdleTimeout: 0,
      };
      const serverConfig: QUICConfig = {
        ...serverDefault,
        verifyPeer: true,
        key: keyPairRSAPEM.privateKey,
        cert: certRSAPEM,
        ca: certRSAPEM,
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
    test('client -initial-> server', async () => {
      [clientSendLength, _clientSendInfo] = clientConn.send(clientBuffer);
      serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
        to: serverHost,
        from: clientHost,
      });
    });
    test('client <-handshake- server', async () => {
      [serverSendLength, _serverSendInfo] = serverConn.send(serverBuffer);
      clientConn.recv(serverBuffer.subarray(0, serverSendLength), {
        to: clientHost,
        from: serverHost,
      });
    });
    test('client is established', async () => {
      expect(clientConn.isEstablished()).toBeTrue();
    });
    test('client -handshake-> server', async () => {
      [clientSendLength, _clientSendInfo] = clientConn.send(clientBuffer);
      serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
        to: serverHost,
        from: clientHost,
      });
    });
    test('server is established', async () => {
      expect(serverConn.isEstablished()).toBeTrue();
    });
    test('client close early', async () => {
      clientConn.close(false, 304, Buffer.from('Custom TLS failed'));
      [clientSendLength, _clientSendInfo] = clientConn.send(clientBuffer);

      expect(clientConn.localError()).toEqual({
        isApp: false,
        // This code is unknown!
        errorCode: 304,
        reason: expect.any(Uint8Array),
      });
      expect(clientConn.peerError()).toBeNull();

      expect(clientConn.timeout()).not.toBeNull();
      expect(clientConn.isTimedOut()).toBeFalse();
      expect(clientConn.isInEarlyData()).toBeFalse();
      expect(clientConn.isEstablished()).toBeTrue();
      expect(clientConn.isResumed()).toBeFalse();
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.isClosed()).toBeFalse();
      // Should now be draining
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
        reason: expect.any(Uint8Array),
      });

      expect(serverConn.timeout()).not.toBeNull();
      expect(serverConn.isTimedOut()).toBeFalse();
      expect(serverConn.isInEarlyData()).toBeFalse();
      expect(serverConn.isEstablished()).toBeTrue();
      expect(serverConn.isResumed()).toBeFalse();
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.isClosed()).toBeFalse();
      // Should now be draining
      expect(serverConn.isDraining()).toBeTrue();
    });
    test('client ends after timeout', async () => {
      expect(() => clientConn.send(clientBuffer)).toThrow('Done');
      await testsUtils.waitForTimeoutNull(clientConn);
      await sleep((clientConn.timeout() ?? 0) + 1);
      clientConn.onTimeout();
      expect(clientConn.isClosed()).toBeTrue();
    });
    test('server ends after timeout', async () => {
      expect(() => serverConn.send(clientBuffer)).toThrow('Done');
      await testsUtils.waitForTimeoutNull(serverConn);
      expect(serverConn.isClosed()).toBeTrue();
    });
  });
  describe('ECDSA success', () => {
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
  describe('ECDSA fail verifying client', () => {
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
  describe('ECDSA fail verifying server', () => {
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


  // CUSTOM FAIL VERIFYING SHOULD ACTUALLY BE TESTING verifyAllowFail
  // Not just early closing. You can do the verifyAllowFail as part of a verifyPeer
  // verifyAllowFail true and verifyPeer true would allow passing a bad cert
  // then if you fail this, you can add in the custom failure
  // Let's remove these kinds of tests, and rely on a higher level custom verification test
  // It's sufficient to have the variants of
  // "allowing client with bad client certificate"




  describe('ECDSA custom fail verifying client', () => {
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
    });

    test('server close early', async () => {
      serverConn.close(false, 304, Buffer.from('Custom TLS failed'));
      [serverSendLength, _serverSendInfo] = serverConn.send(serverBuffer);

      expect(serverConn.localError()).toEqual({
        isApp: false,
        // This code is unknown!
        errorCode: 304,
        reason: expect.any(Uint8Array),
      });
      expect(serverConn.peerError()).toBeNull();

      expect(serverConn.timeout()).not.toBeNull();
      expect(serverConn.isTimedOut()).toBeFalse();
      expect(serverConn.isInEarlyData()).toBeFalse();
      expect(serverConn.isEstablished()).toBeTrue();
      expect(serverConn.isResumed()).toBeFalse();
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.isClosed()).toBeFalse();
      // Should now be draining
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
        reason: expect.any(Uint8Array),
      });

      expect(clientConn.timeout()).not.toBeNull();
      expect(clientConn.isTimedOut()).toBeFalse();
      expect(clientConn.isInEarlyData()).toBeFalse();
      expect(clientConn.isEstablished()).toBeTrue();
      expect(clientConn.isResumed()).toBeFalse();
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.isClosed()).toBeFalse();
      // Should now be draining
      expect(clientConn.isDraining()).toBeTrue();
    });
    test('client ends after timeout', async () => {
      expect(() => clientConn.send(clientBuffer)).toThrow('Done');
      await testsUtils.waitForTimeoutNull(clientConn);
      await sleep((clientConn.timeout() ?? 0) + 1);
      clientConn.onTimeout();
      expect(clientConn.isClosed()).toBeTrue();
    });
    test('server ends after timeout', async () => {
      expect(() => serverConn.send(clientBuffer)).toThrow('Done');
      await testsUtils.waitForTimeoutNull(serverConn);
      expect(serverConn.isClosed()).toBeTrue();
    });
  });
  describe('ECDSA custom fail verifying server', () => {
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
    });

    test('client close early', async () => {
      clientConn.close(false, 304, Buffer.from('Custom TLS failed'));
      [clientSendLength, _clientSendInfo] = clientConn.send(clientBuffer);

      expect(clientConn.localError()).toEqual({
        isApp: false,
        // This code is unknown!
        errorCode: 304,
        reason: expect.any(Uint8Array),
      });
      expect(clientConn.peerError()).toBeNull();

      expect(clientConn.timeout()).not.toBeNull();
      expect(clientConn.isTimedOut()).toBeFalse();
      expect(clientConn.isInEarlyData()).toBeFalse();
      expect(clientConn.isEstablished()).toBeTrue();
      expect(clientConn.isResumed()).toBeFalse();
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.isClosed()).toBeFalse();
      // Should now be draining
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
        reason: expect.any(Uint8Array),
      });

      expect(serverConn.timeout()).not.toBeNull();
      expect(serverConn.isTimedOut()).toBeFalse();
      expect(serverConn.isInEarlyData()).toBeFalse();
      expect(serverConn.isEstablished()).toBeTrue();
      expect(serverConn.isResumed()).toBeFalse();
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.isClosed()).toBeFalse();
      // Should now be draining
      expect(serverConn.isDraining()).toBeTrue();
    });
    test('client ends after timeout', async () => {
      expect(() => clientConn.send(clientBuffer)).toThrow('Done');
      await testsUtils.waitForTimeoutNull(clientConn);
      await sleep((clientConn.timeout() ?? 0) + 1);
      clientConn.onTimeout();
      expect(clientConn.isClosed()).toBeTrue();
    });
    test('server ends after timeout', async () => {
      expect(() => serverConn.send(clientBuffer)).toThrow('Done');
      await testsUtils.waitForTimeoutNull(serverConn);
      expect(serverConn.isClosed()).toBeTrue();
    });
  });
  describe('Ed25519 success', () => {
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
        key: keyPairEd25519PEM.privateKey,
        cert: certEd25519PEM,
        ca: certEd25519PEM,
        maxIdleTimeout: 0,
      };
      const serverConfig: QUICConfig = {
        ...serverDefault,
        verifyPeer: true,
        key: keyPairEd25519PEM.privateKey,
        cert: certEd25519PEM,
        ca: certEd25519PEM,
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
  describe('Ed25519 fail verifying client', () => {
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
        key: keyPairEd25519PEM.privateKey,
        cert: certEd25519PEM,
        ca: certEd25519PEM,
        maxIdleTimeout: 0,
      };
      const serverConfig: QUICConfig = {
        ...serverDefault,
        verifyPeer: true,
        key: keyPairEd25519PEM.privateKey,
        cert: certEd25519PEM,
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
  describe('Ed25519 fail verifying server', () => {
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
        key: keyPairEd25519PEM.privateKey,
        cert: certEd25519PEM,
        maxIdleTimeout: 0,
      };
      const serverConfig: QUICConfig = {
        ...serverDefault,
        verifyPeer: true,
        key: keyPairEd25519PEM.privateKey,
        cert: certEd25519PEM,
        ca: certEd25519PEM,
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
  describe('Ed25519 custom fail verifying client', () => {
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
        key: keyPairEd25519PEM.privateKey,
        cert: certEd25519PEM,
        ca: certEd25519PEM,
        maxIdleTimeout: 0,
      };
      const serverConfig: QUICConfig = {
        ...serverDefault,
        verifyPeer: true,
        key: keyPairEd25519PEM.privateKey,
        cert: certEd25519PEM,
        ca: certEd25519PEM,
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
      ).not.toThrow('TlsFail');

      expect(clientConn.localError()).toBeNull();
      expect(clientConn.peerError()).toBeNull();

      expect(clientConn.isTimedOut()).toBeFalse();
      expect(clientConn.isInEarlyData()).toBeFalse();
      expect(clientConn.isEstablished()).toBeTrue();
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
      expect(clientConn.isEstablished()).toBeTrue();
      expect(clientConn.isResumed()).toBeFalse();
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.isClosed()).toBeFalse();
      expect(clientConn.isDraining()).toBeFalse();

      serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
        to: serverHost,
        from: clientHost,
      });

      expect(serverConn.localError()).toBeNull();
      expect(serverConn.peerError()).toBeNull();

      expect(serverConn.timeout()).toBeNull();
      expect(serverConn.isTimedOut()).toBeFalse();
      expect(serverConn.isInEarlyData()).toBeFalse();
      expect(serverConn.isEstablished()).toBeTrue();
      expect(serverConn.isResumed()).toBeFalse();
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.isClosed()).toBeFalse();
      expect(serverConn.isDraining()).toBeFalse();
    });
    test('server close early', async () => {
      serverConn.close(false, 304, Buffer.from('Custom TLS failed'));
      [serverSendLength, _serverSendInfo] = serverConn.send(serverBuffer);

      expect(serverConn.localError()).toEqual({
        isApp: false,
        // This code is unknown!
        errorCode: 304,
        reason: expect.any(Uint8Array),
      });
      expect(serverConn.peerError()).toBeNull();

      expect(serverConn.timeout()).not.toBeNull();
      expect(serverConn.isTimedOut()).toBeFalse();
      expect(serverConn.isInEarlyData()).toBeFalse();
      expect(serverConn.isEstablished()).toBeTrue();
      expect(serverConn.isResumed()).toBeFalse();
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.isClosed()).toBeFalse();
      // Should now be draining
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
        reason: expect.any(Uint8Array),
      });

      expect(clientConn.timeout()).not.toBeNull();
      expect(clientConn.isTimedOut()).toBeFalse();
      expect(clientConn.isInEarlyData()).toBeFalse();
      expect(clientConn.isEstablished()).toBeTrue();
      expect(clientConn.isResumed()).toBeFalse();
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.isClosed()).toBeFalse();
      // Should now be draining
      expect(clientConn.isDraining()).toBeTrue();
    });
    test('client ends after timeout', async () => {
      expect(() => clientConn.send(clientBuffer)).toThrow('Done');
      await testsUtils.waitForTimeoutNull(clientConn);
      await sleep((clientConn.timeout() ?? 0) + 1);
      clientConn.onTimeout();
      expect(clientConn.isClosed()).toBeTrue();
    });
    test('server ends after timeout', async () => {
      expect(() => serverConn.send(clientBuffer)).toThrow('Done');
      await testsUtils.waitForTimeoutNull(serverConn);
      expect(serverConn.isClosed()).toBeTrue();
    });
  });
  describe('Ed25519 custom fail verifying server', () => {
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
        key: keyPairEd25519PEM.privateKey,
        cert: certEd25519PEM,
        ca: certEd25519PEM,
        maxIdleTimeout: 0,
      };
      const serverConfig: QUICConfig = {
        ...serverDefault,
        verifyPeer: true,
        key: keyPairEd25519PEM.privateKey,
        cert: certEd25519PEM,
        ca: certEd25519PEM,
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
      ).not.toThrow('TlsFail');

      expect(clientConn.localError()).toBeNull();
      expect(clientConn.peerError()).toBeNull();

      expect(clientConn.isTimedOut()).toBeFalse();
      expect(clientConn.isInEarlyData()).toBeFalse();
      expect(clientConn.isEstablished()).toBeTrue();
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
      expect(clientConn.isEstablished()).toBeTrue();
      expect(clientConn.isResumed()).toBeFalse();
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.isClosed()).toBeFalse();
      expect(clientConn.isDraining()).toBeFalse();

      serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
        to: serverHost,
        from: clientHost,
      });

      expect(serverConn.localError()).toBeNull();
      expect(serverConn.peerError()).toBeNull();

      expect(serverConn.timeout()).toBeNull();
      expect(serverConn.isTimedOut()).toBeFalse();
      expect(serverConn.isInEarlyData()).toBeFalse();
      expect(serverConn.isEstablished()).toBeTrue();
      expect(serverConn.isResumed()).toBeFalse();
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.isClosed()).toBeFalse();
      expect(serverConn.isDraining()).toBeFalse();
    });
    test('client close early', async () => {
      clientConn.close(false, 304, Buffer.from('Custom TLS failed'));
      [clientSendLength, _clientSendInfo] = clientConn.send(clientBuffer);

      expect(clientConn.localError()).toEqual({
        isApp: false,
        // This code is unknown!
        errorCode: 304,
        reason: expect.any(Uint8Array),
      });
      expect(clientConn.peerError()).toBeNull();

      expect(clientConn.timeout()).not.toBeNull();
      expect(clientConn.isTimedOut()).toBeFalse();
      expect(clientConn.isInEarlyData()).toBeFalse();
      expect(clientConn.isEstablished()).toBeTrue();
      expect(clientConn.isResumed()).toBeFalse();
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.isClosed()).toBeFalse();
      // Should now be draining
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
        reason: expect.any(Uint8Array),
      });

      expect(serverConn.timeout()).not.toBeNull();
      expect(serverConn.isTimedOut()).toBeFalse();
      expect(serverConn.isInEarlyData()).toBeFalse();
      expect(serverConn.isEstablished()).toBeTrue();
      expect(serverConn.isResumed()).toBeFalse();
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.isClosed()).toBeFalse();
      // Should now be draining
      expect(serverConn.isDraining()).toBeTrue();
    });
    test('client ends after timeout', async () => {
      expect(() => clientConn.send(clientBuffer)).toThrow('Done');
      await testsUtils.waitForTimeoutNull(clientConn);
      await sleep((clientConn.timeout() ?? 0) + 1);
      clientConn.onTimeout();
      expect(clientConn.isClosed()).toBeTrue();
    });
    test('server ends after timeout', async () => {
      expect(() => serverConn.send(clientBuffer)).toThrow('Done');
      await testsUtils.waitForTimeoutNull(serverConn);
      expect(serverConn.isClosed()).toBeTrue();
    });
  });
});
