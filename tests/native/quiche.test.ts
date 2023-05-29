import { quiche } from '@/native';

describe('quiche', () => {
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
});
