import type { Connection, StreamIter } from '@/native';
import type { ClientCrypto, Host, Port, ServerCrypto } from '@';
import { Host as HostPort, quiche } from '@/native';
import QUICConnectionId from '@/QUICConnectionId';
import { QUICConfig } from '@';
import { buildQuicheConfig, clientDefault, serverDefault } from '@/config';
import * as utils from '@/utils';
import * as testsUtils from '../utils';

function sendPacket(
  connectionSource: Connection,
  connectionDestination: Connection,
) {
  const dataBuffer = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
  const [serverSendLength, sendInfo] = connectionSource.send(dataBuffer);
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
function initStreamState(
  connectionSource: Connection,
  connectionDestination: Connection,
  streamId: number,
) {
  const message = Buffer.from('Message');
  connectionSource.streamSend(0, message, false);
  sendPacket(connectionSource, connectionDestination);

  throw Error('TMP IMP');
}

describe('quiche stream lifecycle', () => {
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
    ops: ClientCrypto & ServerCrypto;
  };

  let clientConn: Connection;
  let serverConn: Connection;

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

  describe('with RSA certs', () => {
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

      // Randomly genrate the client SCID
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
      let [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);
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
      [clientSendLength, clientSendInfo] = clientConn.send(clientBuffer);

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

    describe('stream can be created', () => {
      const streamBuf = Buffer.allocUnsafe(1024);

      beforeAll(setupConnectionsRSA);

      test('initializing stream with 0-len message', () => {
        clientConn.streamSend(0, new Uint8Array(0), false);
        // No data is sent
        expect(() => sendPacket(clientConn, serverConn)).toThrow('Done');
        expect(iterToArray(clientConn.readable())).not.toContain(0);
        expect(iterToArray(clientConn.writable())).toContain(0);

        expect(clientConn.isReadable()).toBeFalse();
        expect(clientConn.streamFinished(0)).toBeFalse();
        expect(clientConn.streamReadable(0)).toBeFalse();
        expect(clientConn.streamCapacity(0)).toBeGreaterThan(0);
        expect(clientConn.streamWritable(0, 0)).toBeTrue();

        // No new packets
        expect(() => sendPacket(serverConn, clientConn)).toThrow('Done');
        expect(() => sendPacket(clientConn, serverConn)).toThrow('Done');
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

        const [bytes, fin] = serverConn.streamRecv(0, streamBuf);
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
        expect(() => sendPacket(serverConn, clientConn)).toThrow('Done');
        expect(() => sendPacket(clientConn, serverConn)).toThrow('Done');
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
        const [bytes, fin] = clientConn.streamRecv(0, streamBuf);
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
        expect(() => sendPacket(serverConn, clientConn)).toThrow('Done');
        expect(() => sendPacket(clientConn, serverConn)).toThrow('Done');
      });
      test('closing forward stream with fin frame', async () => {
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

        // Server state
        expect(iterToArray(serverConn.readable())).toContain(0);
        expect(iterToArray(serverConn.writable())).toContain(0);
        expect(serverConn.isReadable()).toBeTrue();
        // Is finished
        expect(serverConn.streamFinished(0)).toBeTrue();
        // Still readable
        expect(serverConn.streamReadable(0)).toBeTrue();
        expect(serverConn.streamCapacity(0)).toBeGreaterThan(0);
        expect(serverConn.streamWritable(0, 0)).toBeTrue();

        // Reading message
        const [bytes, fin] = serverConn.streamRecv(0, streamBuf);
        expect(bytes).toEqual(0);
        expect(fin).toBe(true);

        expect(serverConn.streamFinished(0)).toBeTrue();
        // Nothing left to read
        expect(serverConn.isReadable()).toBeFalse();
        expect(serverConn.streamReadable(0)).toBeFalse();
        expect(() => serverConn.streamRecv(0, streamBuf)).toThrow('Done');

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
        expect(() => sendPacket(serverConn, clientConn)).toThrow('Done');
        expect(() => sendPacket(clientConn, serverConn)).toThrow('Done');
      });
      test('closing reverse stream with fin frame', async () => {
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
        const [bytes, fin] = clientConn.streamRecv(0, streamBuf);
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

        // No new packets
        expect(() => sendPacket(serverConn, clientConn)).toThrow('Done');
        expect(() => sendPacket(clientConn, serverConn)).toThrow('Done');
      });
    });
  });
});

// TODO:
//  Stream only finishes after reading out data.
//  test permutations of force closing sending/receiving, by client or server, with and without buffered data.
