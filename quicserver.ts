import dgram from 'dgram';
import { ReadableStream, WritableStream, } from 'stream/web';
import { webcrypto } from 'crypto';
import { bigIntToHexadecimalString, IPv4, IPv6, Validator } from 'ip-num';
import { promisify, promise } from './src/utils';
const quic = require('./index.node');

type StreamId = number;
type ConnectionId = string;
type Connection = any;

function reasonToCode(reason?: any) {
  // The reason to code map must be supplied
  // If it is not a valid reason, we return an unknown reason
  // that is 0
  return 0;
}

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

class QUICDataEvent extends Event {
  public detail;
  constructor(
    options: EventInit & {
      detail: any
    }
  ) {
    super('data', options);
    this.detail = options.detail;
  }
}

class QUICErrorEvent extends Event {
  public detail;
  constructor(
    options: EventInit & {
      detail: any
    }
  ) {
    super('error', options);
    this.detail = options.detail;
  }
}


class QUICStream extends EventTarget implements ReadableWritablePair<Uint8Array, Uint8Array> {

  public streamId: number;
  public readable: ReadableStream<Uint8Array>;
  public writable: WritableStream<Uint8Array>;
  protected conn;
  protected _recvPaused: boolean = false;

  public get recvPaused(): boolean {
    return this._recvPaused;
  }

  public constructor(
    conn,
    streamId: StreamId,
  ) {
    super();
    this.conn = conn;
    this.streamId = streamId;

    // Try the BYOB later, it seems more performant
    let handleReadable : () => void;
    this.readable = new ReadableStream({
      type: 'bytes',
      // autoAllocateChunkSize: 1024,
      start(controller) {
        handleReadable = () => {
          if (this._recvPaused) {
            // Do nothing if we are paused
            return;
          }
          const buf = Buffer.alloc(1024);
          let recvLength, fin;
          try {
            [recvLength, fin] = this.conn.streamRecv(
              this.streamId,
              buf
            );
          } catch (e) {
            if (e.message === 'Done') {
              // Do nothing if there was nothing to read
              return;
            } else {
              // If there is an error, we do not do anything else
              controller.error(e);
              return;
            }
          }
          // It's possible to get a 0-length buffer
          controller.enqueue(buf.subarray(0, recvLength));
          // If fin is true, then that means, the stream is CLOSED
          if (fin) {
            controller.close();
            // If finished, we won't bother doing anything else, we finished
            return;
          }
          // Now we paus receiving if the queue is full
          if (controller.desiredSize != null && controller.desiredSize <= 0) {
            this._recvPaused = true;
            // this.pauseRecv();
          }
        };
        this.addEventListener('readable', handleReadable);
      },
      pull() {
        // this.resumeRecv();
        // Unpausese
        this._recvPaused = false;
        // This causes the readable to run again
        // Because the stream was previously readable
        // The pull
        this.dispatchEvent(new Event('readable'));
      },
      cancel(reason) {
        this.removeEventListener('readable', handleReadable);
        this.conn.streamShutdown(
          this.streamId,
          quic.Shutdown.Read,
          reasonToCode(reason)
        );
      }
    });

    this.writable = new WritableStream({
      start(controller) {
        // Here we start the stream
        // Called when the objectis constructed
        // It should aim to get access to the underlying SINK
        // So what does it really mean here?
        // We have nothing to do here for now
        // Since the server already received a "stream ID"
        // So it already exists, and so it's already ready to be used!!!
      },
      async write(chunk: Uint8Array) {
        await this.streamSendFully(chunk);
      },
      async close() {
        // Send an empty buffer and also `true` to indicate that it is finished!
        await this.streamSendFully(Buffer.from([]), true);
      },
      abort(reason?: any) {
        // Abort can be called even if there are writes are queued up
        // The chunks are meant to be thrown away
        // We could tell it to shutdown
        // This sends a `RESET_STREAM` frame, this abruptly terminates the sending part of a stream
        // The receiver can discard any data it already received on that stream
        // We don't have "unidirectional" streams so that's not important...
        this.conn.streamShutdown(
          this.streamId,
          quic.Shutdown.Write,
          reasonToCode(reason)
        );
      }
    });

  }

