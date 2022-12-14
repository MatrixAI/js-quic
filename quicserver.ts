import dgram from 'dgram';
import { IPv4, IPv6, Validator } from 'ip-num';
import { promisify, promise } from './src/utils';

// So here we imagine we have multiple events that we need to setup
// And then subsequently create web streams over it
// We may need an asynchronous setup first
// Async create and async stop

class QUICServer {

  protected socket: dgram.Socket;
  protected host: string;
  protected port: number;

  public static async createQUICServer() {

  }

  public constructor() {

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
    const { p: errorP, rejectP: rejectErrorP, } = promise();
    this.socket.once('error', rejectErrorP);

    // This uses `getaddrinfo` under the hood, which respects the hosts file
    const socketBind = promisify(this.socket.bind).bind(this.socket);
    const socketBindP = socketBind(port, host);

    try {
      await Promise.race([socketBindP, errorP]);
    } catch (e) {
      // Possible binding failure due to EINVAL or ENOTFOUND
      // EINVAL due to using IPv4 address where udp6 is specified
      // ENOTFOUND when the hostname doesn't resolve, or doesn't resolve to IPv6 if udp6 is specified
      // or doesn't resolve to IPv4 if udp4 is specified
      throw e;
    }
    this.socket.removeListener('error', rejectErrorP);

    const socketAddress = this.socket.address();

    // This is the resolved IP, not the original hostname
    this.host = socketAddress.address;
    this.port = socketAddress.port;

    console.log(this.host, this.port);

  }

  public async stop() {
    // If we want to close the socket
    // this is all we need to do
    // There's no waiting for connections to stop
    // Cause that doesn't exist on the UDP socket level
    this.socket.close();
  }

  public async destroy() {

  }

}

async function main () {

  const quicServer = new QUICServer();
  await quicServer.start({
    host: 'localhost',
    port: 0,
  });
  await quicServer.stop();

}

void main();
