import type { Crypto, Host, Hostname, Port } from '@/types';
import dgram from 'dgram';
import Logger, { LogLevel, StreamHandler } from '@matrixai/logger';
import QUICSocket from '@/QUICSocket';
import * as utils from '@/utils';
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

    console.log('ipv4', msg, rinfo);

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
    console.log('ipv6', msg, rinfo);

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
    console.log('dual stack', msg, rinfo);

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
  test.only('ipv4 to ipv4 succeeds', async () => {
    const socket = new QUICSocket({
      crypto,
      logger
    });
    await socket.start({
      host: '127.0.0.1' as Host,
    });
    expect(socket.type).toBe('ipv4');
    const msg = Buffer.from('Hello World');
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
    await socket.stop();
  });
  test.only('ipv4 to ipv6 fails', async () => {
    const socket = new QUICSocket({
      crypto,
      logger
    });
    await socket.start({
      host: '127.0.0.1' as Host,
    });
    expect(socket.type).toBe('ipv4');
    const msg = Buffer.from('Hello World');
    await expect(
      socket.send(
        msg,
        ipv6SocketPort,
        '::1',
      )
    ).rejects.toThrow('EINVAL');
    await socket.stop();
  });
  test.only('ipv4 to dual stack succeeds', async () => {
    const socket = new QUICSocket({
      crypto,
      logger
    });
    await socket.start({
      host: '127.0.0.1' as Host,
    });
    expect(socket.type).toBe('ipv4');
    const msg = Buffer.from('Hello World');
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
    await socket.stop();
  });

  test.only('ipv6 to ipv6 succeeds', async () => {
    const socket = new QUICSocket({
      crypto,
      logger
    });
    await socket.start({
      host: '::1' as Host,
    });
    expect(socket.type).toBe('ipv6');
    const msg = Buffer.from('Hello World');
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
    await socket.stop();
  });

  test.only('ipv6 to ipv4 fails', async () => {
    const socket = new QUICSocket({
      crypto,
      logger
    });
    await socket.start({
      host: '::1' as Host,
    });
    expect(socket.type).toBe('ipv6');
    const msg = Buffer.from('Hello World');
    await expect(
      socket.send(
        msg,
        ipv4SocketPort,
        '127.0.0.1',
      )
    ).rejects.toThrow('EINVAL');
    // Does not work with IPv4 mapped IPv6 addresses
    await expect(
      socket.send(
        msg,
        ipv4SocketPort,
        '::ffff:127.0.0.1',
      )
    ).rejects.toThrow('ENETUNREACH');
    await socket.stop();
  });


  test.only('ipv6 to dual stack succeeds', async () => {
    const socket = new QUICSocket({
      crypto,
      logger
    });
    await socket.start({
      host: '::1' as Host,
    });
    expect(socket.type).toBe('ipv6');
    const msg = Buffer.from('Hello World');
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
    ).rejects.toThrow('ENETUNREACH');
    await socket.stop();
  });

  test.only('dual stack to ipv4 succeeds', async () => {
    const socket = new QUICSocket({
      crypto,
      logger
    });
    await socket.start({
      host: '::' as Host,
    });
    expect(socket.type).toBe('ipv4&ipv6');
    const msg = Buffer.from('Hello World');
    // Fail if send to IPv4
    await expect(
      socket.send(
        msg,
        ipv4SocketPort,
        '127.0.0.1',
      )
    ).rejects.toThrow('EINVAL');
    // Succeeds if sent with IPv4 mapped IPv6 address
    await socket.send(
      msg,
      ipv4SocketPort,
      '::ffff:127.0.0.1',
    );
    await expect(ipv4SocketMessageP).resolves.toEqual([
      msg,
      {
        address: '127.0.0.1', // Note that this is not a IPv4 mapped IPv6 address
        family: 'IPv4',
        port: socket.port,
        size: msg.byteLength
      }
    ]);
    await socket.stop();
  });

  test.only('dual stack to ipv6 succeeds', async () => {
    const socket = new QUICSocket({
      crypto,
      logger
    });
    await socket.start({
      host: '::' as Host,
    });
    expect(socket.type).toBe('ipv4&ipv6');
    const msg = Buffer.from('Hello World');
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
    await socket.stop();
  });

  test.only('dual stack to dual stack succeeds', async () => {
    const socket = new QUICSocket({
      crypto,
      logger
    });
    await socket.start({
      host: '::' as Host,
    });
    expect(socket.type).toBe('ipv4&ipv6');
    const msg = Buffer.from('Hello World');

    await expect(
      socket.send(
        msg,
        dualStackSocketPort,
        '127.0.0.1',
      )
    ).rejects.toThrow('EINVAL');

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

    await socket.stop();
  });

  test('', async () => {
    const socket = new QUICSocket({
      crypto,
      logger
    });

    // Dual stack (this is the only dual stack available!)
    await socket.start({
      host: '127.0.0.1' as Host,
      ipv6Only: false,
    });

    // expect(socket.type).toBe('ipv4&ipv6');


    // If this is dual stack
    // The qeustion can you send data via ipv4?

    // Use jest to expect that message event is emitted on ipv4Socket

    console.log('This is the IPv4 socket port', ipv4SocketPort);


    // This might fail
    // because it may need to be a mapped thing
    // Yep so if you send IPv4 while it is dual stack or ipv6 it will fail

    const msg = Buffer.from('Hello World');
    await socket.send(
      msg,
      ipv4SocketPort,
      '127.0.0.1',
      // '::ffff:127.0.0.1',
    );

    // I need a promise
    // And I need to indicate that it will eventually resolve to a specific value
    // That's the issue here
    // To do, I have to use a promise and resolve to it


    // Now what address was it sent from?
    // I'm not sure, but let's see

    await expect(ipv4SocketMessageP).resolves.toEqual([
      msg,
      {
        address: '::ffff:127.0.0.1',
        family: 'IPv4',
        port: socket.port,
        size: msg.byteLength
      }
    ]);

    // await expect(handleIPv4SocketMessage).toHaveBeenCalledWith(
    //   'Hello World',
    //   {
    //     address: '::ffff:127.0.0.1',
    //     family: 'IPv4',
    //     port: socket.port,
    //     size: 'Hello World'.length
    //   }
    // );

    // There you, you have to sleep otherwise it won't work
    // Interesting...
    // So intead of expecting it
    // We should AWAIT for am essage
    // await testsUtils.sleep(1000);

    // Use jest to test that a function will eventually be called asynchronously

    // expect(handleIPv4SocketMessage).toHaveBeenCalledWith(
    //   'Hello World',
    //   {
    //     address: '::ffff:
    //     family: 'IPv4',
    //     port: socket.port,
    //     size: 'Hello World'.length
    //   }
    // );


    await socket.stop();

    // // IPv4 wildcard
    // await socket.start({
    //   host: '0.0.0.0' as Host,
    //   ipv6Only: false,
    // });
    // expect(socket.type).toBe('ipv4');
    // await socket.stop();

    // Now this depends on what localhost resolves to..
    // await socket.start({
    //   host: 'localhost' as Hostname,
    //   ipv6Only: false,
    // });
    // await socket.stop();

    // ::0 and 0.0.0.0 are respective wildcards

    // // IPv6 wildcard
    // await socket.start({
    //   host: '::0' as Host,
    //   ipv6Only: false,
    // });
    // expect(socket.type).toBe('ipv6');
    // await socket.stop();


    // // IPv4 wildcard with ipv6Only being useless
    // await socket.start({
    //   host: '0.0.0.0' as Host,
    //   ipv6Only: true,
    // });
    // expect(socket.type).toBe('ipv4');
    // await socket.stop();


    // // IPv6
    // await socket.start({
    //   host: '::1' as Host,
    //   ipv6Only: false,
    // });
    // expect(socket.type).toBe('ipv6');
    // await socket.stop();

    // // IPv6 with ipv6Only being useless
    // await socket.start({
    //   host: '::1' as Host,
    //   ipv6Only: true,
    // });
    // expect(socket.type).toBe('ipv6');
    // await socket.stop();


    // // IPv4
    // await socket.start({
    //   host: '127.0.0.1' as Host,
    //   ipv6Only: false,
    // });
    // expect(socket.type).toBe('ipv4');
    // await socket.stop();

    // // IPv4 with ipv6Only being useless
    // await socket.start({
    //   host: '127.0.0.1' as Host,
    //   ipv6Only: true,
    // });
    // expect(socket.type).toBe('ipv4');
    // await socket.stop();


    // // In this case, if we pass an IPv6 mapped IPv6 address
    // // should it be a ipv6 socket?
    // // It sounds like it should be, because this is the address
    // // that occurs during a dual stack socket
    // // But then I'm not sure how internally it handles this
    // // I know that if we have a dual stack socket
    // // and a send operation is made to an ipv4 address
    // // It must be turned into a mapped address before being sent out
    // // BUT ONLY IF IT IS DUAL STACK SOCKET
    // // plus I'm not sure but if quiche understands this

    // // IPv4 mapped IPv6 address
    // await socket.start({
    //   host: '::ffff:127.0.0.1' as Host,
    //   ipv6Only: false,
    // });
    // expect(socket.type).toBe('ipv6');
    // await socket.stop();


  });

});
