#!/usr/bin/env node

import type { Host, Port } from '../types';
import type * as events from '../events';
import process from 'process';
import { webcrypto } from 'crypto';
import Logger from '@matrixai/logger';
import QUICServer from '../QUICServer';

async function main(_argv = process.argv): Promise<number> {
  _argv = _argv.slice(2); // Removing prepended file paths

  const cryptoKey = await webcrypto.subtle.generateKey(
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );

  const key = await webcrypto.subtle.exportKey('raw', cryptoKey);

  const crypto = {
    key,
    ops: {
      sign: async (_key: ArrayBuffer, data: ArrayBuffer) => {
        // Use `cryptoKey` due to webcrypto requirements
        return webcrypto.subtle.sign('HMAC', cryptoKey, data);
      },
      verify: async (
        _key: ArrayBuffer,
        data: ArrayBuffer,
        sig: ArrayBuffer,
      ) => {
        // Use `cryptoKey` due to webcrypto requirements
        return webcrypto.subtle.verify('HMAC', cryptoKey, sig, data);
      },
      randomBytes: async (data: ArrayBuffer) => {
        webcrypto.getRandomValues(new Uint8Array(data));
      },
    },
  };

  const logger = new Logger();

  const server = new QUICServer({
    crypto,
    logger: logger.getChild(QUICServer.name),
    config: {},
  });

  await server.start({
    host: '127.0.0.1' as Host,
    port: 55555 as Port,
  });

  const handleSignal = async () => {
    await server.stop();
  };

  // SIGINT, SIGTERM, SIGQUIT, SIGHUP
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
  process.on('SIGTERM', handleSignal);
  process.on('SIGHUP', handleSignal);

  const handleStream = async (e: events.QUICConnectionStreamEvent) => {
    const stream = e.detail;

    logger.debug(`Got Stream ${stream.streamId}`);

    // Once we have the stream
    // We need to interact with the stream and read out the data
    const writer = stream.writable.getWriter();

    // It only reads once this auto releases the internal reader
    for await (const read of stream.readable) {
      const readBuffer = Buffer.from(read);
      logger.debug(
        `STREAM READ: ${readBuffer} ${JSON.stringify(
          readBuffer.toString('utf-8'),
        )}`,
      );
    }
    // If the `fin` was received, the stream would be cancelled
    // Then this is unnecessary, but it's still good practice.
    await stream.readable.cancel();

    await writer.write(Buffer.from('Hello World'));
    await writer.close();
    // Always release your locks
    writer.releaseLock();

    // The stream will be auto destroyed
  };

  const handleConnection = (e: events.QUICServerConnectionEvent) => {
    const conn = e.detail;
    logger.debug(`Got Connection ${conn.connectionId.toString()}`);

    conn.addEventListener('stream', handleStream);
    conn.addEventListener(
      'destroy',
      () => {
        conn.removeEventListener('stream', handleStream);
      },
      { once: true },
    );
  };

  server.addEventListener('connection', handleConnection);
  server.addEventListener(
    'stop',
    () => {
      server.removeEventListener('connection', handleConnection);
    },
    { once: true },
  );

  process.exitCode = 0;
  return process.exitCode;
}

if (require.main === module) {
  void main();
}

export default main;
