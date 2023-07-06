import { quiche } from '@/native';
import * as testsUtils from '../utils';

describe('quiche', () => {
  test('frame parsing', async () => {
    const frame = Buffer.from('hello world');
    expect(() =>
      quiche.Header.fromSlice(frame, quiche.MAX_CONN_ID_LEN),
    ).toThrow('BufferTooShort');
    // `InvalidPacket` is also possible but even random bytes can
    // look like a packet, so it's not tested here
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
