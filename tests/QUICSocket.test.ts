import type QUICConnection from '@/QUICConnection';
import dgram from 'dgram';
import { testProp } from '@fast-check/jest';
import Logger, { LogLevel, StreamHandler } from '@matrixai/logger';
import { running } from '@matrixai/async-init';
import QUICSocket from '@/QUICSocket';
import QUICConnectionId from '@/QUICConnectionId';
import QUICServer from '@/QUICServer';
import { quiche } from '@/native';
import * as utils from '@/utils';
import * as errors from '@/errors';
import * as events from '@/events';
import * as testsUtils from './utils';

describe(QUICSocket.name, () => {
  const logger = new Logger(`${QUICSocket.name} Test`, LogLevel.WARN, [
    new StreamHandler(),
  ]);
  // This has to be setup asynchronously due to key generation
  // These socket fixtures will be used to test against the `QUICSocket`
  let ipv4Socket: dgram.Socket;
  let ipv6Socket: dgram.Socket;
  let dualStackSocket: dgram.Socket;
  let ipv4SocketBind: (port: number, host: string) => Promise<void>;
  let ipv4SocketSend: (...params: Array<any>) => Promise<number>;
  let ipv4SocketClose: () => Promise<void>;
  let ipv4SocketPort: number;
  // Handle IPv4 messages
  let { p: ipv4SocketMessageP, resolveP: ipv4SocketMessageResolveP } =
    utils.promise<[Buffer, dgram.RemoteInfo]>();
  const handleIPv4SocketMessage = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    ipv4SocketMessageResolveP([msg, rinfo]);
    const { p, resolveP } = utils.promise<[Buffer, dgram.RemoteInfo]>();
    ipv4SocketMessageP = p;
    ipv4SocketMessageResolveP = resolveP;
  };
  let ipv6SocketBind: (port: number, host: string) => Promise<void>;
  let ipv6SocketSend: (...params: Array<any>) => Promise<number>;
  let ipv6SocketClose: () => Promise<void>;
  let ipv6SocketPort: number;
  // Handle IPv6 messages
  let { p: ipv6SocketMessageP, resolveP: ipv6SocketMessageResolveP } =
    utils.promise<[Buffer, dgram.RemoteInfo]>();
  const handleIPv6SocketMessage = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    ipv6SocketMessageResolveP([msg, rinfo]);
    const { p, resolveP } = utils.promise<[Buffer, dgram.RemoteInfo]>();
    ipv6SocketMessageP = p;
    ipv6SocketMessageResolveP = resolveP;
  };
  let dualStackSocketBind: (port: number, host: string) => Promise<void>;
  let dualStackSocketSend: (...params: Array<any>) => Promise<number>;
  let dualStackSocketClose: () => Promise<void>;
  let dualStackSocketPort: number;
  // Handle dual stack messages
  let { p: dualStackSocketMessageP, resolveP: dualStackSocketMessageResolveP } =
    utils.promise<[Buffer, dgram.RemoteInfo]>();
  const handleDualStackSocketMessage = (
    msg: Buffer,
    rinfo: dgram.RemoteInfo,
  ) => {
    dualStackSocketMessageResolveP([msg, rinfo]);
    const { p, resolveP } = utils.promise<[Buffer, dgram.RemoteInfo]>();
    dualStackSocketMessageP = p;
    dualStackSocketMessageResolveP = resolveP;
  };
  beforeEach(async () => {
    ipv4Socket = dgram.createSocket({
      type: 'udp4',
    });
    ipv6Socket = dgram.createSocket({
      type: 'udp6',
      ipv6Only: true,
    });
    dualStackSocket = dgram.createSocket({
      type: 'udp6',
      ipv6Only: false,
    });
    ipv4SocketBind = utils.promisify(ipv4Socket.bind).bind(ipv4Socket);
    ipv4SocketSend = utils.promisify(ipv4Socket.send).bind(ipv4Socket);
    ipv4SocketClose = utils.promisify(ipv4Socket.close).bind(ipv4Socket);
    ipv6SocketBind = utils.promisify(ipv6Socket.bind).bind(ipv6Socket);
    ipv6SocketSend = utils.promisify(ipv6Socket.send).bind(ipv6Socket);
    ipv6SocketClose = utils.promisify(ipv6Socket.close).bind(ipv6Socket);
    dualStackSocketBind = utils
      .promisify(dualStackSocket.bind)
      .bind(dualStackSocket);
    dualStackSocketSend = utils
      .promisify(dualStackSocket.send)
      .bind(dualStackSocket);
    dualStackSocketClose = utils
      .promisify(dualStackSocket.close)
      .bind(dualStackSocket);
    await ipv4SocketBind(0, '127.0.0.1');
    await ipv6SocketBind(0, '::1');
    await dualStackSocketBind(0, '::');
    ipv4SocketPort = ipv4Socket.address().port;
    ipv6SocketPort = ipv6Socket.address().port;
    dualStackSocketPort = dualStackSocket.address().port;
    ipv4Socket.on('message', handleIPv4SocketMessage);
    ipv6Socket.on('message', handleIPv6SocketMessage);
    dualStackSocket.on('message', handleDualStackSocketMessage);
  });
  afterEach(async () => {
    await ipv4SocketClose();
    await ipv6SocketClose();
    await dualStackSocketClose();
    ipv4Socket.off('message', handleIPv4SocketMessage);
    ipv6Socket.off('message', handleIPv6SocketMessage);
    dualStackSocket.off('message', handleDualStackSocketMessage);
  });
  test('cannot stop socket with active connections', async () => {
    const socket = new QUICSocket({
      logger,
    });
    await socket.start({
      host: '127.0.0.1',
    });
    const connectionId = QUICConnectionId.fromBuffer(
      Buffer.from('SomeRandomId'),
    );
    // Mock connection, we only need the `type` property
    const connection = { type: 'client' } as QUICConnection;
    socket.connectionMap.set(connectionId, connection);
    await expect(socket.stop()).rejects.toThrow(
      errors.ErrorQUICSocketConnectionsActive,
    );
    socket.connectionMap.delete(connectionId);
    await expect(socket.stop()).toResolve();
  });
  test('force stop socket with active connections', async () => {
    const socket = new QUICSocket({
      logger,
    });
    await socket.start({
      host: '127.0.0.1',
    });
    const connectionId = QUICConnectionId.fromBuffer(
      Buffer.from('SomeRandomId'),
    );
    // Mock connection, we only need the `type` property
    const connection = { type: 'client' } as QUICConnection;
    socket.connectionMap.set(connectionId, connection);
    await expect(socket.stop({ force: true })).toResolve();
  });
  test('enabling ipv6 only prevents binding to ipv4 hosts', async () => {
    const socket = new QUICSocket({
      logger,
    });
    await expect(
      socket.start({
        host: '127.0.0.1',
        ipv6Only: true,
      }),
    ).rejects.toThrow(errors.ErrorQUICSocketInvalidBindAddress);
    await socket.stop();
  });
  test('disabling ipv6 only does not prevent binding to ipv6 hosts', async () => {
    const socket = new QUICSocket({
      logger,
    });
    await socket.start({
      host: '::1',
      ipv6Only: false,
    });
    await socket.stop();
  });
  test('ipv4 wildcard to ipv4 succeeds', async () => {
    const socket = new QUICSocket({
      logger,
    });
    await socket.start({
      host: '0.0.0.0',
    });
    const msg = Buffer.from('Hello World');
    await socket.send(msg, ipv4SocketPort, '127.0.0.1');
    await expect(ipv4SocketMessageP).resolves.toEqual([
      msg,
      {
        address: '127.0.0.1',
        family: 'IPv4',
        port: socket.port,
        size: msg.byteLength,
      },
    ]);
    await socket.stop();
  });
  test('ipv6 wildcard to ipv6 succeeds', async () => {
    const socket = new QUICSocket({
      logger,
    });
    await socket.start({
      host: '::0',
    });
    const msg = Buffer.from('Hello World');
    await socket.send(msg, ipv6SocketPort, '::1');
    await expect(ipv6SocketMessageP).resolves.toEqual([
      msg,
      {
        address: '::1',
        family: 'IPv6',
        port: socket.port,
        size: msg.byteLength,
      },
    ]);
    await socket.stop();
  });
  test('failed send is a caller error and does not result in domain error', async () => {
    const socket = new QUICSocket({
      logger,
    });
    const handleEventQUICSocketError = jest.fn();
    socket.addEventListener(
      events.EventQUICSocketError.name,
      handleEventQUICSocketError
    );
    await socket.start({
      host: '::',
    });
    const msg = Buffer.from('hello world');
    expect(
      // @ts-ignore
      socket.send(msg),
    ).rejects.toThrow(TypeError);
    // This should throw a `RangeError` which comes from Node, but due to Jest VM isolation
    expect(
      socket.send(msg, 0, '::1')
    ).rejects.toHaveProperty('name', 'RangeError');
    await expect(
      socket.send(msg, ipv4SocketPort, '0.0.0.0'),
    ).rejects.toThrow(errors.ErrorQUICSocketInvalidSendAddress);
    expect(handleEventQUICSocketError).not.toHaveBeenCalled();
    await socket.stop();
    expect(handleEventQUICSocketError).not.toHaveBeenCalled();
  });
  describe('events', () => {
    test('start and stop event lifecycle', async () => {
      const socket = new QUICSocket({
        logger,
      });
      const handleEventQUICSocketStart = jest.fn();
      socket.addEventListener(
        events.EventQUICSocketStart.name,
        handleEventQUICSocketStart
      );
      const handleEventQUICSocketStarted = jest.fn();
      socket.addEventListener(
        events.EventQUICSocketStarted.name,
        handleEventQUICSocketStarted
      );
      const handleEventQUICSocketStop = jest.fn();
      socket.addEventListener(
        events.EventQUICSocketStop.name,
        handleEventQUICSocketStop
      );
      const handleEventQUICSocketStopped = jest.fn();
      socket.addEventListener(
        events.EventQUICSocketStopped.name,
        handleEventQUICSocketStopped
      );
      const handleEventQUICSocketClose = jest.fn();
      socket.addEventListener(
        events.EventQUICSocketClose.name,
        handleEventQUICSocketClose
      );
      const handleEventQUICSocketError = jest.fn();
      socket.addEventListener(
        events.EventQUICSocketError.name,
        handleEventQUICSocketError
      );
      const startP = socket.start({
        host: '127.0.0.1',
      });
      await testsUtils.sleep(0);
      expect(handleEventQUICSocketStart).toHaveBeenCalled();
      await startP;
      expect(handleEventQUICSocketStarted).toHaveBeenCalled();
      const stopP = socket.stop();
      await testsUtils.sleep(0);
      expect(handleEventQUICSocketStop).toHaveBeenCalled();
      await stopP;
      expect(handleEventQUICSocketClose).toHaveBeenCalled();
      expect(handleEventQUICSocketStopped).toHaveBeenCalled();
      expect(handleEventQUICSocketError).not.toHaveBeenCalled();
    });
    test('error and close event lifecycle', async () => {
      // We expect error logs
      const socketLogger = logger.getChild('abc');
      socketLogger.setLevel(LogLevel.SILENT);
      const socket = new QUICSocket({
        logger: socketLogger,
      });
      const handleEventQUICSocketStop = jest.fn();
      socket.addEventListener(
        events.EventQUICSocketStop.name,
        handleEventQUICSocketStop
      );
      const handleEventQUICSocketStopped = jest.fn();
      socket.addEventListener(
        events.EventQUICSocketStopped.name,
        handleEventQUICSocketStopped
      );
      const handleEventQUICSocketClose = jest.fn();
      socket.addEventListener(
        events.EventQUICSocketClose.name,
        handleEventQUICSocketClose
      );
      const handleEventQUICSocketError = jest.fn();
      socket.addEventListener(
        events.EventQUICSocketError.name,
        handleEventQUICSocketError
      );
      await socket.start({
        host: '127.0.0.1',
      });
      socket.dispatchEvent(
        new events.EventQUICSocketError({
          detail: new errors.ErrorQUICSocketInternal('Dummy Error')
        })
      );
      socket.dispatchEvent(
        new events.EventQUICSocketClose()
      );
      await socket.closedP;
      expect(socket.closed).toBe(true);
      expect(handleEventQUICSocketError).toHaveBeenCalledTimes(1);
      expect(handleEventQUICSocketClose).toHaveBeenCalledTimes(1);
      // Note that we may need to wait for the system to actually stop
      await testsUtils.sleep(0);
      expect(handleEventQUICSocketStop).toHaveBeenCalledTimes(1);
      expect(handleEventQUICSocketStopped).toHaveBeenCalledTimes(1);
      // It should be the case that the `socket` is already stopped
      await socket.stop();
      expect(handleEventQUICSocketStop).toHaveBeenCalledTimes(1);
      expect(handleEventQUICSocketStopped).toHaveBeenCalledTimes(1);
    });
  });
  describe('ipv4', () => {
    const socket = new QUICSocket({
      logger,
    });
    const msg = Buffer.from('Hello World');
    beforeAll(async () => {
      await socket.start({
        host: '127.0.0.1',
      });
    });
    afterAll(async () => {
      await socket.stop();
    });
    test('type will be `ipv4`', () => {
      expect(socket.type).toBe('ipv4');
    });
    test('to ipv4 succeeds', async () => {
      await socket.send(msg, ipv4SocketPort, '127.0.0.1');
      await expect(ipv4SocketMessageP).resolves.toEqual([
        msg,
        {
          address: '127.0.0.1',
          family: 'IPv4',
          port: socket.port,
          size: msg.byteLength,
        },
      ]);
    });
    test('to ipv6 fails', async () => {
      await expect(socket.send(msg, ipv6SocketPort, '::1')).rejects.toThrow(
        errors.ErrorQUICSocketInvalidSendAddress,
      );
    });
    test('to dual stack succeeds', async () => {
      await socket.send(msg, dualStackSocketPort, '127.0.0.1');
      await expect(dualStackSocketMessageP).resolves.toEqual([
        msg,
        {
          address: '::ffff:127.0.0.1', // Note that this is an IPv4 mapped IPv6 address
          family: 'IPv6',
          port: socket.port,
          size: msg.byteLength,
        },
      ]);
    });
  });
  describe('ipv6', () => {
    const socket = new QUICSocket({
      logger,
    });
    const msg = Buffer.from('Hello World');
    beforeAll(async () => {
      await socket.start({
        host: '::1',
      });
    });
    afterAll(async () => {
      await socket.stop();
    });
    test('type will be `ipv6`', () => {
      expect(socket.type).toBe('ipv6');
    });
    test('to ipv6 succeeds', async () => {
      await socket.send(msg, ipv6SocketPort, '::1');
      await expect(ipv6SocketMessageP).resolves.toEqual([
        msg,
        {
          address: '::1',
          family: 'IPv6',
          port: socket.port,
          size: msg.byteLength,
        },
      ]);
    });
    test('to ipv4 fails', async () => {
      await expect(
        socket.send(msg, ipv4SocketPort, '127.0.0.1'),
      ).rejects.toThrow(errors.ErrorQUICSocketInvalidSendAddress);
      // Does not work with IPv4 mapped IPv6 addresses
      await expect(
        socket.send(msg, ipv4SocketPort, '::ffff:127.0.0.1'),
      ).rejects.toThrow(errors.ErrorQUICSocketInvalidSendAddress);
    });
    test('to dual stack succeeds', async () => {
      await socket.send(msg, dualStackSocketPort, '::1');
      await expect(dualStackSocketMessageP).resolves.toEqual([
        msg,
        {
          address: '::1',
          family: 'IPv6',
          port: socket.port,
          size: msg.byteLength,
        },
      ]);
      // Does not work with IPv4 mapped IPv6 addresses
      await expect(
        socket.send(msg, dualStackSocketPort, '::ffff:127.0.0.1'),
      ).rejects.toThrow(errors.ErrorQUICSocketInvalidSendAddress);
    });
  });
  describe('ipv6 only when using `::`', () => {
    const socket = new QUICSocket({
      logger,
    });
    const msg = Buffer.from('Hello World');
    beforeAll(async () => {
      await socket.start({
        host: '::',
        ipv6Only: true,
      });
    });
    afterAll(async () => {
      await socket.stop();
    });
    test('type will be `ipv6`', () => {
      expect(socket.type).toBe('ipv6');
    });
    test('to ipv4 fails', async () => {
      await expect(
        socket.send(msg, ipv4SocketPort, '127.0.0.1'),
      ).rejects.toThrow(errors.ErrorQUICSocketInvalidSendAddress);
      await expect(
        socket.send(msg, ipv4SocketPort, '::ffff:127.0.0.1'),
      ).rejects.toThrow(errors.ErrorQUICSocketInvalidSendAddress);
    });
    test('to ipv6 succeeds', async () => {
      await socket.send(msg, ipv6SocketPort, '::1');
      await expect(ipv6SocketMessageP).resolves.toEqual([
        msg,
        {
          address: '::1',
          family: 'IPv6',
          port: socket.port,
          size: msg.byteLength,
        },
      ]);
    });
    test('to dual stack succeds', async () => {
      await socket.send(msg, dualStackSocketPort, '::1');
      await expect(dualStackSocketMessageP).resolves.toEqual([
        msg,
        {
          address: '::1',
          family: 'IPv6',
          port: socket.port,
          size: msg.byteLength,
        },
      ]);
    });
  });
  describe('dual stack', () => {
    const socket = new QUICSocket({
      logger,
    });
    const msg = Buffer.from('Hello World');
    beforeAll(async () => {
      await socket.start({
        host: '::',
      });
    });
    afterAll(async () => {
      await socket.stop();
    });
    test('type will be `ipv4&ipv6`', () => {
      expect(socket.type).toBe('ipv4&ipv6');
    });
    test('to ipv4 succeeds', async () => {
      // Fail if send to IPv4
      await expect(
        socket.send(msg, ipv4SocketPort, '127.0.0.1'),
      ).rejects.toThrow(errors.ErrorQUICSocketInvalidSendAddress);
      // Succeeds if sent with IPv4 mapped IPv6 address
      await socket.send(msg, ipv4SocketPort, '::ffff:127.0.0.1');
      await expect(ipv4SocketMessageP).resolves.toEqual([
        msg,
        {
          address: '127.0.0.1', // Note that this is not an IPv4 mapped IPv6 address
          family: 'IPv4',
          port: socket.port,
          size: msg.byteLength,
        },
      ]);
    });
    test('to ipv6 succeeds', async () => {
      await socket.send(msg, ipv6SocketPort, '::1');
      await expect(ipv6SocketMessageP).resolves.toEqual([
        msg,
        {
          address: '::1',
          family: 'IPv6',
          port: socket.port,
          size: msg.byteLength,
        },
      ]);
    });
    test('to dual stack succeeds', async () => {
      await expect(
        socket.send(msg, dualStackSocketPort, '127.0.0.1'),
      ).rejects.toThrow(errors.ErrorQUICSocketInvalidSendAddress);
      await socket.send(msg, dualStackSocketPort, '::ffff:127.0.0.1');
      await expect(dualStackSocketMessageP).resolves.toEqual([
        msg,
        {
          address: '::ffff:127.0.0.1',
          family: 'IPv6',
          port: socket.port,
          size: msg.byteLength,
        },
      ]);
      await socket.send(msg, dualStackSocketPort, '::1');
      await expect(dualStackSocketMessageP).resolves.toEqual([
        msg,
        {
          address: '::1',
          family: 'IPv6',
          port: socket.port,
          size: msg.byteLength,
        },
      ]);
    });
  });
  describe('ipv4 mapped ipv6 - dotted decimal variant', () => {
    const socket = new QUICSocket({
      logger,
    });
    const msg = Buffer.from('Hello World');
    beforeAll(async () => {
      await socket.start({
        host: '::ffff:127.0.0.1',
      });
    });
    afterAll(async () => {
      await socket.stop();
    });
    test('type will be `ipv4`', async () => {
      expect(socket.type).toBe('ipv4');
    });
    test('to ipv4 fails', async () => {
      await expect(
        socket.send(msg, ipv4SocketPort, '127.0.0.1'),
      ).rejects.toThrow(errors.ErrorQUICSocketInvalidSendAddress);
    });
    test('to ipv6 fails', async () => {
      await expect(socket.send(msg, ipv6SocketPort, '::1')).rejects.toThrow(
        errors.ErrorQUICSocketInvalidSendAddress,
      );
    });
    test('to ipv4 mapped ipv6 succeeds', async () => {
      await socket.send(msg, ipv4SocketPort, '::ffff:127.0.0.1');
      await expect(ipv4SocketMessageP).resolves.toEqual([
        msg,
        {
          address: '127.0.0.1',
          family: 'IPv4',
          port: socket.port,
          size: msg.byteLength,
        },
      ]);
      await socket.send(msg, ipv4SocketPort, '::ffff:7f00:1');
      await expect(ipv4SocketMessageP).resolves.toEqual([
        msg,
        {
          address: '127.0.0.1',
          family: 'IPv4',
          port: socket.port,
          size: msg.byteLength,
        },
      ]);
    });
  });
  describe('ipv4 mapped ipv6 - hex variant', () => {
    const socket = new QUICSocket({
      logger,
    });
    const msg = Buffer.from('Hello World');
    beforeAll(async () => {
      await socket.start({
        host: '::ffff:7f00:1',
      });
    });
    afterAll(async () => {
      await socket.stop();
    });
    test('type will be `ipv4`', async () => {
      expect(socket.type).toBe('ipv4');
      // Node dgram will resolve to dotted decimal variant
      expect(socket.host).toBe('::ffff:127.0.0.1');
    });
    test('to ipv4 fails', async () => {
      await expect(
        socket.send(msg, ipv4SocketPort, '127.0.0.1'),
      ).rejects.toThrow(errors.ErrorQUICSocketInvalidSendAddress);
    });
    test('to ipv6 fails', async () => {
      await expect(socket.send(msg, ipv6SocketPort, '::1')).rejects.toThrow(
        errors.ErrorQUICSocketInvalidSendAddress,
      );
    });
    test('to ipv4 mapped ipv6 succeeds', async () => {
      await socket.send(msg, ipv4SocketPort, '::ffff:127.0.0.1');
      await expect(ipv4SocketMessageP).resolves.toEqual([
        msg,
        {
          address: '127.0.0.1',
          family: 'IPv4',
          port: socket.port,
          size: msg.byteLength,
        },
      ]);
      await socket.send(msg, ipv4SocketPort, '::ffff:7f00:1');
      await expect(ipv4SocketMessageP).resolves.toEqual([
        msg,
        {
          address: '127.0.0.1',
          family: 'IPv4',
          port: socket.port,
          size: msg.byteLength,
        },
      ]);
    });
  });
  describe('receiving datagrams', () => {
    testProp(
      'random datagrams are discarded when there is no server',
      [
        testsUtils.bufferArb({ minLength: 0, maxLength: 100 })
      ],
      async (message) => {
        const socket = new QUICSocket({
          logger,
        });
        // We have to spy on the arrow function property before it is registered
        // Which meanst this spy must be created before the socket is started
        const handleSocketMessageMock = jest.spyOn(socket, 'handleSocketMessage' as any);
        const handleEventQUICSocketError = jest.fn();
        socket.addEventListener(
          events.EventQUICSocketError.name,
          handleEventQUICSocketError
        );
        await socket.start({
          host: '127.0.0.1',
        });
        // No server
        socket.unsetServer();
        // These messages would be discarded
        await ipv4SocketSend(
          message,
          0,
          message.byteLength,
          socket.port,
          socket.host
        );
        // Allow the event loop to flush the UDP socket
        await testsUtils.sleep(0);
        expect(handleSocketMessageMock).toHaveBeenCalledTimes(1);
        expect(handleEventQUICSocketError).not.toHaveBeenCalled();
        await socket.stop();
      }
    );
    testProp(
      'datagrams at >20 bytes are sometimes accepted for new connections',
      [
        testsUtils.bufferArb({ minLength: quiche.MAX_CONN_ID_LEN + 1, maxLength: 100 })
      ],
      async (message) => {
        const quicServer = {
          acceptConnection: jest.fn().mockResolvedValue(undefined)
        };
        const socket = new QUICSocket({
          logger,
        });
        // We have to spy on the arrow function property before it is registered
        // Which meanst this spy must be created before the socket is started
        const {
          p: handleSocketMessageMockP,
          resolveP: resolveHandleSocketMessageMockP
        } = utils.promise();
        const handleSocketMessage = (socket as any).handleSocketMessage;
        const handleSocketMessageMock = jest.fn((...args) => {
          resolveHandleSocketMessageMockP();
          handleSocketMessage.apply(socket, args);
        });
        (socket as any).handleSocketMessage = handleSocketMessageMock;
        const handleEventQUICSocketError = jest.fn();
        socket.addEventListener(
          events.EventQUICSocketError.name,
          handleEventQUICSocketError
        );
        // Dummy server
        socket.setServer(quicServer as unknown as QUICServer);
        await socket.start({
          host: '::1'
        });
        await ipv6SocketSend(
          message,
          0,
          message.byteLength,
          socket.port,
          socket.host
        );
        // Wait for the message to be received
        await handleSocketMessageMockP;
        // Wait for events to settle
        await testsUtils.sleep(0);
        expect(quicServer.acceptConnection.mock.calls.length).toBeLessThanOrEqual(1);
        expect(handleEventQUICSocketError).not.toHaveBeenCalled();
        await socket.stop();
      }
    );
    testProp(
      'new connection failure due to socket errors results in domain error events',
      [
        testsUtils.bufferArb({ minLength: quiche.MAX_CONN_ID_LEN + 1, maxLength: 100 })
      ],
      async (message) => {
        const quicServer = {
          acceptConnection: jest.fn().mockRejectedValue(
            new errors.ErrorQUICSocket()
          )
        };
        // We expect lots of error logs
        const socketLogger = logger.getChild('abc');
        socketLogger.setLevel(LogLevel.SILENT);
        const socket = new QUICSocket({
          logger: socketLogger
        });

        // We have to spy on the arrow function property before it is registered
        // Which meanst this spy must be created before the socket is started
        const {
          p: handleSocketMessageMockP,
          resolveP: resolveHandleSocketMessageMockP
        } = utils.promise();
        const handleSocketMessage = (socket as any).handleSocketMessage;
        const handleSocketMessageMock = jest.fn((...args) => {
          resolveHandleSocketMessageMockP();
          handleSocketMessage.apply(socket, args);
        });
        (socket as any).handleSocketMessage = handleSocketMessageMock;
        const handleEventQUICSocketError = jest.fn();
        socket.addEventListener(
          events.EventQUICSocketError.name,
          handleEventQUICSocketError
        );
        // Dummy server
        socket.setServer(quicServer as unknown as QUICServer);
        await socket.start({
          host: '::'
        });
        await dualStackSocketSend(
          message,
          0,
          message.byteLength,
          socket.port,
          socket.host
        );
        // Wait for the message to be received
        await handleSocketMessageMockP;
        // Wait for events to settle
        await testsUtils.sleep(0);
        // Some times the packet is considered as `BufferTooShort`
        // So here we branch out depending on whether `acceptConnection` was called
        if (quicServer.acceptConnection.mock.calls.length > 0) {
          expect(handleEventQUICSocketError).toBeCalledWith(
            expect.any(events.EventQUICSocketError),
          );
          // The socket is automatically stopped
          expect(socket[running]).toBe(false);
        } else {
          expect(handleEventQUICSocketError).toBeCalledTimes(0);
          await socket.stop();
        }
      }
    );
    testProp(
      'new connection failure due start timeout is ignored',
      [
        testsUtils.bufferArb({ minLength: quiche.MAX_CONN_ID_LEN + 1, maxLength: 100 })
      ],
      async (message) => {
        const quicServer = {
          acceptConnection: jest.fn().mockRejectedValue(
            new errors.ErrorQUICConnectionStartTimeout()
          )
        };
        const socket = new QUICSocket({
          logger
        });
        // We have to spy on the arrow function property before it is registered
        // Which meanst this spy must be created before the socket is started
        const {
          p: handleSocketMessageMockP,
          resolveP: resolveHandleSocketMessageMockP
        } = utils.promise();
        const handleSocketMessage = (socket as any).handleSocketMessage;
        const handleSocketMessageMock = jest.fn((...args) => {
          resolveHandleSocketMessageMockP();
          handleSocketMessage.apply(socket, args);
        });
        (socket as any).handleSocketMessage = handleSocketMessageMock;
        const handleEventQUICSocketError = jest.fn();
        socket.addEventListener(
          events.EventQUICSocketError.name,
          handleEventQUICSocketError
        );
        // Dummy server
        socket.setServer(quicServer as unknown as QUICServer);
        await socket.start({
          host: '::'
        });
        await dualStackSocketSend(
          message,
          0,
          message.byteLength,
          socket.port,
          socket.host
        );
        // Wait for the message to be received
        await handleSocketMessageMockP;
        // Wait for events to settle
        await testsUtils.sleep(0);
        // Some times the packet is considered as `BufferTooShort`
        expect(quicServer.acceptConnection.mock.calls.length).toBeLessThanOrEqual(1);
        expect(handleEventQUICSocketError).not.toHaveBeenCalled();
        await socket.stop();
      }
    );
  });
});
