import type QUICClient from './QUICClient';
import type QUICServer from './QUICServer';
import type QUICConnection from './QUICConnection';
import type { ConnectionId, ConnectionIdString, Crypto, Host, Hostname, Port } from './types';
import type { Header, Config, Connection } from './native/types';
import QUICConnectionMap from './QUICConnectionMap';
import QUICConnectionId from './QUICConnectionId';
import dgram from 'dgram';
import Logger from '@matrixai/logger';
import { running, destroyed } from '@matrixai/async-init';
import { StartStop, ready } from '@matrixai/async-init/dist/StartStop';
import { Validator } from 'ip-num';
import { quiche, Type } from './native';
import * as events from './events';
import * as utils from './utils';
import * as errors from './errors';

/**
 * Events:
 * - error
 * - stop
 */
interface QUICSocket extends StartStop {}
@StartStop()
class QUICSocket extends EventTarget {

  // we need a quick way to know whether this socket
  // is a dual stack socket or not
  // and also whether it is ipv4 or ipv6

  public connectionMap: QUICConnectionMap = new QUICConnectionMap();

  protected socket: dgram.Socket;
  protected _host: Host;
  protected _port: Port;
  protected _type: 'ipv4' | 'ipv6' | 'ipv4&ipv6';


  protected logger: Logger;
  protected server?: QUICServer;

  protected resolveHostname: (hostname: Hostname) => Host | PromiseLike<Host>;

  protected socketBind: (port: number, host: string) => Promise<void>;
  protected socketClose: () => Promise<void>;
  protected socketSend: (...params: Array<any>) => Promise<number>;

  protected crypto: {
    key: ArrayBuffer;
    ops: Crypto;
  };

  /**
   * Handle the datagram from UDP socket
   * The `data` buffer could be multiple coalesced QUIC packets.
   * It could also be a non-QUIC packet data.
   * If it is non-QUIC, we can discard the data.
   * If there are multiple coalesced QUIC packets, it is expected that
   * all packets are intended for the same connection. This means we only
   * need to parse the first QUIC packet to determinine what connection to route
   * the data to.
   */
  protected handleSocketMessage = async (data: Buffer, rinfo: dgram.RemoteInfo) => {

    console.log('WE GOT A PACKET', rinfo);


    // The data buffer may have multiple coalesced QUIC packets.
    // This header is parsed from the first packet.
    let header: Header;
    try {
      header = quiche.Header.fromSlice(
        data,
        quiche.MAX_CONN_ID_LEN
      );
    } catch (e) {
      // `InvalidPacket` means that this is not a QUIC packet.
      // If so, then we just ignore the packet.
      if (e.message !== 'InvalidPacket') {
        // Only emit an error if it is not an `InvalidPacket` error.
        // Do note, that this kind of error is a peer error.
        // The error is not due to us.
        this.dispatchEvent(new events.QUICSocketErrorEvent({ detail: e }));
      }
      return;
    }

    // Apparently if it is a UDP datagram
    // it could be a QUIC datagram, and not part of any connection
    // However I don't know how the DCID would work in a QUIC dgram
    // We have not explored this yet

    // Destination Connection ID is the ID the remote peer chose for us.
    const dcid = new QUICConnectionId(header.dcid);

    // Derive our SCID using HMAC signing.
    const scid = new QUICConnectionId(
      await this.crypto.ops.sign(
        this.crypto.key,
        dcid // <- use DCID (which is a copy), otherwise it will cause memory problems later in the NAPI
      ),
      0,
      quiche.MAX_CONN_ID_LEN
    );

    const remoteInfo = {
      host: rinfo.address as Host,
      port: rinfo.port as Port,
    };

    // Now both must be checked
    let conn: QUICConnection;
    if (
      !this.connectionMap.has(dcid) &&
      !this.connectionMap.has(scid)
    ) {
      // If a server is not registered
      // then this packet is useless, and we can discard it
      if (this.server == null) {
        return;
      }
      const conn_ = await this.server.connectionNew(
        data,
        remoteInfo,
        header,
        dcid,
        scid
      );
      // If there's no connection yet
      // Then the server is in the middle of the version negotiation/stateless retry
      // or the handshake process
      if (conn_ == null) {
        return;
      }
      conn = conn_;
    } else {
      conn = this.connectionMap.get(dcid) ?? this.connectionMap.get(scid)!;

      // The connection may be a client or server connection
      // When we register a client, we have to put the connection in our
      // connection map

    }
    await conn.recv(
      data,
      remoteInfo
    );

    // The `conn.recv` now may actually destroy the connection
    // In that sense, there's nothing to send
    // That's the `conn.destroy` might call `conn.send`
    // So it's all sent
    // So we should only send things if it isn't already destroyed
    // Remember that there is 3 possible events to the QUICConnection
    // send, recv, timeout
    // That's it.
    // Each send/recv/timeout may result in a destruction

    if (!conn[destroyed]) {
      await conn.send();
    }
  };

