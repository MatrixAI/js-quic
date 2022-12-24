import type { ConnectionId, Crypto } from './types';
import dgram from 'dgram';
import { Validator } from 'ip-num';
import Logger from '@matrixai/logger';
import QUICConnection from './QUICConnection';
import { quiche } from './native';
import * as utils from './utils';

// When we start a QUIC server
// we have to start with some TLS details
// This has to be done as passed data to load
// We also start a QUIC config here
// do we need to have a separate object?
// I think not
// It's not necessary

// You can have a QUICServer work like TCPServer
// Or it can work like TCPSocket


/**
 * You must provide a error handler `addEventListener('error')`.
 * Otherwise errors will just be ignored.
 *
 * 'close'
 * 'connection'
 * 'error'
 * 'listen'
 */
class QUICServer extends EventTarget {
  protected socket: dgram.Socket;
  protected host: string;
  protected port: number;
  protected clients: Map<ConnectionId, QUICConnection> = new Map();

  protected handleMessage = async (data: Buffer, rinfo: dgram.RemoteInfo) => {

  };

  protected handleTimeout = () => {

  };

  // The reason this is needed
  // is due to the usage of webcrypto
  // to be able to use the `key`
  // and hmac stuff
  // to derive stuff
  // webcrypto.subtle.sign
  // webcrypto.subtle.verify

  // Webcrypto is the best to use for now
  // Relying on libsodium here is not a good idea!

  protected crypto?: {
    key: ArrayBuffer;
    ops: Crypto;
  };
  protected logger: Logger;

  // The crypto in this case is **necessary**
  // It is necessary to sign and stuff
  // So we cannot just be a Buffer
  // It's got to be an ArrayBuffer
  public constructor({
    crypto,
    logger,
  }: {
    crypto: {
      key: ArrayBuffer;
      ops: Crypto;
    },
    logger: Logger;
  }) {
    super();
    this.logger = logger;
    this.crypto = crypto;
  }

  public async start({
    host = '::',
    port = 0
  }: {
    host?: string,
    port?: number,
  } = {}) {
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
    this.socket.on('message', this.handleMessage);
  }

  public async stop() {
    // If we want to close the socket
    // this is all we need to do
    // There's no waiting for connections to stop
    // Cause that doesn't exist on the UDP socket level
    this.socket.close();
  }

}

export default QUICServer;
