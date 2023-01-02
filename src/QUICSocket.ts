import dgram from 'dgram';
import Logger from '@matrixai/logger';
import {
  StartStop,
  ready,
} from '@matrixai/async-init/dist/StartStop';
import { Validator } from 'ip-num';
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
        new events.QUICServerErrorEvent({ detail: e })
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
