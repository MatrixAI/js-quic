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

// We can use this to share a socket
// because this has to start a socket
// but also, this means when we "start"
// you may start with a pre-existing socket?
// Plus do we mean to have a QUICPeer
// and we form connections off that socket too?
// or just form connections directly?

// form client connection directly
// take as a a server
// we start with a QUIC socket
// you can create connections off it
// and you can create a server off it
// what does it mean to be a client?
// it's more than a generic counnection right

// so that's my problem

interface QUICSocket extends StartStop {}
@StartStop()
class QUICSocket extends EventTarget {

  protected socket: dgram.Socket;
  protected host: string;
  protected port: number;
  protected logger: Logger;

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
    let header: Header;
    try {
      // Why we would we ever use anything else?
      // This is a constant!
      header = quiche.Header.fromSlice(
        data,
        quiche.MAX_CONN_ID_LEN
      );
    } catch (e) {
      // Only `InvalidPacket` is a valid error here
      if (e.message !== 'InvalidPacket') {
        this.dispatchEvent(new events.QUICSocketErrorEvent({ detail: e }));
      }
      return;
    }

    // The DCID is the ID that the remote peer picked for us.
    // Unlike the SCID it is guaranteed to exist for all QUIC packets.
    const dcid = header.dcid;



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

  // you can proceed to run a server in it
  // by telling the socket to create a server
  // you cannot run 2 servers with the same socket
  // furthermore you have to add handlers
  // or the muxing/demuxing handlers
  public constructor({
    logger
  }: {
    logger?: Logger;
  }) {
    super();
    this.logger = logger ?? new Logger(this.constructor.name);
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
    // This uses `getaddrinfo` under the hood, which respects the hosts file
    // Which is equivalent to `dns.lookup`
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
    this.host = socketAddress.address;
    this.port = socketAddress.port;
    this.socket.on('error', (e) => {
      this.dispatchEvent(
        new events.QUICSocketErrorEvent({ detail: e })
      );
    });
    address = utils.buildAddress(this.host, this.port);
    this.logger.info(`Started ${this.constructor.name} on ${address}`);

    // In the QUIC client we have to use dns.lookup
    // to get the peer address
    // Cause the UDP socket here is locally bound

    // If the `host` is a hostname
    // Then DNS must be used to look it up
    // We must resolve to the addresses

    // standard TLS situation would be relevant here
    // but only if we want to do TLS name verification

    // So we always create a socket in this way
    // the question is that you must create a socket FIRST
    // before passing it around, it's a separate object
    // then when you do an asynchronous creation
    // you do need to do the construction!
  }

  public async stop(): Promise<void> {
    const address = utils.buildAddress(this.host, this.port);
    this.logger.info(`Stopping ${this.constructor.name} on ${address}`);
    this.socket.close();
    this.logger.info(`Stopped ${this.constructor.name} on ${address}`);
  }
}

export default QUICSocket;


// TODO:
// if the quic socket is shared
// how is GC maintained?
// do we use a weakmap or something
// nah something has to maintain the collection structure
// it's possible that multiple clients keep allocating themselves to the client
// perhaps even multiple clients and multiple servers
