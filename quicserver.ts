import dgram from 'dgram';
import { webcrypto } from 'crypto';
import { IPv4, IPv6, Validator } from 'ip-num';
import { promisify, promise } from './src/utils';
const quic = require('./index.node');

// So here we imagine we have multiple events that we need to setup
// And then subsequently create web streams over it
// We may need an asynchronous setup first
// Async create and async stop

class QUICConnectionEvent extends Event {
  public detail;
  constructor(
    options: EventInit & {
      detail: any
    }
  ) {
    super('connection', options);
    this.detail = options.detail;
  }
}


// Event: 'connection' <- indicates a new QUIC connection is available
// Event: 'stream' <- indicates a new QUIC stream is available
class QUICServer extends EventTarget {

  protected socket: dgram.Socket;
  protected host: string;
  protected port: number;
  protected key;
  protected config;
  protected clients: Map<string, any> = new Map();

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
  protected handleMessage = async (data: Buffer, rinfo: dgram.RemoteInfo) => {

    console.group('---- Handle Message ----');

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
      console.groupEnd();
      return;
    }



    // The header is being parsed propertly
    console.log('HEADER TYPE:', header.ty);
    console.log('HEADER VERSION:', header.version);
    console.log('HEADER DCID', header.dcid);
    console.log('HEADER SCID', header.scid);
    console.log('HEADER TOKEN', header.token);
    console.log('HEADER VERSION', header.version);
    console.log('HEADER VERSIONS', header.versions);

    const dcid: Buffer = Buffer.from(header.dcid);

    const dcidSignature = Buffer.from(await webcrypto.subtle.sign(
      'HMAC',
      this.key,
      dcid
    ));

    const connId = dcidSignature.subarray(0, quic.MAX_CONN_ID_LEN);

    console.log('CONNECTION ID', connId);

    // So remember here
    // the "header.dcid" here could be the the derived conn ID from the original dcid
    // at the same time, the newly derived conn id... I just think would not actually exist in the client map
    // SO I'm not sure why

    // The commit here on quiche
    // says that this DOES a "double lookup" for both the raw dcid and deterministically derived conn id

    // The reason is because a "ClientHello" may be split up between MULTIPLE
    // initial packets..., this may cause it to create multiple connections
    // which would be incorrect

    // Apparently doing it this way works better

    // Apparently it's also possible to use multiple keys to point to the same connection
    // That would use a double layer hashmap.. meaning a map of a map?
    // BUt if we are removing connections, we may not have the original dcid
    // That is if a stateless retry is not performed...
    // https://github.com/cloudflare/quiche/commit/06c0d497a4e08da31e8d3684a7bcf03cca38448d#diff-c590b3c924c35c2f241746522284e4709df490d73a38aaa7d6de4ed1eac2f546

    // Ok anyway, so the problem is possibly packet fragmentation
    // where the client hello is split up into multiple packets
    // and the server may not be able to determine which packet is the first
    // So it may create multiple connections
    // So we need to use the dcid to determine the connection id
    // And then use the connection id to determine the connection
    // And then use the connection to determine the stream
    // And then use the stream to determine the data

