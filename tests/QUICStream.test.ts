import type * as events from '@/events';
import type { Host, Port } from '@';
import type QUICSocket from '@/QUICSocket';
import type { ClientCrypto, ServerCrypto } from '@';
import { testProp, fc } from '@fast-check/jest';
import Logger, { formatting, LogLevel, StreamHandler } from '@matrixai/logger';
import { destroyed } from '@matrixai/async-init';
import * as utils from '@/utils';
import QUICServer from '@/QUICServer';
import QUICClient from '@/QUICClient';
import QUICStream from '@/QUICStream';
import * as testsUtils from './utils';
import { generateConfig } from './utils';

describe(QUICStream.name, () => {
  const logger = new Logger(`${QUICStream.name} Test`, LogLevel.DEBUG, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  const defaultType = 'RSA';
  // This has to be setup asynchronously due to key generation
  const serverCrypto: ServerCrypto = {
    sign: testsUtils.signHMAC,
    verify: testsUtils.verifyHMAC,
  };
  let key: ArrayBuffer;
  const clientCrypto: ClientCrypto = {
    randomBytes: testsUtils.randomBytes,
  };
  let sockets: Set<QUICSocket>;

  // We need to test the stream making
  beforeEach(async () => {
    key = await testsUtils.generateKeyHMAC();
    sockets = new Set();
  });
  afterEach(async () => {
    const stopProms: Array<Promise<void>> = [];
    for (const socket of sockets) {
      stopProms.push(socket.stop({ force: true }));
    }
    await Promise.allSettled(stopProms);
  });

  test('should create streams', async () => {
    const streamsNum = 10;
    const connectionEventProm =
      utils.promise<events.QUICServerConnectionEvent>();
    const tlsConfig = await generateConfig(defaultType);
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig.key,
        cert: tlsConfig.cert,
        verifyPeer: false,
      },
    });
    testsUtils.extractSocket(server, sockets);
    server.addEventListener(
      'serverConnection',
      (e: events.QUICServerConnectionEvent) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: '127.0.0.1' as Host,
    });
    const client = await QUICClient.createQUICClient({
      host: '::ffff:127.0.0.1' as Host,
      port: server.port,
      localHost: '::' as Host,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
      },
    });
    testsUtils.extractSocket(client, sockets);
    const conn = (await connectionEventProm.p).detail;
    // Do the test
    let streamCount = 0;
    const streamCreationProm = utils.promise();
    conn.addEventListener('connectionStream', () => {
      streamCount += 1;
      if (streamCount >= streamsNum) streamCreationProm.resolveP();
    });
    // Let's make a new streams.
    // const message = Buffer.from('hello!');
    const message = Buffer.from('Hello!');
    for (let i = 0; i < streamsNum; i++) {
      const stream = await client.connection.streamNew();
      const writer = stream.writable.getWriter();
      await writer.write(message);
      writer.releaseLock();
    }
    await Promise.race([
      streamCreationProm.p,
      testsUtils.sleep(500).then(() => {
        throw Error('Creation timed out');
      }),
    ]);
    expect(streamCount).toBe(streamsNum);
    await client?.destroy({ force: true });
    await server?.stop({ force: true });
  });
  test('destroying stream should clean up on both ends while streams are used', async () => {
    const message = Buffer.from('Message!');
    const streamsNum = 10;
    const connectionEventProm =
      utils.promise<events.QUICServerConnectionEvent>();
    const tlsConfig = await generateConfig(defaultType);
    const streams: Array<QUICStream> = [];
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig.key,
        cert: tlsConfig.cert,
        verifyPeer: false,
      },
    });
    testsUtils.extractSocket(server, sockets);
    server.addEventListener(
      'serverConnection',
      (e: events.QUICServerConnectionEvent) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: '127.0.0.1' as Host,
    });
    const client = await QUICClient.createQUICClient({
      host: '::ffff:127.0.0.1' as Host,
      port: server.port,
      localHost: '::' as Host,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
      },
    });
    testsUtils.extractSocket(client, sockets);
    const conn = (await connectionEventProm.p).detail;
    // Do the test
    let streamCreatedCount = 0;
    let streamEndedCount = 0;
    const streamCreationProm = utils.promise();
    const streamEndedProm = utils.promise();
    conn.addEventListener(
      'connectionStream',
      (event: events.QUICConnectionStreamEvent) => {
        const stream = event.detail;
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
    // Let's make a new streams.
    for (let i = 0; i < streamsNum; i++) {
      const stream = await client.connection.streamNew();
      streams.push(stream);
      const writer = stream.writable.getWriter();
      await writer.write(message);
      writer.releaseLock();
    }
    await Promise.race([
      streamCreationProm.p,
      testsUtils.sleep(100).then(() => {
        throw Error('Creation timed out');
      }),
    ]);
    // Start destroying streams
    await Promise.allSettled(
      streams.map((stream) => stream.destroy({ force: true })),
    );
    await Promise.race([
      streamEndedProm.p,
      testsUtils.sleep(100000).then(() => {
        throw Error('Ending timed out');
      }),
    ]);
    expect(streamCreatedCount).toBe(streamsNum);
    expect(streamEndedCount).toBe(streamsNum);
    await client?.destroy({ force: true });
    await server?.stop({ force: true });
  });
  test('should send data over stream', async () => {
    const message = Buffer.from('The Quick Brown Fox Jumped Over The Lazy Dog');
    const numStreams = 10;
    const numMessage = 100;
    const connectionEventProm =
      utils.promise<events.QUICServerConnectionEvent>();
    const tlsConfig = await generateConfig(defaultType);
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig.key,
        cert: tlsConfig.cert,
        verifyPeer: false,
      },
    });
    testsUtils.extractSocket(server, sockets);
    server.addEventListener(
      'serverConnection',
      (e: events.QUICServerConnectionEvent) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: '127.0.0.1' as Host,
      port: 58888 as Port,
    });
    const client = await QUICClient.createQUICClient({
      host: '::ffff:127.0.0.1' as Host,
      port: server.port,
      localHost: '::' as Host,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
      },
    });
    testsUtils.extractSocket(client, sockets);
    const conn = (await connectionEventProm.p).detail;
    // Do the test
    const activeServerStreams: Array<Promise<void>> = [];
    conn.addEventListener(
      'connectionStream',
      (streamEvent: events.QUICConnectionStreamEvent) => {
        const stream = streamEvent.detail;
        const streamProm = stream.readable.pipeTo(stream.writable);
        activeServerStreams.push(streamProm);
      },
    );

    // Let's make a new streams.
    const activeClientStreams: Array<Promise<void>> = [];
    for (let i = 0; i < numStreams; i++) {
      activeClientStreams.push(
        (async () => {
          const stream = await client.connection.streamNew();
          const writer = stream.writable.getWriter();
          const reader = stream.readable.getReader();
          // Do write and read messages here.
          for (let j = 0; j < numMessage; j++) {
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
    await client?.destroy({ force: true });
    await server?.stop({ force: true });
  });
  test('should propagate errors over stream for writable', async () => {
    const streamsNum = 10;
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
    const connectionEventProm =
      utils.promise<events.QUICServerConnectionEvent>();
    const tlsConfig = await generateConfig(defaultType);
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      codeToReason,
      reasonToCode,
      config: {
        key: tlsConfig.key,
        cert: tlsConfig.cert,
        verifyPeer: false,
      },
    });
    testsUtils.extractSocket(server, sockets);
    server.addEventListener(
      'serverConnection',
      (e: events.QUICServerConnectionEvent) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: '127.0.0.1' as Host,
      port: 59999 as Port,
    });
    const client = await QUICClient.createQUICClient({
      host: '::ffff:127.0.0.1' as Host,
      port: server.port,
      localHost: '::' as Host,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
      },
      codeToReason,
      reasonToCode,
    });
    testsUtils.extractSocket(client, sockets);
    const conn = (await connectionEventProm.p).detail;
    // Do the test
    const activeServerStreams: Array<Promise<void>> = [];
    conn.addEventListener(
      'connectionStream',
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
    await client?.destroy({ force: true });
    await server?.stop({ force: true });
  });
  test('should propagate errors over stream for readable', async () => {
    const streamsNum = 1;
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
    const connectionEventProm =
      utils.promise<events.QUICServerConnectionEvent>();
    const tlsConfig = await generateConfig(defaultType);
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      codeToReason,
      reasonToCode,
      config: {
        key: tlsConfig.key,
        cert: tlsConfig.cert,
        verifyPeer: false,
      },
    });
    testsUtils.extractSocket(server, sockets);
    server.addEventListener(
      'serverConnection',
      (e: events.QUICServerConnectionEvent) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: '127.0.0.1' as Host,
      port: 60000 as Port,
    });
    const client = await QUICClient.createQUICClient({
      host: '::ffff:127.0.0.1' as Host,
      port: server.port,
      localHost: '::' as Host,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
      },
      codeToReason,
      reasonToCode,
    });
    testsUtils.extractSocket(client, sockets);
    const conn = (await connectionEventProm.p).detail;
    // Do the test
    const activeServerStreams: Array<Promise<void>> = [];
    const serverStreamsProm = utils.promise<void>();
    let serverStreamNum = 0;
    conn.addEventListener(
      'connectionStream',
      (streamEvent: events.QUICConnectionStreamEvent) => {
        const stream = streamEvent.detail;
        const streamProm = stream.readable
          .pipeTo(stream.writable)
          .catch((e) => {
            expect(e).toBe(testReason);
          });
        activeServerStreams.push(streamProm);
        serverStreamNum += 1;
        if (serverStreamNum >= streamsNum) serverStreamsProm.resolveP();
      },
    );
    // Let's make a new streams.
    const activeClientStreams: Array<Promise<void>> = [];
    const message = Buffer.from('Hello!');
    const serverStreamsDoneProm = utils.promise();
    for (let i = 0; i < streamsNum; i++) {
      const clientProm = (async () => {
        const stream = await client.connection.streamNew();
        const writer = stream.writable.getWriter();
        // Do write and read messages here.
        await writer.write(message);
        await stream.readable.cancel(testReason);
        await serverStreamsDoneProm.p;
        // Need time for packets to send/recv
        await testsUtils.sleep(100);
        const writeProm = writer.write(message);
        await writeProm.then(
          () => {
            throw Error('write did not throw');
          },
          (e) => expect(e).toBe(testReason),
        );
      })();
      // ClientProm.catch(e => logger.error(e));
      activeClientStreams.push(clientProm);
    }
    // Wait for streams to be created before mapping
    await serverStreamsProm.p;
    await Promise.all([
      Promise.all(activeClientStreams),
      Promise.all(activeServerStreams).finally(() => {
        serverStreamsDoneProm.resolveP();
      }),
    ]);
    await client?.destroy({ force: true });
    await server?.stop({ force: true });
  });
  testProp(
    'should clean up streams when connection ends',
    [
      fc.integer({ min: 5, max: 10 }).noShrink(),
      fc.uint8Array({ minLength: 1 }).noShrink(),
    ],
    async (streamsNum, message) => {
      const connectionEventProm =
        utils.promise<events.QUICServerConnectionEvent>();
      const tlsConfig = await generateConfig(defaultType);
      const server = new QUICServer({
        crypto: {
          key,
          ops: serverCrypto,
        },
        logger: logger.getChild(QUICServer.name),
        config: {
          key: tlsConfig.key,
          cert: tlsConfig.cert,
          verifyPeer: false,
        },
      });
      testsUtils.extractSocket(server, sockets);
      server.addEventListener(
        'serverConnection',
        (e: events.QUICServerConnectionEvent) =>
          connectionEventProm.resolveP(e),
      );
      await server.start({
        host: '127.0.0.1' as Host,
      });
      const client = await QUICClient.createQUICClient({
        host: '::ffff:127.0.0.1' as Host,
        port: server.port,
        localHost: '::' as Host,
        crypto: {
          ops: clientCrypto,
        },
        logger: logger.getChild(QUICClient.name),
        config: {
          verifyPeer: false,
        },
      });
      testsUtils.extractSocket(client, sockets);
      const conn = (await connectionEventProm.p).detail;
      // Do the test
      let streamCreatedCount = 0;
      let streamEndedCount = 0;
      const streamCreationProm = utils.promise();
      const streamEndedProm = utils.promise();
      conn.addEventListener(
        'connectionStream',
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
      // Let's make a new streams.
      for (let i = 0; i < streamsNum; i++) {
        const stream = await client.connection.streamNew();
        const writer = stream.writable.getWriter();
        await writer.write(message);
        writer.releaseLock();
      }
      await Promise.race([
        streamCreationProm.p,
        testsUtils.sleep(100).then(() => {
          throw Error('Creation timed out');
        }),
      ]);
      // Start destroying streams
      await client.destroy({ force: true });
      await Promise.race([
        streamEndedProm.p,
        testsUtils.sleep(100).then(() => {
          throw Error('Ending timed out');
        }),
      ]);
      expect(streamCreatedCount).toBe(streamsNum);
      expect(streamEndedCount).toBe(streamsNum);
      await client?.destroy({ force: true });
      await server?.stop({ force: true });
    },
    { numRuns: 2 },
  );
  test('streams should contain metadata', async () => {
    const connectionEventProm =
      utils.promise<events.QUICServerConnectionEvent>();
    const tlsConfig1 = await generateConfig(defaultType);
    const tlsConfig2 = await generateConfig(defaultType);
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig1.key,
        cert: tlsConfig1.cert,
        verifyPeer: true,
        ca: tlsConfig2.ca,
      },
    });
    testsUtils.extractSocket(server, sockets);
    server.addEventListener(
      'serverConnection',
      (e: events.QUICServerConnectionEvent) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: '127.0.0.1' as Host,
    });
    const client = await QUICClient.createQUICClient({
      host: '127.0.0.1' as Host,
      port: server.port,
      localHost: '127.0.0.1' as Host,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
        key: tlsConfig2.key,
        cert: tlsConfig2.cert,
      },
    });
    testsUtils.extractSocket(client, sockets);
    const conn = (await connectionEventProm.p).detail;
    // Do the test
    const serverStreamProm = utils.promise<QUICStream>();
    conn.addEventListener(
      'connectionStream',
      (event: events.QUICConnectionStreamEvent) => {
        serverStreamProm.resolveP(event.detail);
      },
    );
    // Let's make a new streams.
    const message = Buffer.from('Hello!');
    const clientStream = await client.connection.streamNew();
    const writer = clientStream.writable.getWriter();
    await writer.write(message);
    writer.releaseLock();
    await Promise.race([
      serverStreamProm.p,
      testsUtils.sleep(500).then(() => {
        throw Error('Creation timed out');
      }),
    ]);
    const clientMetadata = clientStream.remoteInfo;
    expect(clientMetadata.localHost).toBe(client.host);
    expect(clientMetadata.localPort).toBe(client.port);
    expect(clientMetadata.remoteHost).toBe(server.host);
    expect(clientMetadata.remotePort).toBe(server.port);
    expect(clientMetadata.remoteCertificates?.length).toBeGreaterThan(0);
    const clientPemChain = utils.certificatePEMsToCertChainPem(
      clientMetadata.remoteCertificates!,
    );
    expect(clientPemChain).toEqual(tlsConfig1.ca);

    const serverStream = await serverStreamProm.p;
    const serverMetadata = serverStream.remoteInfo;
    expect(serverMetadata.localHost).toBe(server.host);
    expect(serverMetadata.localPort).toBe(server.port);
    expect(serverMetadata.remoteHost).toBe(client.host);
    expect(serverMetadata.remotePort).toBe(client.port);
    expect(serverMetadata.remoteCertificates?.length).toBeGreaterThan(0);
    const serverPemChain = utils.certificatePEMsToCertChainPem(
      serverMetadata.remoteCertificates!,
    );
    expect(serverPemChain).toEqual(tlsConfig2.ca);
    await client?.destroy({ force: true });
    await server?.stop({ force: true });
  });
  test('streams can be cancelled', async () => {
    const cancelReason = Symbol('CancelReason');
    const connectionEventProm =
      utils.promise<events.QUICServerConnectionEvent>();
    const tlsConfig1 = await generateConfig(defaultType);
    const tlsConfig2 = await generateConfig(defaultType);
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig1.key,
        cert: tlsConfig1.cert,
        verifyPeer: true,
        ca: tlsConfig2.ca,
      },
    });
    testsUtils.extractSocket(server, sockets);
    server.addEventListener(
      'serverConnection',
      (e: events.QUICServerConnectionEvent) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: '127.0.0.1' as Host,
    });
    const client = await QUICClient.createQUICClient({
      host: '127.0.0.1' as Host,
      port: server.port,
      localHost: '127.0.0.1' as Host,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
        key: tlsConfig2.key,
        cert: tlsConfig2.cert,
      },
    });
    testsUtils.extractSocket(client, sockets);
    const conn = (await connectionEventProm.p).detail;
    // Do the test
    const serverStreamProm = utils.promise<QUICStream>();
    conn.addEventListener(
      'connectionStream',
      (event: events.QUICConnectionStreamEvent) => {
        serverStreamProm.resolveP(event.detail);
      },
    );
    // Let's make a new streams.
    const message = Buffer.from('Hello!');
    const clientStream = await client.connection.streamNew();
    const writer = clientStream.writable.getWriter();
    await writer.write(message);
    writer.releaseLock();
    await Promise.race([
      serverStreamProm.p,
      testsUtils.sleep(500).then(() => {
        throw Error('Creation timed out');
      }),
    ]);
    clientStream.cancel(cancelReason);
    await expect(clientStream.readable.getReader().read()).rejects.toBe(
      cancelReason,
    );
    await expect(clientStream.writable.getWriter().write()).rejects.toBe(
      cancelReason,
    );
    // Let's check that the server side ended
    const serverStream = await serverStreamProm.p;
    await expect(
      serverStream.readable.pipeTo(serverStream.writable),
    ).rejects.toThrow();
    // And client stream should've cleaned up
    await testsUtils.sleep(100);
    expect(clientStream[destroyed]).toBeTrue();
    await client?.destroy({ force: true });
    await server?.stop({ force: true });
  });
});
