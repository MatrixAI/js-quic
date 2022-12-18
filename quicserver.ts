import dgram from 'dgram';
import { ReadableStream, WritableStream, } from 'stream/web';
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

class QUICStream implements ReadableWritablePair<Uint8Array, Uint8Array> {

  public streamId: number;
  public readable: ReadableStream<Uint8Array>;
  public writable: WritableStream<Uint8Array>;

  // Ok so we know when there is data on the stream
  // and that means we need to ensure that it is readable here
  // and we need to enqueue the data
  // to do so... to construct this quic stream
  // we need to passi n the events that are going to be emitted here

  public constructor(
    streamId,
    conn
  ) {
    this.streamId = streamId;
    this.readable = new ReadableStream({
      type: 'bytes',
      start(controller) {

      },
      pull() {

      },
      cancel() {

      }
    });

    // The writable stream is a stream the user will write TO
    // When we iterate over `conn.writable()`
    // we are getting information about WHICH connections are open to writing
    // A writable stream is a stream that has enough flow control capacity
    // to send data to the peer
    // To avoid buffering an infinite amount of the data
    // The buffer is fixed.. it can buffer the amount that the peer allows to send
    // Perhaps in the configuration?
    // Then at a specific POINT in time, then we will know which stream is writable
    // So it's done at 1 point in time
    // It's also done possibly on EVERY single event...
    // The event COULD be receiving a UDP message
    // or it could a timeout event

    // That sort of means... if we don't receive a packet or timeout event
    // then the the whole thing might be blocked
    // since only 1 transfer is allowed by default in the writable stream here

    // Also during the `handle_writable` it's checking that IF there is no partial responses
    // Like almost a buffer, it doesn't bother to write anything

    // When doing `conn.streamSend`
    // If it is DONE it could mean that NO data is written
    // In that case, I use a 0-length number of bytes written
    // That actually can mean the stream has no capacity
    // So it is possible that less data is written into the QUIC stream

    // At that point... we actually need to block our own writable stream from progressing

    // One issue, when we write something to his JS stream, we are writing an atomic object
    // if that atomic object is "partially" written, which is possible
    // Then we have a problem, cause while we might block... we should not be retrying things

    // This means that the number of written bytes returned can be lower
    // than the length of the input buffer when the stream doesn’t have
    // enough capacity for the operation to complete. The application
    // should retry the operation once the stream is reported as writable again.

    // The writable stream can have a `highWaterMark`
    // this can be use for counts, or number of bytes
    // it doesn't really work well here...
    // since we actually don't know how much is still available
    // and a partial amount might be consumed
    // and that partial amount need to be considered...

    // Another way is that with the web streams
    // the third way of backpressure is that `write()` method can return a promise
    // If that promise is not yet resolved, then the writable stream can be blocked
    // Therefore if we are writing to the QUIC stream, and less than the full data is written
    // Then we hold... until we can write the full amount, which means the promise is not resolved yet
    // But how to do this?

    // If you have the web stream
    // You can also do `writableStream.getWriter().ready.then(() => {})`
    // But that's for the WRITER

    // We have 3 pieces of backpressure

    // Writer -> WritableStream -> QUIC stream

    // The RPC stream handler needs to make use of the Writer
    // We care about WritableStream -> QUIC stream
    // So the problem is that `write()` must return a promise that only resolves
    // WHEN all the data is written!!

    // It seems then we should really be using `ByteLengthQueuingStrategy`
    // Cause if we use count queuing strategy... then we would...

    // Actually it sort of makes sense
    // If you were to write 1 MiB chunk immediately
    // The expectation is that you will wait until this is written to

    // Ok we can do this, by holding the `write()` promise
    // HOWEVER

    // Another issue is that handle_stream in the RS example
    // Only calls `conn.steam_send` once
    // It is not looping it
    // probably cause why it would bother
    // The conn still needs to flush before streams would be writable again

    // The conn flushing occurs right afterwards
    // When it is infact looped to send data onto the UDP socket from `conn.send`
    // But at this point in time, we are still not performing "stream_send" again

    // We go back to waiting for another event... either another UDP message
    // or a timeout event

    // I'm still thinking that if... we were to send out data on the UDP socket
    // we could go BACK and end up finishing the write to the `stream_send`
    // And at the same time end up triggering more data to be sent out on the UDP socket
    // Like why does it have to wait for the other side to come back?
    // I reckon as soon as I have data in the stream... then more data should be sent out

    // I think this was a limitation of the IO system in the rust examples

    // Amazing... so the reason that it doesn't just immediately retry writing to the stream is:

    // It's worth noting that flushing the data on the QUIC connection to the
    // UDP socket may not necessarily make the stream writable again, as the
    // send buffer on the remote end may still be full. In this case, the
    // application will need to continue waiting for the stream to become
    // writable.

    // So even if we flush all the data out of the QUIC connection
    // the stream may still be full
    // cause the remote end hasn't actually fully processed that data
    // I see.. that's why we have to wait for the next event (UDP message or timeout) and
    // then check

    this.writable = new WritableStream({
      start(controller) {

      },
      async write(chunk: Uint8Array, controller) {

        // when we write to somethign
        // we need to trigger the handle writable?
        // but this means we are trying to write to something right?
        // so if the previous write has not occurred, this would not happe
        // wait in what sense is this the `fin` packet?
        // it's not

        // We are not just sending
        // More data may be sent later

        // This will result in an infinite loop the problem is
        // We actually need to keep around the data until the next event
        // So there is this thing of "partial" responses...?
        // Because we have to wait for the next event

        // setTimeout(() => ... )
        // or something?
        // like what are we doing here?
        // you sort of have to...
        // put your handler up for the next event


        let sentLength = 0;
        while (sentLength < chunk.length) {
          const sentLength_ = this.conn.streamSend(
            this.streamId,
            chunk.subarray(sentLength),
            false
          );
          sentLength += sentLength_;
        }

        // This could throw an error...
        // but `0` also means it is DONE
        // It means the length is 0...
        // const sentLength = this.conn.streamSend(
        //   this.streamId,
        //   chunk,
        //   false
        // );

        // This means we are cannot finish
        // And we need to wait until it is finished
        // There's a problem though
        // How do we wait for a promise for this to be the case?
        // Plus we have to actually sort of not return this promise until that is the case
        // Or we have an event that is emitted until that is the case!??
        // if (sentLength < chunk.length) {
        // }



        console.log(chunk);
      },
      close() {

      },
      abort(reason) {

      }
    });

  }
}

