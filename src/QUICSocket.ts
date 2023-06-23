import type QUICServer from './QUICServer';
import type QUICConnection from './QUICConnection';
import type { Host, Hostname, Port } from './types';
import type { Header } from './native/types';
import dgram from 'dgram';
import Logger from '@matrixai/logger';
import { running } from '@matrixai/async-init';
import { StartStop, ready } from '@matrixai/async-init/dist/StartStop';
import { Monitor, RWLockWriter } from '@matrixai/async-locks';
import QUICConnectionId from './QUICConnectionId';
import QUICConnectionMap from './QUICConnectionMap';
import { quiche } from './native';
import * as events from './events';
import * as utils from './utils';
import * as errors from './errors';
import { status } from '@matrixai/async-init/dist/utils';

/**
 * Events:
 * - socketError
 * - socketStop
 */
interface QUICSocket extends StartStop {}
@StartStop()
class QUICSocket extends EventTarget {
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

  /**
   * Handle the datagram from UDP socket
   * The `data` buffer could be multiple coalesced QUIC packets.
   * It could also be a non-QUIC packet data.
   * If it is non-QUIC, we can discard the data.
   * If there are multiple coalesced QUIC packets, it is expected that
   * all packets are intended for the same connection. This means we only
   * need to parse the first QUIC packet to determining what connection to route
   * the data to.
   */
  protected handleSocketMessage = async (
    data: Buffer,
    remoteInfo: dgram.RemoteInfo,
  ) => {
    // The data buffer may have multiple coalesced QUIC packets.
    // This header is parsed from the first packet.
    let header: Header;
    try {
      header = quiche.Header.fromSlice(data, quiche.MAX_CONN_ID_LEN);
    } catch (e) {
      // `BufferTooShort` and `InvalidPacket` means that this is not a QUIC
      // packet. If so, then we just ignore the packet.
      if (e.message !== 'BufferTooShort' && e.message !== 'InvalidPacket') {
        // Emit error if it is not a `BufferTooShort` or `InvalidPacket` error.
        // This would indicate something went wrong in header parsing.
        // This is not a critical error, but should be checked.
        this.dispatchEvent(new events.QUICSocketErrorEvent({ detail: e }));
      }
      return;
    }
    // All QUIC packets will have the `dcid` header property
    // However short packets will not have the `scid` property
    // The destination connection ID is supposed to be our connection ID
    const dcid = new QUICConnectionId(header.dcid);
    const remoteInfo_ = {
      host: remoteInfo.address as Host,
      port: remoteInfo.port as Port,
    };
    let connection: QUICConnection;
    if (!this.connectionMap.has(dcid)) {
      // If the DCID is not known, and the server has not been registered then
      // we discard the packet>
      if (this.server == null) {
        return;
      }
      // At this point, the connection may not yet be started
      const connection_ = await this.server.connectionNew(
        remoteInfo_,
        header,
        dcid,
      );
      // If there's no connection yet
      // then the server is middle of version negotiation or stateless retry
      if (connection_ == null) {
        return;
      }
      connection = connection_;
    } else {
      connection = this.connectionMap.get(dcid)!;
    }
    // If the connection has already stopped running
    // then we discard the packet.
    if (!(connection[running] || connection[status] === 'starting')) {
      console.log('x');
      return;
    }
    // Acquire the conn lock, this ensures mutual exclusion
    // for state changes on the internal connection
    const mon = new Monitor<RWLockWriter>(connection.lockbox, RWLockWriter);
    await mon.withF(connection.lockCode, async (mon) => {
      // Even if we are `stopping`, the `quiche` library says we need to
      // continue processing any packets.
      await connection.recv(data, remoteInfo_, mon);
      await connection.send(mon);
    });
  };

  /**
   * Handle error on the DGRAM socket
   */
  protected handleSocketError = (e: Error) => {
    this.dispatchEvent(new events.QUICSocketErrorEvent({ detail: e }));
  };

