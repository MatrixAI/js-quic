import type QUICClient from './QUICClient';
import type QUICServer from './QUICServer';
import type QUICConnection from './QUICConnection';
import type { ConnectionId, Crypto } from './types';
import type { Header, Config, Connection } from './native/types';
import dgram from 'dgram';
import Logger from '@matrixai/logger';
import {
  StartStop,
  ready,
} from '@matrixai/async-init/dist/StartStop';
import { Validator } from 'ip-num';
import { quiche, Type } from './native';
import * as events from './events';
import * as utils from './utils';
import * as errors from './errors';

interface QUICSocket extends StartStop {}
@StartStop()
class QUICSocket extends EventTarget {

  protected socket: dgram.Socket;
  protected _host: string;
  protected _port: number;
  protected logger: Logger;

  protected server: QUICServer;

  // This is being shared between the server and clients
  protected connectionMap: Map<ConnectionId, QUICConnection>;

  // There's actually only one thing I need here
  // The the other stuff is not relevant
  // Although the same type could be used over and over?
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
  protected handleMessage = async (data: Buffer, rinfo: dgram.RemoteInfo) => {
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
        this.dispatchEvent(new events.QUICSocketErrorEvent({ detail: e }));
      }
      return;
    }

    // Apparently if it is a UDP datagram
    // it could be a QUIC datagram, and not part of any connection
    // However I don't know how the DCID would work in a QUIC dgram
    // We have not explored this yet

    // const dcid = Buffer.from(header.dcid);

    // const dcidDerived = utils.bufferWrap(
    //   await this.crypto.ops.sign(
    //     this.crypto.key,
    //     dcid
    //   )
    // ).subarray(0, quiche.MAX_CONN_ID_LEN);

    // dcidPeer <- dcid of the peer
    // scidPeer <- scid of the peer?
    // but we have a packet
    // dcidPacket

    // When a client sends the first packet
    // I might say that a connection hasn't been created until it is ready
    // However this means the ID might not exist in the map
    // If that's the case, then wouldn't that mean...?
    // No because the client generated SCID is what is the DCID coming back in
    // At that point... that has to work that way

    // Destination Connection ID is the ID the remote peer chose for us.
    const dcid = utils.toConnectionId(header.dcid);

    // Derive our SCID using HMAC signing.
    const dcidDerived = new Uint8Array(
      await this.crypto.ops.sign(
        this.crypto.key,
        header.dcid
      ),
      0,
      quiche.MAX_CONN_ID_LEN
    );

    // This Source Connection ID here represents the ID we choose for ourselves.
    const scid = utils.toConnectionId(dcidDerived);

    // Now both must be checked
    let conn;
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
      conn = await this.server.handleNewConnection(data, rinfo, header);

      // If there's no connection yet
      // Then the server is in the middle of the version negotiation/stateless retry
      // or the handshake process
      if (conn == null) {
        return;
      }

    } else {
      // Connection exists
      // could be a server conn
      // could be a client conn
      // just propagate it...

      conn = this.connectionMap.get(dcid) ?? this.connectionMap.get(scid)!;
      // If we have a connection
      // We can proceed to tell tehe conn to do things

    }

    // Do we do the same thing here?
    // Is the idea we write to the socket here?
    // Or can we pass it on... and it will end up managing it from there
    // But if so, how do we ensure we can write the sockets?




    // Because of `toString('hex')`


    // We must then "hash" it with hmac system
    // This has to be done BEFORE we hand off to the server
    // Since we MUST check the connection map
    // To know whether to hand off to a client or server
    // Furthermore can we then simplify to just a connection!?
    // We must have the connection map here
    // That connection map must then be shared with the client and server
    // But it must exist here






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

    // During version neogtiation
    // i







    // This has to do some muxing

  };

  /**
   * Handle error on the DGRAM socket
   */
  protected handleError = (e: Error) => {
    this.dispatchEvent(
      new events.QUICSocketErrorEvent({ detail: e })
    );
  };


  // you can proceed to run a server in it
  // by telling the socket to create a server
  // you cannot run 2 servers with the same socket
  // furthermore you have to add handlers
  // or the muxing/demuxing handlers
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
   */
  public async start({
    host = '::',
    port = 0
  }: {
    host?: string,
    port?: number,
  } = {}): Promise<void> {

    // Remember the `host and port` here
    // Is the host and port that the socket is being bound to
    // This is the "local address"
    // Not the remote address
    // For QUICClient, what we want is actually the remote address
    // which may then bound to random one
    // BUT
    // If the target address is V4, then you want to bind to ipv4
    // and if it is V6, then you want to bind to ipv6
    // That's the important thing

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
    const { p: errorP, rejectP: rejectErrorP, } = utils.promise();
    this.socket.once('error', rejectErrorP);
    // This resolves DNS via `getaddrinfo` under the hood.
    // It which respects the hosts file.
    // This makes it equivalent to `dns.lookup`.
    const socketBind = utils.promisify(this.socket.bind).bind(this.socket);
    const socketBindP = socketBind(port, host);
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
    this.socket.on('message', this.handleMessage);
    this.socket.on('error', this.handleError);
    address = utils.buildAddress(this._host, this._port);
    this.logger.info(`Started ${this.constructor.name} on ${address}`);

    // standard TLS situation would be relevant here
    // but only if we want to do TLS name verification
  }

  public async stop(): Promise<void> {
    const address = utils.buildAddress(this._host, this._port);
    this.logger.info(`Stopping ${this.constructor.name} on ${address}`);
    this.socket.close();
    this.logger.info(`Stopped ${this.constructor.name} on ${address}`);
  }

  /**
   * Sends UDP datagram
   */
  public async send(data, offset, length, port, address) {
    return new Promise<void>((resolve, reject) => {
      this.socket.send(data, offset, length, port, address, (err) => {
        if (err != null) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Registers a client to the socket
   * This is a new client, but clients don't die by itself?
   */
  public addClient(client: QUICClient) {

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
  public setServer(server: QUICServer) {
    this.server = server;
  }

}

export default QUICSocket;

// KMS at the root level just for managing its own key
// Vault system for managing token lifecycles
// - all sorts of goodies here

// TODO:
// if the quic socket is shared
// how is GC maintained?
// do we use a weakmap or something
// nah something has to maintain the collection structure
// it's possible that multiple clients keep allocating themselves to the client
// perhaps even multiple clients and multiple servers

/*

const quicSocket = new QUICSocket();
await quicSocket.start({
  host: '::',
  port: 0
});

// Here we can start doing things


// This way we can complete connections
// The socket you have to register the client and shit
// But you don't directly work against
// It has to make use of it!
// That's the key point!!!

const c1 = new QUICClient({ socket: quicSocket });
await c1.start();

const c2 = new QUICClient({ socket: quicSocket });
await c2.start();

const s1 = new QUICServer({ socket: quicSocket });
await s1.start();

When they start it ends up calling the rest of the system.

The socket is shared between the 3.

If it is not passed in, it will create their own socket and will be registered appropriately.

Remember you can either pass a socket, or host/port combination to start things independently.

Unless you want to be able to rebind?



*/
