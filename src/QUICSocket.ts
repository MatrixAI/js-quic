import type QUICClient from './QUICClient';
import type QUICServer from './QUICServer';
import type QUICConnection from './QUICConnection';
import type { ConnectionId, ConnectionIdString, Crypto, Host, Hostname } from './types';
import type { Header, Config, Connection } from './native/types';
import QUICConnectionMap from './QUICConnectionMap';
import dgram from 'dgram';
import Logger from '@matrixai/logger';
import { running } from '@matrixai/async-init';
import { StartStop, ready } from '@matrixai/async-init/dist/StartStop';
import { Validator } from 'ip-num';
import { quiche, Type } from './native';
import * as events from './events';
import * as utils from './utils';
import * as errors from './errors';

interface QUICSocket extends StartStop {}
@StartStop()
class QUICSocket extends EventTarget {

  public connectionMap: QUICConnectionMap = new QUICConnectionMap();

  protected socket: dgram.Socket;
  protected _host: string;
  protected _port: number;
  protected logger: Logger;
  protected server: QUICServer;

  protected socketBind: (port: number, host: string) => Promise<void>;
  protected socketClose: () => Promise<void>;
  protected socketSend: (...params: Array<any>) => Promise<number>;

  protected crypto: {
    key: ArrayBuffer;
    ops: Crypto;
  };

  @ready(new errors.ErrorQUICSocketNotRunning())
  public get host() {
    return this._host;
  }

  @ready(new errors.ErrorQUICSocketNotRunning())
  public get port() {
    return this._port;
  }

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
    const dcid = Buffer.from(header.dcid) as ConnectionId;

    // Derive our SCID using HMAC signing.
    const scid = Buffer.from(
      await this.crypto.ops.sign(
        this.crypto.key,
        header.dcid
      ),
      0,
      quiche.MAX_CONN_ID_LEN
    ) as ConnectionId;

    // Now both must be checked
    let conn: QUICConnection;
    if (
      !this.connectionMap.has(dcid) &&
      !this.connectionMap.has(scid)
    ) {
      // It doesn't exist
      // possibly new connection
      // Tell the server to handle it
      // The server has to distinguish the socket

      // If a server is not registered
      // then this packet is useless, and we can discard it
      if (this.server == null) {
        return;
      }

      // This is an event handler
      // This will push events to calling functions in other classes
      // Those classes may end up calling back to this object to trigger sends
      const conn_ = await this.server.handleNewConnection(
        data,
        rinfo,
        header,
        scid
      );

      // If there's no connection yet
      // Then the server is in the middle of the version negotiation/stateless retry
      // or the handshake process
      if (conn_ == null) {
        return;
      }

      conn = conn_;

      // Otherwise do we add this into our connection map?
      // If so, how do we then remove it?
      // If we are just meant to be polling things
      // Since obviously the timeout doesn't really work
      // Until we actually check it



    } else {
      // Connection exists
      // could be a server conn
      // could be a client conn
      // just propagate it...

      conn = this.connectionMap.get(dcid) ?? this.connectionMap.get(scid)!;
      // If we have a connection
      // We can proceed to tell tehe conn to do things

    }

    // The the system is now providing a new connection
    // we now need to to bridge the connection
    // to the socket
    // it's already got its own timeout
    // and its management of the lifecycle to the connection map

    // At this point the socket is handling the datagram event
    // It has to plump this data into the connection
    // It's not the server's pov to do this
    // because the client may need to do this as well
    // And the QUICConnection cannot do it, since it doesn't have it
    // So we have to push that adata in
    // By calling a function

    const recvInfo = {
      to: {
        host: this.socket.address().address,
        port: this.socket.address().port
      },
      from: {
        host: rinfo.address,
        port: rinfo.port
      },
    };
    conn.recv(data, recvInfo);

    await conn.send();




    // you can attach an event handler to the conneciton
    // so when there's data on the connection
    // you proceed to do this
    // but that requires you work on every connection upon creation

    // conn.on('recv', () => { sendToSocket })
    // conn.on('timeout', () => { sendToSocket })


    // When the conn has send event
    // conn.on('send', () => { sendToSocket })

    // Every time a stream sends
    // this results in the connection emitting an event
    // Does that mean the stream emits an event?
    // No it doesn't make sense
    // It just means we tell the connection to emit an event
    // When a send occurs, this means we have sent the data
    // or a close event occurs
    // We could emit an event AFTER a send is called
    // this could work.










    // Ok now's the kicker
    // I don't think we should only besending data here
    // Instead it should be based on some other event
    // The problem is that there's no EVENT
    // for if the connection has anything to do
    // we have the POLL the quiche connection if there's data
    // So on WHAT condition do we poll?




    // If we have a connection now
    // We can proced to make work on it
    // Note that in the case of teh above conn
    // It may not exist in the map yet
    // Should the QUICServer put it in?
    // I think it should
    // But what exactly are we doing here
    // We should be sending it appropriately to the client or to the server



