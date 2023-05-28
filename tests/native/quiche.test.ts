import type { X509Certificate } from '@peculiar/x509';
import type { QUICConfig, Crypto, Host, Hostname, Port } from '@/types';
import type { Config, Connection, SendInfo } from '@/native/types';
import quiche from '@/native/quiche';
import { clientDefault, serverDefault, buildQuicheConfig } from '@/config';
import QUICConnectionId from '@/QUICConnectionId';
import * as utils from '@/utils';
import * as testsUtils from '../utils';

describe('quiche', () => {
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
  test('frame parsing', async () => {
    let frame: Buffer;
    frame = Buffer.from('hello world');
    expect(() => quiche.Header.fromSlice(
      frame,
      quiche.MAX_CONN_ID_LEN)
    ).toThrow(
      'BufferTooShort'
    );
    // `InvalidPacket` is also possible but even random bytes can
    // look like a packet, so it's not tested here
  });
  describe('connection lifecycle', () => {
    describe('connect and close client connection', () => {
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
      test('connect', async () => {
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
      test('close', async () => {
        clientConn.close(true, 0, Buffer.from(''));
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
    });
    describe('establish connection between client and server', () => {
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
      test('connect', async () => {
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
      test('dialing', async () => {
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
      test('negotiation', async () => {
        // Process the initial frame
        const clientHeaderInitial = quiche.Header.fromSlice(
          clientBuffer,
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
      });
      test('established', async () => {
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
        // Now we proceed to send
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

        // Upon receiving, it needs to handle and immediately send the next packet
        // It cannot be waiting in the middle...
        // So basically when we do `await recv`, it must "lock" that sequence
        // and immeidatley also call `await send`
        // Because our code acts a bit concurrently
        // If in the process of receiving, we end up receiving again
        // That could be a problem!...
        // However we shouldn't really be locking
        // We should lock on a per-connection basis
        // Between `await conn.recv` and `await conn.send`
        // There needs to be a per-connection lock here
        // Client receives server's header initial

        clientConn.recv(
          serverBuffer.subarray(0, serverSendLength),
          {
            to: clientHost,
            from: serverHost
          }
        );
        [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
        const clientHeaderInitial = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(clientHeaderInitial.ty).toBe(quiche.Type.Initial);


        // The timeout changes now..., it's much faster
        console.log(clientConn.timeout());

        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        expect(clientConn.isEstablished()).toBeFalse();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();



        // Immediately followed by a handshake frame
        // This is why you need a while loop to exhaust the frames
        [serverSendLength, serverSendInfo] = serverConn.send(serverBuffer);
        const serverHeaderHandshake = quiche.Header.fromSlice(
          serverBuffer.subarray(0, serverSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(serverHeaderHandshake.ty).toBe(quiche.Type.Handshake);
        expect(new QUICConnectionId(serverHeaderHandshake.scid)).toEqual(serverScid);
        expect(new QUICConnectionId(serverHeaderHandshake.dcid)).toEqual(serverDcid);
        expect(serverConn.timeout()).toBeCloseTo(1000, -3);
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

        // Also now it should be a small timeout
        console.log(clientConn.timeout());

        expect(clientConn.isTimedOut()).toBeFalse();
        expect(clientConn.isInEarlyData()).toBeFalse();
        // Client connection is now established!
        expect(clientConn.isEstablished()).toBeTrue();
        expect(clientConn.isResumed()).toBeFalse();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.isClosed()).toBeFalse();
        expect(clientConn.isDraining()).toBeFalse();


        [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
        const clientHeaderHandshake = quiche.Header.fromSlice(
          clientBuffer.subarray(0, clientSendLength),
          quiche.MAX_CONN_ID_LEN
        );
        expect(clientHeaderHandshake.ty).toBe(quiche.Type.Handshake);
        expect(() => clientConn.send(clientBuffer)).toThrow('Done');




        // expect(serverConn.isTimedOut()).toBeFalse();
        // expect(serverConn.isInEarlyData()).toBeFalse();
        // expect(serverConn.isEstablished()).toBeFalse();
        // expect(serverConn.isResumed()).toBeFalse();
        // expect(serverConn.isReadable()).toBeFalse();
        // expect(serverConn.isClosed()).toBeFalse();
        // expect(serverConn.isDraining()).toBeFalse();

        // // Wait out the delay (add 50ms for non-determinism)
        // await testsUtils.sleep(clientConn.timeout()! + 50);

      });
      // // Next step is to move the connection to being established
      // test('', async () => {
      // });
      test('close', async () => {
        clientConn.close(true, 0, Buffer.from(''));
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
    });

  });
});