  async streamSendFully(chunk, fin = false) {
    // This means that the number of written bytes returned can be lower
    // than the length of the input buffer when the stream doesn???t have
    // enough capacity for the operation to complete. The application
    // should retry the operation once the stream is reported as writable again.
    let sentLength;
    try {
      sentLength = this.conn.streamSend(
        this.streamId,
        chunk,
        fin
      );
    } catch (e) {
      // If the Done is returned
      // then no data was sent
      // because the stream has no capacity
      // That is equivalent here to being sent lenght of 0
      if (e.message === 'Done') {
        sentLength = 0;
      } else {
        throw e;
      }
    }
    if (sentLength < chunk.length) {
      // Could also use a LOCK... but this is sort of the same thing
      // We have to wait for the next event!
      await new Promise((resolve) => {
        this.addEventListener(
          'writable',
          resolve,
          { once: true }
        );
      });
      return await this.streamSendFully(
        chunk.subarray(sentLength)
      );
    }
  }
}

// The only reason to encapsulate is to make it easier
// for JS modelling here
// Otherwise in rust we will have a ES6 map of the streams
// And I can refer to the connection here
// We have to have events that make this thing writable/readable
// Note that ON every packet... there could be writable/readable events
class QUICClient extends EventTarget {

  /**
   * Underlying QUIC connection
   */
  public connection: Connection;
  protected streams: Map<StreamId, QUICStream> = new Map();

  // We may need to iterate over all the other connections too
  // not just the connection that we care about too
  public constructor(
    connectionId: ConnectionId,
    connection,
    server
  ) {
    super();
    this.connection = connection;

    // A data event means there's some data
    // And it is in fact a socket event
    // And this may have been constructed

    this.addEventListener(
      'data',
      (e) => {

        // Here we are "processing" the data
        let recvLength;
        try {
          // @ts-ignore
          recvLength = this.connection.recv(e.detail.data, e.detail.recvInfo);
        } catch (e) {
          console.log('Error processing packet data', e);
          return;
        }

        console.log('CONNECTION processed this many bytes:', recvLength);

        // Every time the connection is ready, we are going to create streams
        // and process it accordingly
        if (this.connection.isInEarlyData() && this.connection.isEstablished()) {
          for (const streamId of this.connection.writable()) {
            let quicStream = this.streams.get(streamId);
            if (quicStream == null) {
              quicStream = new QUICStream(this.connection, streamId);
            }
            // This triggers a writable event
            // If nothing is listening on this
            // The event is discarded
            // But when the stream is first created
            // It will be ready to be written to
            // But if it is blocked it will wait
            // for the next writable event
            // This event won't be it...
            // So it's only useful for existing streams
            quicStream.dispatchEvent(new Event('writable'));
          }
          // What streams can be read from?
          for (const streamId of this.connection.readable()) {
            let quicStream = this.streams.get(streamId);
            if (quicStream == null) {
              quicStream = new QUICStream(this.connection, streamId);
            }
            // We must emit a readable event, otherwise the quic stream
            // will not actually read anything
            quicStream.dispatchEvent(new Event('readable'));
          }
        }

        // Now we go into our sending loop?
        // The reason is because EVEN if streams have nothing to do
        // The connection may still have some data to be sent back on
        // We don't know, only quiche knows
        // We have to interrogate quiche for this
        // The regular system actually ITERATES
        // over ALL connections, not just the connection that sent us data
        // I think this may be primarily due to timeout events
        // But I cannot be sure
        // But why do we do this?

        // Ok so the reason is that QUIC may send periodic keep-alive packets to all clients
        // But would this be due to the timeout event in any way?

        // Ok so we need iterate over ALL connections when we do this
        // This makes a bit difficult actually to do this

      }
    );


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
      stream = new QUICStream(this.connection, streamId);
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

  protected clients: Map<ConnectionId, QUICClient> = new Map();

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

    // Funny
    // If we do this
    // we need to ensure that we can run this separately?
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
    let connection;
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

        // This is actually non-blocking already
        // the other ones try to break out of the loop and retry
        // But this is not necessary
        // We always end up sending data!
        this.socket.send(
          versionDatagram,
          0,
          versionDatagramLength,
          rinfo.port,
          rinfo.address,
          (e) => {
            // The error can be a DNS error, although not in this case
            if (e != null) {
              this.dispatchEvent(new QUICErrorEvent({ detail: e}));
            }
          }
        );

        console.groupEnd();

        // I'm confused how to translate teh `continue 'read`
        // to a return here
        // Or a break to occur if the socket would block
        // But it seems that if the socket would block
        // We still attempt to see if we need to send out data
        // So it's almost like
        // We do this on every event

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

      const connectionId = scid.toString('binary');

      connection = new QUICClient(
        connectionId,
        conn,
        this
      );

      this.clients.set(
        scid.toString('binary'),
        connection
      );

      // The only issue is how do we do this
      // If we our QUICConnection also needs reference
      // We can pass it reference back to the server
      // So it can iterate over all connections to do this
      // So the child object has reference to the parent object here


      actualId = scid;

      // Note that this `conn` is kind of useless...
      // It's not a stream duplex or anything
      // It's a QUIC connection specifically
      // this.dispatchEvent(
      //   new QUICConnectionEvent({
      //     detail: conn
      //   })
      // );

    } else {
      // One of these 2 will be acquired!
      // But this is an existing connection
      console.log('EXISTING CONNECTION');

      connection = this.clients.get(dcid.toString('binary'));
      actualId = dcid;
      if (connection == null) {
        connection = this.clients.get(connId.toString('binary'));
        actualId = connId;
      }
    }

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

