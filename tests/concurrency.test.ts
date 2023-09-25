import type { ClientCryptoOps, ServerCryptoOps, StreamReasonToCode } from '@';
import type { Messages, StreamData } from './utils';
import type { QUICConfig } from '@';
import { fc, testProp } from '@fast-check/jest';
import Logger, { formatting, LogLevel, StreamHandler } from '@matrixai/logger';
import * as events from '@/events';
import QUICServer from '@/QUICServer';
import { promise } from '@/utils';
import QUICClient from '@/QUICClient';
import QUICSocket from '@/QUICSocket';
import { generateTLSConfig, handleStreamProm, sleep } from './utils';
import * as testsUtils from './utils';

describe('Concurrency tests', () => {
  const logger = new Logger(`${QUICClient.name} Test`, LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  // This has to be setup asynchronously due to key generation
  let key: ArrayBuffer;
  let ClientCryptoOps: ClientCryptoOps;
  let ServerCryptoOps: ServerCryptoOps;

  // Tracking resources
  let socketCleanMethods: ReturnType<typeof testsUtils.socketCleanupFactory>;
  // Normally we'd bind to a random port, but we need to know it before creating the server for these tests
  const socketPort1 = 50001;

  const reasonToCode = (type: 'read' | 'write', reason?: any) => {
    logger.error(type, reason);
    return 0;
  };

  beforeEach(async () => {
    key = await testsUtils.generateKeyHMAC();
    ClientCryptoOps = {
      randomBytes: testsUtils.randomBytes,
    };
    ServerCryptoOps = {
      sign: testsUtils.signHMAC,
      verify: testsUtils.verifyHMAC,
    };
    socketCleanMethods = testsUtils.socketCleanupFactory();
  });

  afterEach(async () => {
    await socketCleanMethods.stopSockets();
  });

  const handleClientProm = async (
    client: QUICClient,
    connectionData: ConnectionData,
  ) => {
    const streamProms: Array<Promise<void>> = [];
    try {
      for (const streamData of connectionData.streams) {
        const streamProm = sleep(streamData.startDelay)
          .then(() => client.connection.newStream())
          .then((stream) => {
            return handleStreamProm(stream, streamData);
          });
        streamProms.push(streamProm);
      }
      await Promise.all(streamProms);
      await sleep(connectionData.endDelay);
    } finally {
      await client.destroy({ force: true });
      logger.info(
        `client result ${JSON.stringify(
          await Promise.allSettled(streamProms),
        )}`,
      );
    }
  };

  type ConnectionData = {
    streams: Array<StreamData>;
    startDelay: number;
    endDelay: number;
  };
  const messagesArb = fc
    .array(fc.uint8Array({ size: 'medium', minLength: 1 }), {
      size: 'small',
      minLength: 1,
      maxLength: 10,
    })
    .noShrink() as fc.Arbitrary<Messages>;
  const streamArb = fc
    .record({
      messages: messagesArb,
      startDelay: fc.integer({ min: 0, max: 20 }),
      endDelay: fc.integer({ min: 0, max: 20 }),
      delays: fc.array(fc.integer({ min: 0, max: 10 }), {
        size: 'small',
        minLength: 1,
      }),
    })
    .noShrink() as fc.Arbitrary<StreamData>;
  const streamsArb = (minLength?: number, maxLength?: number) =>
    fc.array(streamArb, { size: 'small', minLength, maxLength }).noShrink();
  const connectionArb = fc
    .record({
      streams: streamsArb(1, 5),
      startDelay: fc.integer({ min: 0, max: 20 }),
      endDelay: fc.integer({ min: 0, max: 20 }),
    })
    .noShrink() as fc.Arbitrary<ConnectionData>;
  const connectionsArb = fc
    .array(connectionArb, {
      minLength: 1,
      maxLength: 5,
      size: 'small',
    })
    .noShrink() as fc.Arbitrary<Array<ConnectionData>>;

  testProp(
    'Multiple clients connecting to a server',
    [connectionsArb, streamsArb(3)],
    async (clientDatas, serverStreams) => {
      const tlsConfig = await generateTLSConfig('RSA');
      const cleanUpHoldProm = promise<void>();
      const serverProm = (async () => {
        const server = new QUICServer({
          crypto: {
            key,
            ops: ServerCryptoOps,
          },
          logger: logger.getChild(QUICServer.name),
          config: {
            key: tlsConfig.leafKeyPairPEM.privateKey,
            cert: tlsConfig.leafCertPEM,
            verifyPeer: false,
          },
        });
        socketCleanMethods.extractSocket(server);
        const connProms: Array<Promise<void>> = [];
        server.addEventListener(
          events.EventQUICServerConnection.name,
          async (e: events.EventQUICServerConnection) => {
            const conn = e.detail;
            const connProm = (async () => {
              const serverStreamProms: Array<Promise<void>> = [];
              conn.addEventListener(
                events.EventQUICConnectionStream.name,
                (streamEvent: events.EventQUICConnectionStream) => {
                  const stream = streamEvent.detail;
                  const streamData =
                    serverStreams[
                      serverStreamProms.length % serverStreams.length
                    ];
                  serverStreamProms.push(handleStreamProm(stream, streamData));
                },
              );
              try {
                await cleanUpHoldProm.p;
                await Promise.all(serverStreamProms);
              } finally {
                await conn.stop({ force: true });
                logger.info(
                  `server conn result ${JSON.stringify(
                    await Promise.allSettled(serverStreamProms),
                  )}`,
                );
              }
            })();
            connProms.push(connProm);
          },
        );
        await sleep(100);
        await server.start({
          host: '127.0.0.1',
          port: socketPort1,
        });
        try {
          await cleanUpHoldProm.p;
          await Promise.all(connProms);
        } finally {
          await server.stop({ force: true });
          logger.info(
            `server result ${JSON.stringify(
              await Promise.allSettled(connProms),
            )}`,
          );
        }
      })();

      // Creating client activity
      logger.info('STARTING CLIENTS');
      const clientProms: Array<Promise<void>> = [];
      for (const clientData of clientDatas) {
        const clientProm = sleep(clientData.startDelay)
          .then(() => {
            logger.info('STARTING CLIENT');
            return QUICClient.createQUICClient({
              host: '::ffff:127.0.0.1',
              port: socketPort1,
              localHost: '::',
              crypto: {
                ops: ClientCryptoOps,
              },
              logger: logger.getChild(QUICClient.name),
              config: {
                verifyPeer: false,
              },
              reasonToCode,
            });
          })
          .then((client) => {
            socketCleanMethods.extractSocket(client);
            return handleClientProm(client, clientData);
          });
        clientProms.push(clientProm);
      }
      // Wait for running activity to finish, should complete without error
      logger.info('STARTING TEST');
      try {
        await (async () => {
          await Promise.all(clientProms);
          // Allow for streams to be negotiated
          await sleep(200);
          cleanUpHoldProm.resolveP();
          await serverProm;
        })();
      } catch (e) {
        logger.error(`test failed with ${e.message}`);
        throw e;
      } finally {
        logger.info('STARTING TEST FINALLY');
        cleanUpHoldProm.resolveP();
        logger.info(
          `test result ${JSON.stringify(
            await Promise.allSettled([...clientProms, serverProm]),
          )}`,
        );
      }
      logger.info('TEST FULLY DONE!');
    },
    { numRuns: 1 },
  );
  testProp(
    'Multiple clients sharing a socket',
    [connectionsArb, streamsArb(3)],
    async (clientDatas, serverStreams) => {
      const tlsConfig = await generateTLSConfig('RSA');
      const cleanUpHoldProm = promise<void>();
      const serverProm = (async () => {
        const server = new QUICServer({
          crypto: {
            key,
            ops: ServerCryptoOps,
          },
          logger: logger.getChild(QUICServer.name),
          config: {
            key: tlsConfig.leafKeyPairPEM.privateKey,
            cert: tlsConfig.leafCertPEM,
            verifyPeer: false,
          },
        });
        socketCleanMethods.extractSocket(server);
        const connProms: Array<Promise<void>> = [];
        server.addEventListener(
          events.EventQUICServerConnection.name,
          async (e: events.EventQUICServerConnection) => {
            const conn = e.detail;
            const connProm = (async () => {
              const serverStreamProms: Array<Promise<void>> = [];
              conn.addEventListener(
                events.EventQUICConnectionStream.name,
                (streamEvent: events.EventQUICConnectionStream) => {
                  const stream = streamEvent.detail;
                  const streamData =
                    serverStreams[
                      serverStreamProms.length % serverStreams.length
                    ];
                  serverStreamProms.push(handleStreamProm(stream, streamData));
                },
              );
              try {
                await cleanUpHoldProm.p;
                await Promise.all(serverStreamProms);
              } finally {
                await conn.stop({ force: true });
                logger.info(
                  `server conn result ${JSON.stringify(
                    await Promise.allSettled(serverStreamProms),
                  )}`,
                );
              }
            })();
            connProms.push(connProm);
          },
        );
        await sleep(100);
        await server.start({
          host: '127.0.0.1',
          port: socketPort1,
        });
        try {
          await cleanUpHoldProm.p;
          await Promise.all(connProms);
        } finally {
          await server.stop({ force: true });
          logger.info(
            `server result ${JSON.stringify(
              await Promise.allSettled(connProms),
            )}`,
          );
        }
      })();
      // Creating socket
      const socket = new QUICSocket({
        logger: logger.getChild('socket'),
      });
      await socket.start({
        host: '127.0.0.1',
      });

      // Creating client activity
      logger.info('STARTING CLIENTS');
      const clientProms: Array<Promise<void>> = [];
      for (const clientData of clientDatas) {
        const clientProm = sleep(clientData.startDelay)
          .then(() => {
            logger.info('STARTING CLIENT');
            return QUICClient.createQUICClient({
              host: '127.0.0.1',
              port: socketPort1,
              socket,
              crypto: {
                ops: ClientCryptoOps,
              },
              logger: logger.getChild(QUICClient.name),
              config: {
                verifyPeer: false,
              },
              reasonToCode,
            });
          })
          .then((client) => {
            socketCleanMethods.extractSocket(client);
            return handleClientProm(client, clientData);
          });
        clientProms.push(clientProm);
      }
      // Wait for running activity to finish, should complete without error
      logger.info('STARTING TEST');
      try {
        await (async () => {
          await Promise.all(clientProms);
          // Allow for streams to be negotiated
          await sleep(200);
          cleanUpHoldProm.resolveP();
          await serverProm;
        })();
      } catch (e) {
        logger.error(`test failed with ${e.message}`);
        throw e;
      } finally {
        logger.info('STARTING TEST FINALLY');
        cleanUpHoldProm.resolveP();
        logger.info(
          `test result ${JSON.stringify(
            await Promise.allSettled([...clientProms, serverProm]),
          )}`,
        );
      }
      await socket.stop();
      logger.info('TEST FULLY DONE!');
    },
    { numRuns: 1 },
  );
  const spawnServer = async ({
    socket,
    port,
    cleanUpHoldProm,
    config,
    serverStreams,
    reasonToCode,
  }: {
    socket: QUICSocket;
    port: number | undefined;
    cleanUpHoldProm: Promise<void>;
    config: Partial<QUICConfig> & {
      key: string | Array<string> | Uint8Array | Array<Uint8Array>;
      cert: string | Array<string> | Uint8Array | Array<Uint8Array>;
    };
    serverStreams: Array<StreamData>;
    reasonToCode: StreamReasonToCode;
  }) => {
    const server = new QUICServer({
      crypto: {
        key,
        ops: ServerCryptoOps,
      },
      socket,
      logger: logger.getChild(QUICServer.name),
      config,
      reasonToCode,
    });
    socketCleanMethods.extractSocket(server);
    const connProms: Array<Promise<void>> = [];
    server.addEventListener(
      events.EventQUICServerConnection.name,
      async (e: events.EventQUICServerConnection) => {
        const conn = e.detail;
        const connProm = (async () => {
          const serverStreamProms: Array<Promise<void>> = [];
          conn.addEventListener(
            events.EventQUICConnectionStream.name,
            (streamEvent: events.EventQUICConnectionStream) => {
              const stream = streamEvent.detail;
              const streamData =
                serverStreams[serverStreamProms.length % serverStreams.length];
              serverStreamProms.push(
                handleStreamProm(stream, {
                  ...streamData,
                  endDelay: 0,
                }),
              );
            },
          );
          try {
            await cleanUpHoldProm;
            await Promise.all(serverStreamProms);
          } finally {
            await conn.stop({ force: true });
            logger.info(
              `server conn result ${JSON.stringify(
                await Promise.allSettled(serverStreamProms),
              )}`,
            );
          }
        })();
        connProms.push(connProm);
      },
    );
    await sleep(100);
    await server.start({
      host: '127.0.0.1',
      port,
    });
    try {
      await cleanUpHoldProm;
      await Promise.all(connProms);
    } finally {
      await server.stop({ force: true });
      logger.info(
        `server result ${JSON.stringify(await Promise.allSettled(connProms))}`,
      );
    }
  };
  testProp(
    'Multiple clients sharing a socket with a server',
    [connectionsArb, connectionsArb, streamsArb(3), streamsArb(3)],
    async (clientDatas1, clientDatas2, serverStreams1, serverStreams2) => {
      const tlsConfig1 = await generateTLSConfig('RSA');
      const tlsConfig2 = await generateTLSConfig('RSA');
      const clientsInfosA = clientDatas1.map((v) => v.streams.length);
      const clientsInfosB = clientDatas2.map((v) => v.streams.length);
      logger.info(`clientsA: ${clientsInfosA}`);
      logger.info(`clientsB: ${clientsInfosB}`);
      const cleanUpHoldProm = promise<void>();
      // Creating socket
      const socket1 = new QUICSocket({
        logger: logger.getChild('socket'),
      });
      const socket2 = new QUICSocket({
        logger: logger.getChild('socket'),
      });
      socketCleanMethods.sockets.add(socket1);
      socketCleanMethods.sockets.add(socket2);
      await socket1.start({
        host: '127.0.0.1',
      });
      await socket2.start({
        host: '127.0.0.1',
      });

      const serverProm1 = spawnServer({
        cleanUpHoldProm: cleanUpHoldProm.p,
        port: undefined,
        serverStreams: serverStreams1,
        socket: socket1,
        config: {
          key: tlsConfig1.leafKeyPairPEM.privateKey,
          cert: tlsConfig1.leafCertPEM,
          verifyPeer: false,
          logKeys: './tmp/key1.log',
          initialMaxStreamsBidi: 10000,
        },
        reasonToCode,
      });
      const serverProm2 = spawnServer({
        cleanUpHoldProm: cleanUpHoldProm.p,
        port: undefined,
        serverStreams: serverStreams2,
        socket: socket2,
        config: {
          key: tlsConfig2.leafKeyPairPEM.privateKey,
          cert: tlsConfig2.leafCertPEM,
          verifyPeer: false,
          logKeys: './tmp/key2.log',
          initialMaxStreamsBidi: 10000,
        },
        reasonToCode,
      });

      // Creating client activity
      logger.info('STARTING CLIENTS');
      const clientProms1: Array<Promise<void>> = [];
      const clientProms2: Array<Promise<void>> = [];
      for (const clientData of clientDatas1) {
        const clientProm = sleep(clientData.startDelay)
          .then(() => {
            logger.info('STARTING CLIENT');
            return QUICClient.createQUICClient({
              host: '127.0.0.1',
              port: socket2.port,
              socket: socket1,
              crypto: {
                ops: ClientCryptoOps,
              },
              logger: logger.getChild(QUICClient.name),
              config: {
                verifyPeer: false,
              },
              reasonToCode,
            });
          })
          .then((client) => {
            socketCleanMethods.extractSocket(client);
            return handleClientProm(client, clientData);
          });
        clientProms1.push(clientProm);
      }
      for (const clientData of clientDatas2) {
        const clientProm = sleep(clientData.startDelay)
          .then(() => {
            logger.info('STARTING CLIENT');
            return QUICClient.createQUICClient({
              host: '127.0.0.1',
              port: socket1.port,
              socket: socket2,
              crypto: {
                ops: ClientCryptoOps,
              },
              logger: logger.getChild(QUICClient.name),
              config: {
                verifyPeer: false,
                initialMaxStreamsBidi: 10000,
              },
              reasonToCode,
            });
          })
          .then((client) => {
            socketCleanMethods.extractSocket(client);
            return handleClientProm(client, clientData);
          });
        clientProms2.push(clientProm);
      }
      // Wait for running activity to finish, should complete without error
      logger.info('STARTING TEST');
      try {
        await (async () => {
          logger.info('waiting for client proms');
          await Promise.all([
            Promise.all(clientProms1),
            Promise.all(clientProms2),
          ]);
          logger.info('DONE waiting for client proms');
          // Allow for streams to be negotiated
          await sleep(200);
          cleanUpHoldProm.resolveP();
          await serverProm1;
          await serverProm2;
          logger.info('DONE waiting for server proms');
        })();
      } catch (e) {
        logger.error(`test failed with ${e.message}`);
        logger.info('FAILED THE TEST, RESULTED IN ERROR');
        throw e;
      } finally {
        logger.info('STARTING TEST FINALLY');
        cleanUpHoldProm.resolveP();
        logger.info(
          `test result ${JSON.stringify(
            await Promise.allSettled([
              // ...clientProms1,
              ...clientProms2,
              serverProm1,
              // ServerProm2,
            ]),
          )}`,
        );
      }
      logger.info('CLOSING SOCKETS');
      await socket1.stop({ force: true });
      await socket2.stop({ force: true });
      logger.info('TEST FULLY DONE!');
    },
    { numRuns: 1 },
  );
});
