import type { Crypto, Host, Hostname, Port } from '@/types';
import dgram from 'dgram';
import Logger, { LogLevel, StreamHandler } from '@matrixai/logger';
import QUICSocket from '@/QUICSocket';
import * as utils from '@/utils';
import * as errors from '@/errors';
import * as testsUtils from './utils';

describe(QUICSocket.name, () => {
  const logger = new Logger(`${QUICSocket.name} Test`, LogLevel.WARN, [
    new StreamHandler(),
  ]);
  // This has to be setup asynchronously due to key generation
  let crypto: {
    key: ArrayBuffer;
    ops: Crypto;
  };
  let ipv4Socket: dgram.Socket;
  let ipv6Socket: dgram.Socket;
  let dualStackSocket: dgram.Socket;
  let ipv4SocketBind: (port: number, host: string) => Promise<void>;
  let ipv4SocketSend: (...params: Array<any>) => Promise<number>;
  let ipv4SocketClose: () => Promise<void>;
  let ipv4SocketPort: number;
  // Handle IPv4 messages
  let {
    p: ipv4SocketMessageP,
    resolveP: ipv4SocketMessageResolveP
  } = utils.promise<[Buffer, dgram.RemoteInfo]>();
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
  let {
    p: ipv6SocketMessageP,
    resolveP: ipv6SocketMessageResolveP
  } = utils.promise<[Buffer, dgram.RemoteInfo]>();
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
  let {
    p: dualStackSocketMessageP,
    resolveP: dualStackSocketMessageResolveP
  } = utils.promise<[Buffer, dgram.RemoteInfo]>();
  const handleDualStackSocketMessage = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    dualStackSocketMessageResolveP([msg, rinfo]);
    const { p, resolveP } = utils.promise<[Buffer, dgram.RemoteInfo]>();
    dualStackSocketMessageP = p;
    dualStackSocketMessageResolveP = resolveP;
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
    ipv4Socket  = dgram.createSocket({
      type: 'udp4',
    });
    ipv6Socket = dgram.createSocket({
      type: 'udp6',
      ipv6Only: true
    });
    dualStackSocket = dgram.createSocket({
      type: 'udp6',
      ipv6Only: false
    });
    ipv4SocketBind = utils.promisify(ipv4Socket.bind).bind(ipv4Socket);
    ipv4SocketSend = utils.promisify(ipv4Socket.send).bind(ipv4Socket);
    ipv4SocketClose = utils.promisify(ipv4Socket.close).bind(ipv4Socket);
    ipv6SocketBind = utils.promisify(ipv6Socket.bind).bind(ipv6Socket);
    ipv6SocketSend = utils.promisify(ipv6Socket.send).bind(ipv6Socket);
    ipv6SocketClose = utils.promisify(ipv6Socket.close).bind(ipv6Socket);
    dualStackSocketBind = utils.promisify(dualStackSocket.bind).bind(dualStackSocket);
    dualStackSocketSend = utils.promisify(dualStackSocket.send).bind(dualStackSocket);
    dualStackSocketClose = utils.promisify(dualStackSocket.close).bind(dualStackSocket);
    await ipv4SocketBind(55555, '127.0.0.1');
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
  describe('ipv4', () => {
    const socket = new QUICSocket({
      crypto,
      logger
    });
    const msg = Buffer.from('Hello World');
    beforeAll(async () => {
      await socket.start({
        host: '127.0.0.1' as Host,
      });
    });
    afterAll(async () => {
      await socket.stop();
    });
    test('type will be `ipv4`', () => {
      expect(socket.type).toBe('ipv4');
    });
    test('to ipv4 succeeds', async () => {
      await socket.send(
        msg,
        ipv4SocketPort,
        '127.0.0.1',
      );
      await expect(ipv4SocketMessageP).resolves.toEqual([
        msg,
        {
          address: '127.0.0.1',
          family: 'IPv4',
          port: socket.port,
          size: msg.byteLength
        }
      ]);
    });
    test('to ipv6 fails', async () => {
      await expect(
        socket.send(
          msg,
          ipv6SocketPort,
          '::1',
        )
      ).rejects.toThrow(errors.ErrorQUICSocketInvalidSendAddress);
    });
    test('to dual stack succeeds', async () => {
      await socket.send(
        msg,
        dualStackSocketPort,
        '127.0.0.1',
      );
      await expect(dualStackSocketMessageP).resolves.toEqual([
        msg,
        {
          address: '::ffff:127.0.0.1', // Note that this is an IPv4 mapped IPv6 address
          family: 'IPv6',
          port: socket.port,
          size: msg.byteLength
        }
      ]);
    });
  });
  describe('ipv6', () => {
    const socket = new QUICSocket({
      crypto,
      logger
    });
    const msg = Buffer.from('Hello World');
    beforeAll(async () => {
      await socket.start({
        host: '::1' as Host,
      });
    });
    afterAll(async () => {
      await socket.stop();
    });
    test('type will be `ipv6`', () => {
      expect(socket.type).toBe('ipv6');
    });
    test('to ipv6 succeeds', async () => {
      await socket.send(
        msg,
        ipv6SocketPort,
        '::1',
      );
      await expect(ipv6SocketMessageP).resolves.toEqual([
        msg,
        {
          address: '::1',
          family: 'IPv6',
          port: socket.port,
          size: msg.byteLength
        }
      ]);
    });
    test('to ipv4 fails', async () => {
      await expect(
        socket.send(
          msg,
          ipv4SocketPort,
          '127.0.0.1',
        )
      ).rejects.toThrow(errors.ErrorQUICSocketInvalidSendAddress);
      // Does not work with IPv4 mapped IPv6 addresses
      await expect(
        socket.send(
          msg,
          ipv4SocketPort,
          '::ffff:127.0.0.1',
        )
      ).rejects.toThrow(errors.ErrorQUICSocketInvalidSendAddress);
    });
    test('to dual stack succeeds', async () => {
      await socket.send(
        msg,
        dualStackSocketPort,
        '::1',
      );
      await expect(dualStackSocketMessageP).resolves.toEqual([
        msg,
        {
          address: '::1',
          family: 'IPv6',
          port: socket.port,
          size: msg.byteLength
        }
      ]);
      // Does not work with IPv4 mapped IPv6 addresses
      await expect(
        socket.send(
          msg,
          dualStackSocketPort,
          '::ffff:127.0.0.1',
        )
      ).rejects.toThrow(errors.ErrorQUICSocketInvalidSendAddress);
    });
  });
  describe('ipv6 only when using `::`', () => {
    const socket = new QUICSocket({
      crypto,
      logger
    });
    const msg = Buffer.from('Hello World');
    beforeAll(async () => {
      await socket.start({
        host: '::' as Host,
        ipv6Only: true
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
        socket.send(
          msg,
          ipv4SocketPort,
          '127.0.0.1',
        )
      ).rejects.toThrow(errors.ErrorQUICSocketInvalidSendAddress);
      await expect(
        socket.send(
          msg,
          ipv4SocketPort,
          '::ffff:127.0.0.1',
        )
      ).rejects.toThrow(errors.ErrorQUICSocketInvalidSendAddress);
    });
    test('to ipv6 succeeds', async () => {
      await socket.send(
        msg,
        ipv6SocketPort,
        '::1',
      );
      await expect(ipv6SocketMessageP).resolves.toEqual([
        msg,
        {
          address: '::1',
          family: 'IPv6',
          port: socket.port,
          size: msg.byteLength
        }
      ]);
    });
    test('to dual stack succeds', async () => {
      await socket.send(
        msg,
        dualStackSocketPort,
        '::1',
      );
      await expect(dualStackSocketMessageP).resolves.toEqual([
        msg,
        {
          address: '::1',
          family: 'IPv6',
          port: socket.port,
          size: msg.byteLength
        }
      ]);
    });
  });
  describe('dual stack', () => {
    const socket = new QUICSocket({
      crypto,
      logger
    });
    const msg = Buffer.from('Hello World');
    beforeAll(async () => {
      await socket.start({
        host: '::' as Host,
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
        socket.send(
          msg,
          ipv4SocketPort,
          '127.0.0.1',
        )
      ).rejects.toThrow(errors.ErrorQUICSocketInvalidSendAddress);
      // Succeeds if sent with IPv4 mapped IPv6 address
      await socket.send(
        msg,
        ipv4SocketPort,
        '::ffff:127.0.0.1',
      );
      await expect(ipv4SocketMessageP).resolves.toEqual([
        msg,
        {
          address: '127.0.0.1', // Note that this is not an IPv4 mapped IPv6 address
          family: 'IPv4',
          port: socket.port,
          size: msg.byteLength
        }
      ]);
    });
    test('to ipv6 succeeds', async () => {
      await socket.send(
        msg,
        ipv6SocketPort,
        '::1',
      );
      await expect(ipv6SocketMessageP).resolves.toEqual([
        msg,
        {
          address: '::1',
          family: 'IPv6',
          port: socket.port,
          size: msg.byteLength
        }
      ]);
    });
    test('to dual stack succeeds', async () => {
      await expect(
        socket.send(
          msg,
          dualStackSocketPort,
          '127.0.0.1',
        )
      ).rejects.toThrow(errors.ErrorQUICSocketInvalidSendAddress);
      await socket.send(
        msg,
        dualStackSocketPort,
        '::ffff:127.0.0.1',
      );
      await expect(dualStackSocketMessageP).resolves.toEqual([
        msg,
        {
          address: '::ffff:127.0.0.1',
          family: 'IPv6',
          port: socket.port,
          size: msg.byteLength
        }
      ]);
      await socket.send(
        msg,
        dualStackSocketPort,
        '::1',
      );
      await expect(dualStackSocketMessageP).resolves.toEqual([
        msg,
        {
          address: '::1',
          family: 'IPv6',
          port: socket.port,
          size: msg.byteLength
        }
      ]);
    });
  });
  test('enabling ipv6 only prevents binding to ipv4 hosts', async () => {
    const socket = new QUICSocket({
      crypto,
      logger
    });
    await expect(
      socket.start({
        host: '127.0.0.1' as Host,
        ipv6Only: true,
      })
    ).rejects.toThrow(errors.ErrorQUICSocketInvalidBindAddress);
    await socket.stop();
  });
  test('disabling ipv6 only does not prevent binding to ipv6 hosts', async () => {
    const socket = new QUICSocket({
      crypto,
      logger
    });
    await socket.start({
      host: '::1' as Host,
      ipv6Only: false,
    });
    await socket.stop();
  });
  test('ipv4 wildcard to ipv4 succeeds', async () => {
    const socket = new QUICSocket({
      crypto,
      logger
    });
    await socket.start({
      host: '0.0.0.0' as Host,
    });
    const msg = Buffer.from('Hello World');
    await socket.send(msg, ipv4SocketPort, '127.0.0.1');
    await expect(
      ipv4SocketMessageP,
    ).resolves.toEqual([
      msg,
      {
        address: '127.0.0.1',
        family: 'IPv4',
        port: socket.port,
        size: msg.byteLength
      }
    ]);
    await socket.stop();
  });
  test('ipv6 wildcard to ipv6 succeeds', async () => {
    const socket = new QUICSocket({
      crypto,
      logger
    });
    await socket.start({
      host: '::0' as Host,
    });
    const msg = Buffer.from('Hello World');
    await socket.send(msg, ipv6SocketPort, '::1');
    await expect(
      ipv6SocketMessageP,
    ).resolves.toEqual([
      msg,
      {
        address: '::1',
        family: 'IPv6',
        port: socket.port,
        size: msg.byteLength
      }
    ]);
    await socket.stop();
  });
  describe('ipv4 mapped ipv6', () => {
    const socket = new QUICSocket({
      crypto,
      logger
    });
    const msg = Buffer.from('Hello World');
    beforeAll(async () => {
      await socket.start({
        host: '::ffff:127.0.0.1' as Host,
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
        socket.send(
          msg,
          ipv4SocketPort,
          '127.0.0.1',
        )
      ).rejects.toThrow(errors.ErrorQUICSocketInvalidSendAddress);
    });
    test('to ipv6 fails', async () => {
      await expect(
        socket.send(
          msg,
          ipv6SocketPort,
          '::1',
        )
      ).rejects.toThrow(errors.ErrorQUICSocketInvalidSendAddress);
    });
    test('to ipv4 mapped ipv6 succeeds', async () => {
      await socket.send(msg, ipv4SocketPort, '::ffff:127.0.0.1');
      await expect(ipv4SocketMessageP).resolves.toEqual([
        msg,
        {
          address: '127.0.0.1',
          family: 'IPv4',
          port: socket.port,
          size: msg.byteLength
        }
      ]);
    });
  });
});
