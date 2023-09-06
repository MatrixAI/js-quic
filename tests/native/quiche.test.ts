import { quiche } from '@/native';
import * as testsUtils from '../utils';

describe('native/quiche', () => {
  test('packet parsing', async () => {
    // Remember a UDP payload only has 1 QUIC packet
    // But 1 QUIC packet can have multiple QUIC frames
    expect(() =>
      quiche.Header.fromSlice(Buffer.from('hello world'), quiche.MAX_CONN_ID_LEN),
    ).toThrow('BufferTooShort');
    expect(() =>
      quiche.Header.fromSlice(
        Buffer.alloc(quiche.MAX_CONN_ID_LEN),
        quiche.MAX_CONN_ID_LEN
      )
    ).toThrow('BufferTooShort');
    const header = quiche.Header.fromSlice(
      Buffer.alloc(quiche.MAX_CONN_ID_LEN + 1),
      quiche.MAX_CONN_ID_LEN
    );
    expect(header.ty).toBe(quiche.Type.Short);
    // Triggering `InvalidPacket` seems to require a non-short
    // packet that has some incorrect structure, which means
    // random data looks like short packets
    for (let i = 0; i < 100; i++) {
      // It's possible that eventually this may generate a long packet
      // that becomes invalid, but after trying 10,000 times, still nothing
      // If it does happen, then log out the packet!
      const packet = Buffer.alloc(quiche.MAX_DATAGRAM_SIZE);
      await testsUtils.randomBytes(packet)
      try {
        const h = quiche.Header.fromSlice(packet, quiche.MAX_CONN_ID_LEN);
        expect(h.ty).toBe(quiche.Type.Short);
      } catch (e) {
        if (e.message === 'InvalidPacket') {
          // Store this somewhere!
          console.warn('InvalidPacket found!', ...packet);
        }
      }
    }
  });
  test('version negotiation', async () => {
    const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
    await testsUtils.randomBytes(scidBuffer);
    const scid = new Uint8Array(scidBuffer);
    const dcidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
    await testsUtils.randomBytes(dcidBuffer);
    const dcid = new Uint8Array(dcidBuffer);
    const versionPacket = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
    const versionPacketLength = quiche.negotiateVersion(
      scid,
      dcid,
      versionPacket,
    );
    const serverHeaderVersion = quiche.Header.fromSlice(
      versionPacket.subarray(0, versionPacketLength),
      quiche.MAX_CONN_ID_LEN,
    );
    expect(serverHeaderVersion.ty).toBe(quiche.Type.VersionNegotiation);
  });
});