type StreamId = number;

// The only reason to encapsulate is to make it easier
// for JS modelling here
// Otherwise in rust we will have a ES6 map of the streams
// And I can refer to the connection here
// We have to have events that make this thing writable/readable
// Note that ON every packet... there could be writable/readable events
class QUICConnection {

  // Internal quic native connection object
  protected connection;

  // A single connection can have multiple streams
  // Wait so we are modelling this separately
  // Or encapsulating it?
  // Cause we already have quic connections
  protected streams: Map<StreamId, QUICStream> = new Map();

  public constructor (connection) {
    this.connection = connection;
  }

  protected handleStream(streamId: StreamId) {
    // so what are we doing here?
    // if we get a new stream id
    // we are saying that this tream is both readable/writable
    // so it could be the same

    let stream = this.streams.get(streamId);
    if (stream == null) {
      // Then we have a new stream
      // That's the idea
      stream = new QUICStream(streamId);
    }

    // Now we have the stream

  }

  // Should we be checking which streams here
  // and then emitting it somehow?

  protected doSomething () {

    // Output data (this means) there's
    for (const streamId of this.connection.writable()) {
      // A writable stream JUST means the stream is ready to be written to
      // It doesn't mean there's any DATA to be written to it
      // The original RS code checks the "partial" responses
      // Therefore this is actually meant to be used for the flow-control... on write streams
    }

    // Input data
    for (const streamId of this.connection.readable()) {

    }

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

  // This is really managing connections
  protected connections: Map<string, any> = new Map();

  // Note that this has to be "indexed" by the connection
  // Any given connection is going to have a set of streams
  // Maybe we should model this with a class..


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
    // console.log('HEADER TYPE:', header.ty);
    // console.log('HEADER VERSION:', header.version);
    // console.log('HEADER DCID', header.dcid);
    // console.log('HEADER SCID', header.scid);
    // console.log('HEADER TOKEN', header.token);
    // console.log('HEADER VERSION', header.version);
    // console.log('HEADER VERSIONS', header.versions);

    const dcid: Buffer = Buffer.from(header.dcid);

    const dcidSignature = Buffer.from(await webcrypto.subtle.sign(
      'HMAC',
      this.key,
      dcid
    ));

    console.log('Deriving CONNID');

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

    let actualId;
    let conn;
    if (
      !this.connections.has(dcid.toString('binary')) &&
      !this.connections.has(connId.toString('binary'))
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
        console.groupEnd();
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

      this.connections.set(
        scid.toString('binary'),
        conn
      );

      actualId = scid;

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
      console.log('EXISTING CONNECTION');

      conn = this.connections.get(dcid.toString('binary'));
      actualId = dcid;
      if (conn == null) {
        conn = this.connections.get(connId.toString('binary'));
        actualId = connId;
      }
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

    console.log('Connection Trace ID', conn.traceId());

    // At this point the connection is not established
    // and it is not in early data

    // In early data means TLS handshake completed
    // and can send and receive application data

    // It is not established until the 0-RTT handshake is done
    // The 0-RTT just means that the client can send data to the server
    // without waiting for the server to confirm receipt
    // To do this both client and serer must support it
    // And the client must use a previously established connection

    const recvInfo = {
      to: {
        addr: this.socket.address().address,
        port: this.socket.address().port
      },
      from: {
        addr: rinfo.address,
        port: rinfo.port
      },
    };

    console.log('RECV INFO', recvInfo);

    // Here we are asking the CONNECTION to actually process the message
    // Because the above is just pre-processing
    // We have accepted the connection
    // But we must be processing the actual message at this point
    let recvLength
    try {
      recvLength = conn.recv(data, recvInfo);
    } catch(e) {
      // And here we get a TlsFail error
      console.log('Error processing packet data', e);
      // Ignore this packet if you can't do anything about it
      console.groupEnd();
      return;
    }

    // 1200 bytes is processed here (the full message)
    console.log('CONNECTION processed this many bytes:', recvLength);

    // Ok we managed to "process" the connection
    // But we are actually still neither of the 2 below
    // This is because we need to ANSWER something...

    // At this point it should be the case that it is established
    if (conn.isInEarlyData() || conn.isEstablished()) {

      // Process the streams now
      // This is where we need to also attach the stream concepts

      // So here in this connection
      // we now can ASK which of these streams are writable
      // and which of these streams are readable
      // these are ALL events that has to be dispatched

      // The streams wants to be read!?!?!?!?
      for (const streamId of conn.writable()) {
        // depending on which stream id we that is writable
        // we have to emit to that
        // at the same time
        // it doesn't seem like there's a "creation" of streams
        // any time there is a new stream id
        // that means a new stream

        console.log('WRITABLE stream', streamId);
      }

      for (const streamId of conn.readable()) {
        console.log('READABLE stream', streamId);
      }

    } else {

      console.log('NOT In early data or is established!');

    }

    // We have to COMPLETE the TLS handshake here
    // by responding BACK to the client here

    // Perhaps what we actually need to do is to "send" back data?
    // This has to be DONE for every connection
    // This is being triggered here
    // But other triggers could also trigger connection sends

    // This is some how processing FOR everything
    // but here we are handling 1 message from a given thing
    // We are only operating over our own connection here

    // This actually GOES in a loop
    // cause there may be more than 1 piece of data to send
    console.group('SENDING loop');
    while (true) {
      // Remember that this is supposed to loop
      // UNTIL we are done


      const dataSend = Buffer.allocUnsafe(quic.MAX_DATAGRAM_SIZE);
      let dataSendLength;
      let sendInfo;
      try {
        [dataSendLength, sendInfo] = conn.send(dataSend);
      } catch (e) {
        // If there's a failure to do this
        // We actually CLOSE the connection ...
        conn.close(
          false,
          0x01,
          Buffer.from('Failed to send data')
        );
        this.connections.delete(actualId);
        break;
      }

      console.log('SENDING', dataSendLength, sendInfo);

      if (dataSendLength === 0) {
        // If there's nothing to send, we got nothing to do anymore
        console.log('NOTHING TO SEND');
        break;
        // However we may be closing connections
        // But that's not what we are doing right?
      }

      // This is not properly awaited for
      // But if there was a problem
      // You'd break out of the loop as well
      this.socket.send(
        dataSend,
        0,
        dataSendLength,
        sendInfo.to.port,
        sendInfo.to.addr,
        (e) => {
          // The error can be a DNS error, although not in this case
          if (e != null) {
            console.log('Error send socket', e);
          }
          console.log('Sent out data!');
        }
      );
    }
    console.groupEnd();

    // So we still need these to be asynchronously awaited

    console.log('### FINISH HANDLING MESSAGE ###');
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

    // This is necessary even though we are not verifying the peer
    // It is mandatory to provide the cert and key
    // Otherwise when we do conn.recv() we would get a cryptic TlsFail error!
    config.loadCertChainFromPemFile(
      './tmp/localhost.crt'
    );
    config.loadPrivKeyFromPemFile(
      './tmp/localhost.key'
    );

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

    // Note that we have not enabled dgrams yet!
    // that will be important

    // This will ensure that... we can do what exactly?
    // It allows the client to immediately send data
    // before it receives RECEIPT of it
    config.enableEarlyData();

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
