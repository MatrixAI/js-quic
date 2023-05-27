import type { QUICConfig, Crypto, Host, Hostname, Port } from '@/types';
import type { Connection, SendInfo } from '@/native/types';
import quiche from '@/native/quiche';
import { clientDefault, serverDefault, buildQuicheConfig } from '@/config';
import * as testsUtils from '../utils';

describe('quiche', () => {
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();
  let crypto: {
    key: ArrayBuffer;
    ops: Crypto;
  };
  beforeAll(async () => {
    crypto = {
      key: await testsUtils.generateKeyHMAC(),
      ops: {
        sign: testsUtils.signHMAC,
        verify: testsUtils.verifyHMAC,
        randomBytes: testsUtils.randomBytes,
      },
    };
  });
  test('frame parsing', async () => {
    let frame: Buffer;
    frame = Buffer.allocUnsafe(0);
    expect(() => quiche.Header.fromSlice(
      frame,
      quiche.MAX_CONN_ID_LEN)
    ).toThrow(
      'BufferTooShort'
    );
    frame = Buffer.allocUnsafe(100);
    expect(() => quiche.Header.fromSlice(
      frame,
      quiche.MAX_CONN_ID_LEN)
    ).toThrow(
      'BufferTooShort'
    );
    // `InvalidPacket` is also possible but even random bytes can
    // look like a packet, so it's not tested here
  });
  describe('client connection lifecycle', () => {
    // These tests run in-order, and each step is a state transition
    const clientConfig: QUICConfig = {
      ...clientDefault,
    };
    const clientQuicheConfig = buildQuicheConfig(clientConfig);
    const localHost = {
      host: '127.0.0.1' as Host,
      port: 55555 as Port,
    };
    const remoteHost = {
      host: '127.0.0.1' as Host,
      port: 55556,
    };
    // These buffers will be used between the tests and will be mutated
    const sendBuffer = new Uint8Array(quiche.MAX_DATAGRAM_SIZE);
    const sendBuffer_ = new Uint8Array(quiche.MAX_DATAGRAM_SIZE);
    const recvBuffer = new Uint8Array(quiche.MAX_DATAGRAM_SIZE);
    const recvBuffer_ = new Uint8Array(quiche.MAX_DATAGRAM_SIZE);
    let scid: Uint8Array;
    let clientConn: Connection;
    beforeAll(async () => {
      const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
      await crypto.ops.randomBytes(scidBuffer);
      scid = new Uint8Array(scidBuffer);
    });
    test('connect', async () => {
      clientConn = quiche.Connection.connect(
        null,
        scid,
        localHost,
        remoteHost,
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
      let sendLength: number, sendInfo: SendInfo;
      // Send the initial packet
      [sendLength, sendInfo] = clientConn.send(sendBuffer);
      // The initial frame will always be 1200 bytes
      expect(sendLength).toBe(1200);
      expect(sendInfo.from).toEqual(localHost);
      expect(sendInfo.to).toEqual(remoteHost);
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
      expect(() => clientConn.send(sendBuffer)).toThrow('Done');
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
      [sendLength, sendInfo] = clientConn.send(sendBuffer_);
      expect(sendLength).toBe(1200);
      expect(sendInfo.from).toEqual(localHost);
      expect(sendInfo.to).toEqual(remoteHost);
      // Retried initial frame is not an exact copy
      expect(sendBuffer_).not.toEqual(sendBuffer);
      // Upon the retry, the delay now doubles
      // Round to the nearest 1000
      expect(clientConn.timeout()).toBeCloseTo(2000, -3);
      // This dialing process will repeat max idle timeout is exhausted
      // Copy sendBuffer_ into sendBuffer
      sendBuffer.set(sendBuffer_);
    });
    test('processing initial frame', async () => {
      // Process the initial frame
      const header = quiche.Header.fromSlice(
        sendBuffer,
        quiche.MAX_CONN_ID_LEN
      );
      // It will be an initial packet
      expect(header.ty).toBe(quiche.Type.Initial);
      // The SCID is what was generated above
      expect(header.scid).toEqual(scid);
      // The DCID is randomly generated
      expect(header.dcid).toBeInstanceOf(Uint8Array);
      // The token will be empty
      expect(header.token).toHaveLength(0);
      // The initial version will be 1 initially
      expect(header.version).toBe(1);
      expect(header.versions).toBeNull();
    });
    // Next step is to move the connection to being established
    test('', async () => {

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
  // test('client connection connect and close', async () => {
  //   const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
  //   await crypto.ops.randomBytes(scidBuffer);
  //   const scid = new Uint8Array(scidBuffer);
  //   const clientConfig: QUICConfig = {
  //     ...clientDefault,
  //   };
  //   const clientQuicheConfig = buildQuicheConfig(clientConfig);
  //   const clientConn = quiche.Connection.connect(
  //     null,
  //     scid,
  //     {
  //       host: '127.0.0.1' as Host,
  //       port: 55555 as Port,
  //     },
  //     {
  //       host: '127.0.0.1' as Host,
  //       port: 55556,
  //     },
  //     clientQuicheConfig,
  //   );
  //   expect(clientConn.timeout()).toBeNull();
  //   expect(clientConn.isTimedOut()).toBeFalse();
  //   expect(clientConn.isInEarlyData()).toBeFalse();
  //   expect(clientConn.isEstablished()).toBeFalse();
  //   expect(clientConn.isResumed()).toBeFalse();
  //   expect(clientConn.isReadable()).toBeFalse();
  //   expect(clientConn.isClosed()).toBeFalse();
  //   expect(clientConn.isDraining()).toBeFalse();


  //   const textDecoder = new TextDecoder();
  //   const textEncoder = new TextEncoder();
  //   const sendBuffer = new Uint8Array(quiche.MAX_DATAGRAM_SIZE);
  //   const [sendLength, sendInfo] = clientConn.send(sendBuffer);

  //   // This is the initial delay for the dialing procedure
  //   // Quiche will repeatedly send the initial packet until it is received
  //   // or exhausted the idle timeout, which in this case is 0 (disabled)
  //   expect(typeof clientConn.timeout()).toBe('number');
  //   expect(clientConn.isTimedOut()).toBeFalse();
  //   expect(clientConn.isInEarlyData()).toBeFalse();
  //   expect(clientConn.isEstablished()).toBeFalse();
  //   expect(clientConn.isResumed()).toBeFalse();
  //   expect(clientConn.isReadable()).toBeFalse();
  //   expect(clientConn.isClosed()).toBeFalse();
  //   expect(clientConn.isDraining()).toBeFalse();


  //   // This proves that only 1 send is necessary at the beginning
  //   // Repeated send will throw `Done`
  //   const sendBuffer2 = new Uint8Array(quiche.MAX_DATAGRAM_SIZE);
  //   expect(() => clientConn.send(sendBuffer2)).toThrow('Done');


  //   // We can  do something here!
  //   const header = quiche.Header.fromSlice(sendBuffer, quiche.MAX_CONN_ID_LEN);

  //   console.log(header);
  //   console.log(header.dcid);
  //   console.log(header.scid);


  //   // console.log(sendLength, sendInfo, textDecoder.decode(sendBuffer.slice(0, sendLength)));


  //   clientConn.close(true, 0, Buffer.from(''));
  //   expect(clientConn.timeout()).toBeNull();
  //   expect(clientConn.isTimedOut()).toBeFalse();
  //   expect(clientConn.isInEarlyData()).toBeFalse();
  //   expect(clientConn.isEstablished()).toBeFalse();
  //   expect(clientConn.isResumed()).toBeFalse();
  //   expect(clientConn.isReadable()).toBeFalse();
  //   // Client connection is closed (this is not true if there is draining)
  //   expect(clientConn.isClosed()).toBeTrue();
  //   expect(clientConn.isDraining()).toBeFalse();
  // });
  // test('server connection accept and close', async () => {
  //   const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
  //   await crypto.ops.randomBytes(scidBuffer);
  //   const scid = new Uint8Array(scidBuffer);
  //   const dcidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
  //   await crypto.ops.randomBytes(dcidBuffer);
  //   const dcid = new Uint8Array(dcidBuffer);
  //   const serverConfig: QUICConfig = {
  //     ...serverDefault,
  //   };
  //   const serverQuicheConfig = buildQuicheConfig(serverConfig);
  //   const serverConn = quiche.Connection.accept(
  //     dcid,
  //     scid,
  //     {
  //       host: '127.0.0.1' as Host,
  //       port: 55555 as Port,
  //     },
  //     {
  //       host: '127.0.0.1' as Host,
  //       port: 55556,
  //     },
  //     serverQuicheConfig,
  //   );
  //   expect(serverConn.timeout()).toBeNull();
  //   expect(serverConn.isTimedOut()).toBeFalse();
  //   expect(serverConn.isInEarlyData()).toBeFalse();
  //   expect(serverConn.isEstablished()).toBeFalse();
  //   expect(serverConn.isResumed()).toBeFalse();
  //   expect(serverConn.isReadable()).toBeFalse();
  //   expect(serverConn.isClosed()).toBeFalse();
  //   expect(serverConn.isDraining()).toBeFalse();
  //   serverConn.close(true, 0, Buffer.from(''));
  //   expect(serverConn.timeout()).toBeNull();
  //   expect(serverConn.isTimedOut()).toBeFalse();
  //   expect(serverConn.isInEarlyData()).toBeFalse();
  //   expect(serverConn.isEstablished()).toBeFalse();
  //   expect(serverConn.isResumed()).toBeFalse();
  //   expect(serverConn.isReadable()).toBeFalse();
  //   // Server connection is closed (this is not true if there is draining)
  //   expect(serverConn.isClosed()).toBeTrue();
  //   expect(serverConn.isDraining()).toBeFalse();
  // });
});