  /**
   * Handle error on the DGRAM socket
   */
  protected handleSocketError = (e: Error) => {
    this.dispatchEvent(
      new events.QUICSocketErrorEvent({ detail: e })
    );
  };

  public constructor({
    crypto,
    resolveHostname = utils.resolveHostname,
    logger
  }: {
    crypto: {
      key: ArrayBuffer;
      ops: Crypto;
    },
    resolveHostname?: (hostname: Hostname) => Host | PromiseLike<Host>;
    logger?: Logger;
  }) {
    super();
    this.logger = logger ?? new Logger(this.constructor.name);
    this.crypto = crypto;
    this.resolveHostname = resolveHostname;
  }

  /**
   * Gets the bound resolved host IP (not hostname).
   * This can be the IPv4 or IPv6 address.
   * This could be a wildcard address which means all interfaces.
   * Note that `::` can mean all IPv4 and all IPv6.
   * Whereas `0.0.0.0` means only all IPv4.
   */
  @ready(new errors.ErrorQUICSocketNotRunning())
  public get host() {
    return this._host;
  }

  /**
   * Gets the bound resolved port.
   * This cannot be `0`.
   * Because `0` is always resolved to a specific port.
   */
  @ready(new errors.ErrorQUICSocketNotRunning())
  public get port() {
    return this._port;
  }

  /**
   * Gets the type of socket
   * It can be ipv4-only, ipv6-only or dual stack
   */
  @ready(new errors.ErrorQUICSocketNotRunning())
  public get type(): 'ipv4' | 'ipv6' | 'ipv4&ipv6' {
    return this._type;
  }

  /**
   * Supports IPv4 and IPv6 addresses
   * Note that if the host is `::`, this will also bind to `0.0.0.0`.
   * The host and port here are the local host and port that the socket will bind to.
   * If the host is a hostname such as `localhost`, this will perform do local resolution.
   */
  public async start({
    host = '::' as Host,
    port = 0 as Port,
    ipv6Only = false,
  }: {
    host?: Host | Hostname,
    port?: Port,
    ipv6Only?: boolean,
  } = {}): Promise<void> {
    let address = utils.buildAddress(host, port);
    this.logger.info(`Start ${this.constructor.name} on ${address}`);
    // Resolves the host which could be a hostname and acquire the type.
    // If the host is an IPv4 mapped IPv6 address, then the type should be udp6.
    const [host_, udpType] = await utils.resolveHost(
      host,
      this.resolveHostname
    );

    // If we are doing udp6 here
    // that implies the ability to send ipv4 packets
    // We don't know yet
    // So we need to check if this is possible


    this.socket = dgram.createSocket({
      type: udpType,
      reuseAddr: false,
      ipv6Only,
    });
    this.socketBind = utils.promisify(this.socket.bind).bind(this.socket);
    this.socketClose = utils.promisify(this.socket.close).bind(this.socket);
    this.socketSend = utils.promisify(this.socket.send).bind(this.socket);
    const { p: errorP, rejectP: rejectErrorP, } = utils.promise();
    this.socket.once('error', rejectErrorP);
    // This resolves DNS via `getaddrinfo` under the hood.
    // It which respects the hosts file.
    // This makes it equivalent to `dns.lookup`.
    const socketBindP = this.socketBind(port, host_);
    try {
      await Promise.race([socketBindP, errorP]);
    } catch (e) {
      // Possible binding failure due to EINVAL or ENOTFOUND.
      // EINVAL due to using IPv4 address where udp6 is specified.
      // ENOTFOUND when the hostname doesn't resolve, or doesn't resolve to IPv6 if udp6 is specified
      // or doesn't resolve to IPv4 if udp4 is specified.
      throw e;
    }
    this.socket.removeListener('error', rejectErrorP);
    const socketAddress = this.socket.address();
    // This is the resolved IP, not the original hostname
    this._host = socketAddress.address as Host;
    this._port = socketAddress.port as Port;
    // Dual stack only exists for `::` and `!ipv6Only`
    if (host_ === '::' && !ipv6Only) {
      this._type = 'ipv4&ipv6';
    } else if (udpType === 'udp4') {
      this._type = 'ipv4';
    } else if (udpType === 'udp6') {
      this._type = 'ipv6';
    }

    console.log('THE ADDRESS', this.socket.address());

    this.socket.on('message', this.handleSocketMessage);
    this.socket.on('error', this.handleSocketError);
    address = utils.buildAddress(this._host, this._port);
    this.logger.info(`Started ${this.constructor.name} on ${address}`);
  }

