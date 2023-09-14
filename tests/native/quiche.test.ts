import { testProp, fc } from '@fast-check/jest';
import { quiche } from '@/native';
import * as testsUtils from '../utils';

describe('native/quiche', () => {
  testProp(
    'packet parsing',
    [testsUtils.bufferArb({ minLength: 0, maxLength: 100})],
    (packet) => {
      // Remember a UDP payload only has 1 QUIC packet
      // But 1 QUIC packet can have multiple QUIC frames
      try {
        // The `quiche.MAX_CONN_ID_LEN` is 20 bytes
        // From 21 bytes it is possible to by pass `BufferTooShort` but it is not guaranteed
        // However 20 bytes and under is always `BufferTooShort`
        quiche.Header.fromSlice(packet, quiche.MAX_CONN_ID_LEN);
      } catch (e) {
        expect(e.message).toBe('BufferTooShort');
        // InvalidPacket seems very rare, save it as an example if you find one!
      }
    }
  );
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
