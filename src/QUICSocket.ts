import type QUICServer from './QUICServer';
import type { Host, Hostname, Port, ResolveHostname } from './types';
import type { Header } from './native/types';
import dgram from 'dgram';
import Logger from '@matrixai/logger';
import { StartStop, ready, running } from '@matrixai/async-init/dist/StartStop';
import { utils as errorsUtils } from '@matrixai/errors';
import QUICConnectionId from './QUICConnectionId';
import QUICConnectionMap from './QUICConnectionMap';
import { quiche } from './native';
import * as events from './events';
import * as utils from './utils';
import * as errors from './errors';

interface QUICSocket extends StartStop {}
@StartStop({
  eventStart: events.EventQUICSocketStart,
  eventStarted: events.EventQUICSocketStarted,
  eventStop: events.EventQUICSocketStop,
  eventStopped: events.EventQUICSocketStopped,
})
class QUICSocket {
  /**
   * The connection map is defined here so that it can be shared between
   * the `QUICClient` and the `QUICServer`. However every connection's
   * lifecycle is managed by either the `QUICClient` or `QUICServer`.
   * `QUICSocket` will not set or unset any connections in this connection map.
   * @internal
   */
  public connectionMap: QUICConnectionMap = new QUICConnectionMap();

  protected logger: Logger;

  /**
   * Registered server for this socket.
   * If a server is not registered for this socket, all packets for new
   * connections will be dropped.
   */
  protected server?: QUICServer;

  /**
   * Hostname resolver.
   */
  protected resolveHostname: ResolveHostname;

  protected _host: Host;
  protected _port: Port;
  protected _type: 'ipv4' | 'ipv6' | 'ipv4&ipv6';

  /**
   * UDP socket.
   * This is the only IO that this library uses.
   */
  protected socket: dgram.Socket;

  protected socketBind: (port: number, host: string) => Promise<void>;
  protected socketClose: () => Promise<void>;
  protected socketSend: (...params: Array<any>) => Promise<number>;

  public readonly closedP: Promise<void>;
  protected _closed: boolean = false;
  protected resolveClosedP: () => void;

  /**
   * Upon a QUIC socket error, stop this socket.
   */
  protected handleEventQUICSocketError = (
    evt: events.EventQUICSocketError,
  ) => {
    const error = evt.detail;
    this.logger.error(utils.formatError(error));
  };