    let conn;
    if (
      !this.clients.has(dcid.toString('binary')) &&
      !this.clients.has(connId.toString('binary'))
    ) {

      // It must be an initial packet here
      if (header.ty !== quic.Type.Initial) {
        console.log('PACKET is not initial');
        console.groupEnd();
        return;
      }

      console.log('PROTOCOL VERSION', quic.PROTOCOL_VERSION);

      // The initial packet's version is set to a fixed value
      // that is not used by any other packet type.
      // This allows the server to easily identify the packet
      // as the initial packet, even if it doesn't yet know
      // the version of the QUIC protocol be used by the client.

      // Then we proceed to negotiate the protocol version

      if (!quic.versionIsSupported(header.version)) {

        const versionDatagram = Buffer.allocUnsafe(quic.MAX_DATAGRAM_SIZE);
        const versionDatagramLength = quic.negotiateVersion(
          header.scid,
          header.dcid,
          versionDatagram
        );

        this.socket.send(
          versionDatagram,
          0,
          versionDatagramLength,
          rinfo.port,
          rinfo.address,
          (e) => {
            // The error can be a DNS error, although not in this case
            if (e != null) {
              console.log('Error version negotation', e);
            }
          }
        );

        console.groupEnd();
        return;
      }

      // At this point the version would be negotiated as version 1
      // It's still an initial packet, but the token is now set as a Uint8Array

      const token: Uint8Array | undefined = header.token;
      if (token == null) {
        // This is a BUG
        console.log('INITIAL packet does not have token');
        console.groupEnd();
        return;
      }

      // If the byte length is 0
      // then we are starting a stateless retry

      if (token.byteLength === 0) {

        // Make the client prove that they own this source address to prevent spoofing
        // We will create a signed token that they must return back to us
        const token = await mintToken(
          this.key,
          Buffer.from(header.dcid),
          rinfo.address
        );
        const retryDatagram = Buffer.allocUnsafe(quic.MAX_DATAGRAM_SIZE);

        console.log('The token', token.byteLength);

        // Should be quic.packet.retry
        // The `connId` here should be a NEW SCID
        // that the client should be using on the next packet

        // This is a stateless retry process
        // The retry packet is sent back to the client
        // The next packet should be an initial packet
        // That as the token AND the new SCID

        console.log('RETRY with SCID', header.scid);
        console.log('RETRY with DCID', header.dcid);

        console.log('NEW SCID to be used', connId.toString('base64url'));
        console.log('NEW SCID to be used', new Uint8Array(connId));

        const retryDatagramLength = quic.retry(
          header.scid, // Client initial packet source ID
          header.dcid, // Client initial packet destination ID
          connId, // Server's new source ID that is derived
          Buffer.from(token),
          header.version,
          retryDatagram
        );

        // I would argue...
        // that IF we fail to send the datagram
        // THEN we just failed the connection here
        // but that doesn't mean the socket has failed here

        this.socket.send(
          retryDatagram,
          0,
          retryDatagramLength,
          rinfo.port,
          rinfo.address,
          (e) => {
            // The error can be a DNS error, although not in this case
            if (e != null) {
              console.log('Error stateless retry', e);
            }
          }
        );

        console.groupEnd();
        return;
      }

      // Stateless retry happened
      // And we receive the same token back
      // that must mean it's the same
      // Plus we actually verify it
      // Cause it is stateless, we have to just check that we in fact signed that token
      // The token is 177 bytes for us here!!!

      // This is the DCID that is acquired from inside the token
      // Which was the ORIGINAL DCID that was first sent (the ID that the remote side allocated to us the server)
      // So we don't take into the account the current DCID
      // This is why we have odcid prefix
      const odcid = await validateToken(
        this.key,
        rinfo.address,
        Buffer.from(token)
      );

      // This is in fact the ORIGINAL DCID
      // before we sent the retry packet over
      console.log('ORIGINAL DCID', odcid);

      if (odcid == null) {
        console.log('INVALID TOKEN');
        console.groupEnd();
        return;
      }

      // Our derived conn ID, should not be required
      if (connId.byteLength !== dcid.byteLength) {
        console.log('INVALID SCID/DCID LENGTH');
        return;
      }


      // Why is this not correct?
      console.log('Received DCID', Buffer.from(header.dcid).toString('base64url'));
      console.log('Received SCID', Buffer.from(header.scid).toString('base64url'));


      // Now we set the SCID to be the current packet's DCID
      // At this point the SCID hasn't even changed in any of the packets
      // So I'm not entirely sure I understand how the `connId` works at all
      // Anyway the server determines the SCID and the client is meant to use the new SCID on subsequent packets
      // Server can tell the client by
      // 1. Sending a packet with the new `scid`
      // 2. Send a retry packet which includes the new scid value and a generated token (what we did above)
      // 3. The server can send a stateless reset packet to the client... and includes new scid and generated token

      // It seems the NEW SCID is only used for the next packet
      // and it appears in the header.dcid, and not the header.scid
      // The header.scid is still the original scid from the first initial packet
      // But new scid that we used in `quic.retry` is in the header.dcid
      // And here we retrieve and use it as the `scid`
      const scid = Buffer.from(header.dcid);

      // At this point
      // we have the ORIGINAL DCID
      // AND we have a "scid" that is actually the originally derived DCID

      // These are the 2 IDs we will be using from now on!

      conn = quic.Connection.accept(
        scid, // This is actually the originally derived DCID
        odcid, // This is the original DCID...
        {
          addr: this.socket.address().address,
          port: this.socket.address().port
        },
        {
          addr: rinfo.address,
          port: rinfo.port
        },
        this.config
      );

      console.log('WE GOT A CONNECTION!', conn);

      // SO we should not require partial responses
      // We will manage backpressure on both ends
      // using streams, that should be fine

      // We are setting the CONNECTION object here

      this.clients.set(
        scid.toString('binary'),
        conn
      );

      // Note that this `conn` is kind of useless...
      // It's not a stream duplex or anything
      // It's a QUIC connection specifically
      this.dispatchEvent(
        new QUICConnectionEvent({
          detail: conn
        })
      );

    } else {
      // One of these 2 will be acquired!
      // But this is an existing connection
      conn = this.clients.get(dcid.toString('binary')) ||
             this.clients.get(connId.toString('binary'));
    }