    this.dispatchEvent(
      new QUICDataEvent({
        detail: {
          data,
          recvInfo
        }
      })
    );


    // // Here we are asking the CONNECTION to actually process the message
    // // Because the above is just pre-processing
    // // We have accepted the connection
    // // But we must be processing the actual message at this point
    // let recvLength
    // try {
    //   recvLength = conn.recv(data, recvInfo);
    // } catch(e) {
    //   // And here we get a TlsFail error
    //   console.log('Error processing packet data', e);
    //   // Ignore this packet if you can't do anything about it
    //   console.groupEnd();
    //   return;
    // }

    // // 1200 bytes is processed here (the full message)
    // console.log('CONNECTION processed this many bytes:', recvLength);

    // Ok we managed to "process" the connection
    // But we are actually still neither of the 2 below
    // This is because we need to ANSWER something...

    // At this point it should be the case that it is established
    // if (conn.isInEarlyData() || conn.isEstablished()) {

    //   // Process the streams now
    //   // This is where we need to also attach the stream concepts

    //   // So here in this connection
    //   // we now can ASK which of these streams are writable
    //   // and which of these streams are readable
    //   // these are ALL events that has to be dispatched

    //   // The streams wants to be read!?!?!?!?
    //   for (const streamId of conn.writable()) {
    //     // depending on which stream id we that is writable
    //     // we have to emit to that
    //     // at the same time
    //     // it doesn't seem like there's a "creation" of streams
    //     // any time there is a new stream id
    //     // that means a new stream

    //     console.log('WRITABLE stream', streamId);
    //   }

    //   for (const streamId of conn.readable()) {
    //     console.log('READABLE stream', streamId);
    //   }

    // } else {

    //   console.log('NOT In early data or is established!');

    // }

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
    // console.group('SENDING loop');
    // while (true) {
    //   // Remember that this is supposed to loop
    //   // UNTIL we are done


    //   const dataSend = Buffer.allocUnsafe(quic.MAX_DATAGRAM_SIZE);
    //   let dataSendLength;
    //   let sendInfo;
    //   try {
    //     [dataSendLength, sendInfo] = conn.send(dataSend);
    //   } catch (e) {
    //     // If there's a failure to do this
    //     // We actually CLOSE the connection ...
    //     conn.close(
    //       false,
    //       0x01,
    //       Buffer.from('Failed to send data')
    //     );
    //     this.connections.delete(actualId);
    //     break;
    //   }

    //   console.log('SENDING', dataSendLength, sendInfo);