  protected handleEventQUICSocketClose = async () => {
    await this.socketClose();
    this._closed = true;
    this.resolveClosedP();
    if (this[running]) {
      // Failing this is a software error
      await this.stop({ force: true });
    }
  };

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
      if (e.message === 'BufferTooShort' || e.message === 'InvalidPacket') {
        return;
      }
      // If the error is niether `BufferTooShort` or `InvalidPacket`, this
      // may indicate something went wrong in the header parsing, which should
      // be a software error.
      throw e;
    }
    // All QUIC packets will have the `dcid` header property
    // However short packets will not have the `scid` property
    // The destination connection ID is supposed to be our connection ID
    const dcid = new QUICConnectionId(header.dcid);
    const remoteInfo_ = {
      host: remoteInfo.address as Host,
      port: remoteInfo.port as Port,
    };
    const connection = this.connectionMap.get(dcid);
    if (connection != null) {
      // Remember if the connection is stopped, then the @ready decorator prevent calls
      // If it is stopping, then this can still be called, and quiche might just be ignoring
      // But if the connection is stopped, it could not have been acquired here

      // In the QUIC protocol, acknowledging packets while in a draining
      // state is optional. We can respond with `STATELESS_RESET`
      // but it's not necessary, and ignoring is simpler
      // https://www.rfc-editor.org/rfc/rfc9000.html#stateless-reset
      await connection.recv(data, remoteInfo_);
      // Failing this is a software error (not a caller error)
    } else {
      // If the server is not registered, we cannot attempt to create a new
      // connection for this packet.
      if (this.server == null) {
        return;
      }
      try {
        // This call will block until the connection is started which
        // may require multiple `recv` and `send` pairs to process the
        // received packets.
        // In order to do this, firstly the initial `data` is faciliated by the
        // `QUICServer`. And subsequently multiple `recv` and `send` pairs will
        // occur concurrently while the the connection is starting.
        // These concurrent `recv` and `send` pairs occur in this same handler,
        // but just in the other branch of the current `if` statement where
        // the connection object already exists in the connection map.
        await this.server.acceptConnection(
          remoteInfo_,
          header,
          dcid,
          data,
        );
      } catch (e) {
        // The acceptConnection is a caller error
        // Now we have to handle this and decide
        // Whether this is to be dropped
        // OR that it's a domain error

        // If the connection timed out during start, this is an expected
        // possibility, because the remote peer might have become unavailable,
        // in which case we can just ignore the error here.
        if (
          errorsUtils.checkError(
            e,
            (e) => e instanceof errors.ErrorQUICServerNewConnection,
          )
        ) {
          // This is a legitimate state transition
          // The caller error is ignored
          return;
        }
        // Translate the caller error to a domain error
        if (
          errorsUtils.checkError(e, (e) => e instanceof errors.ErrorQUICSocket)
        ) {
          // This would mean the `this.send` call somewhere failed
          const e_ = new errors.ErrorQUICSocketInternal(
            'Failed to call accept connection due to socket send',
            { cause: e }
          );
          this.dispatchEvent(
            new events.EventQUICSocketError({
              detail: e_
            })
          );
          this.dispatchEvent(
            new events.EventQUICSocketClose()
          );
          return;
        }

        // Software error - throw upwards
        throw e;
      }
    }
  };

  public constructor({
    resolveHostname = utils.resolveHostname,
    logger,
  }: {
    resolveHostname?: ResolveHostname;
    logger?: Logger;
  }) {
    this.logger = logger ?? new Logger(this.constructor.name);
    this.resolveHostname = resolveHostname;
    const {
      p: closedP,
      resolveP: resolveClosedP,
    } = utils.promise();
    this.closedP = closedP;
    this.resolveClosedP = resolveClosedP;
  }

  /**
   * Socket is closed!
   */
  public get closed() {
    return this._closed;
  }

  /**
   * Gets the bound resolved host IP (not hostname).
   * This can be the IPv4 or IPv6 address.
   * This could be a wildcard address which means all interfaces.
   * Note that `::` can mean all IPv4 and all IPv6.
   * Whereas `0.0.0.0` means only all IPv4.
   */
  @ready(new errors.ErrorQUICSocketNotRunning())
  public get host(): Host {
    return this._host;
  }

  /**
   * Gets the bound resolved port.
   * This cannot be `0`.
   * Because `0` is always resolved to a specific port.
   */
  @ready(new errors.ErrorQUICSocketNotRunning())
  public get port(): Port {
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
   * Starts this QUICSocket.
   * This supports hostnames and IPv4 and IPv6 addresses.
   * If the host is `::`, this will also bind to `0.0.0.0`.
   *
   * @param opts
   * @param opts.host - The host to bind to. Default is `::`.
   * @param opts.port - The port to bind to. Default is `0`.
   * @param opts.reuseAddr - Whether to reuse the address. Default is `false`.
   * @param opts.ipv6Only - Whether to only bind to IPv6. Default is `false`.
   *
   * @throws {errors.ErrorQUICSocketInvalidBindAddress} If bind failed due to
   * EINVAL or ENOTFOUND. EINVAL is due to using IPv4 host when creating a
   * `udp6` socket. ENOTFOUND is when the hostname does not resolve
   * or does not resolve to IPv6 when creating a `udp6` socket or does not
   * resolve to IPv4 when creating a `udp4` socket.
   */
  public async start({
    host = '::',
    port = 0,
    reuseAddr = false,
    ipv6Only = false,
  }: {
    host?: string;
    port?: number;
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
    const port_ = utils.toPort(port);
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
    const socketBindP = this.socketBind(port_, host_);
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

    // The dgram socket's error events might just be informational
    // They don't necessarily correspond to an error
    // Therefore we don't bother listening for it
    // Unless we were propagating default events upwards

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
    this.addEventListener(
      events.EventQUICSocketError.name,
      this.handleEventQUICSocketError,
    );
    this.addEventListener(
      events.EventQUICSocketClose.name,
      this.handleEventQUICSocketClose,
      { once: true }
    );
    address = utils.buildAddress(this._host, this._port);
    this.logger.info(`Started ${this.constructor.name} on ${address}`);
  }

  /**
   * Stop this QUICSocket.
   *
   * @param force - Stop the socket even if the connection map is not empty.
   *
   * @throws {errors.ErrorQUICSocketConnectionsActive} if the connection map is
   * not empty and `force` is `false`.
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
    if (!this._closed) {
      this.dispatchEvent(new events.EventQUICSocketClose());
    }
    await this.closedP;
    this.removeEventListener(
      events.EventQUICSocketError.name,
      this.handleEventQUICSocketError,
    );
    this.removeEventListener(
      events.EventQUICSocketClose.name,
      this.handleEventQUICSocketClose
    );
    this.socket.off('message', this.handleSocketMessage);
    this.logger.info(`Stopped ${this.constructor.name} on ${address}`);
  }

  /**
   * Sends UDP datagram.
   * Because UDP socket is connectionless, the port and address are required.
   * This call is used internally by the rest of the library, but it is not
   * internal because it can be used for hole punching, which is an application
   * concern. Therefore if this method throws an exception, it does necessarily
   * mean that this `QUICSocket` is an error state. It could be the caller's
   * fault. However, if one of the internal procedures in this library receives
   * an error, then that would be considered a runtime IO error for this
   * `QUICSocket`. At this point we cannot know who is calling this method, so
   * we expect such exceptions to bubble up eventually to one of the root event
   * handlers in this `QUICSocket` which will convert the exception to a
   * `EventQUICSocketError`.
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
   * This is an internal send that is faster.
   * @internal
   */
  public async send_(
    msg: string | Uint8Array | ReadonlyArray<any>,
    port: number,
    address: string,
  ): Promise<number>;
  public async send_(
    msg: string | Uint8Array,
    offset: number,
    length: number,
    port: number,
    address: string,
  ): Promise<number>;
  @ready(new errors.ErrorQUICSocketNotRunning())
  public async send_(...params: Array<any>): Promise<number> {
    return this.socketSend(...params);
  }

  public setServer(server: QUICServer) {
    this.server = server;
  }

  public unsetServer() {
    delete this.server;
  }
}

export default QUICSocket;
