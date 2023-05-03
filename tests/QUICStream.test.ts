import type * as events from '@/events';
import type { Crypto, Host, Port } from '@';
import { testProp, fc } from '@fast-check/jest';
import Logger, { formatting, LogLevel, StreamHandler } from '@matrixai/logger';
import { promise } from '@/utils';
import QUICServer from '@/QUICServer';
import QUICClient from '@/QUICClient';
import QUICStream from '@/QUICStream';
import { tlsConfigWithCaArb } from './tlsUtils';
import * as testsUtils from './utils';
import { sleep } from './utils';

describe(QUICStream.name, () => {
  const logger = new Logger(`${QUICStream.name} Test`, LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  // This has to be setup asynchronously due to key generation
  let crypto: {
    key: ArrayBuffer;
    ops: Crypto;
  };

  // We need to test the stream making
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
  testProp(
    'should create streams',
    [tlsConfigWithCaArb, fc.integer({ min: 5, max: 50 }).noShrink()],
    async (tlsConfigProm, streamsNum) => {
      const connectionEventProm = promise<events.QUICServerConnectionEvent>();
      const tlsConfig = await tlsConfigProm;
      let server: QUICServer | null = null;
      let client: QUICClient | null = null;
      try {
        server = new QUICServer({
          crypto,
          logger: logger.getChild(QUICServer.name),
          config: {
            tlsConfig: tlsConfig.tlsConfig,
            verifyPeer: false,
            logKeys: './tmp/key.log',
          },
        });
        server.addEventListener(
          'connection',
          (e: events.QUICServerConnectionEvent) =>
            connectionEventProm.resolveP(e),
        );
        await server.start({
          host: '127.0.0.1' as Host,
        });
        client = await QUICClient.createQUICClient({
          host: '::ffff:127.0.0.1' as Host,
          port: server.port,
          localHost: '::' as Host,
          crypto,
          logger: logger.getChild(QUICClient.name),
          config: {
            verifyPeer: false,
          },
        });
        const conn = (await connectionEventProm.p).detail;
        // Do the test
        let streamCount = 0;
        const streamCreationProm = promise();
        conn.addEventListener('stream', () => {
          streamCount += 1;
          if (streamCount >= streamsNum) streamCreationProm.resolveP();
        });
        // Lets make a new streams.
        // const message = Buffer.from('hello!');
        const message = Buffer.from('Helllo!');
        for (let i = 0; i < streamsNum; i++) {
          const stream = await client.connection.streamNew();
          const writer = stream.writable.getWriter();
          await writer.write(message);
          writer.releaseLock();
        }
        await Promise.race([
          streamCreationProm.p,
          sleep(500).then(() => {
            throw Error('Creation timed out');
          }),
        ]);
        expect(streamCount).toBe(streamsNum);
      } finally {
        await client?.destroy({ force: true });
        await server?.stop({ force: true });
      }
    },
    { numRuns: 10 },
  );
  testProp(
    'destroying stream should clean up on both ends while streams are used',
    [
      tlsConfigWithCaArb,
      fc.integer({ min: 5, max: 10 }).noShrink(),
      fc.uint8Array({ minLength: 1 }).noShrink(),
    ],
    async (tlsConfigProm, streamsNum, message) => {
      const connectionEventProm = promise<events.QUICServerConnectionEvent>();
      const tlsConfig = await tlsConfigProm;
      let server: QUICServer | null = null;
      let client: QUICClient | null = null;
      const streams: Array<QUICStream> = [];
      try {
        server = new QUICServer({
          crypto,
          logger: logger.getChild(QUICServer.name),
          config: {
            tlsConfig: tlsConfig.tlsConfig,
            verifyPeer: false,
          },
        });
        server.addEventListener(
          'connection',
          (e: events.QUICServerConnectionEvent) =>
            connectionEventProm.resolveP(e),
        );
        await server.start({
          host: '127.0.0.1' as Host,
        });
        client = await QUICClient.createQUICClient({
          host: '::ffff:127.0.0.1' as Host,
          port: server.port,
          localHost: '::' as Host,
          crypto,
          logger: logger.getChild(QUICClient.name),
          config: {
            verifyPeer: false,
          },
        });
        const conn = (await connectionEventProm.p).detail;
        // Do the test
        let streamCreatedCount = 0;
        let streamEndedCount = 0;
        const streamCreationProm = promise();
        const streamEndedProm = promise();
        conn.addEventListener(
          'stream',
          (asd: events.QUICConnectionStreamEvent) => {
            const stream = asd.detail;
            streamCreatedCount += 1;
            if (streamCreatedCount >= streamsNum) streamCreationProm.resolveP();
            void stream.readable
              .pipeTo(stream.writable)
              // Ignore errors
              .catch(() => {})
              .finally(() => {
                streamEndedCount += 1;
                if (streamEndedCount >= streamsNum) streamEndedProm.resolveP();
              });
          },
        );
        // Lets make a new streams.
        for (let i = 0; i < streamsNum; i++) {
          const stream = await client.connection.streamNew();
          streams.push(stream);
          const writer = stream.writable.getWriter();
          await writer.write(message);
          writer.releaseLock();
        }
        await Promise.race([
          streamCreationProm.p,
          sleep(100).then(() => {
            throw Error('Creation timed out');
          }),
        ]);
        // Start destroying streams
        await Promise.allSettled(streams.map((stream) => stream.destroy()));
        await Promise.race([
          streamEndedProm.p,
          sleep(100).then(() => {
            throw Error('Ending timed out');
          }),
        ]);
        expect(streamCreatedCount).toBe(streamsNum);
        expect(streamEndedCount).toBe(streamsNum);
      } finally {
        await client?.destroy({ force: true });
        await server?.stop({ force: true });
      }
    },
    { numRuns: 10 },
  );
  testProp(
    'should send data over stream',
    [
      tlsConfigWithCaArb,
      fc
        .array(fc.array(fc.uint8Array({ minLength: 1 })), {
          minLength: 1,
        })
        .noShrink(),
    ],
    async (tlsConfigProm, streamsData) => {
      const connectionEventProm = promise<events.QUICServerConnectionEvent>();
      const tlsConfig = await tlsConfigProm;
      let server: QUICServer | null = null;
      let client: QUICClient | null = null;
      try {
        server = new QUICServer({
          crypto,
          logger: logger.getChild(QUICServer.name),
          config: {
            tlsConfig: tlsConfig.tlsConfig,
            verifyPeer: false,
            logKeys: './tmp/key.log',
          },
        });
        server.addEventListener(
          'connection',
          (e: events.QUICServerConnectionEvent) =>
            connectionEventProm.resolveP(e),
        );
        await server.start({
          host: '127.0.0.1' as Host,
          port: 55555 as Port,
        });
        client = await QUICClient.createQUICClient({
          host: '::ffff:127.0.0.1' as Host,
          port: server.port,
          localHost: '::' as Host,
          crypto,
          logger: logger.getChild(QUICClient.name),
          config: {
            verifyPeer: false,
          },
        });
        const conn = (await connectionEventProm.p).detail;
        // Do the test
        const activeServerStreams: Array<Promise<void>> = [];
        conn.addEventListener(
          'stream',
          (streamEvent: events.QUICConnectionStreamEvent) => {
            const stream = streamEvent.detail;
            const streamProm = stream.readable.pipeTo(stream.writable);
            activeServerStreams.push(streamProm);
          },
        );

        // Let's make a new streams.
        const activeClientStreams: Array<Promise<void>> = [];
        for (const data of streamsData) {
          activeClientStreams.push(
            (async () => {
              const stream = await client.connection.streamNew();
              const writer = stream.writable.getWriter();
              const reader = stream.readable.getReader();
              // Do write and read messages here.
              for (const message of data) {
                await writer.write(message);
                const readMessage = await reader.read();
                expect(readMessage.done).toBeFalse();
                expect(readMessage.value).toStrictEqual(message);
              }
              await writer.close();
              const value = await reader.read();
              expect(value.done).toBeTrue();
            })(),
          );
        }
        await Promise.all([
          Promise.all(activeClientStreams),
          Promise.all(activeServerStreams),
        ]);
      } finally {
        await client?.destroy({ force: true });
        await server?.stop({ force: true });
      }
    },
    { numRuns: 10 },
  );
  testProp(
    'should propagate errors over stream for writable',
    [tlsConfigWithCaArb, fc.integer({ min: 1, max: 10 }).noShrink()],
    async (tlsConfigProm, streamsNum) => {
      const testReason = Symbol('TestReason');
      const codeToReason = (type, code) => {
        switch (code) {
          case 2:
            return testReason;
          default:
            return new Error(`${type.toString()} ${code.toString()}`);
        }
      };
      const reasonToCode = (type, reason) => {
        if (reason === testReason) return 2;
        return 1;
      };
      const connectionEventProm = promise<events.QUICServerConnectionEvent>();
      const tlsConfig = await tlsConfigProm;
      let server: QUICServer | null = null;
      let client: QUICClient | null = null;
      try {
        server = new QUICServer({
          crypto,
          logger: logger.getChild(QUICServer.name),
          codeToReason,
          reasonToCode,
          config: {
            tlsConfig: tlsConfig.tlsConfig,
            verifyPeer: false,
            logKeys: './tmp/key.log',
          },
        });
        server.addEventListener(
          'connection',
          (e: events.QUICServerConnectionEvent) =>
            connectionEventProm.resolveP(e),
        );
        await server.start({
          host: '127.0.0.1' as Host,
          port: 55555 as Port,
        });
        client = await QUICClient.createQUICClient({
          host: '::ffff:127.0.0.1' as Host,
          port: server.port,
          localHost: '::' as Host,
          crypto,
          logger: logger.getChild(QUICClient.name),
          config: {
            verifyPeer: false,
          },
          codeToReason,
          reasonToCode,
        });
        const conn = (await connectionEventProm.p).detail;
        // Do the test
        const activeServerStreams: Array<Promise<void>> = [];
        conn.addEventListener(
          'stream',
          (streamEvent: events.QUICConnectionStreamEvent) => {
            const stream = streamEvent.detail;
            const streamProm = stream.readable.pipeTo(stream.writable);
            // Ignore unhandled errors
            streamProm.catch(() => {});
            activeServerStreams.push(streamProm);
          },
        );
        // Let's make a new streams.
        const activeClientStreams: Array<Promise<void>> = [];
        const message = Buffer.from('Hello!');
        for (let i = 0; i < streamsNum; i++) {
          activeClientStreams.push(
            (async () => {
              const stream = await client.connection.streamNew();
              const writer = stream.writable.getWriter();
              // Do write and read messages here.
              await writer.write(message);
              await writer.abort(testReason);
              try {
                for await (const _ of stream.readable) {
                  // Do nothing, wait for finish
                }
              } catch (e) {
                expect(e).toBe(testReason);
              }
            })(),
          );
        }
        const expectationProms = activeServerStreams.map(async (v) => {
          await v.catch((e) => {
            expect(e).toBe(testReason);
          });
        });
        await Promise.all([
          Promise.all(activeClientStreams),
          Promise.all(expectationProms),
        ]);
      } finally {
        await client?.destroy({ force: true });
        await server?.stop({ force: true });
      }
    },
    { numRuns: 10 },
  );
  testProp(
    'should propagate errors over stream for readable',
    [tlsConfigWithCaArb, fc.integer({ min: 5, max: 10 }).noShrink()],
    async (tlsConfigProm, streamsNum) => {
      const testReason = Symbol('TestReason');
      const codeToReason = (type, code) => {
        switch (code) {
          case 2:
            return testReason;
          default:
            return new Error(`${type.toString()} ${code.toString()}`);
        }
      };
      const reasonToCode = (type, reason) => {
        if (reason === testReason) return 2;
        return 1;
      };
      const connectionEventProm = promise<events.QUICServerConnectionEvent>();
      const tlsConfig = await tlsConfigProm;
      let server: QUICServer | null = null;
      let client: QUICClient | null = null;
      try {
        server = new QUICServer({
          crypto,
          logger: logger.getChild(QUICServer.name),
          codeToReason,
          reasonToCode,
          config: {
            tlsConfig: tlsConfig.tlsConfig,
            verifyPeer: false,
            logKeys: './tmp/key.log',
          },
        });
        server.addEventListener(
          'connection',
          (e: events.QUICServerConnectionEvent) =>
            connectionEventProm.resolveP(e),
        );
        await server.start({
          host: '127.0.0.1' as Host,
          port: 55555 as Port,
        });
        client = await QUICClient.createQUICClient({
          host: '::ffff:127.0.0.1' as Host,
          port: server.port,
          localHost: '::' as Host,
          crypto,
          logger: logger.getChild(QUICClient.name),
          config: {
            verifyPeer: false,
          },
          codeToReason,
          reasonToCode,
        });
        const conn = (await connectionEventProm.p).detail;
        // Do the test
        const activeServerStreams: Array<Promise<void>> = [];
        const serverStreamsProm = promise<void>();
        let serverStreamNum = 0;
        conn.addEventListener(
          'stream',
          (streamEvent: events.QUICConnectionStreamEvent) => {
            const stream = streamEvent.detail;
            const streamProm = stream.readable.pipeTo(stream.writable);
            activeServerStreams.push(streamProm);
            serverStreamNum += 1;
            if (serverStreamNum >= streamsNum) serverStreamsProm.resolveP();
          },
        );
        // Let's make a new streams.
        const activeClientStreams: Array<Promise<void>> = [];
        const message = Buffer.from('Hello!');
        const serverStreamsDoneProm = promise();
        for (let i = 0; i < streamsNum; i++) {
          activeClientStreams.push(
            (async () => {
              const stream = await client.connection.streamNew();
              const writer = stream.writable.getWriter();
              // Do write and read messages here.
              await writer.write(message);
              await stream.readable.cancel(testReason);
              await serverStreamsDoneProm.p;
              // Need time for packets to send/recv
              await sleep(100);
              const writeProm = writer.write(message);
              await writeProm.then(
                () => {
                  throw Error('write did not throw');
                },
                (e) => expect(e).toBe(testReason),
              );
            })(),
          );
        }
        // Wait for streams to be created before mapping
        await serverStreamsProm.p;
        const expectationProms = activeServerStreams.map(async (v) => {
          await v.catch((e) => {
            expect(e).toBe(testReason);
          });
        });
        await Promise.all([
          Promise.all(activeClientStreams),
          Promise.all(expectationProms).finally(serverStreamsDoneProm.resolveP),
        ]);
      } finally {
        await client?.destroy({ force: true });
        await server?.stop({ force: true });
      }
    },
    { numRuns: 10 },
  );
  testProp(
    'should clean up streams when connection ends',
    [
      tlsConfigWithCaArb,
      fc.integer({ min: 5, max: 10 }).noShrink(),
      fc.uint8Array({ minLength: 1 }).noShrink(),
    ],
    async (tlsConfigProm, streamsNum, message) => {
      const connectionEventProm = promise<events.QUICServerConnectionEvent>();
      const tlsConfig = await tlsConfigProm;
      let server: QUICServer | null = null;
      let client: QUICClient | null = null;
      try {
        server = new QUICServer({
          crypto,
          logger: logger.getChild(QUICServer.name),
          config: {
            tlsConfig: tlsConfig.tlsConfig,
            verifyPeer: false,
          },
        });
        server.addEventListener(
          'connection',
          (e: events.QUICServerConnectionEvent) =>
            connectionEventProm.resolveP(e),
        );
        await server.start({
          host: '127.0.0.1' as Host,
        });
        client = await QUICClient.createQUICClient({
          host: '::ffff:127.0.0.1' as Host,
          port: server.port,
          localHost: '::' as Host,
          crypto,
          logger: logger.getChild(QUICClient.name),
          config: {
            verifyPeer: false,
          },
        });
        const conn = (await connectionEventProm.p).detail;
        // Do the test
        let streamCreatedCount = 0;
        let streamEndedCount = 0;
        const streamCreationProm = promise();
        const streamEndedProm = promise();
        conn.addEventListener(
          'stream',
          (asd: events.QUICConnectionStreamEvent) => {
            const stream = asd.detail;
            streamCreatedCount += 1;
            if (streamCreatedCount >= streamsNum) streamCreationProm.resolveP();
            void stream.readable
              .pipeTo(stream.writable)
              // Ignore errors
              .catch(() => {})
              .finally(() => {
                streamEndedCount += 1;
                if (streamEndedCount >= streamsNum) streamEndedProm.resolveP();
              });
          },
        );
        // Lets make a new streams.
        for (let i = 0; i < streamsNum; i++) {
          const stream = await client.connection.streamNew();
          const writer = stream.writable.getWriter();
          await writer.write(message);
          writer.releaseLock();
        }
        await Promise.race([
          streamCreationProm.p,
          sleep(100).then(() => {
            throw Error('Creation timed out');
          }),
        ]);
        // Start destroying streams
        await client.destroy({ force: true });
        await Promise.race([
          streamEndedProm.p,
          sleep(100).then(() => {
            throw Error('Ending timed out');
          }),
        ]);
        expect(streamCreatedCount).toBe(streamsNum);
        expect(streamEndedCount).toBe(streamsNum);
      } finally {
        await client?.destroy({ force: true });
        await server?.stop({ force: true });
      }
    },
    { numRuns: 10 },
  );
});