  public async stop(): Promise<void> {
    const address = utils.buildAddress(this._host, this._port);
    this.logger.info(`Stop ${this.constructor.name} on ${address}`);
    if (this.connectionMap.size > 0) {
      throw new errors.ErrorQUICSocketConnectionsActive(
        `Cannot stop QUICSocket with ${this.connectionMap.size} active connection(s)`,
      );
    }
    this.socket.off('message', this.handleSocketMessage);
    this.socket.off('error', this.handleSocketError);
    await this.socketClose();
    this.dispatchEvent(new events.QUICSocketStopEvent());
    this.logger.info(`Stopped ${this.constructor.name} on ${address}`);
  }

  /**
   * Sends UDP datagram
   */
  public async send(msg: string | Uint8Array | ReadonlyArray<any>, port?: number, address?: string): Promise<number>;
  public async send(msg: string | Uint8Array | ReadonlyArray<any>, port?: number): Promise<number>;
  public async send(msg: string | Uint8Array | ReadonlyArray<any>): Promise<number>;
  public async send(msg: string | Uint8Array, offset: number, length: number, port?: number, address?: string): Promise<number>;
  public async send(msg: string | Uint8Array, offset: number, length: number, port?: number): Promise<number>;
  public async send(msg: string | Uint8Array, offset: number, length: number): Promise<number>;
  @ready(new errors.ErrorQUICSocketNotRunning())
  public async send(...params: Array<any>): Promise<number> {

    // Oh man we need to examine the parameters here now
    // there are 2 case where  this occurs

    // if we are an ipv6 socket, can we send data to a mapped ipv4? I"m not sure
    // wen eed to check!

    // if (this._type === 'ipv4&ipv6') {
    //   if (
    //     params.length === 3 && typeof params[2] === 'string'
    //   ) {
    //     const host = params[2];
    //     if (utils.isIPv4(host)) {
    //       // We must map it to ipv6 address
    //     }
    //     // Check if we are dual stack and IPv4
    //   }
    // }

    // We do this on QUICClient and QUICServer instead
    // Becuase I think the addresses should be changed at the higher level


    // We could throw an error here before
    // because WE KNOW
    // what happens...
    // if you rely on the non-mapped address
    // Let's see


    return this.socketSend(...params);
  }

  /**
   * Registers a client to the socket
   * This is a new client, but clients don't die by itself?
   */
  public registerClient(client: QUICClient) {

    // So what really this does?
    // Is this about creating a connection?
    // So we can add the connection to the map?
    // And if we are doing
    // QUICConnection.createQUICConnection

    // Then that means, we are really creating that connection in the async creator
    // That means the async creator needs to create teh `connection` and call it too


  }

  // But we already have a connection map
  // well yea, we are checking liveness of connections
  // But client destruction is only way to destory connections
  // But if the client connection fails
  // we need to simultaneously destroy the client


  /**
   * Sets a single server to the socket
   * You can only have 1 server for the socket
   * The socket message handling can dispatch new connections to the new server
   * Consider it is an event... therefore a new connection
   * Although that would be if there's an event being emitted
   * One way is to make QUICSocket an EventTarget
   * Then for server to add a handler to it, by doing addEventListener('connection', ...)
   * Or something else
   * But why bother with this pub/sub system
   * Just go straight to calling a thing
   * We can call this.server.handleConnection()
   * Why `handleConnection` because technically it's built on top of the handleMessage
   * Thatbecomes the key idea there
   * handleNewConnection
   * And all sorts of other stuff!
   * Or whatever it needs to be
   */
  public registerServer(server: QUICServer) {
    if (this.server != null && this.server[running]) {
      throw new errors.ErrorQUICSocketServerDuplicate();
    }
    this.server = server;
  }

  public deregisterServer(server: QUICServer) {
    if (this.server === server) {
      delete this.server;
    }
  }

}

export default QUICSocket;