  public constructor({
    resolveHostname = utils.resolveHostname,
    logger,
  }: {
    resolveHostname?: (hostname: Hostname) => Host | PromiseLike<Host>;
    logger?: Logger;
  }) {
    super();
    this.logger = logger ?? new Logger(this.constructor.name);
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
    reuseAddr = false,
    ipv6Only = false,
  }: {
    host?: Host | Hostname;
    port?: Port;
    reuseAddr?: boolean;
    ipv6Only?: boolean;
  } = {}): Promise<void> {
    let address = utils.buildAddress(host, port);
    this.logger.info(`Start ${this.constructor.name} on ${address}`);
    // Resolves the host which could be a hostname and acquire the type.
    // If the host is an IPv4 mapped IPv6 address, then the type should be udp6.
    const [host_, udpType] = await utils.resolveHost(
      host,
      this.resolveHostname,
    );
    this.socket = dgram.createSocket({
      type: udpType,
      reuseAddr,
      ipv6Only,
    });
    this.socketBind = utils.promisify(this.socket.bind).bind(this.socket);
    this.socketClose = utils.promisify(this.socket.close).bind(this.socket);
    this.socketSend = utils.promisify(this.socket.send).bind(this.socket);
    const { p: errorP, rejectP: rejectErrorP } = utils.promise();
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
      throw new errors.ErrorQUICSocketInvalidBindAddress(
        host !== host_
          ? `Could not bind to resolved ${host} -> ${host_}`
          : `Could not bind to ${host}`,
        {
          cause: e,
        },
      );
    }
    this.socket.removeListener('error', rejectErrorP);
    const socketAddress = this.socket.address();
    // This is the resolved IP, not the original hostname
    this._host = socketAddress.address as Host;
    this._port = socketAddress.port as Port;
    // Dual stack only exists for `::` and `!ipv6Only`
    if (host_ === '::' && !ipv6Only) {
      this._type = 'ipv4&ipv6';
    } else if (udpType === 'udp4' || utils.isIPv4MappedIPv6(host_)) {
      this._type = 'ipv4';
    } else if (udpType === 'udp6') {
      this._type = 'ipv6';
    }
    this.socket.on('message', this.handleSocketMessage);
    this.socket.on('error', this.handleSocketError);
    address = utils.buildAddress(this._host, this._port);
    this.logger.info(`Started ${this.constructor.name} on ${address}`);
  }

  /**
   * Will stop the socket.
   * An `ErrorQUICSocketConnectionsActive` will be thrown if there are active connections.
   * If force is true, it will skip checking connections and stop the socket.
   * @param force - Will force the socket to end even if there are active connections, used for cleaning up after tests.
   */
  public async stop({
    force = false,
  }: { force?: boolean } = {}): Promise<void> {
    const address = utils.buildAddress(this._host, this._port);
    this.logger.info(`Stop ${this.constructor.name} on ${address}`);
    if (!force && this.connectionMap.size > 0) {
      throw new errors.ErrorQUICSocketConnectionsActive(
        `Cannot stop QUICSocket with ${this.connectionMap.size} active connection(s)`,
      );
    }
    this.socket.removeListener('message', this.handleSocketMessage);
    this.socket.removeListener('error', this.handleSocketError);
    await this.socketClose();
    this.dispatchEvent(new events.QUICSocketStopEvent());
    this.logger.info(`Stopped ${this.constructor.name} on ${address}`);
  }

  /**
   * Sends UDP datagram
   * The UDP socket here is connectionless.
   * The port and address are necessary.
   */
  public async send(
    msg: string | Uint8Array | ReadonlyArray<any>,
    port: number,
    address: string,
  ): Promise<number>;
  public async send(
    msg: string | Uint8Array,
    offset: number,
    length: number,
    port: number,
    address: string,
  ): Promise<number>;
  @ready(new errors.ErrorQUICSocketNotRunning())
  public async send(...params: Array<any>): Promise<number> {
    let index: number;
    if (params.length === 3 && typeof params[2] === 'string') {
      index = 2;
    } else if (params.length === 5 && typeof params[4] === 'string') {
      index = 4;
    } else {
      throw new TypeError(
        'QUICSocket.send requires `port` and `address` parameters',
      );
    }
    const host = params[index] as Host | Hostname;
    const [host_, udpType] = await utils.resolveHost(
      host,
      this.resolveHostname,
    );
    if (
      this._type === 'ipv4' &&
      udpType !== 'udp4' &&
      !utils.isIPv4MappedIPv6(host_)
    ) {
      throw new errors.ErrorQUICSocketInvalidSendAddress(
        `Cannot send to ${host_} on an IPv4 QUICSocket`,
      );
    } else if (
      this._type === 'ipv6' &&
      (udpType !== 'udp6' || utils.isIPv4MappedIPv6(host_))
    ) {
      throw new errors.ErrorQUICSocketInvalidSendAddress(
        `Cannot send to ${host_} on an IPv6 QUICSocket`,
      );
    } else if (this._type === 'ipv4&ipv6' && udpType !== 'udp6') {
      throw new errors.ErrorQUICSocketInvalidSendAddress(
        `Cannot send to ${host_} on a dual stack QUICSocket`,
      );
    } else if (
      this._type === 'ipv4' &&
      utils.isIPv4MappedIPv6(this._host) &&
      !utils.isIPv4MappedIPv6(host_)
    ) {
      throw new errors.ErrorQUICSocketInvalidSendAddress(
        `Cannot send to ${host_} an IPv4 mapped IPv6 QUICSocket`,
      );
    }
    params[index] = host_;
    return this.socketSend(...params);
  }

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
   * That becomes the key idea there
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