    // We have to dispatch to the appropriate system
    // Depending on the connection ID
    // note that if it is not an existing connection ID
    // Then we assume that means it is for creating a new one
    // If it is not, it is discarded
    // if it is for handling a new connection
    // Then we must use a "single" server to do this
    // But on the client side
    // The DCID is the ID that the remote peer picked for us.
    // Unlike the SCID it is guaranteed to exist for all QUIC packets.
    // const dcid = header.dcid;

    // If this packet is a short header
    // the DCID is decoded based on the dcid length
    // However the SCID is actually:
    // header.scid: ConnectionId::default()
    // What is this?
    // The default connection id is a `from_vec(Vec::new())`
    // I think it's just an empty Uint8Array
    // With length of 0
    // Ok that makes sense now

    // DCID is the only thing that will always exist
    // We must use this as a way to route the connections
    // How do we decide how to do this?
    // We must maintain a "connection" map here
    // That is QUIC connections... etc.
    // Furthermore the DCID may also not exist in the map
    // In that case it can be a NEW connection
    // But if it doesn't follow the new connections
    // it must be discarded too

    // When we pass this QUICSocket into the  the QUICClient
    // or to QUICServer
    // like
    // we can use await, to indicate when it is started
    // it doesn't already need to be started

    // const s = new QUICServer({ socket: QUICSocket });
    // const c1 = new QUICClient({ socket: QUICSocket });
    // const c2 = new QUICClient({ socket: QUICSocket });

    // Then upon doing `s.start()`
    // and `c1.start()`
    // We need to therefore "register" its connections with this handleMessage dispatch

    // Ok so the problem is that there could be multiple packets in the datagram
    // In the initial packet we have the random DCID that the client creates
    // But it also randomly chooses its SCID

    // On the server side, we are converting the `dcid` to `connId`
    // Which is a deterministic hash of it, well a "signed" version of it

    // So we have DCID, SCID and CONNID

    // At any time, endpoints can change the DCID they transmit to a value that has not been used on
    // **another** path.

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
    logger
  }: {
    crypto: {
      key: ArrayBuffer;
      ops: Crypto;
    },
    logger?: Logger;
  }) {
    super();
    this.logger = logger ?? new Logger(this.constructor.name);
    this.crypto = crypto;
  }

  /**
   * Supports IPv4 and IPv6 addresses
   * Note that if the host is `::`, this will also bind to `0.0.0.0`.
   * The host and port here are the local host and port that the socket will bind to.
   * If the host is a hostname such as `localhost`, this will perform do local resolution.
   */
  public async start({
    host = '::' as Host,
    port = 0
  }: {
    host?: Host | Hostname,
    port?: number,
  } = {}): Promise<void> {
    let address = utils.buildAddress(host, port);
    this.logger.info(`Starting ${this.constructor.name} on ${address}`);
    const [isIPv4] = Validator.isValidIPv4String(host);
    const [isIPv6] = Validator.isValidIPv6String(host);
    let type: 'udp4' | 'udp6';
    if (isIPv4) {
      type = 'udp4';
    } else if (isIPv6) {
      type = 'udp6';
    } else {
      // The `host` is a host name, most likely `localhost`.
      // We cannot tell if the host will resolve to IPv4 or IPv6.
      // Here we default to IPv4 so that `127.0.0.1` would be usable if `localhost` is used
      type = 'udp4';
    }
    this.socket = dgram.createSocket({
      type,
      reuseAddr: false,
      ipv6Only: false,
    });
    this.socketBind = utils.promisify(this.socket.bind).bind(this.socket);
    this.socketClose = utils.promisify(this.socket.close).bind(this.socket);
    this.socketSend = utils.promisify(this.socket.send).bind(this.socket);
    const { p: errorP, rejectP: rejectErrorP, } = utils.promise();
    this.socket.once('error', rejectErrorP);
    // This resolves DNS via `getaddrinfo` under the hood.
    // It which respects the hosts file.
    // This makes it equivalent to `dns.lookup`.
    const socketBindP = this.socketBind(port, host);
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
    this._host = socketAddress.address;
    this._port = socketAddress.port;
    this.socket.on('message', this.handleSocketMessage);
    this.socket.on('error', this.handleSocketError);
    address = utils.buildAddress(this._host, this._port);
    this.logger.info(`Started ${this.constructor.name} on ${address}`);
  }

  public async stop(): Promise<void> {
    const address = utils.buildAddress(this._host, this._port);
    this.logger.info(`Stopping ${this.constructor.name} on ${address}`);
    if (this.connectionMap.size > 0) {
      throw new errors.ErrorQUICSocketConnectionsActive();
    }
    this.socket.off('message', this.handleSocketMessage);
    this.socket.off('error', this.handleSocketError);
    await this.socketClose();
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
    return this.socketSend(...params);
  }

  /**
   * Registers a client to the socket
   * This is a new client, but clients don't die by itself?
   */
  public registerClient(client: QUICClient) {

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

}

export default QUICSocket;