    //   if (dataSendLength === 0) {
    //     // If there's nothing to send, we got nothing to do anymore
    //     console.log('NOTHING TO SEND');
    //     break;
    //     // However we may be closing connections
    //     // But that's not what we are doing right?
    //   }

    //   // This is not properly awaited for
    //   // But if there was a problem
    //   // You'd break out of the loop as well
    //   this.socket.send(
    //     dataSend,
    //     0,
    //     dataSendLength,
    //     sendInfo.to.port,
    //     sendInfo.to.addr,
    //     (e) => {
    //       // The error can be a DNS error, although not in this case
    //       if (e != null) {
    //         console.log('Error send socket', e);
    //       }
    //       console.log('Sent out data!');
    //     }
    //   );
    // }
    // console.groupEnd();

    // So we still need these to be asynchronously awaited

    console.log('### FINISH HANDLING MESSAGE ###');
    console.groupEnd();
  };

  // Loop through all connections and send some data back!
  // This needs to be used every time there's data
  // Even if other things are broken
  // Even if no streams are used
  // It must always run
  // Even if it is a timeout
  protected async sendQUICData() {

    // Ok so it turns out...
    // EVEN if no data was read from the UDP socket
    // That is, if there was a `WouldBlock`  from reading rom the UDP socket
    // Then we still trigger this function
    // Meaning you still try to see if there is data to be sent out
    // That's because even in a timeout, we would want to perform this action

    // We could technically do this all in parallel
    // We don't need to loop through anything
    // The system will figure out how to do this
    // The while loop is that we loop until the socket says it will block
    // But actually in our case, we don't really have this concept
    // Our socket is ALWAYS non-blocking, just by virtue of the callback system
    // Even if we turn it into a promise it still is
    // So the idea of LOOPING is kind of strange
    // It sort of is the case that we are doing this no matter what?
    // Breaking only occurs either when `conn.send` is Done
    // Or when there's an error, and we close the connection
    // And when the send() would block on the socket
    // Would block simply means that this would actually be blocking?
    // We make something non-blocking. It is possible for the send operation to be sent later
    // Strangely enough.. that doesn't actually mean it is sent
    // When sending the version negotiation
    // We CONTINUE on read (meaning we skip and wait for the next message)
    // When sending the stateless retry
    // WE CONTINUE on read (meaning we skip and wait for the next message)

    // We may be able to use this
    // socket.getSendBufferSize()
    // socket.getSendQueueSize()
    // socket.getSendQueueCount()

    const ps: Array<Promise<void>> = [];
    const clients = this.clients.values();
    for (const client of clients) {
      ps.push(
        (async () => {
          while (true) {
            const dataSend = Buffer.allocUnsafe(quic.MAX_DATAGRAM_SIZE);
            let dataSendLength;
            let sendInfo;
            try {
              [dataSendLength, sendInfo] = client.connection.send(
                dataSend
              );
            } catch (e) {
              if (e.message === 'Done') {
                break;
              }
              this.dispatchEvent(new QUICErrorEvent({ detail: e}));
              try {
                client.connection.close(
                  false,
                  0x01,
                  Buffer.from('Failed to send data')
                );
              } catch (e) {
                if (e.message === 'Done') {
                  break;
                }
                this.dispatchEvent(new QUICErrorEvent({ detail: e}));
              }
              break;
            }
            // @ts-ignore
            const socketSend = promisify(this.socket.send).bind(this.socket);
            try {
              await socketSend(
                dataSend,
                0,
                dataSendLength,
                sendInfo.to.port,
                sendInfo.to.addr,
              );
            } catch (e) {
              // If there is in fact an error
              // In the QUIC program, it results in a hard failure like panic
              // But again we just emit another error
              this.dispatchEvent(new QUICErrorEvent({ detail: e}));
              break;
            }
          }
        })()
      );
    }
    await Promise.all(ps);
  }



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

    // There needs to be a default error handler
    // otherwise errors will not be emitted
    // Remember our async handlers should not reject
    // We only use it due to some functions easier to use
    this.addEventListener('error', (e) => {
      // @ts-ignore
      console.log('GOT an error', e.detail);
    });

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
