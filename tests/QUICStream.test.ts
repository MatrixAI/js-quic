import type { ClientCryptoOps, QUICConnection, ServerCryptoOps } from '@';
import Logger, { formatting, LogLevel, StreamHandler } from '@matrixai/logger';
import { destroyed } from '@matrixai/async-init';
import * as events from '@/events';
import * as utils from '@/utils';
import QUICServer from '@/QUICServer';
import QUICClient from '@/QUICClient';
import QUICStream from '@/QUICStream';
import * as testsUtils from './utils';
import { generateTLSConfig, sleep } from './utils';

describe(QUICStream.name, () => {
  const logger = new Logger(`${QUICStream.name} Test`, LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  const defaultType = 'RSA';
  const localhost = '127.0.0.1';
  // This has to be setup asynchronously due to key generation
  const serverCrypto: ServerCryptoOps = {
    sign: testsUtils.signHMAC,
    verify: testsUtils.verifyHMAC,
  };
  let key: ArrayBuffer;
  const clientCrypto: ClientCryptoOps = {
    randomBytes: testsUtils.randomBytes,
  };
  let socketCleanMethods: ReturnType<typeof testsUtils.socketCleanupFactory>;
  let createQUICStreamMock: jest.SpyInstance;

  const testReason = Symbol('TestReason');
  const testCodeToReason = (type, code) => {
    switch (code) {
      case 2:
        return testReason;
      default:
        return new Error(`${type.toString()} ${code.toString()}`);
    }
  };
  const testReasonToCode = (type, reason) => {
    if (reason === testReason) return 2;
    return 1;
  };

  // We need to test the stream making
  beforeEach(async () => {
    key = await testsUtils.generateKeyHMAC();
    socketCleanMethods = testsUtils.socketCleanupFactory();
    createQUICStreamMock = jest.spyOn(QUICStream, 'createQUICStream');
  });
  afterEach(async () => {
    createQUICStreamMock.mockRestore();
    await socketCleanMethods.stopSockets();
  });

  test('should create streams', async () => {
    const streamsNum = 10;
    const connectionEventProm =
      utils.promise<events.EventQUICServerConnection>();
    const tlsConfig = await generateTLSConfig(defaultType);
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig.leafKeyPairPEM.privateKey,
        cert: tlsConfig.leafCertPEM,
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(server);
    server.addEventListener(
      events.EventQUICServerConnection.name,
      (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: localhost,
    });
    const client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(client);
    const conn = (await connectionEventProm.p).detail;
    // Do the test
    let streamCount = 0;
    const streamCreationProm = utils.promise();
    conn.addEventListener(events.EventQUICConnectionStream.name, () => {
      streamCount += 1;
      if (streamCount >= streamsNum) streamCreationProm.resolveP();
    });
    // Let's make a new streams.
    // const message = Buffer.from('hello!');
    const message = Buffer.from('Hello!');
    for (let i = 0; i < streamsNum; i++) {
      const stream = client.connection.newStream();
      const writer = stream.writable.getWriter();
      await writer.write(message);
      writer.releaseLock();
    }
    await streamCreationProm.p;
    expect(streamCount).toBe(streamsNum);
    await client.destroy({ force: true });
    await server.stop({ force: true });
  });
  test('destroying stream should clean up on both ends while streams are used', async () => {
    const message = Buffer.from('Message!');
    const streamsNum = 10;
    const connectionEventProm =
      utils.promise<events.EventQUICServerConnection>();
    const tlsConfig = await generateTLSConfig(defaultType);
    const streams: Array<QUICStream> = [];
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig.leafKeyPairPEM.privateKey,
        cert: tlsConfig.leafCertPEM,
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(server);
    server.addEventListener(
      events.EventQUICServerConnection.name,
      (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: localhost,
    });
    const client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(client);
    const conn = (await connectionEventProm.p).detail;
    // Do the test
    let streamCreatedCount = 0;
    let streamEndedCount = 0;
    const streamCreationProm = utils.promise();
    const streamEndedProm = utils.promise();
    conn.addEventListener(
      events.EventQUICConnectionStream.name,
      (event: events.EventQUICConnectionStream) => {
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
      const stream = client.connection.newStream();
      streams.push(stream);
      const writer = stream.writable.getWriter();
      await writer.write(message);
      writer.releaseLock();
    }
    await streamCreationProm.p;
    // Start destroying streams
    await Promise.allSettled(streams.map((stream) => stream.destroy()));
    await streamEndedProm.p;
    expect(streamCreatedCount).toBe(streamsNum);
    expect(streamEndedCount).toBe(streamsNum);
    await client.destroy({ force: true });
    await server.stop({ force: true });
  });
  test('should send data over stream', async () => {
    const message = Buffer.from('The Quick Brown Fox Jumped Over The Lazy Dog');
    const numStreams = 10;
    const numMessage = 10;
    const connectionEventProm =
      utils.promise<events.EventQUICServerConnection>();
    const tlsConfig = await generateTLSConfig(defaultType);
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig.leafKeyPairPEM.privateKey,
        cert: tlsConfig.leafCertPEM,
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(server);
    server.addEventListener(
      events.EventQUICServerConnection.name,
      (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: localhost,
    });
    const client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(client);
    const conn = (await connectionEventProm.p).detail;
    // Do the test
    const activeServerStreams: Array<Promise<void>> = [];
    conn.addEventListener(
      events.EventQUICConnectionStream.name,
      (streamEvent: events.EventQUICConnectionStream) => {
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
          const stream = client.connection.newStream();
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
    await client.destroy({ force: true });
    await server.stop({ force: true });
  });
  test('sent data should be correct and expected', async () => {
    const messages = [
      'The',
      'Quick',
      'Brown',
      'Fox',
      'Jumped',
      'Over',
      'The',
      'Lazy',
      'Dog',
    ].map((v) => Buffer.from(v));
    const connectionEventProm =
      utils.promise<events.EventQUICServerConnection>();
    const tlsConfig = await generateTLSConfig(defaultType);
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig.leafKeyPairPEM.privateKey,
        cert: tlsConfig.leafCertPEM,
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(server);
    server.addEventListener(
      events.EventQUICServerConnection.name,
      (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: localhost,
    });
    const client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(client);
    const conn = (await connectionEventProm.p).detail;
    // Do the test
    const streamProm = utils.promise<QUICStream>();
    conn.addEventListener(
      events.EventQUICConnectionStream.name,
      (streamEvent: events.EventQUICConnectionStream) => {
        streamProm.resolveP(streamEvent.detail);
      },
      { once: true },
    );

    // Create a stream
    const streamLocal = client.connection.newStream();
    const writerLocal = streamLocal.writable.getWriter();
    for (const message of messages) {
      await writerLocal.write(message);
    }
    await writerLocal.close();
    const streamPeer = await streamProm.p;
    const writerPeer = streamPeer.writable.getWriter();
    for (const message of messages) {
      await writerPeer.write(message);
    }
    await writerPeer.close();

    const readMessagesLocal: Array<any> = [];
    const readMessagesPeer: Array<any> = [];
    for await (const chunk of streamPeer.readable) {
      readMessagesLocal.push(chunk);
    }
    for await (const chunk of streamLocal.readable) {
      readMessagesPeer.push(chunk);
    }

    const expected = messages.map((v) => Buffer.from(v)).join(' ');
    expect(readMessagesLocal.map((v) => Buffer.from(v)).join(' ')).toBe(
      expected,
    );
    expect(readMessagesPeer.map((v) => Buffer.from(v)).join(' ')).toBe(
      expected,
    );

    await client.destroy({ force: true });
    await server.stop({ force: true });
  });
  test('should propagate errors over stream for writable', async () => {
    const tlsConfig = await generateTLSConfig(defaultType);
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      codeToReason: testCodeToReason,
      reasonToCode: testReasonToCode,
      config: {
        key: tlsConfig.leafKeyPairPEM.privateKey,
        cert: tlsConfig.leafCertPEM,
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(server);

    const streamProm = utils.promise<QUICStream>();
    server.addEventListener(
      events.EventQUICServerConnection.name,
      (evt: events.EventQUICServerConnection) => {
        const conn = evt.detail;
        conn.addEventListener(
          events.EventQUICConnectionStream.name,
          (evt: events.EventQUICConnectionStream) => {
            streamProm.resolveP(evt.detail);
          },
          { once: true },
        );
      },
      { once: true },
    );

    await server.start({
      host: localhost,
    });

    const client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
      },
      codeToReason: testCodeToReason,
      reasonToCode: testReasonToCode,
    });
    socketCleanMethods.extractSocket(client);

    // Create a stream
    const clientStream = client.connection.newStream();

    const clientWriter = clientStream.writable.getWriter();
    const clientReader = clientStream.readable.getReader();
    await clientWriter.write(Buffer.from('hello'));

    const serverStream = await streamProm.p;
    const serverWriter = serverStream.writable.getWriter();
    const serverReader = serverStream.readable.getReader();
    await serverReader.read();

    // Forward write error
    await clientWriter.abort(testReason);
    await expect(serverReader.read()).rejects.toBe(testReason);
    await serverWriter.abort(testReason);
    await expect(clientReader.read()).rejects.toBe(testReason);

    await client.destroy({ force: true });
    await server.stop({ force: true });
  });
  test('should propagate errors over stream for readable', async () => {
    const tlsConfig = await generateTLSConfig(defaultType);
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      codeToReason: testCodeToReason,
      reasonToCode: testReasonToCode,
      config: {
        key: tlsConfig.leafKeyPairPEM.privateKey,
        cert: tlsConfig.leafCertPEM,
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(server);

    const streamProm = utils.promise<QUICStream>();
    server.addEventListener(
      events.EventQUICServerConnection.name,
      (evt: events.EventQUICServerConnection) => {
        const conn = evt.detail;
        conn.addEventListener(
          events.EventQUICConnectionStream.name,
          (evt: events.EventQUICConnectionStream) => {
            streamProm.resolveP(evt.detail);
          },
          { once: true },
        );
      },
      { once: true },
    );

    await server.start({
      host: localhost,
    });

    const client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
      },
      codeToReason: testCodeToReason,
      reasonToCode: testReasonToCode,
    });
    socketCleanMethods.extractSocket(client);

    // Create a stream
    const clientStream = client.connection.newStream();

    const clientWriter = clientStream.writable.getWriter();
    const clientReader = clientStream.readable.getReader();
    await clientWriter.write(Buffer.from('hello'));

    const serverStream = await streamProm.p;
    const serverWriter = serverStream.writable.getWriter();
    const serverReader = serverStream.readable.getReader();
    await serverReader.read();

    // Forward write error
    await clientReader.cancel(testReason);
    await serverReader.cancel(testReason);
    // Takes some time for reader cancel to propagate to the writer
    await clientStream.closedP;
    await serverStream.closedP;
    await expect(serverWriter.write(Buffer.from('hello'))).rejects.toBe(
      testReason,
    );
    await expect(clientWriter.write(Buffer.from('hello'))).rejects.toBe(
      testReason,
    );

    await client.destroy({ force: true });
    await server.stop({ force: true });
  });
  test('should clean up streams when local connection ends', async () => {
    const streamsNum = 10;
    const message = Buffer.from('The quick brown fox jumped over the lazy dog');
    const connectionEventProm =
      utils.promise<events.EventQUICServerConnection>();
    const tlsConfig = await generateTLSConfig(defaultType);
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig.leafKeyPairPEM.privateKey,
        cert: tlsConfig.leafCertPEM,
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(server);
    server.addEventListener(
      events.EventQUICServerConnection.name,
      (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: localhost,
    });
    const client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(client);
    const conn = (await connectionEventProm.p).detail;
    // Do the test
    let streamCreatedCount = 0;
    let streamEndedCount = 0;
    const streamCreationProm = utils.promise();
    const streamEndedProm = utils.promise();
    conn.addEventListener(
      events.EventQUICConnectionStream.name,
      (asd: events.EventQUICConnectionStream) => {
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
      const stream = client.connection.newStream();
      const writer = stream.writable.getWriter();
      await writer.write(message);
      writer.releaseLock();
    }
    await streamCreationProm.p;
    // Start destroying streams
    await client.destroy({ force: true });
    // All streams need to finish
    await streamEndedProm.p;
    expect(streamCreatedCount).toBe(streamsNum);
    expect(streamEndedCount).toBe(streamsNum);
    await client.destroy({ force: true });
    await server.stop({ force: true });
  });
  test('should clean up streams when peer connection ends', async () => {
    const streamsNum = 10;
    const message = Buffer.from('The quick brown fox jumped over the lazy dog');
    const connectionEventProm =
      utils.promise<events.EventQUICServerConnection>();
    const tlsConfig = await generateTLSConfig(defaultType);
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig.leafKeyPairPEM.privateKey,
        cert: tlsConfig.leafCertPEM,
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(server);
    server.addEventListener(
      events.EventQUICServerConnection.name,
      (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: localhost,
    });
    const client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(client);
    const conn = (await connectionEventProm.p).detail;
    // Do the test
    let streamCreatedCount = 0;
    let streamEndedCount = 0;
    const streamCreationProm = utils.promise();
    const streamEndedProm = utils.promise();
    conn.addEventListener(
      events.EventQUICConnectionStream.name,
      (asd: events.EventQUICConnectionStream) => {
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
      const stream = client.connection.newStream();
      const writer = stream.writable.getWriter();
      await writer.write(message);
      writer.releaseLock();
    }
    await streamCreationProm.p;
    // Start destroying streams
    await conn.stop({ force: true });
    await streamEndedProm.p;
    expect(streamCreatedCount).toBe(streamsNum);
    expect(streamEndedCount).toBe(streamsNum);
  });
  test('should clean up streams when connection times out', async () => {
    const streamsNum = 10;
    const message = Buffer.from('The quick brown fox jumped over the lazy dog');
    const connectionEventProm =
      utils.promise<events.EventQUICServerConnection>();
    const tlsConfig = await generateTLSConfig(defaultType);
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig.leafKeyPairPEM.privateKey,
        cert: tlsConfig.leafCertPEM,
        verifyPeer: false,
        maxIdleTimeout: 100,
      },
    });
    socketCleanMethods.extractSocket(server);
    server.addEventListener(
      events.EventQUICServerConnection.name,
      (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
      { once: true },
    );
    await server.start({
      host: localhost,
    });
    const client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(client);
    const conn = (await connectionEventProm.p).detail;
    // Do the test
    let streamCreatedCount = 0;
    let streamEndedCount = 0;
    const streamCreationProm = utils.promise();
    const streamEndedProm = utils.promise();
    conn.addEventListener(
      events.EventQUICConnectionStream.name,
      (asd: events.EventQUICConnectionStream) => {
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
      const stream = client.connection.newStream();
      const writer = stream.writable.getWriter();
      await writer.write(message);
      writer.releaseLock();
    }
    await streamCreationProm.p;
    await streamEndedProm.p;
    expect(streamCreatedCount).toBe(streamsNum);
    expect(streamEndedCount).toBe(streamsNum);
    await client.destroy({ force: true });
    await server.stop({ force: true });
  });
  test('streams should contain metadata', async () => {
    const connectionEventProm =
      utils.promise<events.EventQUICServerConnection>();
    const tlsConfig1 = await generateTLSConfig(defaultType);
    const tlsConfig2 = await generateTLSConfig(defaultType);
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig1.leafKeyPairPEM.privateKey,
        cert: tlsConfig1.leafCertPEM,
        verifyPeer: true,
        ca: tlsConfig2.caCertPEM,
        maxIdleTimeout: 100,
      },
    });
    socketCleanMethods.extractSocket(server);
    server.addEventListener(
      events.EventQUICServerConnection.name,
      (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: localhost,
    });
    const client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
        key: tlsConfig2.leafKeyPairPEM.privateKey,
        cert: tlsConfig2.leafCertPEM,
        maxIdleTimeout: 100,
      },
    });
    socketCleanMethods.extractSocket(client);
    const conn = (await connectionEventProm.p).detail;
    // Do the test
    const serverStreamProm = utils.promise<QUICStream>();
    conn.addEventListener(
      events.EventQUICConnectionStream.name,
      (event: events.EventQUICConnectionStream) => {
        serverStreamProm.resolveP(event.detail);
      },
    );
    // Let's make a new streams.
    const message = Buffer.from('Hello!');
    const clientStream = client.connection.newStream();
    const writer = clientStream.writable.getWriter();
    await writer.write(message);
    writer.releaseLock();
    await serverStreamProm.p;
    const clientMetadata = clientStream.meta;
    expect(clientMetadata.localHost).toBe(client.localHost);
    expect(clientMetadata.localPort).toBe(client.localPort);
    expect(clientMetadata.remoteHost).toBe(server.host);
    expect(clientMetadata.remotePort).toBe(server.port);
    expect(clientMetadata.remoteCertsChain?.length).toBeGreaterThan(0);
    const clientPemChain = utils.collectPEMs(
      clientMetadata.remoteCertsChain.map((v) => utils.derToPEM(v)),
    );
    expect(clientPemChain[0]).toEqual(tlsConfig1.leafCertPEM);

    const serverStream = await serverStreamProm.p;
    const serverMetadata = serverStream.meta;
    expect(serverMetadata.localHost).toBe(server.host);
    expect(serverMetadata.localPort).toBe(server.port);
    expect(serverMetadata.remoteHost).toBe(client.localHost);
    expect(serverMetadata.remotePort).toBe(client.localPort);
    expect(serverMetadata.remoteCertsChain?.length).toBeGreaterThan(0);
    const serverPemChain = utils.collectPEMs(
      serverMetadata.remoteCertsChain.map((v) => utils.derToPEM(v)),
    );
    expect(serverPemChain[0]).toEqual(tlsConfig2.leafCertPEM);
    await client.destroy({ force: true });
    await server.stop({ force: true });
  });
  test('streams can be cancelled after data sent', async () => {
    const cancelReason = Symbol('CancelReason');
    const connectionEventProm =
      utils.promise<events.EventQUICServerConnection>();
    const tlsConfig1 = await generateTLSConfig(defaultType);
    const tlsConfig2 = await generateTLSConfig(defaultType);
    const reasonConverters = testsUtils.createReasonConverters();
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig1.leafKeyPairPEM.privateKey,
        cert: tlsConfig1.leafCertPEM,
        verifyPeer: true,
        ca: tlsConfig2.caCertPEM,
      },
      ...reasonConverters,
    });
    socketCleanMethods.extractSocket(server);
    server.addEventListener(
      events.EventQUICServerConnection.name,
      (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: localhost,
    });
    const client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
        key: tlsConfig2.leafKeyPairPEM.privateKey,
        cert: tlsConfig2.leafCertPEM,
      },
      ...reasonConverters,
    });
    socketCleanMethods.extractSocket(client);
    const conn = (await connectionEventProm.p).detail;
    // Do the test
    const serverStreamProm = utils.promise<QUICStream>();
    conn.addEventListener(
      events.EventQUICConnectionStream.name,
      (event: events.EventQUICConnectionStream) => {
        serverStreamProm.resolveP(event.detail);
      },
    );
    // Let's make a new streams.
    const message = Buffer.from('Hello!');
    const clientStream = client.connection.newStream();
    const writer = clientStream.writable.getWriter();
    await writer.write(message);
    writer.releaseLock();
    clientStream.cancel(cancelReason);
    await expect(clientStream.readable.getReader().read()).rejects.toBe(
      cancelReason,
    );
    await expect(clientStream.writable.getWriter().write()).rejects.toBe(
      cancelReason,
    );

    // Let's check that the server side ended
    const serverStream = await serverStreamProm.p;
    const serverReadProm = (async () => {
      for await (const _ of serverStream.readable) {
        // Just consume until stream throws
      }
    })();
    await expect(serverReadProm).rejects.toBe(cancelReason);
    const serverWriter = serverStream.writable.getWriter();
    // Should throw
    await expect(serverWriter.write(Buffer.from('hello'))).rejects.toBe(
      cancelReason,
    );

    // And client stream should've cleaned up
    await testsUtils.sleep(100);
    expect(clientStream[destroyed]).toBeTrue();
    await client.destroy({ force: true });
    await server.stop({ force: true });
  });
  test('streams can be cancelled with no data sent', async () => {
    const connectionEventProm = utils.promise<QUICConnection>();
    const tlsConfig1 = await generateTLSConfig(defaultType);
    const tlsConfig2 = await generateTLSConfig(defaultType);
    const reasonConverters = testsUtils.createReasonConverters();
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig1.leafKeyPairPEM.privateKey,
        cert: tlsConfig1.leafCertPEM,
        verifyPeer: true,
        ca: tlsConfig2.caCertPEM,
      },
      ...reasonConverters,
    });
    socketCleanMethods.extractSocket(server);
    server.addEventListener(
      events.EventQUICServerConnection.name,
      (evt: events.EventQUICServerConnection) =>
        connectionEventProm.resolveP(evt.detail),
    );
    await server.start({
      host: localhost,
    });
    const client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
        key: tlsConfig2.leafKeyPairPEM.privateKey,
        cert: tlsConfig2.leafCertPEM,
      },
      ...reasonConverters,
    });
    socketCleanMethods.extractSocket(client);
    const conn = await connectionEventProm.p;
    // Do the test
    const serverStreamProm = utils.promise<QUICStream>();
    conn.addEventListener(
      events.EventQUICConnectionStream.name,
      (event: events.EventQUICConnectionStream) => {
        serverStreamProm.resolveP(event.detail);
      },
    );
    // Let's make a new streams.
    const clientStream = client.connection.newStream();
    clientStream.cancel(testReason);
    await expect(clientStream.readable.getReader().read()).rejects.toBe(
      testReason,
    );
    await expect(clientStream.writable.getWriter().write()).rejects.toBe(
      testReason,
    );

    // Let's check that the server side ended
    const serverStream = await serverStreamProm.p;
    const serverReadProm = (async () => {
      for await (const _ of serverStream.readable) {
        // Just consume until stream throws
      }
    })();
    await expect(serverReadProm).rejects.toBe(testReason);
    const serverWriter = serverStream.writable.getWriter();
    // Should throw
    await expect(serverWriter.write(Buffer.from('hello'))).rejects.toBe(
      testReason,
    );

    // And client stream should've cleaned up
    await clientStream.closedP;
    await serverStream.closedP;
    expect(clientStream[destroyed]).toBeTrue();
    await client.destroy({ force: true });
    await server.stop({ force: true });
  });
  test('streams can be cancelled concurrently after data sent', async () => {
    const cancelReason = Symbol('CancelReason');
    const connectionEventProm =
      utils.promise<events.EventQUICServerConnection>();
    const tlsConfig1 = await generateTLSConfig(defaultType);
    const tlsConfig2 = await generateTLSConfig(defaultType);
    const reasonConverters = testsUtils.createReasonConverters();
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig1.leafKeyPairPEM.privateKey,
        cert: tlsConfig1.leafCertPEM,
        verifyPeer: true,
        ca: tlsConfig2.caCertPEM,
      },
      ...reasonConverters,
    });
    socketCleanMethods.extractSocket(server);
    server.addEventListener(
      events.EventQUICServerConnection.name,
      (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: localhost,
    });
    const client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
        key: tlsConfig2.leafKeyPairPEM.privateKey,
        cert: tlsConfig2.leafCertPEM,
      },
      ...reasonConverters,
    });
    socketCleanMethods.extractSocket(client);
    const conn = (await connectionEventProm.p).detail;
    // Do the test
    const serverStreamProm = utils.promise<QUICStream>();
    conn.addEventListener(
      events.EventQUICConnectionStream.name,
      (event: events.EventQUICConnectionStream) => {
        serverStreamProm.resolveP(event.detail);
      },
    );
    // Let's make a new streams.
    const message = Buffer.from('Hello!');
    const clientStream = client.connection.newStream();
    const writer = clientStream.writable.getWriter();
    await writer.write(message);
    writer.releaseLock();
    const serverStream = await serverStreamProm.p;
    serverStream.cancel(cancelReason);
    clientStream.cancel(cancelReason);

    // Checking stream states
    await expect(clientStream.readable.getReader().read()).rejects.toBe(
      cancelReason,
    );
    await expect(clientStream.writable.getWriter().write()).rejects.toBe(
      cancelReason,
    );
    await expect(serverStream.readable.getReader().read()).rejects.toBe(
      cancelReason,
    );
    await expect(serverStream.writable.getWriter().write()).rejects.toBe(
      cancelReason,
    );

    // And client stream should've cleaned up
    await testsUtils.sleep(100);
    expect(clientStream[destroyed]).toBeTrue();
    await client.destroy({ force: true });
    await server.stop({ force: true });
  });
  test('stream will end when waiting for more data', async () => {
    // Needed to check that the pull based reading of data doesn't break when we
    // temporarily run out of data to read
    const connectionEventProm =
      utils.promise<events.EventQUICServerConnection>();
    const tlsConfig = await generateTLSConfig(defaultType);
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig.leafKeyPairPEM.privateKey,
        cert: tlsConfig.leafCertPEM,
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(server);
    server.addEventListener(
      events.EventQUICServerConnection.name,
      (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: localhost,
    });
    const client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(client);
    const conn = (await connectionEventProm.p).detail;
    // Do the test
    const streamCreationProm = utils.promise<QUICStream>();
    conn.addEventListener(
      events.EventQUICConnectionStream.name,
      (event: events.EventQUICConnectionStream) => {
        streamCreationProm.resolveP(event.detail);
      },
    );
    const message = Buffer.from('Hello!');
    const clientStream = client.connection.newStream();
    const clientWriter = clientStream.writable.getWriter();
    await clientWriter.write(message);
    await streamCreationProm.p;
    const serverStream = await streamCreationProm.p;

    // Drain the readable buffer
    const serverReader = serverStream.readable.getReader();
    await serverReader.read();
    serverReader.releaseLock();

    // Closing stream with no buffered data should be responsive
    await clientWriter.close();
    await serverStream.writable.close();

    // Both streams are destroyed even without reading till close
    await Promise.all([clientStream.closedP, serverStream.closedP]);

    await client.destroy({ force: true });
    await server.stop({ force: true });
  });
  test('stream can error when blocked on data', async () => {
    // This checks that if the readable web-stream is full and not pulling data,
    // we will still respond to an error in the readable stream

    const connectionEventProm =
      utils.promise<events.EventQUICServerConnection>();
    const tlsConfig = await generateTLSConfig(defaultType);
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig.leafKeyPairPEM.privateKey,
        cert: tlsConfig.leafCertPEM,
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(server);
    server.addEventListener(
      events.EventQUICServerConnection.name,
      (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: localhost,
    });
    const client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(client);
    const conn = (await connectionEventProm.p).detail;
    // Do the test
    const streamCreationProm = utils.promise<QUICStream>();
    conn.addEventListener(
      events.EventQUICConnectionStream.name,
      (event: events.EventQUICConnectionStream) => {
        streamCreationProm.resolveP(event.detail);
      },
    );
    const message = Buffer.from('Hello!');
    const clientStream = client.connection.newStream();
    const clientWriter = clientStream.writable.getWriter();
    await clientWriter.write(message);
    await streamCreationProm.p;
    const serverStream = await streamCreationProm.p;

    // Fill up buffers to block reads from pulling
    const serverWriter = serverStream.writable.getWriter();
    await serverWriter.write(message);
    await serverWriter.write(message);
    await serverWriter.write(message);
    await clientWriter.write(message);
    await clientWriter.write(message);
    await clientWriter.write(message);

    // Closing stream with no buffered data should be responsive
    await clientWriter.abort(testReason);
    await serverWriter.abort(testReason);

    // Both streams are destroyed even without reading till close
    await Promise.all([clientStream.closedP, serverStream.closedP]);

    await client.destroy({ force: true });
    await server.stop({ force: true });
  });
  test('streams are allowed to end when client is destroyed with force: false', async () => {
    const message = Buffer.from('The Quick Brown Fox Jumped Over The Lazy Dog');
    const numStreams = 10;
    const numMessage = 10;
    const connectionEventProm =
      utils.promise<events.EventQUICServerConnection>();
    const tlsConfig = await generateTLSConfig(defaultType);
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig.leafKeyPairPEM.privateKey,
        cert: tlsConfig.leafCertPEM,
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(server);
    server.addEventListener(
      events.EventQUICServerConnection.name,
      (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: localhost,
    });
    const client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(client);
    const conn = (await connectionEventProm.p).detail;

    // Do the test
    const activeServerStreams: Array<Promise<void>> = [];
    conn.addEventListener(
      events.EventQUICConnectionStream.name,
      (streamEvent: events.EventQUICConnectionStream) => {
        const stream = streamEvent.detail;
        const streamProm = stream.readable.pipeTo(stream.writable);
        activeServerStreams.push(streamProm);
      },
    );

    const { p: waitP, resolveP: waitResolveP } = utils.promise();

    // Let's make a new streams.
    const activeClientStreams: Array<Promise<void>> = [];
    for (let i = 0; i < numStreams; i++) {
      activeClientStreams.push(
        (async () => {
          const stream = client.connection.newStream();
          const writer = stream.writable.getWriter();
          const reader = stream.readable.getReader();
          // Do write and read messages here.
          for (let j = 0; j < numMessage; j++) {
            await writer.write(message);
            const readMessage = await reader.read();
            expect(readMessage.done).toBeFalse();
            expect(readMessage.value).toStrictEqual(message);
            await waitP;
          }
          await writer.close();
          const value = await reader.read();
          expect(value.done).toBeTrue();
        })(),
      );
    }
    // Yield to allow streams to propagate
    await sleep(0);

    // Start unforced close of client
    const clientDestroyP = client.destroy({ force: false });
    waitResolveP();

    await Promise.all([
      Promise.all(activeClientStreams),
      Promise.all(activeServerStreams),
      clientDestroyP,
    ]);
    await server.stop({ force: true });
  });
  test('streams are allowed to end when server is destroyed with force: false', async () => {
    const message = Buffer.from('The Quick Brown Fox Jumped Over The Lazy Dog');
    const numStreams = 10;
    const numMessage = 10;
    const connectionEventProm =
      utils.promise<events.EventQUICServerConnection>();
    const tlsConfig = await generateTLSConfig(defaultType);
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig.leafKeyPairPEM.privateKey,
        cert: tlsConfig.leafCertPEM,
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(server);
    server.addEventListener(
      events.EventQUICServerConnection.name,
      (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: localhost,
    });
    const client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(client);
    const conn = (await connectionEventProm.p).detail;

    // Do the test
    const activeServerStreams: Array<Promise<void>> = [];
    conn.addEventListener(
      events.EventQUICConnectionStream.name,
      (streamEvent: events.EventQUICConnectionStream) => {
        const stream = streamEvent.detail;
        const streamProm = stream.readable.pipeTo(stream.writable);
        activeServerStreams.push(streamProm);
      },
    );

    const { p: waitP, resolveP: waitResolveP } = utils.promise();

    // Let's make a new streams.
    const activeClientStreams: Array<Promise<void>> = [];
    for (let i = 0; i < numStreams; i++) {
      activeClientStreams.push(
        (async () => {
          const stream = client.connection.newStream();
          const writer = stream.writable.getWriter();
          const reader = stream.readable.getReader();
          // Do write and read messages here.
          for (let j = 0; j < numMessage; j++) {
            await writer.write(message);
            const readMessage = await reader.read();
            expect(readMessage.done).toBeFalse();
            expect(readMessage.value).toStrictEqual(message);
            await waitP;
          }
          await writer.close();
          const value = await reader.read();
          expect(value.done).toBeTrue();
        })(),
      );
    }
    // Yield to allow streams to propagate
    await sleep(0);

    // Start unforced close of server
    const serverStopP = server.stop({ force: false });
    waitResolveP();

    await Promise.all([
      Promise.all(activeClientStreams),
      Promise.all(activeServerStreams),
      serverStopP,
    ]);
    await client.destroy({ force: true });
  });
  test('new streams are rejected when a connection is ending', async () => {
    const message = Buffer.from('The Quick Brown Fox Jumped Over The Lazy Dog');
    const connectionEventProm =
      utils.promise<events.EventQUICServerConnection>();
    const tlsConfig = await generateTLSConfig(defaultType);
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig.leafKeyPairPEM.privateKey,
        cert: tlsConfig.leafCertPEM,
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(server);
    server.addEventListener(
      events.EventQUICServerConnection.name,
      (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: localhost,
    });
    const client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(client);
    const conn = (await connectionEventProm.p).detail;

    // Do the test
    const { p: waitP, resolveP: waitResolveP } = utils.promise();
    const activeServerStreams: Array<Promise<void>> = [];
    conn.addEventListener(
      events.EventQUICConnectionStream.name,
      async (streamEvent: events.EventQUICConnectionStream) => {
        const stream = streamEvent.detail;
        await waitP;
        const streamProm = stream.readable.pipeTo(stream.writable);
        activeServerStreams.push(streamProm);
      },
    );

    const stream = client.connection.newStream();
    const writer = stream.writable.getWriter();
    await writer.write(message);
    await writer.close();

    // Start unforced close of client
    const clientDestroyP = client.destroy({ force: false });
    // Yield to allow `destroy` to progress
    await sleep(0);
    // New client streams should throw
    expect(() => client.connection.newStream()).toThrow();
    // Creating a stream on the server side should throw
    const newStream = conn.newStream();
    await newStream.writable.close();
    const code = (async () => {
      for await (const _ of newStream.readable) {
        // Do nothing
      }
    })();
    await expect(code).rejects.toThrow('read 0');

    waitResolveP();
    await Promise.all(activeServerStreams);
    await clientDestroyP;
    await server.stop({ force: true });
  });
  test('connection can be forced closed after unforced destroy', async () => {
    const message = Buffer.from('The Quick Brown Fox Jumped Over The Lazy Dog');
    const connectionEventProm =
      utils.promise<events.EventQUICServerConnection>();
    const tlsConfig = await generateTLSConfig(defaultType);
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig.leafKeyPairPEM.privateKey,
        cert: tlsConfig.leafCertPEM,
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(server);
    server.addEventListener(
      events.EventQUICServerConnection.name,
      (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: localhost,
    });
    const client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(client);
    const conn = (await connectionEventProm.p).detail;

    // Do the test
    const { p: waitP, resolveP: waitResolveP } = utils.promise();
    const activeServerStreams: Array<Promise<void>> = [];
    conn.addEventListener(
      events.EventQUICConnectionStream.name,
      async (streamEvent: events.EventQUICConnectionStream) => {
        const stream = streamEvent.detail;
        await waitP;
        const streamProm = stream.readable
          .pipeTo(stream.writable)
          .catch(() => {});
        activeServerStreams.push(streamProm);
      },
    );

    const stream = client.connection.newStream();
    const writer = stream.writable.getWriter();
    await writer.write(message);
    await writer.close();

    // Start unforced close of client
    const clientDestroyP = client.destroy({ force: false });

    const result = await Promise.race([
      clientDestroyP.then(() => true),
      sleep(500).then(() => false),
    ]);

    expect(result).toBe(false);

    // We can force close the streams causing client destruction to end
    client.connection.destroyStreams();
    await clientDestroyP;
    await Promise.allSettled(activeServerStreams);

    await server.stop({ force: true });
    waitResolveP();
    await waitP;
  });
  test('quicStream properly cleans up after cancelling without data sent', async () => {
    const cancelReason = Symbol('CancelReason');
    const connectionEventProm =
      utils.promise<events.EventQUICServerConnection>();
    const tlsConfig1 = await generateTLSConfig(defaultType);
    const tlsConfig2 = await generateTLSConfig(defaultType);
    const reasonConverters = testsUtils.createReasonConverters();
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig1.leafKeyPairPEM.privateKey,
        cert: tlsConfig1.leafCertPEM,
        verifyPeer: true,
        ca: tlsConfig2.caCertPEM,
      },
      ...reasonConverters,
    });
    socketCleanMethods.extractSocket(server);
    server.addEventListener(
      events.EventQUICServerConnection.name,
      (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: localhost,
    });
    const client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
        key: tlsConfig2.leafKeyPairPEM.privateKey,
        cert: tlsConfig2.leafCertPEM,
      },
      ...reasonConverters,
    });
    socketCleanMethods.extractSocket(client);
    const serverConnection = (await connectionEventProm.p).detail;

    // Do the test
    const { p: serverStreamP, resolveP: serverStreamResolveP } =
      utils.promise<QUICStream>();
    serverConnection.addEventListener(
      events.EventQUICConnectionStream.name,
      (event: events.EventQUICConnectionStream) => {
        serverStreamResolveP(event.detail);
      },
    );
    // Let's make a new stream.
    const clientStream = client.connection.newStream();
    const writer = clientStream.writable.getWriter();
    // Await writer.write(message);
    writer.releaseLock();
    clientStream.cancel(cancelReason);
    await expect(clientStream.readable.getReader().read()).rejects.toBe(
      cancelReason,
    );
    await expect(clientStream.writable.getWriter().write()).rejects.toBe(
      cancelReason,
    );

    // Let's check that the server side ended
    const serverStream = await serverStreamP;
    const serverReadProm = (async () => {
      for await (const _ of serverStream.readable) {
        // Just consume until stream throws
      }
    })();
    await expect(serverReadProm).rejects.toBe(cancelReason);
    const serverWriter = serverStream.writable.getWriter();
    // Should throw
    await expect(serverWriter.write(Buffer.from('hello'))).rejects.toBe(
      cancelReason,
    );

    // And client stream should've cleaned up
    await testsUtils.sleep(100);
    // Only two streams should've been created
    expect(createQUICStreamMock).toHaveBeenCalledTimes(2);

    expect(clientStream[destroyed]).toBeTrue();
    await client.destroy({ force: true });
    await server.stop({ force: true });
  });
  test('quicStream properly cleans up after cancelling with data sent', async () => {
    const cancelReason = Symbol('CancelReason');
    const connectionEventProm =
      utils.promise<events.EventQUICServerConnection>();
    const tlsConfig1 = await generateTLSConfig(defaultType);
    const tlsConfig2 = await generateTLSConfig(defaultType);
    const reasonConverters = testsUtils.createReasonConverters();
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig1.leafKeyPairPEM.privateKey,
        cert: tlsConfig1.leafCertPEM,
        verifyPeer: true,
        ca: tlsConfig2.caCertPEM,
      },
      ...reasonConverters,
    });
    socketCleanMethods.extractSocket(server);
    server.addEventListener(
      events.EventQUICServerConnection.name,
      (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: localhost,
    });
    const client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
        key: tlsConfig2.leafKeyPairPEM.privateKey,
        cert: tlsConfig2.leafCertPEM,
      },
      ...reasonConverters,
    });
    socketCleanMethods.extractSocket(client);
    const serverConnection = (await connectionEventProm.p).detail;

    // Do the test
    const { p: serverStreamP, resolveP: serverStreamResolveP } =
      utils.promise<QUICStream>();
    serverConnection.addEventListener(
      events.EventQUICConnectionStream.name,
      (event: events.EventQUICConnectionStream) => {
        serverStreamResolveP(event.detail);
      },
    );
    // Let's make a new stream.
    const message = Buffer.from('Hello!');
    const clientStream = client.connection.newStream();
    const writer = clientStream.writable.getWriter();
    await writer.write(message);
    writer.releaseLock();
    clientStream.cancel(cancelReason);
    await expect(clientStream.readable.getReader().read()).rejects.toBe(
      cancelReason,
    );
    await expect(clientStream.writable.getWriter().write()).rejects.toBe(
      cancelReason,
    );

    // Let's check that the server side ended
    const serverStream = await serverStreamP;
    const serverReadProm = (async () => {
      for await (const _ of serverStream.readable) {
        // Just consume until stream throws
      }
    })();
    await expect(serverReadProm).rejects.toBe(cancelReason);
    const serverWriter = serverStream.writable.getWriter();
    // Should throw
    await expect(serverWriter.write(Buffer.from('hello'))).rejects.toBe(
      cancelReason,
    );

    // And client stream should've cleaned up
    await testsUtils.sleep(100);
    // Only two streams should've been created
    expect(createQUICStreamMock).toHaveBeenCalledTimes(2);

    expect(clientStream[destroyed]).toBeTrue();
    await client.destroy({ force: true });
    await server.stop({ force: true });
  });
  test('quicStream properly cleans up after graceful end with data sent', async () => {
    const connectionEventProm =
      utils.promise<events.EventQUICServerConnection>();
    const tlsConfig1 = await generateTLSConfig(defaultType);
    const tlsConfig2 = await generateTLSConfig(defaultType);
    const reasonConverters = testsUtils.createReasonConverters();
    const server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: logger.getChild(QUICServer.name),
      config: {
        key: tlsConfig1.leafKeyPairPEM.privateKey,
        cert: tlsConfig1.leafCertPEM,
        verifyPeer: true,
        ca: tlsConfig2.caCertPEM,
      },
      ...reasonConverters,
    });
    socketCleanMethods.extractSocket(server);
    server.addEventListener(
      events.EventQUICServerConnection.name,
      (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
    );
    await server.start({
      host: localhost,
    });
    const client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
        key: tlsConfig2.leafKeyPairPEM.privateKey,
        cert: tlsConfig2.leafCertPEM,
      },
      ...reasonConverters,
    });
    socketCleanMethods.extractSocket(client);
    const serverConnection = (await connectionEventProm.p).detail;

    // Do the test
    const { p: serverStreamP, resolveP: serverStreamResolveP } =
      utils.promise<QUICStream>();
    serverConnection.addEventListener(
      events.EventQUICConnectionStream.name,
      (event: events.EventQUICConnectionStream) => {
        serverStreamResolveP(event.detail);
      },
    );
    // Let's make a new stream.
    const message = Buffer.from('Hello!');
    const clientStream = client.connection.newStream();
    const writer = clientStream.writable.getWriter();
    await writer.write(message);
    await writer.close();

    // Let's check that the server side ended
    const serverStream = await serverStreamP;
    const serverReadP = (async () => {
      const writer = serverStream.writable.getWriter();
      await writer.write(message);
      await writer.close();
      for await (const _ of serverStream.readable) {
        // Just consume until finish
      }
    })();
    for await (const _ of clientStream.readable) {
      // Just consume until finish
    }
    await serverReadP;

    // And client stream should've cleaned up
    await testsUtils.sleep(100);
    // Only two streams should've been created
    expect(createQUICStreamMock).toHaveBeenCalledTimes(2);

    expect(clientStream[destroyed]).toBeTrue();
    await client.destroy({ force: true });
    await server.stop({ force: true });
  });
});
