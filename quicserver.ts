import dgram from 'dgram';
import { IPv4, IPv6, Validator } from 'ip-num';
import { promisify, promise } from './src/utils';
const quic = require('./index.node');

// So here we imagine we have multiple events that we need to setup
// And then subsequently create web streams over it
// We may need an asynchronous setup first
// Async create and async stop


// Event: 'connection' <- indicates a new QUIC connection is available
// Event: 'stream' <- indicates a new QUIC stream is available
class QUICServer extends EventTarget {

  protected socket: dgram.Socket;
  protected host: string;
  protected port: number;

  // This is method?
  // No it must be async property
  // That way we can attach it without losing context!!
  // Event connection is going to have a `timeout()`
  // Which returns the amount of time before a timeout event will occur
  // However this will necessarily be replaced..
  // If `conn.timeout() == null`, then the timeout should be DISARMED or removed
  // If it returns the milliseconds, we need set it
  protected handleTimeout = () => {
    // The `this` is the INSTANCE

  };

  // This handles the UDP socket message
  protected handleMessage = (data: Buffer, rinfo: dgram.RemoteInfo) => {

    console.log('MESSAGE', data.byteLength, rinfo);

    // The `this` is the INSTANCE

    // data.subarray(0, 1200);


    console.log('MAX CONN ID LEN', quic.MAX_CONN_ID_LEN);

    // console.log('CONSTRUCT', new quic.Header(123));


    // This is quic.Header
    let header;
    try {
      // Maximum length of a connection ID
      header = quic.Header.fromSlice(
        data,
        20
        // quic.MAX_CONN_ID_LEN
      );
    } catch (e) {
      // Drop the message if it is not a QUIC packet
      return;
    }

    // The header is being parsed propertly
    console.log(header);
    console.log(header.ty);
    console.log(header.version);
    console.log(header.dcid);
    console.log(header.scid);
    console.log(header.tokens);
    console.log(header.versions);


  };

  protected handleStream = () => {

  };

  // alternatively
  // we expose "events" that gets emitted here
  // and you just register events on this
  // but if we are not using event emitter
  // but instead a
  // i think it's interesting
  // in that we would wnt to pass something to handle streams
  // rather than you attach handlers to these  things
  // quicServer.on('stream')
  // so then you would extend the event emitter in nodeJS
  // on other systems you may want to use other things
  // OR you extend the event target
  // We may emit an event called stream here
  // protected handleStream;

  public static async createQUICServer() {

  }

  public constructor() {
    super();

    // The stream events are "custom"
    // We need to emit this event to create a stream
    // But we walso need to pass data in
    // this.addEventListener('stream');
    // this.handleStream = handleStream;
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

    this.socket.on('message', this.handleMessage);

    // Ok suppose we handle a new stream for whatever eason
    // It would mean one has to provide a handler for an event
    // We would emit an event for a new stream that was created
    // And you would need to provide some data for it

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
    port: 55555,
  });
  // await quicServer.stop();

  // After `on_timeout()` is called (which occurs at a timeout event)
  // More packets on the connection may need to be sent (for that specific connection)
  // In such a case, that connection should have the `conn.send()` called

}

void main();
