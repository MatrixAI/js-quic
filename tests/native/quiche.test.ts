import type { QUICConfig, Crypto, Host, Hostname, Port } from '@/types';
import quiche from '@/native/quiche';
import { clientDefault, serverDefault, buildQuicheConfig } from '@/config';
import * as testsUtils from '../utils';

describe('quiche', () => {
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
  test('client connection connect and close', async () => {
    const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
    await crypto.ops.randomBytes(scidBuffer);
    const scid = new Uint8Array(scidBuffer);
    const clientConfig: QUICConfig = {
      ...clientDefault,
    };
    const clientQuicheConfig = buildQuicheConfig(clientConfig);
    const clientConn = quiche.Connection.connect(
      null,
      scid,
      {
        host: '127.0.0.1' as Host,
        port: 55555 as Port,
      },
      {
        host: '127.0.0.1' as Host,
        port: 55556,
      },
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


    const textDecoder = new TextDecoder();
    const textEncoder = new TextEncoder();
    const sendBuffer = new Uint8Array(quiche.MAX_DATAGRAM_SIZE);
    const [sendLength, sendInfo] = clientConn.send(sendBuffer);

    // This is the initial delay for the dialing procedure
    // Quiche will repeatedly send the initial packet until it is received
    // or exhausted the idle timeout, which in this case is 0 (disabled)
    expect(typeof clientConn.timeout()).toBe('number');
    expect(clientConn.isTimedOut()).toBeFalse();
    expect(clientConn.isInEarlyData()).toBeFalse();
    expect(clientConn.isEstablished()).toBeFalse();
    expect(clientConn.isResumed()).toBeFalse();
    expect(clientConn.isReadable()).toBeFalse();
    expect(clientConn.isClosed()).toBeFalse();
    expect(clientConn.isDraining()).toBeFalse();


    // This proves that only 1 send is necessary at the beginning
    // Repeated send will throw `Done`
    const sendBuffer2 = new Uint8Array(quiche.MAX_DATAGRAM_SIZE);
    expect(() => clientConn.send(sendBuffer2)).toThrow('Done');


    // We can  do something here!
    const header = quiche.Header.fromSlice(sendBuffer, quiche.MAX_CONN_ID_LEN);

    console.log(header);
    console.log(header.dcid);
    console.log(header.scid);


    // console.log(sendLength, sendInfo, textDecoder.decode(sendBuffer.slice(0, sendLength)));


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
  test('server connection accept and close', async () => {
    const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
    await crypto.ops.randomBytes(scidBuffer);
    const scid = new Uint8Array(scidBuffer);
    const dcidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
    await crypto.ops.randomBytes(dcidBuffer);
    const dcid = new Uint8Array(dcidBuffer);
    const serverConfig: QUICConfig = {
      ...serverDefault,
    };
    const serverQuicheConfig = buildQuicheConfig(serverConfig);
    const serverConn = quiche.Connection.accept(
      dcid,
      scid,
      {
        host: '127.0.0.1' as Host,
        port: 55555 as Port,
      },
      {
        host: '127.0.0.1' as Host,
        port: 55556,
      },
      serverQuicheConfig,
    );
    expect(serverConn.timeout()).toBeNull();
    expect(serverConn.isTimedOut()).toBeFalse();
    expect(serverConn.isInEarlyData()).toBeFalse();
    expect(serverConn.isEstablished()).toBeFalse();
    expect(serverConn.isResumed()).toBeFalse();
    expect(serverConn.isReadable()).toBeFalse();
    expect(serverConn.isClosed()).toBeFalse();
    expect(serverConn.isDraining()).toBeFalse();
    serverConn.close(true, 0, Buffer.from(''));
    expect(serverConn.timeout()).toBeNull();
    expect(serverConn.isTimedOut()).toBeFalse();
    expect(serverConn.isInEarlyData()).toBeFalse();
    expect(serverConn.isEstablished()).toBeFalse();
    expect(serverConn.isResumed()).toBeFalse();
    expect(serverConn.isReadable()).toBeFalse();
    // Server connection is closed (this is not true if there is draining)
    expect(serverConn.isClosed()).toBeTrue();
    expect(serverConn.isDraining()).toBeFalse();
  });
});
