// to test the QUICClient
// we need to be able to setup ta test server
import type { Crypto, Host } from '@/types';
import Logger, { LogLevel, StreamHandler } from '@matrixai/logger';
import QUICClient from '@/QUICClient';
import * as testsUtils from './utils';

// No need for the the quickcheck yet
// we are testing basic behaviour here
// but we may need some testing structure

describe(QUICClient.name, () => {
  const logger = new Logger(`${QUICClient.name} Test`, LogLevel.WARN, [
    new StreamHandler(),
  ]);
  // This has to be setup asynchronously due to key generation
  let crypto: {
    key: ArrayBuffer;
    ops: Crypto;
  };
  beforeEach(async () => {
    crypto = {
      key: await testsUtils.generateKey(),
      ops: {
        sign: testsUtils.sign,
        verify: testsUtils.verify,
        randomBytes: testsUtils.randomBytes,
      },
    };
  });
  afterEach(async () => {
  });
  test('', async () => {

    const data = new ArrayBuffer(32);
    await crypto.ops.randomBytes(data);
    console.log(data)

    const signature = await crypto.ops.sign(crypto.key, data);
    console.log(signature);

    const verified = await crypto.ops.verify(crypto.key, data, signature);
    console.log(verified);



    // Prior to this we have to run a server!!

    // Here we want to create a client
    // which is 1 specific QUICConnection
    // This means we need to host a localhost too
    // Note that HOST must be IP, we don't expect to resolve the hostnames yet
    // const client = QUICClient.createQUICClient({
    //   host: '127.0.0.1' as Host,

    // });

  });
  // We need to test shared socket later
});
