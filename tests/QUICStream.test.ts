import type { ClientCryptoOps, ServerCryptoOps } from '#types.js';
import type { TLSConfigs } from './utils.js';
import type QUICConnection from '#QUICConnection.js';
import Logger, { formatting, LogLevel, StreamHandler } from '@matrixai/logger';
import { test } from '@fast-check/jest';
import { firstValueFrom } from 'rxjs';
import * as testsUtils from './utils.js';
import { generateTLSConfig } from './utils.js';
import QUICServer from '#QUICServer.js';
import QUICClient from '#QUICClient.js';
import QUICStream from '#QUICStream.js';
import * as utils from '#utils.js';

describe('QUICStream', () => {
  const _logger = new Logger(`QUICStream Test`, LogLevel.SILENT, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  const loggerClient = new Logger(`QUICClient`, LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  const loggerServer = new Logger(`QUICServer`, LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  const defaultType = 'RSA';
  const localhost = '127.0.0.1';
  // This has to be set up asynchronously due to key generation
  const serverCrypto: ServerCryptoOps = {
    sign: testsUtils.signHMAC,
    verify: testsUtils.verifyHMAC,
  };
  let key: ArrayBuffer;
  const clientCrypto: ClientCryptoOps = {
    randomBytes: testsUtils.randomBytes,
  };
  let socketCleanMethods: ReturnType<typeof testsUtils.socketCleanupFactory>;

  let tlsConfig: TLSConfigs;
  let server: QUICServer;
  let serverConnection: QUICConnection;
  let client: QUICClient;
  let clientConnection: QUICConnection;

  // We need to test the stream-making
  beforeEach(async () => {
    key = await testsUtils.generateKeyHMAC();
    socketCleanMethods = testsUtils.socketCleanupFactory();

    tlsConfig = await generateTLSConfig(defaultType);
    server = new QUICServer({
      crypto: {
        key,
        ops: serverCrypto,
      },
      logger: loggerServer.getChild(QUICServer.name),
      config: {
        key: tlsConfig.leafKeyPairPEM.privateKey,
        cert: tlsConfig.leafCertPEM,
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(server);
    const connectionP = firstValueFrom(server.connection$, {
      defaultValue: undefined,
    });
    await server.start({
      host: localhost,
    });
    client = await QUICClient.createQUICClient({
      host: localhost,
      port: server.port,
      localHost: localhost,
      crypto: {
        ops: clientCrypto,
      },
      logger: loggerClient.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
      },
    });
    socketCleanMethods.extractSocket(client);
    const connection = await connectionP;
    if (connection == null) throw Error('Connection is missing');
    serverConnection = connection;
    clientConnection = client.connection;
  });
  afterEach(async () => {
    await server.stop({ force: true });
    await client.destroy({ force: true });
    await socketCleanMethods.stopSockets();
  });

  // Easy paths
  test('should create a stream on client', async () => {
    // Note that no stream is created on the server side unless a message is sent.
    // Can create a stream
    const clientStream = clientConnection.newStream();
    expect(clientStream).toBeInstanceOf(QUICStream);
    // StreamId should be the initial client initiated bidi
    expect(clientStream.id).toBe(0b00);
  });
  test('should create a stream on server', async () => {
    // Note that no stream is created on the server side unless a message is sent.
    // Can create a stream
    const serverStream = serverConnection.newStream();
    expect(serverStream).toBeInstanceOf(QUICStream);
    // StreamId should be the initial server initiated bidi
    expect(serverStream.id).toBe(0b01);
  });
  test('should trigger complement stream on first message sent on client', async () => {
    const serverStreamP = firstValueFrom(serverConnection.stream$);
    const clientStream = clientConnection.newStream();
    const clientWriter = clientStream.writable.getWriter();
    // Writing a message should trigger the stream creation on the server side.
    await clientWriter.write(Buffer.from('message'));
    const serverStream = await serverStreamP;
    expect(serverStream).toBeInstanceOf(QUICStream);
    expect(serverStream.id).toBe(0b00);
  });
  test('should trigger complement stream on first message sent on server', async () => {
    const clientStreamP = firstValueFrom(clientConnection.stream$);
    const serverStream = serverConnection.newStream();
    const serverWriter = serverStream.writable.getWriter();
    // Writing a message should trigger the stream creation on the client side.
    await serverWriter.write(Buffer.from('message'));
    const clientStream = await clientStreamP;
    expect(clientStream).toBeInstanceOf(QUICStream);
    expect(clientStream.id).toBe(0b01);
  });
  test('should send data over stream', async () => {
    const messages = [
      'The ',
      'Quick ',
      'Brown ',
      'Fox ',
      'Jumped ',
      'Over ',
      'The ',
      'Lazy ',
      'Dog.',
    ];
    const serverStreamP = firstValueFrom(serverConnection.stream$);
    const clientStream = clientConnection.newStream();
    const clientWriter = clientStream.writable.getWriter();
    for (const message of messages) {
      await clientWriter.write(Buffer.from(message));
    }
    await clientWriter.close();
    const serverStream = await serverStreamP;
    let receivedData = '';
    for await (const chunk of serverStream.readable) {
      receivedData += chunk.toString();
    }
    expect(receivedData).toBe(messages.join(''));
  });
  test('should send large amount of data over stream', async () => {
    // Large amounts of data will block the writes until the buffers are drained.
    // So we need a non-blocking way of sending and receiving the data at the same time.
    // Default stream capacity is 13,500 bytes.
    const message = Buffer.alloc(
      20000,
      'The Quick Brown Fox Jumped Over The Lazy Dog.',
    );
    const serverStreamP = firstValueFrom(serverConnection.stream$);
    const handleServerStreamP = (async () => {
      const serverStream = await serverStreamP;
      let receivedData = '';
      for await (const chunk of serverStream.readable) {
        receivedData += chunk.toString();
      }
      return receivedData;
    })();
    const clientStream = clientConnection.newStream();
    const clientWriter = clientStream.writable.getWriter();
    await clientWriter.write(message);
    await clientWriter.close();
    const receivedData = await handleServerStreamP;
    expect(receivedData).toBe(message.toString());
  });
  test('should handle multiple streams on client', async () => {
    const message = Buffer.alloc(
      20000,
      'The Quick Brown Fox Jumped Over The Lazy Dog.',
    );
    const streamsNum = 10;
    const serverStreamPromises: Array<Promise<string>> = [];
    const serverStreamsCreatedProm = utils.promise<void>();
    let serverStreamCount = 0;
    serverConnection.stream$.subscribe((stream) => {
      serverStreamPromises.push(
        (async () => {
          let receivedData = '';
          for await (const chunk of stream.readable) {
            receivedData += chunk.toString();
          }
          return receivedData;
        })(),
      );
      serverStreamCount++;
      if (serverStreamCount >= streamsNum) serverStreamsCreatedProm.resolveP();
    });
    // Start creating streams concurrently
    const waitProm = utils.promise();
    const clientStreamPromises: Array<Promise<void>> = [];
    for (let i = 0; i < streamsNum; i++) {
      clientStreamPromises.push(
        (async () => {
          await waitProm.p;
          const stream = clientConnection.newStream();
          const writer = stream.writable.getWriter();
          await writer.write(message);
          await writer.close();
        })(),
      );
    }

    // Now we let everything run concurrently
    waitProm.resolveP();
    await Promise.all(clientStreamPromises);
    await serverStreamsCreatedProm.p;
    const results = await Promise.all(serverStreamPromises);
    for (const result of results) {
      expect(result).toBe(message.toString());
    }
  });
  test('should handle multiple streams on server', async () => {
    const message = Buffer.alloc(
      20000,
      'The Quick Brown Fox Jumped Over The Lazy Dog.',
    );
    const streamsNum = 10;
    const clientStreamPromises: Array<Promise<string>> = [];
    const clientStreamsCreatedProm = utils.promise<void>();
    let clientStreamCount = 0;
    clientConnection.stream$.subscribe((stream) => {
      clientStreamPromises.push(
        (async () => {
          let receivedData = '';
          for await (const chunk of stream.readable) {
            receivedData += chunk.toString();
          }
          return receivedData;
        })(),
      );
      clientStreamCount++;
      if (clientStreamCount >= streamsNum) clientStreamsCreatedProm.resolveP();
    });
    // Start creating streams concurrently
    const waitProm = utils.promise();
    const serverStreamPromises: Array<Promise<void>> = [];
    for (let i = 0; i < streamsNum; i++) {
      serverStreamPromises.push(
        (async () => {
          await waitProm.p;
          const stream = serverConnection.newStream();
          const writer = stream.writable.getWriter();
          await writer.write(message);
          await writer.close();
        })(),
      );
    }

    // Now we let everything run concurrently
    waitProm.resolveP();
    await Promise.all(serverStreamPromises);
    await clientStreamsCreatedProm.p;
    const results = await Promise.all(clientStreamPromises);
    for (const result of results) {
      expect(result).toBe(message.toString());
    }
  });

  // Problem paths
  test('should handle writeable stream abort with data sent', async () => {
    const serverStreamP = firstValueFrom(serverConnection.stream$);
    const clientStream = clientConnection.newStream();
    const clientWriter = clientStream.writable.getWriter();
    // Writing a message should trigger the stream creation on the server side.
    await clientWriter.write(Buffer.from('message'));
    await clientWriter.abort(new Error('some error'));
    const serverStream = await serverStreamP;
    const readP = (async () => {
      for await (const _chunk of serverStream.readable) {
        // Consume stream data
      }
    })();
    await expect(readP).rejects.toThrow();
  });
  test('should handle writeable stream abort with no data sent', async () => {
    const serverStreamP = firstValueFrom(serverConnection.stream$);
    const clientStream = clientConnection.newStream();
    const clientWriter = clientStream.writable.getWriter();
    // Writing a message should trigger the stream creation on the server side.
    await clientWriter.abort(new Error('some error'));
    const serverStream = await serverStreamP;
    const readP = (async () => {
      for await (const _chunk of serverStream.readable) {
        // Consume data
      }
    })();
    await firstValueFrom(serverStream.readableComplete$);
    // FIXME: check actual error
    await expect(readP).rejects.toThrow();
  });
  test('should handle writeable stream abort while data blocked', async () => {
    const serverStreamP = firstValueFrom(serverConnection.stream$);
    const clientStream = clientConnection.newStream();
    const clientWriter = clientStream.writable.getWriter();
    // Writing a message should trigger the stream creation on the server side.
    await clientWriter.write(Buffer.alloc(20000, 'message'));
    await clientWriter.abort(new Error('some error'));

    const waitProm = utils.promise();
    const serverStream = await serverStreamP;
    const readP = (async () => {
      for await (const _chunk of serverStream.readable) {
        await waitProm.p;
      }
    })();
    // Waiting for the readable stream to end despite not being consumed
    await firstValueFrom(serverStream.readableComplete$);
    waitProm.resolveP();
    // FIXME: check actual error
    await expect(readP).rejects.toThrow();
  });
  test('should handle readable stream cancel with data sent', async () => {
    const message = Buffer.from('message');
    const serverStreamP = firstValueFrom(serverConnection.stream$);
    const clientStream = clientConnection.newStream();
    const clientWriter = clientStream.writable.getWriter();
    // Writing a message should trigger the stream creation on the server side.
    await clientWriter.write(message);
    const serverStream = await serverStreamP;
    const serverReader = serverStream.readable.getReader();
    await serverReader.read();
    await serverReader.cancel(new Error('some error'));
    await firstValueFrom(clientStream.writableComplete$);
    // TODO: use actual error
    await expect(clientWriter.write(message)).rejects.toThrow();
  });
  // It's not possible to cancel the readable stream before data is sent
  //  because we need data to be sent to create the stream in the first place.
  test.todo(
    'should handle readable stream cancel while data blocked',
    async () => {},
  );
  // TODO: add obervables for data being block or waiting;

  test.todo('shutting down client should clean up streams');
  test.todo('shutting down server should clean up streams');

  // Test('destroying stream should clean up on both ends while streams are used', async () => {
  //   const message = Buffer.from('Message!');
  //   const streamsNum = 10;
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig = await generateTLSConfig(defaultType);
  //   const streams: Array<QUICStream> = [];
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig.leafCertPEM,
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   const conn = (await connectionEventProm.p).detail;
  //   // Do the test
  //   let streamCreatedCount = 0;
  //   let streamEndedCount = 0;
  //   const streamCreationProm = utils.promise();
  //   const streamEndedProm = utils.promise();
  //   conn.addEventListener(
  //     events.EventQUICConnectionStream.name,
  //     (event: events.EventQUICConnectionStream) => {
  //       const stream = event.detail;
  //       streamCreatedCount += 1;
  //       if (streamCreatedCount >= streamsNum) streamCreationProm.resolveP();
  //       void stream.readable
  //         .pipeTo(stream.writable)
  //         // Ignore errors
  //         .catch(() => {})
  //         .finally(() => {
  //           streamEndedCount += 1;
  //           if (streamEndedCount >= streamsNum) streamEndedProm.resolveP();
  //         });
  //     },
  //   );
  //   // Let's make a new streams.
  //   for (let i = 0; i < streamsNum; i++) {
  //     const stream = client.connection.newStream();
  //     streams.push(stream);
  //     const writer = stream.writable.getWriter();
  //     await writer.write(message);
  //     writer.releaseLock();
  //   }
  //   await streamCreationProm.p;
  //   // Start destroying streams
  //   await Promise.allSettled(streams.map((stream) => stream.destroy()));
  //   await streamEndedProm.p;
  //   expect(streamCreatedCount).toBe(streamsNum);
  //   expect(streamEndedCount).toBe(streamsNum);
  //   await client.destroy({ force: true });
  //   await server.stop({ force: true });
  // });

  // test('should send data over stream', async () => {
  //   const message = Buffer.from('The Quick Brown Fox Jumped Over The Lazy Dog');
  //   const numStreams = 10;
  //   const numMessage = 10;
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig = await generateTLSConfig(defaultType);
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig.leafCertPEM,
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   const conn = (await connectionEventProm.p).detail;
  //   // Do the test
  //   const activeServerStreams: Array<Promise<void>> = [];
  //   conn.addEventListener(
  //     events.EventQUICConnectionStream.name,
  //     (streamEvent: events.EventQUICConnectionStream) => {
  //       const stream = streamEvent.detail;
  //       const streamProm = stream.readable.pipeTo(stream.writable);
  //       activeServerStreams.push(streamProm);
  //     },
  //   );
  //
  //   // Let's make a new streams.
  //   const activeClientStreams: Array<Promise<void>> = [];
  //   for (let i = 0; i < numStreams; i++) {
  //     activeClientStreams.push(
  //       (async () => {
  //         const stream = client.connection.newStream();
  //         const writer = stream.writable.getWriter();
  //         const reader = stream.readable.getReader();
  //         // Do write and read messages here.
  //         for (let j = 0; j < numMessage; j++) {
  //           await writer.write(message);
  //           const readMessage = await reader.read();
  //           expect(readMessage.done).toBeFalse();
  //           expect(readMessage.value).toStrictEqual(message);
  //         }
  //         await writer.close();
  //         const value = await reader.read();
  //         expect(value.done).toBeTrue();
  //       })(),
  //     );
  //   }
  //   await Promise.all([
  //     Promise.all(activeClientStreams),
  //     Promise.all(activeServerStreams),
  //   ]);
  //   await client.destroy({ force: true });
  //   await server.stop({ force: true });
  // });

  // test('sent data should be correct and expected', async () => {
  //   const messages = [
  //     'The',
  //     'Quick',
  //     'Brown',
  //     'Fox',
  //     'Jumped',
  //     'Over',
  //     'The',
  //     'Lazy',
  //     'Dog',
  //   ].map((v) => Buffer.from(v));
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig = await generateTLSConfig(defaultType);
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig.leafCertPEM,
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   const conn = (await connectionEventProm.p).detail;
  //   // Do the test
  //   const streamProm = utils.promise<QUICStream>();
  //   conn.addEventListener(
  //     events.EventQUICConnectionStream.name,
  //     (streamEvent: events.EventQUICConnectionStream) => {
  //       streamProm.resolveP(streamEvent.detail);
  //     },
  //     { once: true },
  //   );
  //
  //   // Create a stream
  //   const streamLocal = client.connection.newStream();
  //   const writerLocal = streamLocal.writable.getWriter();
  //   for (const message of messages) {
  //     await writerLocal.write(message);
  //   }
  //   await writerLocal.close();
  //   const streamPeer = await streamProm.p;
  //   const writerPeer = streamPeer.writable.getWriter();
  //   for (const message of messages) {
  //     await writerPeer.write(message);
  //   }
  //   await writerPeer.close();
  //
  //   const readMessagesLocal: Array<any> = [];
  //   const readMessagesPeer: Array<any> = [];
  //   for await (const chunk of streamPeer.readable) {
  //     readMessagesLocal.push(chunk);
  //   }
  //   for await (const chunk of streamLocal.readable) {
  //     readMessagesPeer.push(chunk);
  //   }
  //
  //   const expected = messages.map((v) => Buffer.from(v)).join(' ');
  //   expect(readMessagesLocal.map((v) => Buffer.from(v)).join(' ')).toBe(
  //     expected,
  //   );
  //   expect(readMessagesPeer.map((v) => Buffer.from(v)).join(' ')).toBe(
  //     expected,
  //   );
  //
  //   await client.destroy({ force: true });
  //   await server.stop({ force: true });
  // });

  // test('should propagate errors over stream for writable', async () => {
  //   const tlsConfig = await generateTLSConfig(defaultType);
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     codeToReason: testCodeToReason,
  //     reasonToCode: testReasonToCode,
  //     config: {
  //       key: tlsConfig.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig.leafCertPEM,
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(server);
  //
  //   const streamProm = utils.promise<QUICStream>();
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (evt: events.EventQUICServerConnection) => {
  //       const conn = evt.detail;
  //       conn.addEventListener(
  //         events.EventQUICConnectionStream.name,
  //         (evt: events.EventQUICConnectionStream) => {
  //           streamProm.resolveP(evt.detail);
  //         },
  //         { once: true },
  //       );
  //     },
  //     { once: true },
  //   );
  //
  //   await server.start({
  //     host: localhost,
  //   });
  //
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //     },
  //     codeToReason: testCodeToReason,
  //     reasonToCode: testReasonToCode,
  //   });
  //   socketCleanMethods.extractSocket(client);
  //
  //   // Create a stream
  //   const clientStream = client.connection.newStream();
  //
  //   const clientWriter = clientStream.writable.getWriter();
  //   const clientReader = clientStream.readable.getReader();
  //   await clientWriter.write(Buffer.from('hello'));
  //
  //   const serverStream = await streamProm.p;
  //   const serverWriter = serverStream.writable.getWriter();
  //   const serverReader = serverStream.readable.getReader();
  //   await serverReader.read();
  //
  //   // Forward write error
  //   await clientWriter.abort(testReason);
  //   await expect(serverReader.read()).rejects.toBe(testReason);
  //   await serverWriter.abort(testReason);
  //   await expect(clientReader.read()).rejects.toBe(testReason);
  //
  //   await client.destroy({ force: true });
  //   await server.stop({ force: true });
  // });

  // test('should propagate errors over stream for readable', async () => {
  //   const tlsConfig = await generateTLSConfig(defaultType);
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     codeToReason: testCodeToReason,
  //     reasonToCode: testReasonToCode,
  //     config: {
  //       key: tlsConfig.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig.leafCertPEM,
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(server);
  //
  //   const streamProm = utils.promise<QUICStream>();
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (evt: events.EventQUICServerConnection) => {
  //       const conn = evt.detail;
  //       conn.addEventListener(
  //         events.EventQUICConnectionStream.name,
  //         (evt: events.EventQUICConnectionStream) => {
  //           streamProm.resolveP(evt.detail);
  //         },
  //         { once: true },
  //       );
  //     },
  //     { once: true },
  //   );
  //
  //   await server.start({
  //     host: localhost,
  //   });
  //
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //     },
  //     codeToReason: testCodeToReason,
  //     reasonToCode: testReasonToCode,
  //   });
  //   socketCleanMethods.extractSocket(client);
  //
  //   // Create a stream
  //   const clientStream = client.connection.newStream();
  //
  //   const clientWriter = clientStream.writable.getWriter();
  //   const clientReader = clientStream.readable.getReader();
  //   await clientWriter.write(Buffer.from('hello'));
  //
  //   const serverStream = await streamProm.p;
  //   const serverWriter = serverStream.writable.getWriter();
  //   const serverReader = serverStream.readable.getReader();
  //   await serverReader.read();
  //
  //   // Forward write error
  //   await clientReader.cancel(testReason);
  //   await serverReader.cancel(testReason);
  //   // Takes some time for reader cancel to propagate to the writer
  //   await clientStream.closedP;
  //   await serverStream.closedP;
  //   await expect(serverWriter.write(Buffer.from('hello'))).rejects.toBe(
  //     testReason,
  //   );
  //   await expect(clientWriter.write(Buffer.from('hello'))).rejects.toBe(
  //     testReason,
  //   );
  //
  //   await client.destroy({ force: true });
  //   await server.stop({ force: true });
  // });

  // test('should clean up streams when local connection ends', async () => {
  //   const streamsNum = 10;
  //   const message = Buffer.from('The quick brown fox jumped over the lazy dog');
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig = await generateTLSConfig(defaultType);
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig.leafCertPEM,
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   const conn = (await connectionEventProm.p).detail;
  //   // Do the test
  //   let streamCreatedCount = 0;
  //   let streamEndedCount = 0;
  //   const streamCreationProm = utils.promise();
  //   const streamEndedProm = utils.promise();
  //   conn.addEventListener(
  //     events.EventQUICConnectionStream.name,
  //     (asd: events.EventQUICConnectionStream) => {
  //       const stream = asd.detail;
  //       streamCreatedCount += 1;
  //       if (streamCreatedCount >= streamsNum) streamCreationProm.resolveP();
  //       void stream.readable
  //         .pipeTo(stream.writable)
  //         // Ignore errors
  //         .catch(() => {})
  //         .finally(() => {
  //           streamEndedCount += 1;
  //           if (streamEndedCount >= streamsNum) streamEndedProm.resolveP();
  //         });
  //     },
  //   );
  //   // Let's make a new streams.
  //   for (let i = 0; i < streamsNum; i++) {
  //     const stream = client.connection.newStream();
  //     const writer = stream.writable.getWriter();
  //     await writer.write(message);
  //     writer.releaseLock();
  //   }
  //   await streamCreationProm.p;
  //   // Start destroying streams
  //   await client.destroy({ force: true });
  //   // All streams need to finish
  //   await streamEndedProm.p;
  //   expect(streamCreatedCount).toBe(streamsNum);
  //   expect(streamEndedCount).toBe(streamsNum);
  //   await client.destroy({ force: true });
  //   await server.stop({ force: true });
  // });

  // test('should clean up streams when peer connection ends', async () => {
  //   const streamsNum = 10;
  //   const message = Buffer.from('The quick brown fox jumped over the lazy dog');
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig = await generateTLSConfig(defaultType);
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig.leafCertPEM,
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   const conn = (await connectionEventProm.p).detail;
  //   // Do the test
  //   let streamCreatedCount = 0;
  //   let streamEndedCount = 0;
  //   const streamCreationProm = utils.promise();
  //   const streamEndedProm = utils.promise();
  //   conn.addEventListener(
  //     events.EventQUICConnectionStream.name,
  //     (asd: events.EventQUICConnectionStream) => {
  //       const stream = asd.detail;
  //       streamCreatedCount += 1;
  //       if (streamCreatedCount >= streamsNum) streamCreationProm.resolveP();
  //       void stream.readable
  //         .pipeTo(stream.writable)
  //         // Ignore errors
  //         .catch(() => {})
  //         .finally(() => {
  //           streamEndedCount += 1;
  //           if (streamEndedCount >= streamsNum) streamEndedProm.resolveP();
  //         });
  //     },
  //   );
  //   // Let's make a new streams.
  //   for (let i = 0; i < streamsNum; i++) {
  //     const stream = client.connection.newStream();
  //     const writer = stream.writable.getWriter();
  //     await writer.write(message);
  //     writer.releaseLock();
  //   }
  //   await streamCreationProm.p;
  //   // Start destroying streams
  //   await conn.stop({ force: true });
  //   await streamEndedProm.p;
  //   expect(streamCreatedCount).toBe(streamsNum);
  //   expect(streamEndedCount).toBe(streamsNum);
  // });

  // test('should clean up streams when connection times out', async () => {
  //   const streamsNum = 10;
  //   const message = Buffer.from('The quick brown fox jumped over the lazy dog');
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig = await generateTLSConfig(defaultType);
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig.leafCertPEM,
  //       verifyPeer: false,
  //       maxIdleTimeout: 100,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //     { once: true },
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   const conn = (await connectionEventProm.p).detail;
  //   // Do the test
  //   let streamCreatedCount = 0;
  //   let streamEndedCount = 0;
  //   const streamCreationProm = utils.promise();
  //   const streamEndedProm = utils.promise();
  //   conn.addEventListener(
  //     events.EventQUICConnectionStream.name,
  //     (asd: events.EventQUICConnectionStream) => {
  //       const stream = asd.detail;
  //       streamCreatedCount += 1;
  //       if (streamCreatedCount >= streamsNum) streamCreationProm.resolveP();
  //       void stream.readable
  //         .pipeTo(stream.writable)
  //         // Ignore errors
  //         .catch(() => {})
  //         .finally(() => {
  //           streamEndedCount += 1;
  //           if (streamEndedCount >= streamsNum) streamEndedProm.resolveP();
  //         });
  //     },
  //   );
  //   // Let's make a new streams.
  //   for (let i = 0; i < streamsNum; i++) {
  //     const stream = client.connection.newStream();
  //     const writer = stream.writable.getWriter();
  //     await writer.write(message);
  //     writer.releaseLock();
  //   }
  //   await streamCreationProm.p;
  //   await streamEndedProm.p;
  //   expect(streamCreatedCount).toBe(streamsNum);
  //   expect(streamEndedCount).toBe(streamsNum);
  //   await client.destroy({ force: true });
  //   await server.stop({ force: true });
  // });

  // test('streams should contain metadata', async () => {
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig1 = await generateTLSConfig(defaultType);
  //   const tlsConfig2 = await generateTLSConfig(defaultType);
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig1.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig1.leafCertPEM,
  //       verifyPeer: true,
  //       ca: tlsConfig2.caCertPEM,
  //       maxIdleTimeout: 100,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //       key: tlsConfig2.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig2.leafCertPEM,
  //       maxIdleTimeout: 100,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   const conn = (await connectionEventProm.p).detail;
  //   // Do the test
  //   const serverStreamProm = utils.promise<QUICStream>();
  //   conn.addEventListener(
  //     events.EventQUICConnectionStream.name,
  //     (event: events.EventQUICConnectionStream) => {
  //       serverStreamProm.resolveP(event.detail);
  //     },
  //   );
  //   // Let's make a new streams.
  //   const message = Buffer.from('Hello!');
  //   const clientStream = client.connection.newStream();
  //   const writer = clientStream.writable.getWriter();
  //   await writer.write(message);
  //   writer.releaseLock();
  //   await serverStreamProm.p;
  //   const clientMetadata = clientStream.meta;
  //   expect(clientMetadata.localHost).toBe(client.localHost);
  //   expect(clientMetadata.localPort).toBe(client.localPort);
  //   expect(clientMetadata.remoteHost).toBe(server.host);
  //   expect(clientMetadata.remotePort).toBe(server.port);
  //   expect(clientMetadata.remoteCertsChain?.length).toBeGreaterThan(0);
  //   const clientPemChain = utils.collectPEMs(
  //     clientMetadata.remoteCertsChain.map((v) => utils.derToPEM(v)),
  //   );
  //   expect(clientPemChain[0]).toEqual(tlsConfig1.leafCertPEM);
  //
  //   const serverStream = await serverStreamProm.p;
  //   const serverMetadata = serverStream.meta;
  //   expect(serverMetadata.localHost).toBe(server.host);
  //   expect(serverMetadata.localPort).toBe(server.port);
  //   expect(serverMetadata.remoteHost).toBe(client.localHost);
  //   expect(serverMetadata.remotePort).toBe(client.localPort);
  //   expect(serverMetadata.remoteCertsChain?.length).toBeGreaterThan(0);
  //   const serverPemChain = utils.collectPEMs(
  //     serverMetadata.remoteCertsChain.map((v) => utils.derToPEM(v)),
  //   );
  //   expect(serverPemChain[0]).toEqual(tlsConfig2.leafCertPEM);
  //   await client.destroy({ force: true });
  //   await server.stop({ force: true });
  // });

  // test('streams can be cancelled after data sent', async () => {
  //   const cancelReason = Symbol('CancelReason');
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig1 = await generateTLSConfig(defaultType);
  //   const tlsConfig2 = await generateTLSConfig(defaultType);
  //   const reasonConverters = testsUtils.createReasonConverters();
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig1.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig1.leafCertPEM,
  //       verifyPeer: true,
  //       ca: tlsConfig2.caCertPEM,
  //     },
  //     ...reasonConverters,
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //       key: tlsConfig2.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig2.leafCertPEM,
  //     },
  //     ...reasonConverters,
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   const conn = (await connectionEventProm.p).detail;
  //   // Do the test
  //   const serverStreamProm = utils.promise<QUICStream>();
  //   conn.addEventListener(
  //     events.EventQUICConnectionStream.name,
  //     (event: events.EventQUICConnectionStream) => {
  //       serverStreamProm.resolveP(event.detail);
  //     },
  //   );
  //   // Let's make a new streams.
  //   const message = Buffer.from('Hello!');
  //   const clientStream = client.connection.newStream();
  //   const writer = clientStream.writable.getWriter();
  //   await writer.write(message);
  //   writer.releaseLock();
  //   clientStream.cancel(cancelReason);
  //   await expect(clientStream.readable.getReader().read()).rejects.toBe(
  //     cancelReason,
  //   );
  //   await expect(clientStream.writable.getWriter().write()).rejects.toBe(
  //     cancelReason,
  //   );
  //
  //   // Let's check that the server side ended
  //   const serverStream = await serverStreamProm.p;
  //   const serverReadProm = (async () => {
  //     for await (const _ of serverStream.readable) {
  //       // Just consume until stream throws
  //     }
  //   })();
  //   await expect(serverReadProm).rejects.toBe(cancelReason);
  //   const serverWriter = serverStream.writable.getWriter();
  //   // Should throw
  //   await expect(serverWriter.write(Buffer.from('hello'))).rejects.toBe(
  //     cancelReason,
  //   );
  //
  //   // And client stream should've cleaned up
  //   await testsUtils.sleep(100);
  //   expect(clientStream[destroyed]).toBeTrue();
  //   await client.destroy({ force: true });
  //   await server.stop({ force: true });
  // });

  // test('streams can be cancelled with no data sent', async () => {
  //   const connectionEventProm = utils.promise<QUICConnection>();
  //   const tlsConfig1 = await generateTLSConfig(defaultType);
  //   const tlsConfig2 = await generateTLSConfig(defaultType);
  //   const reasonConverters = testsUtils.createReasonConverters();
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig1.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig1.leafCertPEM,
  //       verifyPeer: true,
  //       ca: tlsConfig2.caCertPEM,
  //     },
  //     ...reasonConverters,
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (evt: events.EventQUICServerConnection) =>
  //       connectionEventProm.resolveP(evt.detail),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //       key: tlsConfig2.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig2.leafCertPEM,
  //     },
  //     ...reasonConverters,
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   const conn = await connectionEventProm.p;
  //   // Do the test
  //   const serverStreamProm = utils.promise<QUICStream>();
  //   conn.addEventListener(
  //     events.EventQUICConnectionStream.name,
  //     (event: events.EventQUICConnectionStream) => {
  //       serverStreamProm.resolveP(event.detail);
  //     },
  //   );
  //   // Let's make a new streams.
  //   const clientStream = client.connection.newStream();
  //   clientStream.cancel(testReason);
  //   await expect(clientStream.readable.getReader().read()).rejects.toBe(
  //     testReason,
  //   );
  //   await expect(clientStream.writable.getWriter().write()).rejects.toBe(
  //     testReason,
  //   );
  //
  //   // Let's check that the server side ended
  //   const serverStream = await serverStreamProm.p;
  //   const serverReadProm = (async () => {
  //     for await (const _ of serverStream.readable) {
  //       // Just consume until stream throws
  //     }
  //   })();
  //   await expect(serverReadProm).rejects.toBe(testReason);
  //   const serverWriter = serverStream.writable.getWriter();
  //   // Should throw
  //   await expect(serverWriter.write(Buffer.from('hello'))).rejects.toBe(
  //     testReason,
  //   );
  //
  //   // And client stream should've cleaned up
  //   await clientStream.closedP;
  //   await serverStream.closedP;
  //   expect(clientStream[destroyed]).toBeTrue();
  //   await client.destroy({ force: true });
  //   await server.stop({ force: true });
  // });

  // test('streams can be cancelled concurrently after data sent', async () => {
  //   const cancelReason = Symbol('CancelReason');
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig1 = await generateTLSConfig(defaultType);
  //   const tlsConfig2 = await generateTLSConfig(defaultType);
  //   const reasonConverters = testsUtils.createReasonConverters();
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig1.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig1.leafCertPEM,
  //       verifyPeer: true,
  //       ca: tlsConfig2.caCertPEM,
  //     },
  //     ...reasonConverters,
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //       key: tlsConfig2.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig2.leafCertPEM,
  //     },
  //     ...reasonConverters,
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   const conn = (await connectionEventProm.p).detail;
  //   // Do the test
  //   const serverStreamProm = utils.promise<QUICStream>();
  //   conn.addEventListener(
  //     events.EventQUICConnectionStream.name,
  //     (event: events.EventQUICConnectionStream) => {
  //       serverStreamProm.resolveP(event.detail);
  //     },
  //   );
  //   // Let's make a new streams.
  //   const message = Buffer.from('Hello!');
  //   const clientStream = client.connection.newStream();
  //   const writer = clientStream.writable.getWriter();
  //   await writer.write(message);
  //   writer.releaseLock();
  //   const serverStream = await serverStreamProm.p;
  //   serverStream.cancel(cancelReason);
  //   clientStream.cancel(cancelReason);
  //
  //   // Checking stream states
  //   await expect(clientStream.readable.getReader().read()).rejects.toBe(
  //     cancelReason,
  //   );
  //   await expect(clientStream.writable.getWriter().write()).rejects.toBe(
  //     cancelReason,
  //   );
  //   await expect(serverStream.readable.getReader().read()).rejects.toBe(
  //     cancelReason,
  //   );
  //   await expect(serverStream.writable.getWriter().write()).rejects.toBe(
  //     cancelReason,
  //   );
  //
  //   // And client stream should've cleaned up
  //   await testsUtils.sleep(100);
  //   expect(clientStream[destroyed]).toBeTrue();
  //   await client.destroy({ force: true });
  //   await server.stop({ force: true });
  // });

  // test('stream will end when waiting for more data', async () => {
  //   // Needed to check that the pull based reading of data doesn't break when we
  //   // temporarily run out of data to read
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig = await generateTLSConfig(defaultType);
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig.leafCertPEM,
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   const conn = (await connectionEventProm.p).detail;
  //   // Do the test
  //   const streamCreationProm = utils.promise<QUICStream>();
  //   conn.addEventListener(
  //     events.EventQUICConnectionStream.name,
  //     (event: events.EventQUICConnectionStream) => {
  //       streamCreationProm.resolveP(event.detail);
  //     },
  //   );
  //   const message = Buffer.from('Hello!');
  //   const clientStream = client.connection.newStream();
  //   const clientWriter = clientStream.writable.getWriter();
  //   await clientWriter.write(message);
  //   await streamCreationProm.p;
  //   const serverStream = await streamCreationProm.p;
  //
  //   // Drain the readable buffer
  //   const serverReader = serverStream.readable.getReader();
  //   await serverReader.read();
  //   serverReader.releaseLock();
  //
  //   // Closing stream with no buffered data should be responsive
  //   await clientWriter.close();
  //   await serverStream.writable.close();
  //
  //   // Both streams are destroyed even without reading till close
  //   await Promise.all([clientStream.closedP, serverStream.closedP]);
  //
  //   await client.destroy({ force: true });
  //   await server.stop({ force: true });
  // });

  // test('stream can error when blocked on data', async () => {
  //   // This checks that if the readable web-stream is full and not pulling data,
  //   // we will still respond to an error in the readable stream
  //
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig = await generateTLSConfig(defaultType);
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig.leafCertPEM,
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   const conn = (await connectionEventProm.p).detail;
  //   // Do the test
  //   const streamCreationProm = utils.promise<QUICStream>();
  //   conn.addEventListener(
  //     events.EventQUICConnectionStream.name,
  //     (event: events.EventQUICConnectionStream) => {
  //       streamCreationProm.resolveP(event.detail);
  //     },
  //   );
  //   const message = Buffer.from('Hello!');
  //   const clientStream = client.connection.newStream();
  //   const clientWriter = clientStream.writable.getWriter();
  //   await clientWriter.write(message);
  //   await streamCreationProm.p;
  //   const serverStream = await streamCreationProm.p;
  //
  //   // Fill up buffers to block reads from pulling
  //   const serverWriter = serverStream.writable.getWriter();
  //   await serverWriter.write(message);
  //   await serverWriter.write(message);
  //   await serverWriter.write(message);
  //   await clientWriter.write(message);
  //   await clientWriter.write(message);
  //   await clientWriter.write(message);
  //
  //   // Closing stream with no buffered data should be responsive
  //   await clientWriter.abort(testReason);
  //   await serverWriter.abort(testReason);
  //
  //   // Both streams are destroyed even without reading till close
  //   await Promise.all([clientStream.closedP, serverStream.closedP]);
  //
  //   await client.destroy({ force: true });
  //   await server.stop({ force: true });
  // });

  // test('streams are allowed to end when client is destroyed with force: false', async () => {
  //   const message = Buffer.from('The Quick Brown Fox Jumped Over The Lazy Dog');
  //   const numStreams = 10;
  //   const numMessage = 10;
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig = await generateTLSConfig(defaultType);
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig.leafCertPEM,
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   const conn = (await connectionEventProm.p).detail;
  //
  //   // Do the test
  //   const activeServerStreams: Array<Promise<void>> = [];
  //   conn.addEventListener(
  //     events.EventQUICConnectionStream.name,
  //     (streamEvent: events.EventQUICConnectionStream) => {
  //       const stream = streamEvent.detail;
  //       const streamProm = stream.readable.pipeTo(stream.writable);
  //       activeServerStreams.push(streamProm);
  //     },
  //   );
  //
  //   const { p: waitP, resolveP: waitResolveP } = utils.promise();
  //
  //   // Let's make a new streams.
  //   const activeClientStreams: Array<Promise<void>> = [];
  //   for (let i = 0; i < numStreams; i++) {
  //     activeClientStreams.push(
  //       (async () => {
  //         const stream = client.connection.newStream();
  //         const writer = stream.writable.getWriter();
  //         const reader = stream.readable.getReader();
  //         // Do write and read messages here.
  //         for (let j = 0; j < numMessage; j++) {
  //           await writer.write(message);
  //           const readMessage = await reader.read();
  //           expect(readMessage.done).toBeFalse();
  //           expect(readMessage.value).toStrictEqual(message);
  //           await waitP;
  //         }
  //         await writer.close();
  //         const value = await reader.read();
  //         expect(value.done).toBeTrue();
  //       })(),
  //     );
  //   }
  //   // Yield to allow streams to propagate
  //   await sleep(0);
  //
  //   // Start unforced close of client
  //   const clientDestroyP = client.destroy({ force: false });
  //   waitResolveP();
  //
  //   await Promise.all([
  //     Promise.all(activeClientStreams),
  //     Promise.all(activeServerStreams),
  //     clientDestroyP,
  //   ]);
  //   await server.stop({ force: true });
  // });

  // test('streams are allowed to end when server is destroyed with force: false', async () => {
  //   const message = Buffer.from('The Quick Brown Fox Jumped Over The Lazy Dog');
  //   const numStreams = 10;
  //   const numMessage = 10;
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig = await generateTLSConfig(defaultType);
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig.leafCertPEM,
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   const conn = (await connectionEventProm.p).detail;
  //
  //   // Do the test
  //   const activeServerStreams: Array<Promise<void>> = [];
  //   conn.addEventListener(
  //     events.EventQUICConnectionStream.name,
  //     (streamEvent: events.EventQUICConnectionStream) => {
  //       const stream = streamEvent.detail;
  //       const streamProm = stream.readable.pipeTo(stream.writable);
  //       activeServerStreams.push(streamProm);
  //     },
  //   );
  //
  //   const { p: waitP, resolveP: waitResolveP } = utils.promise();
  //
  //   // Let's make a new streams.
  //   const activeClientStreams: Array<Promise<void>> = [];
  //   for (let i = 0; i < numStreams; i++) {
  //     activeClientStreams.push(
  //       (async () => {
  //         const stream = client.connection.newStream();
  //         const writer = stream.writable.getWriter();
  //         const reader = stream.readable.getReader();
  //         // Do write and read messages here.
  //         for (let j = 0; j < numMessage; j++) {
  //           await writer.write(message);
  //           const readMessage = await reader.read();
  //           expect(readMessage.done).toBeFalse();
  //           expect(readMessage.value).toStrictEqual(message);
  //           await waitP;
  //         }
  //         await writer.close();
  //         const value = await reader.read();
  //         expect(value.done).toBeTrue();
  //       })(),
  //     );
  //   }
  //   // Yield to allow streams to propagate
  //   await sleep(0);
  //
  //   // Start unforced close of server
  //   const serverStopP = server.stop({ force: false });
  //   waitResolveP();
  //
  //   await Promise.all([
  //     Promise.all(activeClientStreams),
  //     Promise.all(activeServerStreams),
  //     serverStopP,
  //   ]);
  //   await client.destroy({ force: true });
  // });

  // test('new streams are rejected when a connection is ending', async () => {
  //   const message = Buffer.from('The Quick Brown Fox Jumped Over The Lazy Dog');
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig = await generateTLSConfig(defaultType);
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig.leafCertPEM,
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   const conn = (await connectionEventProm.p).detail;
  //
  //   // Do the test
  //   const { p: waitP, resolveP: waitResolveP } = utils.promise();
  //   const activeServerStreams: Array<Promise<void>> = [];
  //   conn.addEventListener(
  //     events.EventQUICConnectionStream.name,
  //     async (streamEvent: events.EventQUICConnectionStream) => {
  //       const stream = streamEvent.detail;
  //       await waitP;
  //       const streamProm = stream.readable.pipeTo(stream.writable);
  //       activeServerStreams.push(streamProm);
  //     },
  //   );
  //
  //   const stream = client.connection.newStream();
  //   const writer = stream.writable.getWriter();
  //   await writer.write(message);
  //   await writer.close();
  //
  //   // Start unforced close of client
  //   const clientDestroyP = client.destroy({ force: false });
  //   // Yield to allow `destroy` to progress
  //   await sleep(0);
  //   // New client streams should throw
  //   expect(() => client.connection.newStream()).toThrow();
  //   // Creating a stream on the server side should throw
  //   const newStream = conn.newStream();
  //   await newStream.writable.close();
  //   const code = (async () => {
  //     for await (const _ of newStream.readable) {
  //       // Do nothing
  //     }
  //   })();
  //   await expect(code).rejects.toThrow('read 0');
  //
  //   waitResolveP();
  //   await Promise.all(activeServerStreams);
  //   await clientDestroyP;
  //   await server.stop({ force: true });
  // });

  // test('connection can be forced closed after unforced destroy', async () => {
  //   const message = Buffer.from('The Quick Brown Fox Jumped Over The Lazy Dog');
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig = await generateTLSConfig(defaultType);
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig.leafCertPEM,
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   const conn = (await connectionEventProm.p).detail;
  //
  //   // Do the test
  //   const { p: waitP, resolveP: waitResolveP } = utils.promise();
  //   const activeServerStreams: Array<Promise<void>> = [];
  //   conn.addEventListener(
  //     events.EventQUICConnectionStream.name,
  //     async (streamEvent: events.EventQUICConnectionStream) => {
  //       const stream = streamEvent.detail;
  //       await waitP;
  //       const streamProm = stream.readable
  //         .pipeTo(stream.writable)
  //         .catch(() => {});
  //       activeServerStreams.push(streamProm);
  //     },
  //   );
  //
  //   const stream = client.connection.newStream();
  //   const writer = stream.writable.getWriter();
  //   await writer.write(message);
  //   await writer.close();
  //
  //   // Start unforced close of client
  //   const clientDestroyP = client.destroy({ force: false });
  //
  //   const result = await Promise.race([
  //     clientDestroyP.then(() => true),
  //     sleep(500).then(() => false),
  //   ]);
  //
  //   expect(result).toBe(false);
  //
  //   // We can force close the streams causing client destruction to end
  //   client.connection.destroyStreams();
  //   await clientDestroyP;
  //   await Promise.allSettled(activeServerStreams);
  //
  //   await server.stop({ force: true });
  //   waitResolveP();
  //   await waitP;
  // });

  // test('quicStream properly cleans up after cancelling without data sent', async () => {
  //   const cancelReason = Symbol('CancelReason');
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig1 = await generateTLSConfig(defaultType);
  //   const tlsConfig2 = await generateTLSConfig(defaultType);
  //   const reasonConverters = testsUtils.createReasonConverters();
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig1.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig1.leafCertPEM,
  //       verifyPeer: true,
  //       ca: tlsConfig2.caCertPEM,
  //     },
  //     ...reasonConverters,
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //       key: tlsConfig2.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig2.leafCertPEM,
  //     },
  //     ...reasonConverters,
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   const serverConnection = (await connectionEventProm.p).detail;
  //
  //   // Do the test
  //   const { p: serverStreamP, resolveP: serverStreamResolveP } =
  //     utils.promise<QUICStream>();
  //   serverConnection.addEventListener(
  //     events.EventQUICConnectionStream.name,
  //     (event: events.EventQUICConnectionStream) => {
  //       serverStreamResolveP(event.detail);
  //     },
  //   );
  //   // Let's make a new stream.
  //   const clientStream = client.connection.newStream();
  //   const writer = clientStream.writable.getWriter();
  //   // Await writer.write(message);
  //   writer.releaseLock();
  //   clientStream.cancel(cancelReason);
  //   await expect(clientStream.readable.getReader().read()).rejects.toBe(
  //     cancelReason,
  //   );
  //   await expect(clientStream.writable.getWriter().write()).rejects.toBe(
  //     cancelReason,
  //   );
  //
  //   // Let's check that the server side ended
  //   const serverStream = await serverStreamP;
  //   const serverReadProm = (async () => {
  //     for await (const _ of serverStream.readable) {
  //       // Just consume until stream throws
  //     }
  //   })();
  //   await expect(serverReadProm).rejects.toBe(cancelReason);
  //   const serverWriter = serverStream.writable.getWriter();
  //   // Should throw
  //   await expect(serverWriter.write(Buffer.from('hello'))).rejects.toBe(
  //     cancelReason,
  //   );
  //
  //   // And client stream should've cleaned up
  //   await testsUtils.sleep(100);
  //   // Only two streams should've been created
  //   expect(createQUICStreamMock).toHaveBeenCalledTimes(2);
  //
  //   expect(clientStream[destroyed]).toBeTrue();
  //   await client.destroy({ force: true });
  //   await server.stop({ force: true });
  // });

  // test('quicStream properly cleans up after cancelling with data sent', async () => {
  //   const cancelReason = Symbol('CancelReason');
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig1 = await generateTLSConfig(defaultType);
  //   const tlsConfig2 = await generateTLSConfig(defaultType);
  //   const reasonConverters = testsUtils.createReasonConverters();
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig1.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig1.leafCertPEM,
  //       verifyPeer: true,
  //       ca: tlsConfig2.caCertPEM,
  //     },
  //     ...reasonConverters,
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //       key: tlsConfig2.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig2.leafCertPEM,
  //     },
  //     ...reasonConverters,
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   const serverConnection = (await connectionEventProm.p).detail;
  //
  //   // Do the test
  //   const { p: serverStreamP, resolveP: serverStreamResolveP } =
  //     utils.promise<QUICStream>();
  //   serverConnection.addEventListener(
  //     events.EventQUICConnectionStream.name,
  //     (event: events.EventQUICConnectionStream) => {
  //       serverStreamResolveP(event.detail);
  //     },
  //   );
  //   // Let's make a new stream.
  //   const message = Buffer.from('Hello!');
  //   const clientStream = client.connection.newStream();
  //   const writer = clientStream.writable.getWriter();
  //   await writer.write(message);
  //   writer.releaseLock();
  //   clientStream.cancel(cancelReason);
  //   await expect(clientStream.readable.getReader().read()).rejects.toBe(
  //     cancelReason,
  //   );
  //   await expect(clientStream.writable.getWriter().write()).rejects.toBe(
  //     cancelReason,
  //   );
  //
  //   // Let's check that the server side ended
  //   const serverStream = await serverStreamP;
  //   const serverReadProm = (async () => {
  //     for await (const _ of serverStream.readable) {
  //       // Just consume until stream throws
  //     }
  //   })();
  //   await expect(serverReadProm).rejects.toBe(cancelReason);
  //   const serverWriter = serverStream.writable.getWriter();
  //   // Should throw
  //   await expect(serverWriter.write(Buffer.from('hello'))).rejects.toBe(
  //     cancelReason,
  //   );
  //
  //   // And client stream should've cleaned up
  //   await testsUtils.sleep(100);
  //   // Only two streams should've been created
  //   expect(createQUICStreamMock).toHaveBeenCalledTimes(2);
  //
  //   expect(clientStream[destroyed]).toBeTrue();
  //   await client.destroy({ force: true });
  //   await server.stop({ force: true });
  // });

  // test('quicStream properly cleans up after graceful end with data sent', async () => {
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig1 = await generateTLSConfig(defaultType);
  //   const tlsConfig2 = await generateTLSConfig(defaultType);
  //   const reasonConverters = testsUtils.createReasonConverters();
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig1.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig1.leafCertPEM,
  //       verifyPeer: true,
  //       ca: tlsConfig2.caCertPEM,
  //     },
  //     ...reasonConverters,
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //       key: tlsConfig2.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig2.leafCertPEM,
  //     },
  //     ...reasonConverters,
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   const serverConnection = (await connectionEventProm.p).detail;
  //
  //   // Do the test
  //   const { p: serverStreamP, resolveP: serverStreamResolveP } =
  //     utils.promise<QUICStream>();
  //   serverConnection.addEventListener(
  //     events.EventQUICConnectionStream.name,
  //     (event: events.EventQUICConnectionStream) => {
  //       serverStreamResolveP(event.detail);
  //     },
  //   );
  //   // Let's make a new stream.
  //   const message = Buffer.from('Hello!');
  //   const clientStream = client.connection.newStream();
  //   const writer = clientStream.writable.getWriter();
  //   await writer.write(message);
  //   await writer.close();
  //
  //   // Let's check that the server side ended
  //   const serverStream = await serverStreamP;
  //   const serverReadP = (async () => {
  //     const writer = serverStream.writable.getWriter();
  //     await writer.write(message);
  //     await writer.close();
  //     for await (const _ of serverStream.readable) {
  //       // Just consume until finish
  //     }
  //   })();
  //   for await (const _ of clientStream.readable) {
  //     // Just consume until finish
  //   }
  //   await serverReadP;
  //
  //   // And client stream should've cleaned up
  //   await testsUtils.sleep(100);
  //   // Only two streams should've been created
  //   expect(createQUICStreamMock).toHaveBeenCalledTimes(2);
  //
  //   expect(clientStream[destroyed]).toBeTrue();
  //   await client.destroy({ force: true });
  //   await server.stop({ force: true });
  // });

  // test('invalid arguments causes `createQUICClient` to fail', async () => {
  //   await expect(
  //     QUICClient.createQUICClient({
  //       host: '123.123.123.123', // Invalid ip when bound to loopback
  //       port: 55555,
  //       localHost: localhost,
  //       crypto: {
  //         ops: clientCrypto,
  //       },
  //       logger: logger.getChild(QUICClient.name),
  //       config: {
  //         verifyPeer: false,
  //       },
  //     }),
  //   ).rejects.toThrow(errors.ErrorQUICClientInvalidArgument);
  // });

  // test('connections are tolerant to network failures', async () => {
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig = await generateTLSConfig(defaultType);
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig.leafCertPEM,
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   // @ts-ignore: kidnap protected properties
  //   const mockedSendClient = jest.spyOn(client.socket, 'send_');
  //   // @ts-ignore: kidnap protected properties
  //   const mockedSendServer = jest.spyOn(server.socket, 'send_');
  //
  //   const conn = (await connectionEventProm.p).detail;
  //   // Do the test
  //   const activeServerStreams: Array<Promise<void>> = [];
  //   conn.addEventListener(
  //     events.EventQUICConnectionStream.name,
  //     (streamEvent: events.EventQUICConnectionStream) => {
  //       const stream = streamEvent.detail;
  //       const streamProm = stream.readable.pipeTo(stream.writable);
  //       activeServerStreams.push(streamProm);
  //     },
  //   );
  //
  //   const stream = client.connection.newStream();
  //   const writer = stream.writable.getWriter();
  //   const backgroundReadP = (async () => {
  //     let acc: string = '';
  //     for await (const message of stream.readable) {
  //       acc += message.toString();
  //     }
  //     return acc.split('message').length - 1;
  //   })();
  //
  //   // Do write and read messages here.
  //   for (let j = 0; j < 10; j++) {
  //     await writer.write(Buffer.from(`message${j}`));
  //   }
  //
  //   /*
  //   // replicating this error
  //
  //   Error: send ENETUNREACH ::ffff:13.54.214.222:1314
  //   at doSend (node:dgram:716:16)
  //   at defaultTriggerAsyncIdScope (node:internal/async_hooks:463:18)
  //   at afterDns (node:dgram:662:5)
  //   at processTicksAndRejections (node:internal/process/task_queues:83:21) {
  //     errno: -101,
  //       code: 'ENETUNREACH',
  //       syscall: 'send',
  //       address: '::ffff:13.54.214.222',
  //       port: 1314
  //   }
  //   */
  //   class FakeError extends Error {
  //     constructor(
  //       public address: string,
  //       public port: number,
  //     ) {
  //       super(`send ENETUNREACH ${address}:${port}`);
  //     }
  //     public errorno = -101;
  //     public code = 'ENETUNREACH';
  //     public syscall = 'send';
  //   }
  //   const fakeErrorClient = new FakeError(localhost, server.port);
  //   const fakeErrorServer = new FakeError(localhost, client.localPort);
  //   // Make the send fail 10 times
  //   mockedSendClient.mockRejectedValueOnce(fakeErrorClient);
  //   mockedSendClient.mockRejectedValueOnce(fakeErrorClient);
  //   mockedSendClient.mockRejectedValueOnce(fakeErrorClient);
  //   mockedSendClient.mockRejectedValueOnce(fakeErrorClient);
  //   mockedSendClient.mockRejectedValueOnce(fakeErrorClient);
  //   mockedSendClient.mockRejectedValueOnce(fakeErrorClient);
  //   mockedSendClient.mockRejectedValueOnce(fakeErrorClient);
  //   mockedSendClient.mockRejectedValueOnce(fakeErrorClient);
  //   mockedSendClient.mockRejectedValueOnce(fakeErrorClient);
  //   mockedSendClient.mockRejectedValueOnce(fakeErrorClient);
  //   // Same for the server
  //   mockedSendServer.mockRejectedValueOnce(fakeErrorServer);
  //   mockedSendServer.mockRejectedValueOnce(fakeErrorServer);
  //   mockedSendServer.mockRejectedValueOnce(fakeErrorServer);
  //   mockedSendServer.mockRejectedValueOnce(fakeErrorServer);
  //   mockedSendServer.mockRejectedValueOnce(fakeErrorServer);
  //   mockedSendServer.mockRejectedValueOnce(fakeErrorServer);
  //   mockedSendServer.mockRejectedValueOnce(fakeErrorServer);
  //   mockedSendServer.mockRejectedValueOnce(fakeErrorServer);
  //   mockedSendServer.mockRejectedValueOnce(fakeErrorServer);
  //   mockedSendServer.mockRejectedValueOnce(fakeErrorServer);
  //
  //   // Send another 20 messages
  //   for (let j = 0; j < 20; j++) {
  //     await writer.write(Buffer.from(`message${j + 10}`));
  //   }
  //   await writer.close();
  //   // Expect 30 fully formed messages
  //   await expect(backgroundReadP).resolves.toBe(30);
  //
  //   await Promise.all(activeServerStreams);
  //   await client.destroy({ force: true });
  //   await server.stop({ force: true });
  // });

  // test('connections timeout if network fails', async () => {
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig = await generateTLSConfig(defaultType);
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig.leafCertPEM,
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       maxIdleTimeout: 1000,
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   // @ts-ignore: kidnap protected properties
  //   const mockedSendClient = jest.spyOn(client.socket, 'send_');
  //   // @ts-ignore: kidnap protected properties
  //   const mockedSendServer = jest.spyOn(server.socket, 'send_');
  //
  //   const conn = (await connectionEventProm.p).detail;
  //   // Do the test
  //   let activeServerStreamP: Promise<void> | undefined = undefined;
  //   conn.addEventListener(
  //     events.EventQUICConnectionStream.name,
  //     async (streamEvent: events.EventQUICConnectionStream) => {
  //       const stream = streamEvent.detail;
  //       const streamP = stream.readable.pipeTo(stream.writable);
  //       void streamP.catch(() => {});
  //       activeServerStreamP = streamP;
  //     },
  //   );
  //   const stream = client.connection.newStream();
  //   const writer = stream.writable.getWriter();
  //   const backgroundReadP = (async () => {
  //     let acc: string = '';
  //     for await (const message of stream.readable) {
  //       acc += message.toString();
  //     }
  //     return acc.split('message').length - 1;
  //   })();
  //
  //   // Do write and read messages here.
  //   await writer.write(Buffer.from(`first message`));
  //
  //   /*
  //   // replicating this error
  //
  //   Error: send ENETUNREACH ::ffff:13.54.214.222:1314
  //   at doSend (node:dgram:716:16)
  //   at defaultTriggerAsyncIdScope (node:internal/async_hooks:463:18)
  //   at afterDns (node:dgram:662:5)
  //   at processTicksAndRejections (node:internal/process/task_queues:83:21) {
  //     errno: -101,
  //       code: 'ENETUNREACH',
  //       syscall: 'send',
  //       address: '::ffff:13.54.214.222',
  //       port: 1314
  //   }
  //   */
  //   class FakeError extends Error {
  //     constructor(
  //       public address: string,
  //       public port: number,
  //     ) {
  //       super(`send ENETUNREACH ${address}:${port}`);
  //     }
  //     public errorno = -101;
  //     public code = 'ENETUNREACH';
  //     public syscall = 'send';
  //   }
  //   // Make the send fail 10 times
  //   mockedSendClient.mockRejectedValue(new FakeError(localhost, server.port));
  //   // Same for the server
  //   mockedSendServer.mockRejectedValue(
  //     new FakeError(localhost, client.localPort),
  //   );
  //   await writer.write(Buffer.from(`second message`));
  //   // Expect both sides to time out
  //   await expect(backgroundReadP).rejects.toThrow(
  //     errors.ErrorQUICConnectionIdleTimeout,
  //   );
  //   await expect(activeServerStreamP).rejects.toThrow(
  //     errors.ErrorQUICConnectionIdleTimeout,
  //   );
  //   await expect(writer.write(Buffer.from('fail message'))).rejects.toThrow(
  //     errors.ErrorQUICConnectionIdleTimeout,
  //   );
  //   await client.destroy({ force: true });
  //   await server.stop({ force: true });
  // });

  // test('should throw stream limit error when limit is reached', async () => {
  //   const streamsNum = 10;
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig = await generateTLSConfig(defaultType);
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       initialMaxStreamsBidi: 5,
  //       key: tlsConfig.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig.leafCertPEM,
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       initialMaxStreamsBidi: 5,
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   const conn = (await connectionEventProm.p).detail;
  //   // Do the test
  //   let streamCount = 0;
  //   const streamCreationProm = utils.promise();
  //   conn.addEventListener(events.EventQUICConnectionStream.name, () => {
  //     streamCount += 1;
  //     if (streamCount >= streamsNum) streamCreationProm.resolveP();
  //   });
  //   // Let's make a new streams.
  //   const message = Buffer.from('Hello!');
  //   const streamsP = (async () => {
  //     for (let i = 0; i < streamsNum; i++) {
  //       const stream = client.connection.newStream();
  //       const writer = stream.writable.getWriter();
  //       await writer.write(message);
  //       await writer.close();
  //     }
  //   })();
  //   await expect(streamsP).rejects.toThrow(errors.ErrorQUICStreamLimit);
  //   await client.destroy({ force: true });
  //   await server.stop({ force: true });
  // });

  // test('ended streams do not contribute to limit', async () => {
  //   const streamsNum = 10;
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig = await generateTLSConfig(defaultType);
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       initialMaxStreamsBidi: 5,
  //       key: tlsConfig.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig.leafCertPEM,
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       initialMaxStreamsBidi: 5,
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   const conn = (await connectionEventProm.p).detail;
  //   // Do the test
  //   let streamCount = 0;
  //   const streamCreationProm = utils.promise();
  //   conn.addEventListener(
  //     events.EventQUICConnectionStream.name,
  //     (evt: events.EventQUICConnectionStream) => {
  //       const stream = evt.detail;
  //       void stream.readable.pipeTo(stream.writable).catch(() => {});
  //       streamCount += 1;
  //       if (streamCount >= streamsNum) streamCreationProm.resolveP();
  //     },
  //   );
  //   // Let's make a new streams.
  //   const message = Buffer.from('Hello!');
  //   const streamsP = (async () => {
  //     for (let i = 0; i < streamsNum; i++) {
  //       const stream = client.connection.newStream();
  //       const writer = stream.writable.getWriter();
  //       await writer.write(message);
  //       await writer.close();
  //       for await (const _ of stream.readable) {
  //         // Just consume
  //       }
  //     }
  //   })();
  //   await expect(streamsP).resolves.toBe(undefined);
  //   await streamCreationProm.p;
  //   expect(streamCount).toBe(streamsNum);
  //   await client.destroy({ force: true });
  //   await server.stop({ force: true });
  // });

  // test.prop(
  //   [
  //     fc.noShrink(
  //       fc.array(fc.integer({ min: 1 }), { minLength: 1000, maxLength: 2000 }),
  //     ),
  //   ],
  //   { numRuns: 1 },
  // )('out of order Ids are handled properly', async (arr) => {
  //   const size = arr.length;
  //   const used: Set<number> = new Set();
  //   const ids: Array<number> = [];
  //   for (let num of arr) {
  //     do {
  //       num = (num + 1) % size;
  //     } while (used.has(num));
  //     ids.push(num);
  //     used.add(num);
  //   }
  //
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig = await generateTLSConfig(defaultType);
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig.leafCertPEM,
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   await connectionEventProm.p;
  //
  //   const checkId = (id: StreamId): boolean => {
  //     // @ts-ignore: Using protected method
  //     return client.connection.isStreamUsed(id);
  //   };
  //
  //   for (const id of ids) {
  //     expect(checkId(id as StreamId)).toBeFalse();
  //   }
  //   // @ts-ignore: using protected property
  //   const usedIdSet = client.connection.streamIdUsedSet;
  //   expect(usedIdSet.size).toBe(0);
  // });

  // test('out of order Ids are handled properly', async () => {
  //   const connectionEventProm =
  //     utils.promise<events.EventQUICServerConnection>();
  //   const tlsConfig = await generateTLSConfig(defaultType);
  //   const server = new QUICServer({
  //     crypto: {
  //       key,
  //       ops: serverCrypto,
  //     },
  //     logger: logger.getChild(QUICServer.name),
  //     config: {
  //       key: tlsConfig.leafKeyPairPEM.privateKey,
  //       cert: tlsConfig.leafCertPEM,
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(server);
  //   server.addEventListener(
  //     events.EventQUICServerConnection.name,
  //     (e: events.EventQUICServerConnection) => connectionEventProm.resolveP(e),
  //   );
  //   await server.start({
  //     host: localhost,
  //   });
  //   const client = await QUICClient.createQUICClient({
  //     host: localhost,
  //     port: server.port,
  //     localHost: localhost,
  //     crypto: {
  //       ops: clientCrypto,
  //     },
  //     logger: logger.getChild(QUICClient.name),
  //     config: {
  //       verifyPeer: false,
  //     },
  //   });
  //   socketCleanMethods.extractSocket(client);
  //   await connectionEventProm.p;
  //
  //   const checkId = (id: StreamId): boolean => {
  //     // @ts-ignore: Using protected method
  //     return client.connection.isStreamUsed(id);
  //   };
  //
  //   expect(checkId(0 as StreamId)).toBeFalse();
  //   expect(checkId(4 as StreamId)).toBeFalse();
  //   expect(checkId(8 as StreamId)).toBeFalse();
  //   expect(checkId(4 as StreamId)).toBeTrue();
  //   expect(checkId(16 as StreamId)).toBeFalse();
  //   expect(checkId(0 as StreamId)).toBeTrue();
  //   expect(checkId(0 as StreamId)).toBeTrue();
  // });
});
