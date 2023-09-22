import type { Connection, StreamIter } from '@/native';
import type { ClientCryptoOps, Host, Port, ServerCryptoOps } from '@';
import { quiche, Shutdown } from '@/native';
import QUICConnectionId from '@/QUICConnectionId';
import { buildQuicheConfig, clientDefault, serverDefault } from '@/config';
import * as utils from '@/utils';
import { sleep } from '@/utils';
import * as testsUtils from '../utils';

describe('native/stream', () => {
  const localHost = '127.0.0.1' as Host;
  const clientHost = {
    host: localHost,
    port: 55555 as Port,
  };
  const serverHost = {
    host: localHost,
    port: 55556,
  };

  let crypto: {
    key: ArrayBuffer;
    ops: ClientCryptoOps & ServerCryptoOps;
  };

  let clientConn: Connection;
  let serverConn: Connection;

  function sendPacket(
    connectionSource: Connection,
    connectionDestination: Connection,
  ): null | void {
    const dataBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
    const result = connectionSource.send(dataBuffer);
    if (result === null) return null;
    const [serverSendLength, sendInfo] = result;
    connectionDestination.recv(dataBuffer.subarray(0, serverSendLength), {
      to: sendInfo.to,
      from: sendInfo.from,
    });
  }

  function iterToArray(iter: StreamIter) {
    const array: Array<number> = [];
    for (const iterElement of iter) {
      array.push(iterElement);
    }
    return array;
  }

  /**
   * Does all the steps for initiating a stream on both sides.
   * Used as a starting point for a bunch of tests.
   */
  function setupStreamState(
    connectionSource: Connection,
    connectionDestination: Connection,
    streamId: number,
  ) {
    const message = Buffer.from('Message');
    connectionSource.streamSend(streamId, message, false);
    sendPacket(connectionSource, connectionDestination);
    sendPacket(connectionDestination, connectionSource);
    // Clearing message buffer
    const buffer = Buffer.allocUnsafe(1024);
    connectionDestination.streamRecv(streamId, buffer);
  }

  const setupConnectionsRSA = async () => {
    const clientConfig = buildQuicheConfig({
      ...clientDefault,
      verifyPeer: false,
    });
    const tlsConfigServer = await testsUtils.generateConfig('RSA');
    const serverConfig = buildQuicheConfig({
      ...serverDefault,

      key: tlsConfigServer.key,
      cert: tlsConfigServer.cert,
    });

    // Randomly generate the client SCID
    const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
    await crypto.ops.randomBytes(scidBuffer);
    const clientScid = new QUICConnectionId(scidBuffer);
    clientConn = quiche.Connection.connect(
      null,
      clientScid,
      clientHost,
      serverHost,
      clientConfig,
    );

    const clientBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
    let result = clientConn.send(clientBuffer);
    expect(result).not.toBeNull();
    let [clientSendLength] = result!;
    const clientHeaderInitial = quiche.Header.fromSlice(
      clientBuffer.subarray(0, clientSendLength),
      quiche.MAX_CONN_ID_LEN,
    );
    const clientDcid = new QUICConnectionId(clientHeaderInitial.dcid);

    // Derives a new SCID by signing the client's generated DCID
    // This is only used during the stateless retry
    const serverScid = new QUICConnectionId(
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
    result = clientConn.send(clientBuffer);
    expect(result).not.toBeNull();
    [clientSendLength] = result!;

    // Server accept
    serverConn = quiche.Connection.accept(
      serverScid,
      clientDcid,
      serverHost,
      clientHost,
      serverConfig,
    );
    // Server receives the retried initial frame
    serverConn.recv(clientBuffer.subarray(0, clientSendLength), {
      to: serverHost,
      from: clientHost,
    });

    // Client <-initial- server
    sendPacket(serverConn, clientConn);
    // Client -initial-> server
    sendPacket(clientConn, serverConn);
    // Client <-handshake- server
    sendPacket(serverConn, clientConn);
    // Client -handshake-> server
    sendPacket(clientConn, serverConn);
    // Client <-short- server
    sendPacket(serverConn, clientConn);
    // Client -short-> server
    sendPacket(clientConn, serverConn);
    // Both are established
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

  describe('stream can be created', () => {
    const streamBuf = Buffer.allocUnsafe(1024);

    beforeAll(setupConnectionsRSA);

    test('initializing stream with 0-len message', () => {
      clientConn.streamSend(0, new Uint8Array(0), false);
      // No data is sent
      expect(sendPacket(clientConn, serverConn)).toBeNull();
      expect(iterToArray(clientConn.readable())).not.toContain(0);
      expect(iterToArray(clientConn.writable())).toContain(0);

      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(clientConn.streamWritable(0, 0)).toBeTrue();

      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
    test('Server state does not exist yet', () => {
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      expect(iterToArray(serverConn.writable())).not.toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(() => serverConn.streamCapacity(0)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(() => serverConn.streamWritable(0, 0)).toThrow(
        'InvalidStreamState(0)',
      );
    });
    test('first stream message creates server state', async () => {
      const message = Buffer.from('Message');
      expect(clientConn.streamSend(0, message, false)).toEqual(
        message.byteLength,
      );

      // Packet should be sent
      sendPacket(clientConn, serverConn);

      // Server state for stream is created
      expect(iterToArray(serverConn.readable())).toContain(0);
      expect(iterToArray(serverConn.writable())).toContain(0);
      expect(serverConn.isReadable()).toBeTrue();
      expect(serverConn.streamFinished(0)).toBeFalse();
      expect(serverConn.streamReadable(0)).toBeTrue();
      expect(serverConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(serverConn.streamWritable(0, 0)).toBeTrue();

      // Reading the message

      const result = serverConn.streamRecv(0, streamBuf);
      expect(result).not.toBeNull();
      const [bytes, fin] = result!;
      expect(bytes).toEqual(message.byteLength);
      expect(fin).toBe(false);
      expect(streamBuf.subarray(0, bytes).toString()).toEqual(
        message.toString(),
      );

      // State is updated after reading
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      expect(iterToArray(serverConn.writable())).toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeFalse();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(serverConn.streamWritable(0, 0)).toBeTrue();

      // Ack is returned
      sendPacket(serverConn, clientConn);

      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
    test('reverse data can be sent', () => {
      // Server state before sending
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      expect(iterToArray(serverConn.writable())).toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeFalse();
      expect(serverConn.streamReadable(0)).toBeFalse();
      const serverStreamCapacity = serverConn.streamCapacity(0);
      expect(serverStreamCapacity).toBeGreaterThan(0);
      expect(serverConn.streamWritable(0, 0)).toBeTrue();

      // Client state before sending
      expect(iterToArray(clientConn.readable())).not.toContain(0);
      expect(iterToArray(clientConn.writable())).toContain(0);
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(clientConn.streamWritable(0, 0)).toBeTrue();

      // Sending data
      const message = Buffer.from('Message 2');
      serverConn.streamSend(0, message, false);

      // Server state is updated
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      expect(iterToArray(serverConn.writable())).toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeFalse();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamCapacity(0)).toBeLessThan(serverStreamCapacity);
      expect(serverConn.streamWritable(0, 0)).toBeTrue();

      // Packet is sent
      sendPacket(serverConn, clientConn);

      // Client state after sending
      expect(iterToArray(clientConn.readable())).toContain(0);
      expect(iterToArray(clientConn.writable())).toContain(0);
      expect(clientConn.isReadable()).toBeTrue();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeTrue();
      expect(clientConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(clientConn.streamWritable(0, 0)).toBeTrue();

      // Read message
      const result = clientConn.streamRecv(0, streamBuf);
      expect(result).not.toBeNull();
      const [bytes, fin] = result!;
      expect(bytes).toEqual(message.byteLength);
      expect(fin).toBe(false);
      expect(streamBuf.subarray(0, bytes).toString()).toEqual(
        message.toString(),
      );

      expect(iterToArray(clientConn.readable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();

      // Ack returned
      sendPacket(clientConn, serverConn);

      // Server state is updated
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      expect(iterToArray(serverConn.writable())).toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeFalse();
      expect(serverConn.streamReadable(0)).toBeFalse();
      // Capacity has increased again
      expect(serverConn.streamCapacity(0)).toEqual(serverStreamCapacity);
      expect(serverConn.streamWritable(0, 0)).toBeTrue();

      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
  });
  describe('stream finishes with 0-len fin', () => {
    const streamBuf = Buffer.allocUnsafe(1024);

    beforeAll(async () => {
      await setupConnectionsRSA();
      setupStreamState(clientConn, serverConn, 0);
    });

    test('closing forward stream with 0-len fin frame', async () => {
      clientConn.streamSend(0, new Uint8Array(0), true);
      expect(iterToArray(clientConn.readable())).not.toContain(0);
      // Not in the writable iterator
      expect(iterToArray(clientConn.writable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      // But still technically writable
      expect(clientConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(clientConn.streamWritable(0, 0)).toBeTrue();

      sendPacket(clientConn, serverConn);

      // Client state, no changes
      expect(iterToArray(clientConn.readable())).not.toContain(0);
      expect(iterToArray(clientConn.writable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(clientConn.streamWritable(0, 0)).toBeTrue();

      // Further writes throws `FinalSize`
      expect(() =>
        clientConn.streamSend(0, Buffer.from('message'), false),
      ).toThrow('FinalSize');

      // Server state
      expect(iterToArray(serverConn.readable())).toContain(0);
      expect(iterToArray(serverConn.writable())).toContain(0);
      expect(serverConn.isReadable()).toBeTrue();
      // Stream is immediately finished due to no buffered data
      expect(serverConn.streamFinished(0)).toBeTrue();
      // Still readable due to 0-len message and fin flag
      expect(serverConn.streamReadable(0)).toBeTrue();
      expect(serverConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(serverConn.streamWritable(0, 0)).toBeTrue();

      // Reading message

      const result = serverConn.streamRecv(0, streamBuf);
      expect(result).not.toBeNull();
      const [bytes, fin] = result!;

      // Message is empty but exists due to fin flag
      expect(bytes).toEqual(0);
      expect(fin).toBe(true);

      expect(serverConn.streamFinished(0)).toBeTrue();
      // Nothing left to read
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamReadable(0)).toBeFalse();
      // Further reads throw `Done`
      expect(serverConn.streamRecv(0, streamBuf)).toBeNull();

      // Server sends ack back
      sendPacket(serverConn, clientConn);

      // Client state
      expect(iterToArray(clientConn.readable())).not.toContain(0);
      expect(iterToArray(clientConn.writable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(clientConn.streamWritable(0, 0)).toBeTrue();

      // Server state
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      expect(iterToArray(serverConn.writable())).toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(serverConn.streamWritable(0, 0)).toBeTrue();

      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
    test('closing reverse stream with 0-len fin frame', async () => {
      serverConn.streamSend(0, new Uint8Array(0), true);
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      expect(iterToArray(serverConn.writable())).not.toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(serverConn.streamWritable(0, 0)).toBeTrue();

      sendPacket(serverConn, clientConn);

      // Server state
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      // Not writable anymore
      expect(iterToArray(serverConn.writable())).not.toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(serverConn.streamWritable(0, 0)).toBeTrue();

      // Client state
      expect(iterToArray(clientConn.readable())).toContain(0);
      expect(iterToArray(clientConn.writable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeTrue();
      // Is finished
      expect(clientConn.streamFinished(0)).toBeTrue();
      // Still readable
      expect(clientConn.streamReadable(0)).toBeTrue();
      expect(clientConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(clientConn.streamWritable(0, 0)).toBeTrue();

      // Reading message
      const result = clientConn.streamRecv(0, streamBuf);
      expect(result).not.toBeNull();
      const [bytes, fin] = result!;
      expect(bytes).toEqual(0);
      expect(fin).toBe(true);

      expect(clientConn.streamFinished(0)).toBeTrue();
      // Nothing left to read
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      // Stream state is now invalid since both streams have fully closed
      expect(() => clientConn.streamRecv(0, streamBuf)).toThrow(
        'InvalidStreamState(0)',
      );
      // Server sends ack back
      sendPacket(clientConn, serverConn);
    });
    test('server state is cleaned up and invalid', async () => {
      // Server state
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      expect(iterToArray(serverConn.writable())).not.toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(() => serverConn.streamCapacity(0)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(() => serverConn.streamWritable(0, 0)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(serverConn.streamSend(0, Buffer.from('message'), false),
      ).toBeNull();
      expect(() => serverConn.streamRecv(0, streamBuf)).toThrow(
        'InvalidStreamState(0)',
      );
    });
    test('client state is cleaned up and invalid', async () => {
      // Client state
      expect(iterToArray(clientConn.readable())).not.toContain(0);
      expect(iterToArray(clientConn.writable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeTrue();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(() => clientConn.streamCapacity(0)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(() => clientConn.streamWritable(0, 0)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(clientConn.streamSend(0, Buffer.from('message'), false),
      ).toBeNull();
      expect(() => clientConn.streamRecv(0, streamBuf)).toThrow(
        'InvalidStreamState(0)',
      );
    });
    test('no new packets', async () => {
      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
  });
  describe('stream finishes with data fin', () => {
    const streamBuf = Buffer.allocUnsafe(1024);

    beforeAll(async () => {
      await setupConnectionsRSA();
      setupStreamState(clientConn, serverConn, 0);
    });

    test('closing forward stream with data fin frame', async () => {
      clientConn.streamSend(0, Buffer.from('message'), true);
      expect(iterToArray(clientConn.readable())).not.toContain(0);
      expect(iterToArray(clientConn.writable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(clientConn.streamWritable(0, 0)).toBeTrue();

      sendPacket(clientConn, serverConn);

      // Client state
      expect(iterToArray(clientConn.readable())).not.toContain(0);
      // Not writable anymore
      expect(iterToArray(clientConn.writable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(clientConn.streamWritable(0, 0)).toBeTrue();

      // Server state
      expect(iterToArray(serverConn.readable())).toContain(0);
      expect(iterToArray(serverConn.writable())).toContain(0);
      expect(serverConn.isReadable()).toBeTrue();
      // Stream is not finished due to buffered data
      expect(serverConn.streamFinished(0)).toBeFalse();
      // Still readable due to buffered data
      expect(serverConn.streamReadable(0)).toBeTrue();
      expect(serverConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(serverConn.streamWritable(0, 0)).toBeTrue();

      // Reading message
      const result = serverConn.streamRecv(0, streamBuf);
      expect(result).not.toBeNull();
      const [bytes, fin] = result!;
      // Message is empty but exists due to fin flag
      expect(bytes).toEqual(7);
      expect(fin).toBe(true);
      expect(streamBuf.subarray(0, bytes).toString()).toEqual('message');

      expect(serverConn.streamFinished(0)).toBeTrue();
      // Nothing left to read
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamRecv(0, streamBuf)).toBeNull();

      // Server sends ack back
      sendPacket(serverConn, clientConn);

      // Client state
      expect(iterToArray(clientConn.readable())).not.toContain(0);
      expect(iterToArray(clientConn.writable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(clientConn.streamWritable(0, 0)).toBeTrue();

      // Server state
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      expect(iterToArray(serverConn.writable())).toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(serverConn.streamWritable(0, 0)).toBeTrue();

      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
    test('closing reverse stream with data fin frame', async () => {
      serverConn.streamSend(0, Buffer.from('message'), true);
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      expect(iterToArray(serverConn.writable())).not.toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(serverConn.streamWritable(0, 0)).toBeTrue();

      sendPacket(serverConn, clientConn);

      // Server state
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      // Not writable anymore
      expect(iterToArray(serverConn.writable())).not.toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(serverConn.streamWritable(0, 0)).toBeTrue();

      // Client state
      expect(iterToArray(clientConn.readable())).toContain(0);
      expect(iterToArray(clientConn.writable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeTrue();
      // Stream is not finished due to buffered data
      expect(clientConn.streamFinished(0)).toBeFalse();
      // Still readable due to buffered data
      expect(clientConn.streamReadable(0)).toBeTrue();
      expect(clientConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(clientConn.streamWritable(0, 0)).toBeTrue();

      // Reading message
      const result = clientConn.streamRecv(0, streamBuf);
      expect(result).not.toBeNull();
      const [bytes, fin] = result!;
      expect(bytes).toEqual(7);
      expect(fin).toBe(true);
      expect(streamBuf.subarray(0, bytes).toString()).toEqual('message');

      expect(clientConn.streamFinished(0)).toBeTrue();
      // Nothing left to read
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      // Stream state is now invalid since both streams have fully closed
      expect(() => clientConn.streamRecv(0, streamBuf)).toThrow(
        'InvalidStreamState(0)',
      );

      // Server sends ack back
      sendPacket(clientConn, serverConn);
    });
    test('server state is cleaned up and invalid', async () => {
      // Server state
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      expect(iterToArray(serverConn.writable())).not.toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(() => serverConn.streamCapacity(0)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(() => serverConn.streamWritable(0, 0)).toThrow(
        'InvalidStreamState(0)',
      );
    });
    test('client state is cleaned up and invalid', async () => {
      // Client state
      expect(iterToArray(clientConn.readable())).not.toContain(0);
      expect(iterToArray(clientConn.writable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeTrue();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(() => clientConn.streamCapacity(0)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(() => clientConn.streamWritable(0, 0)).toThrow(
        'InvalidStreamState(0)',
      );
    });
    test('no new packets', async () => {
      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
  });
  describe('stream finishes with buffered data and data fin', () => {
    const streamBuf = Buffer.allocUnsafe(1024);

    beforeAll(async () => {
      await setupConnectionsRSA();
      setupStreamState(clientConn, serverConn, 0);
    });

    test('sending multiple messages on forward stream', async () => {
      clientConn.streamSend(0, Buffer.from('Message1 '), false);
      clientConn.streamSend(0, Buffer.from('Message2 '), false);
      clientConn.streamSend(0, Buffer.from('Message3 '), false);

      // Only one packet is sent
      sendPacket(clientConn, serverConn);
      sendPacket(serverConn, clientConn); // Ack
      expect(sendPacket(clientConn, serverConn)).toBeNull();
      expect(sendPacket(serverConn, clientConn)).toBeNull();

      expect(serverConn.streamReadable(0)).toBeTrue();
      expect(serverConn.streamFinished(0)).toBeFalse();
    });
    test('send multiple messages with a fin frame on forward stream', async () => {
      clientConn.streamSend(0, Buffer.from('Message1 '), false);
      clientConn.streamSend(0, Buffer.from('Message2 '), false);
      clientConn.streamSend(0, Buffer.from('Message3 '), true);

      // Only one packet is sent
      sendPacket(clientConn, serverConn);
      sendPacket(serverConn, clientConn); // Ack
      expect(sendPacket(clientConn, serverConn)).toBeNull();
      expect(sendPacket(serverConn, clientConn)).toBeNull();

      expect(serverConn.streamReadable(0)).toBeTrue();
      expect(serverConn.streamFinished(0)).toBeFalse();
      const result = serverConn.streamRecv(0, streamBuf);
      expect(result).not.toBeNull();
      const [bytes, fin] = result!;
      expect(bytes).toBe(54);
      expect(fin).toBeTrue();
      expect(streamBuf.subarray(0, bytes).toString()).toEqual(
        'Message1 Message2 Message3 Message1 Message2 Message3 ',
      );
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
    });
    test('extra writes and reads are invalid on forward stream', async () => {
      expect(() =>
        clientConn.streamSend(0, Buffer.from('invalid1'), false),
      ).toThrow('FinalSize');
      expect(() =>
        clientConn.streamSend(0, Buffer.from('invalid2'), true),
      ).toThrow('FinalSize');
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
      expect(serverConn.streamRecv(0, streamBuf)).toBeNull();
    });
    test('sending multiple messages on reverse stream', async () => {
      serverConn.streamSend(0, Buffer.from('Message1 '), false);
      serverConn.streamSend(0, Buffer.from('Message2 '), false);
      serverConn.streamSend(0, Buffer.from('Message3 '), false);

      // Only one packet is sent
      sendPacket(serverConn, clientConn);
      sendPacket(clientConn, serverConn); // Ack
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();

      expect(clientConn.streamReadable(0)).toBeTrue();
      expect(clientConn.streamFinished(0)).toBeFalse();
    });
    test('send multiple messages with a fin frame on reverse stream', async () => {
      serverConn.streamSend(0, Buffer.from('Message1 '), false);
      serverConn.streamSend(0, Buffer.from('Message2 '), false);
      serverConn.streamSend(0, Buffer.from('Message3 '), true);

      // Only one packet is sent
      sendPacket(serverConn, clientConn);
      sendPacket(clientConn, serverConn); // Ack
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();

      expect(clientConn.streamReadable(0)).toBeTrue();
      expect(clientConn.streamFinished(0)).toBeFalse();
      const result = clientConn.streamRecv(0, streamBuf);
      expect(result).not.toBeNull();
      const [bytes, fin] = result!;
      expect(bytes).toBe(54);
      expect(fin).toBeTrue();
      expect(streamBuf.subarray(0, bytes).toString()).toEqual(
        'Message1 Message2 Message3 Message1 Message2 Message3 ',
      );
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeTrue();
    });
    test('server state is cleaned up and invalid', async () => {
      // Server state
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      expect(iterToArray(serverConn.writable())).not.toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(() => serverConn.streamCapacity(0)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(() => serverConn.streamWritable(0, 0)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(serverConn.streamSend(0, Buffer.from('message'), false),
      ).toBeNull();
      expect(() => serverConn.streamRecv(0, streamBuf)).toThrow(
        'InvalidStreamState(0)',
      );
    });
    test('client state is cleaned up and invalid', async () => {
      // Client state
      expect(iterToArray(clientConn.readable())).not.toContain(0);
      expect(iterToArray(clientConn.writable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeTrue();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(() => clientConn.streamCapacity(0)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(() => clientConn.streamWritable(0, 0)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(clientConn.streamSend(0, Buffer.from('message'), false),
      ).toBeNull();
      expect(() => clientConn.streamRecv(0, streamBuf)).toThrow(
        'InvalidStreamState(0)',
      );
    });
    test('no new packets', async () => {
      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
  });
  describe('stream finishes with buffered data and 0-len fin', () => {
    // Notes:
    //  The isFinished doesn't return true until buffered data is read.
    //  Reading out buffered data will have fin flag be true.

    const streamBuf = Buffer.allocUnsafe(1024);

    beforeAll(async () => {
      await setupConnectionsRSA();
      setupStreamState(clientConn, serverConn, 0);
    });

    test('sending multiple messages on forward stream', async () => {
      clientConn.streamSend(0, Buffer.from('Message1 '), false);
      clientConn.streamSend(0, Buffer.from('Message2 '), false);
      clientConn.streamSend(0, Buffer.from('Message3 '), false);

      // Only one packet is sent
      sendPacket(clientConn, serverConn);
      sendPacket(serverConn, clientConn); // Ack
      expect(sendPacket(clientConn, serverConn)).toBeNull();
      expect(sendPacket(serverConn, clientConn)).toBeNull();

      expect(serverConn.streamReadable(0)).toBeTrue();
      expect(serverConn.streamFinished(0)).toBeFalse();
    });
    test('send 0-len fin on forward stream', async () => {
      clientConn.streamSend(0, new Uint8Array(0), true);

      // Only one packet is sent
      sendPacket(clientConn, serverConn);
      sendPacket(serverConn, clientConn); // Ack
      expect(sendPacket(clientConn, serverConn)).toBeNull();
      expect(sendPacket(serverConn, clientConn)).toBeNull();

      expect(serverConn.streamReadable(0)).toBeTrue();
      // Finished is still false
      expect(serverConn.streamFinished(0)).toBeFalse();
      const result = serverConn.streamRecv(0, streamBuf);
      expect(result).not.toBeNull();
      const [bytes, fin] = result!;
      expect(bytes).toBe(27);
      expect(fin).toBeTrue();
      expect(streamBuf.subarray(0, bytes).toString()).toEqual(
        'Message1 Message2 Message3 ',
      );
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
    });
    test('extra writes and reads are invalid on forward stream', async () => {
      expect(() =>
        clientConn.streamSend(0, Buffer.from('invalid1'), false),
      ).toThrow('FinalSize');
      expect(() =>
        clientConn.streamSend(0, Buffer.from('invalid2'), true),
      ).toThrow('FinalSize');
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
      expect(serverConn.streamRecv(0, streamBuf)).toBeNull();
    });
    test('sending multiple messages on reverse stream', async () => {
      serverConn.streamSend(0, Buffer.from('Message1 '), false);
      serverConn.streamSend(0, Buffer.from('Message2 '), false);
      serverConn.streamSend(0, Buffer.from('Message3 '), false);

      // Only one packet is sent
      sendPacket(serverConn, clientConn);
      sendPacket(clientConn, serverConn); // Ack
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();

      expect(clientConn.streamReadable(0)).toBeTrue();
      expect(clientConn.streamFinished(0)).toBeFalse();
    });
    test('send 0-len fin on reverse stream', async () => {
      serverConn.streamSend(0, new Uint8Array(0), true);

      // Only one packet is sent
      sendPacket(serverConn, clientConn);
      sendPacket(clientConn, serverConn); // Ack
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();

      expect(clientConn.streamReadable(0)).toBeTrue();
      // Finished is still false due to buffered data
      expect(clientConn.streamFinished(0)).toBeFalse();
      const result = clientConn.streamRecv(0, streamBuf);
      expect(result).not.toBeNull();
      const [bytes, fin] = result!;
      expect(bytes).toBe(27);
      expect(fin).toBeTrue();
      expect(streamBuf.subarray(0, bytes).toString()).toEqual(
        'Message1 Message2 Message3 ',
      );
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeTrue();
    });
    test('server state is cleaned up and invalid', async () => {
      // Server state
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      expect(iterToArray(serverConn.writable())).not.toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(() => serverConn.streamCapacity(0)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(() => serverConn.streamWritable(0, 0)).toThrow(
        'InvalidStreamState(0)',
      );
    });
    test('client state is cleaned up and invalid', async () => {
      // Client state
      expect(iterToArray(clientConn.readable())).not.toContain(0);
      expect(iterToArray(clientConn.writable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeTrue();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(() => clientConn.streamCapacity(0)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(() => clientConn.streamWritable(0, 0)).toThrow(
        'InvalidStreamState(0)',
      );
    });
    test('no new packets', async () => {
      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
  });
  describe('stream finishes with 0-len fin before any data', () => {
    const streamBuf = Buffer.allocUnsafe(1024);

    beforeAll(async () => {
      await setupConnectionsRSA();
    });

    test('initializing stream with no data', async () => {
      clientConn.streamSend(0, new Uint8Array(0), false);

      // Local state exists
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamWritable(0, 0)).toBeTrue();
      expect(clientConn.streamCapacity(0)).toBe(13500);

      // No packets are sent, therefor no remote state created
      expect(sendPacket(clientConn, serverConn)).toBeNull();
      expect(sendPacket(serverConn, clientConn)).toBeNull();
    });
    test('closing forward stream with 0-len fin frame', async () => {
      clientConn.streamSend(0, new Uint8Array(0), true);
      expect(iterToArray(clientConn.readable())).not.toContain(0);
      expect(iterToArray(clientConn.writable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(clientConn.streamWritable(0, 0)).toBeTrue();

      sendPacket(clientConn, serverConn);

      // Client state
      expect(iterToArray(clientConn.readable())).not.toContain(0);
      // Not writable anymore
      expect(iterToArray(clientConn.writable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(clientConn.streamWritable(0, 0)).toBeTrue();

      // Further writes fail
      expect(() =>
        clientConn.streamSend(0, Buffer.from('message'), false),
      ).toThrow('FinalSize');

      // Server state
      expect(iterToArray(serverConn.readable())).toContain(0);
      expect(iterToArray(serverConn.writable())).toContain(0);
      expect(serverConn.isReadable()).toBeTrue();
      // Stream is immediately finished due to no buffered data
      expect(serverConn.streamFinished(0)).toBeTrue();
      // Still readable due to 0-len message and fin flag
      expect(serverConn.streamReadable(0)).toBeTrue();
      expect(serverConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(serverConn.streamWritable(0, 0)).toBeTrue();

      // Reading message
      const result = serverConn.streamRecv(0, streamBuf);
      expect(result).not.toBeNull();
      const [bytes, fin] = result!;
      // Message is empty but exists due to fin flag
      expect(bytes).toEqual(0);
      expect(fin).toBe(true);

      expect(serverConn.streamFinished(0)).toBeTrue();
      // Nothing left to read
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamRecv(0, streamBuf)).toBeNull();

      // Server sends ack back
      sendPacket(serverConn, clientConn);

      // Client state
      expect(iterToArray(clientConn.readable())).not.toContain(0);
      expect(iterToArray(clientConn.writable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(clientConn.streamWritable(0, 0)).toBeTrue();

      // Server state
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      expect(iterToArray(serverConn.writable())).toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(serverConn.streamWritable(0, 0)).toBeTrue();

      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
    test('closing reverse stream with 0-len fin frame', async () => {
      serverConn.streamSend(0, new Uint8Array(0), true);
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      expect(iterToArray(serverConn.writable())).not.toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(serverConn.streamWritable(0, 0)).toBeTrue();

      sendPacket(serverConn, clientConn);

      // Server state
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      // Not writable anymore
      expect(iterToArray(serverConn.writable())).not.toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(serverConn.streamWritable(0, 0)).toBeTrue();

      // Client state
      expect(iterToArray(clientConn.readable())).toContain(0);
      expect(iterToArray(clientConn.writable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeTrue();
      // Is finished
      expect(clientConn.streamFinished(0)).toBeTrue();
      // Still readable
      expect(clientConn.streamReadable(0)).toBeTrue();
      expect(clientConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(clientConn.streamWritable(0, 0)).toBeTrue();

      // Reading message
      const result = clientConn.streamRecv(0, streamBuf);
      expect(result).not.toBeNull();
      const [bytes, fin] = result!;
      expect(bytes).toEqual(0);
      expect(fin).toBe(true);

      expect(clientConn.streamFinished(0)).toBeTrue();
      // Nothing left to read
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      // Stream state is now invalid since both streams have fully closed
      expect(() => clientConn.streamRecv(0, streamBuf)).toThrow(
        'InvalidStreamState(0)',
      );

      // Server sends ack back
      sendPacket(clientConn, serverConn);
    });
    test('server state is cleaned up and invalid', async () => {
      // Server state
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      expect(iterToArray(serverConn.writable())).not.toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(() => serverConn.streamCapacity(0)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(() => serverConn.streamWritable(0, 0)).toThrow(
        'InvalidStreamState(0)',
      );
    });
    test('client state is cleaned up and invalid', async () => {
      // Client state
      expect(iterToArray(clientConn.readable())).not.toContain(0);
      expect(iterToArray(clientConn.writable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeTrue();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(() => clientConn.streamCapacity(0)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(() => clientConn.streamWritable(0, 0)).toThrow(
        'InvalidStreamState(0)',
      );
    });
    test('no new packets', async () => {
      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
  });
  describe('stream finishes with data fin before any data', () => {
    const streamBuf = Buffer.allocUnsafe(1024);

    beforeAll(async () => {
      await setupConnectionsRSA();
    });

    test('initializing stream with no data', async () => {
      clientConn.streamSend(0, new Uint8Array(0), false);

      // Local state exists
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamWritable(0, 0)).toBeTrue();
      expect(clientConn.streamCapacity(0)).toBe(13500);

      // No packets are sent, therefor no remote state created
      expect(sendPacket(clientConn, serverConn)).toBeNull();
      expect(sendPacket(serverConn, clientConn)).toBeNull();
    });
    test('closing forward stream with data fin frame', async () => {
      clientConn.streamSend(0, Buffer.from('message'), true);
      expect(iterToArray(clientConn.readable())).not.toContain(0);
      expect(iterToArray(clientConn.writable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(clientConn.streamWritable(0, 0)).toBeTrue();

      sendPacket(clientConn, serverConn);

      // Client state
      expect(iterToArray(clientConn.readable())).not.toContain(0);
      // Not writable anymore
      expect(iterToArray(clientConn.writable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(clientConn.streamWritable(0, 0)).toBeTrue();

      // Server state
      expect(iterToArray(serverConn.readable())).toContain(0);
      expect(iterToArray(serverConn.writable())).toContain(0);
      expect(serverConn.isReadable()).toBeTrue();
      // Stream not finished due to buffered data
      expect(serverConn.streamFinished(0)).toBeFalse();
      // Still readable due to buffered and fin flag
      expect(serverConn.streamReadable(0)).toBeTrue();
      expect(serverConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(serverConn.streamWritable(0, 0)).toBeTrue();

      // Reading message
      const result = serverConn.streamRecv(0, streamBuf);
      expect(result).not.toBeNull();
      const [bytes, fin] = result!;
      // Message is empty but exists due to fin flag
      expect(bytes).toEqual(7);
      expect(fin).toBe(true);

      expect(serverConn.streamFinished(0)).toBeTrue();
      // Nothing left to read
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamRecv(0, streamBuf)).toBeNull();

      // Server sends ack back
      sendPacket(serverConn, clientConn);

      // Client state
      expect(iterToArray(clientConn.readable())).not.toContain(0);
      expect(iterToArray(clientConn.writable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(clientConn.streamWritable(0, 0)).toBeTrue();

      // Server state
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      expect(iterToArray(serverConn.writable())).toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(serverConn.streamWritable(0, 0)).toBeTrue();

      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
    test('closing reverse stream with data fin frame', async () => {
      serverConn.streamSend(0, Buffer.from('message'), true);
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      expect(iterToArray(serverConn.writable())).not.toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(serverConn.streamWritable(0, 0)).toBeTrue();

      sendPacket(serverConn, clientConn);

      // Server state
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      // Not writable anymore
      expect(iterToArray(serverConn.writable())).not.toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(serverConn.streamWritable(0, 0)).toBeTrue();

      // Client state
      expect(iterToArray(clientConn.readable())).toContain(0);
      expect(iterToArray(clientConn.writable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeTrue();
      // Stream not finished due to buffered data
      expect(clientConn.streamFinished(0)).toBeFalse();
      // Still readable due to buffered and fin flag
      expect(clientConn.streamReadable(0)).toBeTrue();
      expect(clientConn.streamCapacity(0)).toBeGreaterThan(0);
      expect(clientConn.streamWritable(0, 0)).toBeTrue();

      // Reading message
      const result = clientConn.streamRecv(0, streamBuf);
      expect(result).not.toBeNull();
      const [bytes, fin] = result!;
      expect(bytes).toEqual(7);
      expect(fin).toBe(true);

      expect(clientConn.streamFinished(0)).toBeTrue();
      // Nothing left to read
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      // Stream state is now invalid since both streams have fully closed
      expect(() => clientConn.streamRecv(0, streamBuf)).toThrow(
        'InvalidStreamState(0)',
      );

      // Server sends ack back
      sendPacket(clientConn, serverConn);
    });
    test('server state is cleaned up and invalid', async () => {
      // Server state
      expect(iterToArray(serverConn.readable())).not.toContain(0);
      expect(iterToArray(serverConn.writable())).not.toContain(0);
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(() => serverConn.streamCapacity(0)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(() => serverConn.streamWritable(0, 0)).toThrow(
        'InvalidStreamState(0)',
      );
    });
    test('client state is cleaned up and invalid', async () => {
      // Client state
      expect(iterToArray(clientConn.readable())).not.toContain(0);
      expect(iterToArray(clientConn.writable())).not.toContain(0);
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeTrue();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(() => clientConn.streamCapacity(0)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(() => clientConn.streamWritable(0, 0)).toThrow(
        'InvalidStreamState(0)',
      );
    });
    test('no new packets', async () => {
      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
  });

  // Forcing stream closed tests
  describe('stream forced closed by client after initial message', () => {
    const streamBuf = Buffer.allocUnsafe(1024);

    beforeAll(async () => {
      await setupConnectionsRSA();
      setupStreamState(clientConn, serverConn, 0);
    });

    describe('closing writable from client', () => {
      test('client closes writable', async () => {
        // Initial writable states
        expect(clientConn.streamWritable(0, 0)).toBeTrue();
        expect(clientConn.streamCapacity(0)).toBe(13500);
        expect(iterToArray(clientConn.writable())).toContain(0);

        // After shutting down
        clientConn.streamShutdown(0, Shutdown.Write, 42);
        // Further shutdowns throw done
        expect(
          clientConn.streamShutdown(0, Shutdown.Write, 42),
        ).toBeNull();

        // States are unchanged
        expect(clientConn.streamWritable(0, 0)).toBeTrue();
        expect(clientConn.streamCapacity(0)).toBe(13500);
        // No longer in writable iterator
        expect(iterToArray(clientConn.writable())).not.toContain(0);
      });
      test('stream is no longer writable on client', async () => {
        // Can't write after shutdown
        expect(() =>
          clientConn.streamSend(0, Buffer.from('hello'), false),
        ).toThrow('FinalSize');
        expect(() =>
          clientConn.streamSend(0, Buffer.from('hello'), false),
        ).toThrow('FinalSize');

        // Still seen as writable
        expect(clientConn.streamWritable(0, 0)).toBeTrue();
        expect(clientConn.streamCapacity(0)).toBe(13500);
        expect(iterToArray(clientConn.writable())).not.toContain(0);
      });
      test('server receives packet and updates state', async () => {
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.streamReadable(0)).toBeFalse();
        expect(serverConn.streamFinished(0)).toBeFalse();
        expect(iterToArray(serverConn.readable())).not.toContain(0);

        expect(serverConn.streamRecv(0, streamBuf)).toBeNull();
        sendPacket(clientConn, serverConn);
        // Stream is both readable and finished
        expect(serverConn.isReadable()).toBeTrue();
        expect(serverConn.streamReadable(0)).toBeTrue();
        expect(serverConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(serverConn.readable())).toContain(0);
      });
      test('stream is no longer readable on server', async () => {
        // Stream now throws `StreamReset` with code 42
        expect(() => serverConn.streamRecv(0, streamBuf)).toThrow(
          'StreamReset(42)',
        );
        expect(() => serverConn.streamRecv(0, streamBuf)).toThrow(
          'StreamReset(42)',
        );

        // Connection is now not readable
        expect(serverConn.isReadable()).toBeFalse();
        // Stream is still readable and finished
        expect(serverConn.streamReadable(0)).toBeTrue();
        expect(serverConn.streamFinished(0)).toBeTrue();
        // But not in the iterator
        expect(iterToArray(serverConn.readable())).not.toContain(0);
      });
      test('client receives response packet and updates state', async () => {
        // Initial writable states
        expect(clientConn.streamWritable(0, 0)).toBeTrue();
        expect(clientConn.streamCapacity(0)).toBe(13500);
        expect(iterToArray(clientConn.writable())).not.toContain(0);
        expect(() =>
          clientConn.streamSend(0, Buffer.from('hello'), false),
        ).toThrow('FinalSize');

        // Response is sent
        sendPacket(serverConn, clientConn);

        // No changes to stream state on server
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.streamReadable(0)).toBeTrue();
        expect(serverConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(serverConn.readable())).not.toContain(0);

        // Client changes
        expect(clientConn.streamWritable(0, 0)).toBeTrue();
        expect(clientConn.streamCapacity(0)).toBe(13500);
        expect(iterToArray(clientConn.writable())).not.toContain(0);
        expect(() =>
          clientConn.streamSend(0, Buffer.from('hello'), false),
        ).toThrow('FinalSize');
      });
      test('no further packets sent', async () => {
        expect(sendPacket(serverConn, clientConn)).toBeNull();
        expect(sendPacket(clientConn, serverConn)).toBeNull();
      });
    });
    describe('closing readable from client', () => {
      test('client closes readable', async () => {
        // Initial readable state
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        expect(clientConn.streamFinished(0)).toBeFalse();
        expect(iterToArray(clientConn.readable())).not.toContain(0);

        // After shutting down
        clientConn.streamShutdown(0, Shutdown.Read, 42);
        // Further shutdowns throw done
        expect(clientConn.streamShutdown(0, Shutdown.Read, 42)).toBeNull();

        // No state change
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        expect(clientConn.streamFinished(0)).toBeFalse();
        expect(iterToArray(clientConn.readable())).not.toContain(0);
      });
      test('Stream is still readable for client', async () => {
        expect(clientConn.streamRecv(0, streamBuf)).toBeNull();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        expect(clientConn.streamFinished(0)).toBeFalse();
        expect(iterToArray(clientConn.readable())).not.toContain(0);
      });
      test('server receives packet and updates state', async () => {
        // Initial state
        expect(serverConn.streamWritable(0, 0)).toBeTrue();
        expect(serverConn.streamCapacity(0)).toBe(13500);
        expect(iterToArray(serverConn.writable())).toContain(0);

        // Sending packet
        sendPacket(clientConn, serverConn);
        expect(sendPacket(clientConn, serverConn)).toBeNull();

        // Stream writable and capacity now throws
        expect(() => serverConn.streamWritable(0, 0)).toThrow(
          'StreamStopped(42)',
        );
        expect(() => serverConn.streamCapacity(0)).toThrow(
          'StreamStopped(42)',
        );
        // But still listed as writable
        expect(iterToArray(serverConn.writable())).toContain(0);
      });
      test('stream no longer writable on server', async () => {
        // Writes now throw
        expect(() =>
          serverConn.streamSend(0, Buffer.from('message'), false),
        ).toThrow('StreamStopped(42)');
        expect(() =>
          serverConn.streamSend(0, Buffer.from('message'), true),
        ).toThrow('StreamStopped(42)');

        expect(() => serverConn.streamWritable(0, 0)).toThrow(
          'StreamStopped(42)',
        );
        expect(() => serverConn.streamCapacity(0)).toThrow(
          'StreamStopped(42)',
        );
        // No longer listed as writable
        expect(iterToArray(serverConn.writable())).not.toContain(0);
      });
      test('client receives response packet and updates state', async () => {
        // Initial readable states
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        expect(clientConn.streamFinished(0)).toBeFalse();
        expect(iterToArray(clientConn.readable())).not.toContain(0);

        // Response is sent
        sendPacket(serverConn, clientConn);
        expect(sendPacket(serverConn, clientConn)).toBeNull();

        // No changes to stream state on server
        expect(() => serverConn.streamWritable(0, 0)).toThrow(
          'StreamStopped(42)',
        );
        expect(() => serverConn.streamCapacity(0)).toThrow(
          'StreamStopped(42)',
        );
        expect(iterToArray(serverConn.writable())).not.toContain(0);

        // Client changes
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        // Stream is now finished
        expect(clientConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(clientConn.readable())).not.toContain(0);
      });
      test('client stream now finished', async () => {
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        expect(clientConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(clientConn.readable())).not.toContain(0);
      });
      test('client responds', async () => {
        sendPacket(clientConn, serverConn); // Ack?
        expect(sendPacket(clientConn, serverConn)).toBeNull();

        // No changes to stream state on server
        expect(() => serverConn.streamWritable(0, 0)).toThrow(
          'StreamStopped(42)',
        );
        expect(() => serverConn.streamCapacity(0)).toThrow(
          'StreamStopped(42)',
        );
        expect(iterToArray(serverConn.writable())).not.toContain(0);

        // Client changes
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        expect(clientConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(clientConn.readable())).not.toContain(0);
      });
      test('stream still readable on client', async () => {
        // Reading stream will never throw, but it does finish.
        expect(clientConn.streamRecv(0, streamBuf)).toBeNull();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        expect(clientConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(clientConn.readable())).not.toContain(0);
      });
      test('no more packets sent', async () => {
        // No new packets
        expect(sendPacket(serverConn, clientConn)).toBeNull();
        expect(sendPacket(clientConn, serverConn)).toBeNull();
      });
    });
    test('server final stream state', async () => {
      // Server states
      expect(() =>
        serverConn.streamSend(0, Buffer.from('message'), true),
      ).toThrow('StreamStopped(42)');
      expect(() => serverConn.streamRecv(0, streamBuf)).toThrow(
        'StreamReset(42)',
      );
      // States change
      expect(serverConn.streamSend(0, Buffer.from('message'), true),
      ).toBeNull();
      expect(() => serverConn.streamRecv(0, streamBuf)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(serverConn.streamShutdown(0, Shutdown.Read, 42)).toBeNull();
      expect(serverConn.streamShutdown(0, Shutdown.Write, 42)).toBeNull();

      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(() => serverConn.streamWritable(0, 0)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(() => serverConn.streamCapacity(0)).toThrow(
        'InvalidStreamState(0)',
      );
    });
    test('client final stream state', async () => {
      // Client never reaches invalid state?
      expect(clientConn.streamRecv(0, streamBuf)).toBeNull();
      expect(() =>
        clientConn.streamSend(0, Buffer.from('message'), true),
      ).toThrow('FinalSize');
      expect(clientConn.streamRecv(0, streamBuf)).toBeNull();
      expect(() =>
        clientConn.streamSend(0, Buffer.from('message'), true),
      ).toThrow('FinalSize');
      expect(clientConn.streamShutdown(0, Shutdown.Read, 42)).toBeNull();
      expect(clientConn.streamShutdown(0, Shutdown.Write, 42)).toBeNull();

      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeTrue();
      expect(clientConn.streamWritable(0, 0)).toBeTrue();
      expect(clientConn.streamCapacity(0)).toBe(13500);
    });
    test('no new packets', async () => {
      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
  });
  describe('stream forced closed by server after initial message', () => {
    // This test proves closing is the same from the client side and server side.
    // This is expected given the symmetric nature of a quic connection.

    const streamBuf = Buffer.allocUnsafe(1024);

    beforeAll(async () => {
      await setupConnectionsRSA();
      setupStreamState(clientConn, serverConn, 0);
    });

    describe('closing writable from server', () => {
      test('server closes writable', async () => {
        // Initial writable states
        expect(serverConn.streamWritable(0, 0)).toBeTrue();
        expect(serverConn.streamCapacity(0)).toBe(13500);
        expect(iterToArray(serverConn.writable())).toContain(0);

        // After shutting down
        serverConn.streamShutdown(0, Shutdown.Write, 42);
        // Further shutdowns throw done
        expect(serverConn.streamShutdown(0, Shutdown.Write, 42),
        ).toBeNull();

        // States are unchanged
        expect(serverConn.streamWritable(0, 0)).toBeTrue();
        expect(serverConn.streamCapacity(0)).toBe(13500);
        // No longer in writable iterator
        expect(iterToArray(serverConn.writable())).not.toContain(0);
      });
      test('stream is no longer writable on server', async () => {
        // Can't write after shutdown
        expect(() =>
          serverConn.streamSend(0, Buffer.from('hello'), false),
        ).toThrow('FinalSize');
        expect(() =>
          serverConn.streamSend(0, Buffer.from('hello'), false),
        ).toThrow('FinalSize');

        // Still seen as writable
        expect(serverConn.streamWritable(0, 0)).toBeTrue();
        expect(serverConn.streamCapacity(0)).toBe(13500);
        expect(iterToArray(serverConn.writable())).not.toContain(0);
      });
      test('client receives packet and updates state', async () => {
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        expect(clientConn.streamFinished(0)).toBeFalse();
        expect(iterToArray(clientConn.readable())).not.toContain(0);

        expect(clientConn.streamRecv(0, streamBuf)).toBeNull();
        sendPacket(serverConn, clientConn);
        // Stream is both readable and finished
        expect(clientConn.isReadable()).toBeTrue();
        expect(clientConn.streamReadable(0)).toBeTrue();
        expect(clientConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(clientConn.readable())).toContain(0);
      });
      test('stream is no longer readable on client', async () => {
        // Stream now throws `StreamReset` with code 42
        expect(() => clientConn.streamRecv(0, streamBuf)).toThrow(
          'StreamReset(42)',
        );
        expect(() => clientConn.streamRecv(0, streamBuf)).toThrow(
          'StreamReset(42)',
        );

        // Connection is now not readable
        expect(clientConn.isReadable()).toBeFalse();
        // Stream is still readable and finished
        expect(clientConn.streamReadable(0)).toBeTrue();
        expect(clientConn.streamFinished(0)).toBeTrue();
        // But not in the iterator
        expect(iterToArray(clientConn.readable())).not.toContain(0);
      });
      test('server receives response packet and updates state', async () => {
        // Initial writable states
        expect(serverConn.streamWritable(0, 0)).toBeTrue();
        expect(serverConn.streamCapacity(0)).toBe(13500);
        expect(iterToArray(serverConn.writable())).not.toContain(0);
        expect(() =>
          serverConn.streamSend(0, Buffer.from('hello'), false),
        ).toThrow('FinalSize');

        // Response is sent
        sendPacket(clientConn, serverConn);

        // No changes to stream state on server
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeTrue();
        expect(clientConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(clientConn.readable())).not.toContain(0);

        // Client changes?
        expect(serverConn.streamWritable(0, 0)).toBeTrue();
        expect(serverConn.streamCapacity(0)).toBe(13500);
        expect(iterToArray(serverConn.writable())).not.toContain(0);
        expect(() =>
          serverConn.streamSend(0, Buffer.from('hello'), false),
        ).toThrow('FinalSize');
      });
      test('no further packets sent', async () => {
        expect(sendPacket(serverConn, clientConn)).toBeNull();
        expect(sendPacket(clientConn, serverConn)).toBeNull();
      });
    });
    describe('closing readable from server', () => {
      test('server closes readable', async () => {
        // Initial readable state
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.streamReadable(0)).toBeFalse();
        expect(serverConn.streamFinished(0)).toBeFalse();
        expect(iterToArray(serverConn.readable())).not.toContain(0);

        // After shutting down
        serverConn.streamShutdown(0, Shutdown.Read, 42);
        // Further shutdowns throw done
        expect(serverConn.streamShutdown(0, Shutdown.Read, 42)).toBeNull();

        // No state change
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.streamReadable(0)).toBeFalse();
        expect(serverConn.streamFinished(0)).toBeFalse();
        expect(iterToArray(serverConn.readable())).not.toContain(0);
      });
      test('Stream is still readable for server', async () => {
        expect(serverConn.streamRecv(0, streamBuf)).toBeNull();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.streamReadable(0)).toBeFalse();
        expect(serverConn.streamFinished(0)).toBeFalse();
        expect(iterToArray(serverConn.readable())).not.toContain(0);
      });
      test('client receives packet and updates state', async () => {
        // Initial state
        expect(clientConn.streamWritable(0, 0)).toBeTrue();
        expect(clientConn.streamCapacity(0)).toBe(13500);
        expect(iterToArray(clientConn.writable())).toContain(0);

        // Sending packet
        sendPacket(serverConn, clientConn);
        expect(sendPacket(serverConn, clientConn)).toBeNull();

        // Stream writable and capacity now throws
        expect(() => clientConn.streamWritable(0, 0)).toThrow(
          'StreamStopped(42)',
        );
        expect(() => clientConn.streamCapacity(0)).toThrow(
          'StreamStopped(42)',
        );
        // But still listed as writable
        expect(iterToArray(clientConn.writable())).toContain(0);
      });
      test('stream no longer writable on client', async () => {
        // Writes now throw
        expect(() =>
          clientConn.streamSend(0, Buffer.from('message'), false),
        ).toThrow('StreamStopped(42)');
        expect(() =>
          clientConn.streamSend(0, Buffer.from('message'), true),
        ).toThrow('StreamStopped(42)');

        expect(() => clientConn.streamWritable(0, 0)).toThrow(
          'StreamStopped(42)',
        );
        expect(() => clientConn.streamCapacity(0)).toThrow(
          'StreamStopped(42)',
        );
        // No longer listed as writable
        expect(iterToArray(clientConn.writable())).not.toContain(0);
      });
      test('server receives response packet and updates state', async () => {
        // Initial readable states
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.streamReadable(0)).toBeFalse();
        expect(serverConn.streamFinished(0)).toBeFalse();
        expect(iterToArray(serverConn.readable())).not.toContain(0);

        // Response is sent
        sendPacket(clientConn, serverConn);
        expect(sendPacket(clientConn, serverConn)).toBeNull();

        // Client changes
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.streamReadable(0)).toBeFalse();
        expect(serverConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(serverConn.readable())).not.toContain(0);

        // No changes to stream state on server
        expect(() => clientConn.streamWritable(0, 0)).toThrow(
          'StreamStopped(42)',
        );
        expect(() => clientConn.streamCapacity(0)).toThrow(
          'StreamStopped(42)',
        );
        expect(iterToArray(clientConn.writable())).not.toContain(0);

        // Server changes
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.streamReadable(0)).toBeFalse();
        // Stream is now finished
        expect(serverConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(serverConn.readable())).not.toContain(0);
      });
      test('server stream now finished', async () => {
        // Reading still results in done
        expect(serverConn.streamRecv(0, streamBuf)).toBeNull();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.streamReadable(0)).toBeFalse();
        expect(serverConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(serverConn.readable())).not.toContain(0);
      });
      test('server responds', async () => {
        sendPacket(serverConn, clientConn); // Ack?
        expect(sendPacket(serverConn, clientConn)).toBeNull();

        // No changes to stream state on client
        expect(() => clientConn.streamWritable(0, 0)).toThrow(
          'StreamStopped(42)',
        );
        expect(() => clientConn.streamCapacity(0)).toThrow(
          'StreamStopped(42)',
        );
        expect(iterToArray(clientConn.writable())).not.toContain(0);

        // Server changes
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.streamReadable(0)).toBeFalse();
        expect(serverConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(clientConn.readable())).not.toContain(0);
      });
      test('stream still readable on server', async () => {
        // Reading stream will never throw, but it does finish.
        expect(serverConn.streamRecv(0, streamBuf)).toBeNull();
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.streamReadable(0)).toBeFalse();
        expect(serverConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(serverConn.readable())).not.toContain(0);
      });
      test('no more packets sent', async () => {
        // No new packets
        expect(sendPacket(clientConn, serverConn)).toBeNull();
        expect(sendPacket(serverConn, clientConn)).toBeNull();
      });
    });
    test('client final stream state', async () => {
      // Server states
      expect(() =>
        clientConn.streamSend(0, Buffer.from('message'), true),
      ).toThrow('StreamStopped(42)');
      expect(() => clientConn.streamRecv(0, streamBuf)).toThrow(
        'StreamReset(42)',
      );
      // States change
      expect(
        clientConn.streamSend(0, Buffer.from('message'), true),
      ).toBeNull();
      expect(() => clientConn.streamRecv(0, streamBuf)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(clientConn.streamShutdown(0, Shutdown.Read, 42)).toBeNull();
      expect(clientConn.streamShutdown(0, Shutdown.Write, 42)).toBeNull();

      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeTrue();
      expect(() => clientConn.streamWritable(0, 0)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(() => clientConn.streamCapacity(0)).toThrow(
        'InvalidStreamState(0)',
      );
    });
    test('server final stream state', async () => {
      // Client never reaches invalid state?
      expect(serverConn.streamRecv(0, streamBuf)).toBeNull();
      expect(() =>
        serverConn.streamSend(0, Buffer.from('message'), true),
      ).toThrow('FinalSize');
      expect(serverConn.streamRecv(0, streamBuf)).toBeNull();
      expect(() =>
        serverConn.streamSend(0, Buffer.from('message'), true),
      ).toThrow('FinalSize');
      expect(serverConn.streamShutdown(0, Shutdown.Read, 42)).toBeNull();
      expect(serverConn.streamShutdown(0, Shutdown.Write, 42)).toBeNull();

      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(serverConn.streamWritable(0, 0)).toBeTrue();
      expect(serverConn.streamCapacity(0)).toBe(13500);
    });
    test('no new packets', async () => {
      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
  });
  describe('stream forced closed by client before initial message', () => {
    // This tests the case where a stream is initiated on one side but no data is sent.
    //  So the state is not created on the receiving side before it is closed.

    const streamBuf = Buffer.allocUnsafe(1024);

    beforeAll(async () => {
      await setupConnectionsRSA();
    });

    test('initializing stream with no data', async () => {
      clientConn.streamSend(0, new Uint8Array(0), false);

      // Local state exists
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamWritable(0, 0)).toBeTrue();
      expect(clientConn.streamCapacity(0)).toBe(13500);

      // No packets are sent, therefor no remote state created
      expect(sendPacket(clientConn, serverConn)).toBeNull();
      expect(sendPacket(serverConn, clientConn)).toBeNull();
    });
    describe('closing writable from client', () => {
      test('client closes writable', async () => {
        // Initial writable states
        expect(clientConn.streamWritable(0, 0)).toBeTrue();
        expect(clientConn.streamCapacity(0)).toBe(13500);
        expect(iterToArray(clientConn.writable())).toContain(0);

        // After shutting down
        clientConn.streamShutdown(0, Shutdown.Write, 42);
        // Further shutdowns throw done
        expect(clientConn.streamShutdown(0, Shutdown.Write, 42),
        ).toBeNull();

        // States are unchanged
        expect(clientConn.streamWritable(0, 0)).toBeTrue();
        expect(clientConn.streamCapacity(0)).toBe(13500);
        // No longer in writable iterator
        expect(iterToArray(clientConn.writable())).not.toContain(0);
      });
      test('stream is no longer writable on client', async () => {
        // Can't write after shutdown
        expect(() =>
          clientConn.streamSend(0, Buffer.from('hello'), false),
        ).toThrow('FinalSize');
        expect(() =>
          clientConn.streamSend(0, Buffer.from('hello'), false),
        ).toThrow('FinalSize');

        // Still seen as writable
        expect(clientConn.streamWritable(0, 0)).toBeTrue();
        expect(clientConn.streamCapacity(0)).toBe(13500);
        expect(iterToArray(clientConn.writable())).not.toContain(0);
      });
      test('server receives packet and creates state', async () => {
        // No local state exists initially
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.streamReadable(0)).toBeFalse();
        expect(serverConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(serverConn.readable())).not.toContain(0);
        expect(() => serverConn.streamRecv(0, streamBuf)).toThrow(
          'InvalidStreamState(0)',
        );

        // Packet is sent
        sendPacket(clientConn, serverConn);
        // State is created
        expect(serverConn.isReadable()).toBeTrue();
        expect(serverConn.streamReadable(0)).toBeTrue();
        // And immediately closes
        expect(serverConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(serverConn.readable())).toContain(0);
      });
      test('stream is no longer readable on server', async () => {
        // Stream now throws `StreamReset` with code 42
        expect(() => serverConn.streamRecv(0, streamBuf)).toThrow(
          'StreamReset(42)',
        );
        expect(() => serverConn.streamRecv(0, streamBuf)).toThrow(
          'StreamReset(42)',
        );

        // Connection is now not readable
        expect(serverConn.isReadable()).toBeFalse();
        // Stream is still readable and finished
        expect(serverConn.streamReadable(0)).toBeTrue();
        expect(serverConn.streamFinished(0)).toBeTrue();
        // But not in the iterator
        expect(iterToArray(serverConn.readable())).not.toContain(0);
      });
      test('client receives response packet and updates state', async () => {
        // Initial writable states
        expect(clientConn.streamWritable(0, 0)).toBeTrue();
        expect(clientConn.streamCapacity(0)).toBe(13500);
        expect(iterToArray(clientConn.writable())).not.toContain(0);
        expect(() =>
          clientConn.streamSend(0, Buffer.from('hello'), false),
        ).toThrow('FinalSize');

        // Response is sent
        sendPacket(serverConn, clientConn);

        // No changes to stream state on server
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.streamReadable(0)).toBeTrue();
        expect(serverConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(serverConn.readable())).not.toContain(0);

        // Client changes?
        expect(clientConn.streamWritable(0, 0)).toBeTrue();
        expect(clientConn.streamCapacity(0)).toBe(13500);
        expect(iterToArray(clientConn.writable())).not.toContain(0);
        expect(() =>
          clientConn.streamSend(0, Buffer.from('hello'), false),
        ).toThrow('FinalSize');
      });
      test('no further packets sent', async () => {
        expect(sendPacket(serverConn, clientConn)).toBeNull();
        expect(sendPacket(clientConn, serverConn)).toBeNull();
      });
    });
    describe('closing readable from client', () => {
      test('client closes readable', async () => {
        // Initial readable state
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        expect(clientConn.streamFinished(0)).toBeFalse();
        expect(iterToArray(clientConn.readable())).not.toContain(0);

        // After shutting down
        clientConn.streamShutdown(0, Shutdown.Read, 42);
        // Further shutdowns throw done
        expect(clientConn.streamShutdown(0, Shutdown.Read, 42)).toBeNull();

        // No state change
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        expect(clientConn.streamFinished(0)).toBeFalse();
        expect(iterToArray(clientConn.readable())).not.toContain(0);
      });
      test('Stream is still readable for client', async () => {
        expect(clientConn.streamRecv(0, streamBuf)).toBeNull();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        expect(clientConn.streamFinished(0)).toBeFalse();
        expect(iterToArray(serverConn.readable())).not.toContain(0);
      });
      test('server receives packet and updates state', async () => {
        // Initial state
        expect(serverConn.streamWritable(0, 0)).toBeTrue();
        expect(serverConn.streamCapacity(0)).toBe(13500);
        expect(iterToArray(serverConn.writable())).toContain(0);

        // Sending packet
        sendPacket(clientConn, serverConn);
        expect(sendPacket(clientConn, serverConn)).toBeNull();

        // Stream writable and capacity now throws
        expect(() => serverConn.streamWritable(0, 0)).toThrow(
          'StreamStopped(42)',
        );
        expect(() => serverConn.streamCapacity(0)).toThrow(
          'StreamStopped(42)',
        );
        // But still listed as writable
        expect(iterToArray(serverConn.writable())).toContain(0);
      });
      test('stream no longer writable on server', async () => {
        // Writes now throw
        expect(() =>
          serverConn.streamSend(0, Buffer.from('message'), false),
        ).toThrow('StreamStopped(42)');
        expect(() =>
          serverConn.streamSend(0, Buffer.from('message'), true),
        ).toThrow('StreamStopped(42)');

        expect(() => serverConn.streamWritable(0, 0)).toThrow(
          'StreamStopped(42)',
        );
        expect(() => serverConn.streamCapacity(0)).toThrow(
          'StreamStopped(42)',
        );
        // No longer listed as writable
        expect(iterToArray(serverConn.writable())).not.toContain(0);
      });
      test('client receives response packet and updates state', async () => {
        // Initial readable states
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        expect(clientConn.streamFinished(0)).toBeFalse();
        expect(iterToArray(serverConn.readable())).not.toContain(0);

        // Response is sent
        sendPacket(serverConn, clientConn);
        expect(sendPacket(serverConn, clientConn)).toBeNull();

        // No changes to stream state on server
        expect(() => serverConn.streamWritable(0, 0)).toThrow(
          'StreamStopped(42)',
        );
        expect(() => serverConn.streamCapacity(0)).toThrow(
          'StreamStopped(42)',
        );
        expect(iterToArray(serverConn.writable())).not.toContain(0);

        // Client changes
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        // Stream is now finished
        expect(clientConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(serverConn.readable())).not.toContain(0);
      });
      test('client stream now finished', async () => {
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        expect(clientConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(serverConn.readable())).not.toContain(0);
      });
      test('client responds', async () => {
        sendPacket(clientConn, serverConn); // Ack?
        expect(sendPacket(clientConn, serverConn)).toBeNull();

        // No changes to stream state on server
        expect(() => serverConn.streamWritable(0, 0)).toThrow(
          'StreamStopped(42)',
        );
        expect(() => serverConn.streamCapacity(0)).toThrow(
          'StreamStopped(42)',
        );
        expect(iterToArray(serverConn.writable())).not.toContain(0);

        // Client changes
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        expect(clientConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(serverConn.readable())).not.toContain(0);
      });
      test('stream still readable on client', async () => {
        // Reading stream will never throw, but it does finish.
        expect(clientConn.streamRecv(0, streamBuf)).toBeNull();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        expect(clientConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(serverConn.readable())).not.toContain(0);
      });
      test('no more packets sent', async () => {
        // No new packets
        expect(sendPacket(serverConn, clientConn)).toBeNull();
        expect(sendPacket(clientConn, serverConn)).toBeNull();
      });
    });
    test('server final stream state', async () => {
      // Server states
      expect(() =>
        serverConn.streamSend(0, Buffer.from('message'), true),
      ).toThrow('StreamStopped(42)');
      expect(() => serverConn.streamRecv(0, streamBuf)).toThrow(
        'StreamReset(42)',
      );
      // States change
      expect(serverConn.streamSend(0, Buffer.from('message'), true),
      ).toBeNull();
      expect(() => serverConn.streamRecv(0, streamBuf)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(serverConn.streamShutdown(0, Shutdown.Read, 42)).toBeNull();
      expect(serverConn.streamShutdown(0, Shutdown.Write, 42)).toBeNull();

      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(() => serverConn.streamWritable(0, 0)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(() => serverConn.streamCapacity(0)).toThrow(
        'InvalidStreamState(0)',
      );
    });
    test('client final stream state', async () => {
      // Client never reaches invalid state?
      expect(clientConn.streamRecv(0, streamBuf)).toBeNull();
      expect(() =>
        clientConn.streamSend(0, Buffer.from('message'), true),
      ).toThrow('FinalSize');
      expect(clientConn.streamRecv(0, streamBuf)).toBeNull();
      expect(() =>
        clientConn.streamSend(0, Buffer.from('message'), true),
      ).toThrow('FinalSize');
      expect(clientConn.streamShutdown(0, Shutdown.Read, 42)).toBeNull();
      expect(clientConn.streamShutdown(0, Shutdown.Write, 42)).toBeNull();

      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeTrue();
      expect(clientConn.streamWritable(0, 0)).toBeTrue();
      expect(clientConn.streamCapacity(0)).toBe(13500);
    });
    test('no new packets', async () => {
      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
  });
  describe('stream forced closed by client with buffered data', () => {
    const streamBuf = Buffer.allocUnsafe(1024);

    beforeAll(async () => {
      await setupConnectionsRSA();
      setupStreamState(clientConn, serverConn, 0);
    });

    test('buffering data both ways', async () => {
      clientConn.streamSend(0, Buffer.from('Message1'), false);
      clientConn.streamSend(0, Buffer.from('Message2'), false);
      clientConn.streamSend(0, Buffer.from('Message3'), false);

      serverConn.streamSend(0, Buffer.from('Message1'), false);
      serverConn.streamSend(0, Buffer.from('Message2'), false);
      serverConn.streamSend(0, Buffer.from('Message3'), false);

      sendPacket(clientConn, serverConn);
      sendPacket(serverConn, clientConn);
      sendPacket(clientConn, serverConn);

      // No more packets to send
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
    describe('closing writable from client', () => {
      test('client closes writable', async () => {
        // Initial writable states
        expect(clientConn.streamWritable(0, 0)).toBeTrue();
        expect(clientConn.streamCapacity(0)).toBe(13500);
        expect(iterToArray(clientConn.writable())).toContain(0);

        // After shutting down
        clientConn.streamShutdown(0, Shutdown.Write, 42);
        // Further shutdowns throw done
        expect(clientConn.streamShutdown(0, Shutdown.Write, 42),
        ).toBeNull();

        // States are unchanged
        expect(clientConn.streamWritable(0, 0)).toBeTrue();
        expect(clientConn.streamCapacity(0)).toBe(13500);
        // No longer in writable iterator
        expect(iterToArray(clientConn.writable())).not.toContain(0);
      });
      test('stream is no longer writable on client', async () => {
        // Can't write after shutdown
        expect(() =>
          clientConn.streamSend(0, Buffer.from('hello'), false),
        ).toThrow('FinalSize');
        expect(() =>
          clientConn.streamSend(0, Buffer.from('hello'), false),
        ).toThrow('FinalSize');

        // Still seen as writable
        expect(clientConn.streamWritable(0, 0)).toBeTrue();
        expect(clientConn.streamCapacity(0)).toBe(13500);
        expect(iterToArray(clientConn.writable())).not.toContain(0);
      });
      test('server receives packet and updates state', async () => {
        // Initial state
        expect(serverConn.isReadable()).toBeTrue();
        expect(serverConn.streamReadable(0)).toBeTrue();
        expect(serverConn.streamFinished(0)).toBeFalse();
        expect(iterToArray(serverConn.readable())).toContain(0);

        sendPacket(clientConn, serverConn);

        // Stream is both readable and finished
        expect(serverConn.isReadable()).toBeTrue();
        expect(serverConn.streamReadable(0)).toBeTrue();
        expect(serverConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(serverConn.readable())).toContain(0);
      });
      test('stream is no longer readable on server', async () => {
        // Stream now throws `StreamReset` with code 42
        expect(() => serverConn.streamRecv(0, streamBuf)).toThrow(
          'StreamReset(42)',
        );
        expect(() => serverConn.streamRecv(0, streamBuf)).toThrow(
          'StreamReset(42)',
        );

        // Connection is now not readable
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.streamReadable(0)).toBeTrue();
        expect(serverConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(serverConn.readable())).not.toContain(0);
      });
      test('client receives response packet and updates state', async () => {
        // Initial writable states
        expect(clientConn.streamWritable(0, 0)).toBeTrue();
        expect(clientConn.streamCapacity(0)).toBe(13500);
        expect(iterToArray(clientConn.writable())).not.toContain(0);
        expect(() =>
          clientConn.streamSend(0, Buffer.from('hello'), false),
        ).toThrow('FinalSize');

        // Response is sent
        sendPacket(serverConn, clientConn);

        // No changes to stream state on server
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.streamReadable(0)).toBeTrue();
        expect(serverConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(serverConn.readable())).not.toContain(0);

        // Client changes?
        expect(clientConn.streamWritable(0, 0)).toBeTrue();
        expect(clientConn.streamCapacity(0)).toBe(13500);
        expect(iterToArray(clientConn.writable())).not.toContain(0);
        expect(() =>
          clientConn.streamSend(0, Buffer.from('hello'), false),
        ).toThrow('FinalSize');
      });
      test('no further packets sent', async () => {
        expect(sendPacket(serverConn, clientConn)).toBeNull();
        expect(sendPacket(clientConn, serverConn)).toBeNull();
      });
    });
    describe('closing readable from client', () => {
      test('client closes readable', async () => {
        // Initial readable state
        // Readable due to buffered data
        expect(clientConn.isReadable()).toBeTrue();
        expect(clientConn.streamReadable(0)).toBeTrue();
        expect(clientConn.streamFinished(0)).toBeFalse();
        expect(iterToArray(clientConn.readable())).toContain(0);

        // After shutting down
        clientConn.streamShutdown(0, Shutdown.Read, 42);
        // Further shutdowns throw done
        expect(clientConn.streamShutdown(0, Shutdown.Read, 42)).toBeNull();

        // Client ceases to be readable
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        expect(clientConn.streamFinished(0)).toBeFalse();
        expect(iterToArray(clientConn.readable())).not.toContain(0);
      });
      test('Stream is still readable for client', async () => {
        expect(clientConn.streamRecv(0, streamBuf)).toBeNull();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        expect(clientConn.streamFinished(0)).toBeFalse();
        expect(iterToArray(clientConn.readable())).not.toContain(0);
      });
      test('server receives packet and updates state', async () => {
        // Initial state
        expect(serverConn.streamWritable(0, 0)).toBeTrue();
        expect(serverConn.streamCapacity(0)).toBe(13500);
        expect(iterToArray(serverConn.writable())).toContain(0);

        // Sending packet
        sendPacket(clientConn, serverConn);
        expect(sendPacket(clientConn, serverConn)).toBeNull();

        // Stream writable and capacity now throws
        expect(() => serverConn.streamWritable(0, 0)).toThrow(
          'StreamStopped(42)',
        );
        expect(() => serverConn.streamCapacity(0)).toThrow(
          'StreamStopped(42)',
        );
        // But still listed as writable
        expect(iterToArray(serverConn.writable())).toContain(0);
      });
      test('stream no longer writable on server', async () => {
        // Writes now throw
        expect(() =>
          serverConn.streamSend(0, Buffer.from('message'), false),
        ).toThrow('StreamStopped(42)');
        expect(() =>
          serverConn.streamSend(0, Buffer.from('message'), true),
        ).toThrow('StreamStopped(42)');

        expect(() => serverConn.streamWritable(0, 0)).toThrow(
          'StreamStopped(42)',
        );
        expect(() => serverConn.streamCapacity(0)).toThrow(
          'StreamStopped(42)',
        );
        // No longer listed as writable
        expect(iterToArray(serverConn.writable())).not.toContain(0);
      });
      test('client receives response packet and updates state', async () => {
        // Initial readable states
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        expect(clientConn.streamFinished(0)).toBeFalse();
        expect(iterToArray(clientConn.readable())).not.toContain(0);

        // Response is sent
        sendPacket(serverConn, clientConn);
        expect(sendPacket(serverConn, clientConn)).toBeNull();

        // Client changes
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        // Stream is now finished
        expect(clientConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(clientConn.readable())).not.toContain(0);

        // No changes to stream state on server
        expect(() => serverConn.streamWritable(0, 0)).toThrow(
          'StreamStopped(42)',
        );
        expect(() => serverConn.streamCapacity(0)).toThrow(
          'StreamStopped(42)',
        );
        expect(iterToArray(serverConn.writable())).not.toContain(0);

        // Client changes
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        // Stream is now finished
        expect(clientConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(clientConn.readable())).not.toContain(0);
      });
      test('client stream now finished', async () => {
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        expect(clientConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(clientConn.readable())).not.toContain(0);
      });
      test('client responds', async () => {
        sendPacket(clientConn, serverConn); // Ack?
        expect(sendPacket(clientConn, serverConn)).toBeNull();

        // No changes to stream state on server
        expect(() => serverConn.streamWritable(0, 0)).toThrow(
          'StreamStopped(42)',
        );
        expect(() => serverConn.streamCapacity(0)).toThrow(
          'StreamStopped(42)',
        );
        expect(iterToArray(serverConn.writable())).not.toContain(0);

        // Client changes
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        expect(clientConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(clientConn.readable())).not.toContain(0);
      });
      test('stream still readable on client', async () => {
        // Reading stream will never throw, but it does finish.
        expect(clientConn.streamRecv(0, streamBuf)).toBeNull();
        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        expect(clientConn.streamFinished(0)).toBeTrue();
        expect(iterToArray(clientConn.readable())).not.toContain(0);
      });
      test('no more packets sent', async () => {
        // No new packets
        expect(sendPacket(serverConn, clientConn)).toBeNull();
        expect(sendPacket(clientConn, serverConn)).toBeNull();
      });
    });
    test('server final stream state', async () => {
      // Server states
      expect(() =>
        serverConn.streamSend(0, Buffer.from('message'), true),
      ).toThrow('StreamStopped(42)');
      expect(() => serverConn.streamRecv(0, streamBuf)).toThrow(
        'StreamReset(42)',
      );
      // States change
      expect(serverConn.streamSend(0, Buffer.from('message'), true),
      ).toBeNull();
      expect(() => serverConn.streamRecv(0, streamBuf)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(serverConn.streamShutdown(0, Shutdown.Read, 42)).toBeNull();
      expect(serverConn.streamShutdown(0, Shutdown.Write, 42)).toBeNull();

      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeTrue();
      expect(() => serverConn.streamWritable(0, 0)).toThrow(
        'InvalidStreamState(0)',
      );
      expect(() => serverConn.streamCapacity(0)).toThrow(
        'InvalidStreamState(0)',
      );
    });
    test('client final stream state', async () => {
      // Client never reaches invalid state?
      expect(clientConn.streamRecv(0, streamBuf)).toBeNull();
      expect(() =>
        clientConn.streamSend(0, Buffer.from('message'), true),
      ).toThrow('FinalSize');
      expect(clientConn.streamRecv(0, streamBuf)).toBeNull();
      expect(() =>
        clientConn.streamSend(0, Buffer.from('message'), true),
      ).toThrow('FinalSize');
      expect(clientConn.streamShutdown(0, Shutdown.Read, 42)).toBeNull();
      expect(clientConn.streamShutdown(0, Shutdown.Write, 42)).toBeNull();

      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeTrue();
      expect(clientConn.streamWritable(0, 0)).toBeTrue();
      expect(clientConn.streamCapacity(0)).toBe(13500);
    });
    test('no new packets', async () => {
      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
  });

  // Connection closing
  // Note:
  // It seems that stream states are not aware of connection states.
  // So a closing stream does not trigger streams ending or even cleaning up.
  // This also means, normal stream cleanup expectations don't happen.
  // Stream will still be writable but throw.
  // Stream will still be readable but never finish.
  describe('connection closes with active stream, no buffered stream data', () => {
    // Note:
    //  Seems like stream state is not cleaned up by the stream closing.
    //  We can still write to it and the capacity will change, so the writable is still being buffered?
    //  Do we need to close the stream to free up memory?

    const streamBuf = Buffer.allocUnsafe(1024);

    beforeAll(async () => {
      await setupConnectionsRSA();
      setupStreamState(clientConn, serverConn, 0);
    });

    test('no new packets', async () => {
      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
    test('client closing connection', async () => {
      clientConn.close(true, 42, Buffer.from('some reason'));

      sendPacket(clientConn, serverConn);

      expect(clientConn.isDraining()).toBeTrue();
      expect(clientConn.isClosed()).toBeFalse();
      expect(serverConn.isDraining()).toBeTrue();
      expect(serverConn.isClosed()).toBeFalse();

      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
    test('client stream still functions', async () => {
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamWritable(0, 0)).toBeTrue();
      expect(clientConn.streamCapacity(0)).toBe(13500);

      // Can still send
      expect(clientConn.streamSend(0, Buffer.from('message'), false)).toBe(7);
      // Can still recv
      expect(clientConn.streamRecv(0, streamBuf)).toBeNull();

      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
    test('server stream still functions', async () => {
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeFalse();
      expect(serverConn.streamWritable(0, 0)).toBeTrue();
      expect(serverConn.streamCapacity(0)).toBe(13500);

      // Can still send
      expect(serverConn.streamSend(0, Buffer.from('message'), false)).toBe(7);
      // Can still recv
      expect(serverConn.streamRecv(0, streamBuf)).toBeNull();

      expect(sendPacket(clientConn, serverConn)).toBeNull();
      expect(sendPacket(serverConn, clientConn)).toBeNull();
    });
    test('waiting for closed state', async () => {
      await sleep(100);
      await Promise.all([
        sleep((clientConn.timeout() ?? 0) + 1).then(() =>
          clientConn.onTimeout(),
        ),
        sleep((serverConn.timeout() ?? 0) + 1).then(() =>
          serverConn.onTimeout(),
        ),
      ]);
      expect(clientConn.timeout()).toBeNull();
      expect(serverConn.timeout()).toBeNull();

      expect(clientConn.isDraining()).toBeTrue();
      expect(clientConn.isClosed()).toBeTrue();
      expect(serverConn.isDraining()).toBeTrue();
      expect(serverConn.isClosed()).toBeTrue();

      expect(sendPacket(clientConn, serverConn)).toBeNull();
      expect(sendPacket(serverConn, clientConn)).toBeNull();
    });
    test('client stream still functions', async () => {
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamWritable(0, 0)).toBeTrue();
      expect(clientConn.streamCapacity(0)).toBeLessThan(13500);

      // Can still send
      expect(clientConn.streamSend(0, Buffer.from('message'), false)).toBe(7);
      // Can still recv
      expect(clientConn.streamRecv(0, streamBuf)).toBeNull();
    });
    test('server stream still functions', async () => {
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeFalse();
      expect(serverConn.streamWritable(0, 0)).toBeTrue();
      expect(serverConn.streamCapacity(0)).toBeLessThan(13500);

      // Can still send
      expect(serverConn.streamSend(0, Buffer.from('message'), false)).toBe(7);
      // Can still recv
      expect(serverConn.streamRecv(0, streamBuf)).toBeNull();
    });
    test('no new packets', async () => {
      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
    test('manually clean up client stream state', async () => {
      clientConn.streamShutdown(0, Shutdown.Read, 42);
      expect(clientConn.streamShutdown(0, Shutdown.Read, 42)).toBeNull();
      clientConn.streamShutdown(0, Shutdown.Write, 42);
      expect(clientConn.streamShutdown(0, Shutdown.Write, 42)).toBeNull();

      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();

      // No change
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamWritable(0, 0)).toBeTrue();
      expect(clientConn.streamCapacity(0)).toBeLessThan(13500);

      // Can't send
      expect(() =>
        clientConn.streamSend(0, Buffer.from('message'), false),
      ).toThrow('FinalSize');
      // Can still recv
      expect(clientConn.streamRecv(0, streamBuf)).toBeNull();

      // Still no change
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamWritable(0, 0)).toBeTrue();
      expect(clientConn.streamCapacity(0)).toBeLessThan(13500);
    });
    test('manually clean up server stream state', async () => {
      serverConn.streamShutdown(0, Shutdown.Read, 42);
      expect(serverConn.streamShutdown(0, Shutdown.Read, 42)).toBeNull();
      serverConn.streamShutdown(0, Shutdown.Write, 42);
      expect(serverConn.streamShutdown(0, Shutdown.Write, 42)).toBeNull();

      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();

      // No change
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeFalse();
      expect(serverConn.streamWritable(0, 0)).toBeTrue();
      expect(serverConn.streamCapacity(0)).toBeLessThanOrEqual(13500);

      // Can't send
      expect(() =>
        serverConn.streamSend(0, Buffer.from('message'), false),
      ).toThrow('FinalSize');
      // Can still recv
      expect(serverConn.streamRecv(0, streamBuf)).toBeNull();

      // Still no change
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeFalse();
      expect(serverConn.streamWritable(0, 0)).toBeTrue();
      expect(serverConn.streamCapacity(0)).toBeLessThanOrEqual(13500);
    });
    test('no new packets', async () => {
      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
  });
  describe('connection closes with active stream, with buffered stream data', () => {
    const streamBuf = Buffer.allocUnsafe(1024);

    beforeAll(async () => {
      await setupConnectionsRSA();
      setupStreamState(clientConn, serverConn, 0);
    });

    test('buffering data both ways', async () => {
      clientConn.streamSend(0, Buffer.from('Message1'), false);
      clientConn.streamSend(0, Buffer.from('Message2'), false);
      clientConn.streamSend(0, Buffer.from('Message3'), false);

      serverConn.streamSend(0, Buffer.from('Message1'), false);
      serverConn.streamSend(0, Buffer.from('Message2'), false);
      serverConn.streamSend(0, Buffer.from('Message3'), false);

      sendPacket(clientConn, serverConn);
      sendPacket(serverConn, clientConn);
      sendPacket(clientConn, serverConn);
    });
    test('no new packets', async () => {
      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
    test('client closing connection', async () => {
      clientConn.close(true, 42, Buffer.from('some reason'));

      sendPacket(clientConn, serverConn);

      expect(clientConn.isDraining()).toBeTrue();
      expect(clientConn.isClosed()).toBeFalse();
      expect(serverConn.isDraining()).toBeTrue();
      expect(serverConn.isClosed()).toBeFalse();

      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
    test('client stream still functions', async () => {
      expect(clientConn.isReadable()).toBeTrue();
      expect(clientConn.streamReadable(0)).toBeTrue();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamWritable(0, 0)).toBeTrue();
      expect(clientConn.streamCapacity(0)).toBe(13500);

      // Can still send
      expect(clientConn.streamSend(0, Buffer.from('message'), false)).toBe(7);
      // Can still recv
      const result = clientConn.streamRecv(0, streamBuf);
      expect(result).not.toBeNull();
      const [bytes, fin] = result!;
      expect(bytes).toBe(24);
      expect(fin).toBeFalse();
      expect(streamBuf.subarray(0, bytes).toString()).toEqual(
        'Message1Message2Message3',
      );

      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();

      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamWritable(0, 0)).toBeTrue();
      expect(clientConn.streamCapacity(0)).toBeLessThan(13500);
    });
    test('server stream still functions', async () => {
      expect(serverConn.isReadable()).toBeTrue();
      expect(serverConn.streamReadable(0)).toBeTrue();
      expect(serverConn.streamFinished(0)).toBeFalse();
      expect(serverConn.streamWritable(0, 0)).toBeTrue();
      expect(serverConn.streamCapacity(0)).toBe(13500);

      // Can still send
      expect(serverConn.streamSend(0, Buffer.from('message'), false)).toBe(7);
      // Can still recv
      const result = serverConn.streamRecv(0, streamBuf);
      expect(result).not.toBeNull();
      const [bytes, fin] = result!;
      expect(bytes).toBe(24);
      expect(fin).toBeFalse();
      expect(streamBuf.subarray(0, bytes).toString()).toEqual(
        'Message1Message2Message3',
      );

      expect(sendPacket(clientConn, serverConn)).toBeNull();
      expect(sendPacket(serverConn, clientConn)).toBeNull();

      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeFalse();
      expect(serverConn.streamWritable(0, 0)).toBeTrue();
      expect(serverConn.streamCapacity(0)).toBeLessThan(13500);
    });
    test('waiting for closed state', async () => {
      await sleep(100);
      await Promise.all([
        sleep((clientConn.timeout() ?? 0) + 1).then(() =>
          clientConn.onTimeout(),
        ),
        sleep((serverConn.timeout() ?? 0) + 1).then(() =>
          serverConn.onTimeout(),
        ),
      ]);
      expect(clientConn.timeout()).toBeNull();
      expect(serverConn.timeout()).toBeNull();

      expect(clientConn.isDraining()).toBeTrue();
      expect(clientConn.isClosed()).toBeTrue();
      expect(serverConn.isDraining()).toBeTrue();
      expect(serverConn.isClosed()).toBeTrue();

      expect(sendPacket(clientConn, serverConn)).toBeNull();
      expect(sendPacket(serverConn, clientConn)).toBeNull();
    });
    test('client stream still functions', async () => {
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamWritable(0, 0)).toBeTrue();
      expect(clientConn.streamCapacity(0)).toBeLessThan(13500);

      // Can still send
      expect(clientConn.streamSend(0, Buffer.from('message'), false)).toBe(7);
      // Can still recv
      expect(clientConn.streamRecv(0, streamBuf)).toBeNull();
    });
    test('server stream still functions', async () => {
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeFalse();
      expect(serverConn.streamWritable(0, 0)).toBeTrue();
      expect(serverConn.streamCapacity(0)).toBeLessThan(13500);

      // Can still send
      expect(serverConn.streamSend(0, Buffer.from('message'), false)).toBe(7);
      // Can still recv
      expect(serverConn.streamRecv(0, streamBuf)).toBeNull();
    });
    test('no new packets', async () => {
      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
    test('manually clean up client stream state', async () => {
      clientConn.streamShutdown(0, Shutdown.Read, 42);
      expect(clientConn.streamShutdown(0, Shutdown.Read, 42)).toBeNull();
      clientConn.streamShutdown(0, Shutdown.Write, 42);
      expect(clientConn.streamShutdown(0, Shutdown.Write, 42)).toBeNull();

      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();

      // No change
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamWritable(0, 0)).toBeTrue();
      expect(clientConn.streamCapacity(0)).toBeLessThan(13500);

      // Can't send
      expect(() =>
        clientConn.streamSend(0, Buffer.from('message'), false),
      ).toThrow('FinalSize');
      // Can still recv
      expect(clientConn.streamRecv(0, streamBuf)).toBeNull();

      // Still no change
      expect(clientConn.isReadable()).toBeFalse();
      expect(clientConn.streamReadable(0)).toBeFalse();
      expect(clientConn.streamFinished(0)).toBeFalse();
      expect(clientConn.streamWritable(0, 0)).toBeTrue();
      expect(clientConn.streamCapacity(0)).toBeLessThan(13500);
    });
    test('manually clean up server stream state', async () => {
      serverConn.streamShutdown(0, Shutdown.Read, 42);
      expect(serverConn.streamShutdown(0, Shutdown.Read, 42)).toBeNull();
      serverConn.streamShutdown(0, Shutdown.Write, 42);
      expect(serverConn.streamShutdown(0, Shutdown.Write, 42)).toBeNull();

      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();

      // No change
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeFalse();
      expect(serverConn.streamWritable(0, 0)).toBeTrue();
      expect(serverConn.streamCapacity(0)).toBeLessThanOrEqual(13500);

      // Can't send
      expect(() =>
        serverConn.streamSend(0, Buffer.from('message'), false),
      ).toThrow('FinalSize');
      // Can still recv
      expect(serverConn.streamRecv(0, streamBuf)).toBeNull();

      // Still no change
      expect(serverConn.isReadable()).toBeFalse();
      expect(serverConn.streamReadable(0)).toBeFalse();
      expect(serverConn.streamFinished(0)).toBeFalse();
      expect(serverConn.streamWritable(0, 0)).toBeTrue();
      expect(serverConn.streamCapacity(0)).toBeLessThanOrEqual(13500);
    });
    test('no new packets', async () => {
      // No new packets
      expect(sendPacket(serverConn, clientConn)).toBeNull();
      expect(sendPacket(clientConn, serverConn)).toBeNull();
    });
  });
});
