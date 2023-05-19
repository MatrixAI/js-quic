import QUICConnectionId from '@/QUICConnectionId';
import { quiche } from '@/native';
import * as testsUtils from './utils';

describe(QUICConnectionId.name, () => {
  test('connection ID is a Uint8Array', async () => {
    const cidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
    await testsUtils.randomBytes(cidBuffer);
    const cid = new QUICConnectionId(cidBuffer);
    expect(cid).toBeInstanceOf(Uint8Array);
  });
  test('connection ID encode to hex string and decode from hex string', async () => {
    const cidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
    await testsUtils.randomBytes(cidBuffer);
    const cid = new QUICConnectionId(cidBuffer);
    const cidString = cid.toString();
    const cid_ = QUICConnectionId.fromString(cidString);
    expect(cid).toEqual(cid_);
  });
  test('connection ID to buffer and from buffer is zero-copy', async () => {
    const cidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
    await testsUtils.randomBytes(cidBuffer);
    const cid = new QUICConnectionId(cidBuffer);
    expect(cid.toBuffer().buffer).toBe(cidBuffer);
    const cid_ = QUICConnectionId.fromBuffer(cid.toBuffer());
    expect(cid_.buffer).toBe(cidBuffer);
  });
});