    // So we now have a CONNECTION
    // and we should EMIT this as an "event"
    // and handle the connection "separately"
    // I reckon that would be more useful...
    // But this is technically an internal event I guess
    // Wait a minute
    // no that's not true
    // This is NOT a new connection
    // this could be an existing connection
    // So I guess it doesn't really make sense to emit an event here
    // We either have the new connection or we have an existing connection
    // Now we need to do something with it

    // At this point it should be the case that it is established
    if (conn.isInEarlyData() || conn.isEstablished()) {

      // Process the streams now
      // This is where we need to also attach the stream concepts


    }



    console.groupEnd();
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

  public constructor({
    key
  }) {
    super();
    this.key = key;

    const config = new quic.Config();
    config.verifyPeer(false);
    config.grease(true);
    config.setMaxIdleTimeout(5000);
    config.setMaxRecvUdpPayloadSize(quic.MAX_DATAGRAM_SIZE);
    config.setMaxSendUdpPayloadSize(quic.MAX_DATAGRAM_SIZE);
    config.setInitialMaxData(10000000);
    config.setInitialMaxStreamDataBidiLocal(1000000);
    config.setInitialMaxStreamDataBidiRemote(1000000);
    config.setInitialMaxStreamsBidi(100);
    config.setInitialMaxStreamsUni(100);
    config.setDisableActiveMigration(true);
    config.setApplicationProtos(
      [
        'hq-interop',
        'hq-29',
        'hq-28',
        'hq-27',
        'http/0.9'
      ]
    );
    this.config = config;

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

  const key = await webcrypto.subtle.generateKey(
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );

  const quicServer = new QUICServer({ key });

  await quicServer.start({
    host: 'localhost',
    port: 55555,
  });
  // await quicServer.stop();

  // After `on_timeout()` is called (which occurs at a timeout event)
  // More packets on the connection may need to be sent (for that specific connection)
  // In such a case, that connection should have the `conn.send()` called

}

async function mintToken(
  key: CryptoKey,
  dcid: Buffer,
  sourceAddress: string
): Promise<Buffer> {
  // Remember these are BYTES
  // The IP must be fully formed
  console.log('RETRY DCID', dcid.toString('base64url'));
  const msg = {
    addr: sourceAddress,
    dcid: dcid.toString('base64url'),
  };
  const msgJSON = JSON.stringify(msg);
  const msgData = Buffer.from(msgJSON);
  const sig = Buffer.from(await webcrypto.subtle.sign('HMAC', key, msgData));
  // The token must be BOTH sig and data
  // Essentially it's a signed message, we will be parsing it subsequently
  const token = {
    msg: msgData.toString('base64url'),
    sig: sig.toString('base64url'),
  };
  return Buffer.from(JSON.stringify(token));
}

async function validateToken(key: CryptoKey, sourceAddress: string, tokenData: Buffer): Promise<Buffer | undefined> {
  const token = JSON.parse(tokenData.toString());
  const msgData = Buffer.from(token.msg, 'base64url');
  const sig = Buffer.from(token.sig, 'base64url');
  // If the token was not issued by us
  const check = await webcrypto.subtle.verify('HMAC', key, sig, msgData);
  if (!check) {
    return;
  }
  const msg = JSON.parse(msgData.toString());
  // If the embedded address doesn't match..
  if (msg.addr !== sourceAddress) {
    return;
  }

  // Isn't this meant to be the same?
  // I signed this message too!
  console.log('RECEIVED DCID IN the TOKEN', msg.dcid);

  // The original destination connection ID is therefore correct
  return Buffer.from(msg.dcid, 'base64url');
}

void main();
