// This will be a QUIC server

import { webcrypto } from 'crypto';
import dgram from 'dgram';
const quic = require('./index.node');

let key: CryptoKey;
let socket: dgram.Socket;
let config;

const clients = new Map<string, any>();

async function main() {

  key = await webcrypto.subtle.generateKey(
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );

  const abortController = new AbortController();

  socket = dgram.createSocket({
    type: 'udp6',
    reuseAddr: false,
    ipv6Only: false,
    recvBufferSize: undefined,
    sendBufferSize: undefined,
    signal: abortController.signal,
  });

  config = new quic.Config();
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

  socket.bind(0, '::');
  socket.on('listening', () => {
    // This ends up being `::` and `IPv6` and random port
    console.log(socket.address());
  });
  socket.on('message', handleMessage);

}



/**
 * Everything that happens in QUIC happens upon a message being received
 * This also includes sending messages out
 */
async function handleMessage(
  data: Buffer,
  rinfo: dgram.RemoteInfo
) {

  let header;
  try {
    header = quic.Header.fromSlice(data, quic.MAX_CONN_ID_LEN);
  } catch (e) {
    console.log('NOT A QUIC DGRAM', e.message);
    return;
  }

  // Destination Connection Id
  const dcid: Buffer = Buffer.from(header.dcid);

  const dcidSignature = Buffer.from(await webcrypto.subtle.sign(
    'HMAC',
    key,
    dcid
  ));

  // Derive a conn ID from the dcid
  const connId = dcidSignature.subarray(0, quic.MAX_CONN_ID_LEN);

  let client;
  if (!clients.has(dcid.toString('binary')) && !clients.has(connId.toString('binary'))) {

    if (header.ty !== quic.Type.Initial) {
      console.log('PACKET is not initial');
      return;
    }

    if (!quic.versionIsSupported(header.version)) {
      // We should be able to put these behind packet
      // quic.packet.negotiateVersion()
      const versionDatagram = Buffer.allocUnsafe(quic.MAX_DATAGRAM_SIZE);
      const versionDatagramLength = quic.negotiateVersion(
        header.scid,
        header.dcid,
        versionDatagram
      );
      socket.send(
        versionDatagram,
        0,
        versionDatagramLength,
        rinfo.port,
        rinfo.address,
        (e) => {
          // The error can be a DNS error, although not in this case
          console.log('Error version negotation', e);
        }
      );
      return;
    }

    // Token always exists in initial packets
    const token: Uint8Array | undefined = header.token;
    if (token == null) {
      console.log('INITIAL packet does not have token');
      return;
    }

    if (token.byteLength === 0) {
      console.log('STATELESS RETRY');

      // Make the client prove that they own this source address to prevent spoofing
      // We will create a signed token that they must return back to us
      const token = await mintToken(key, header.dcid, rinfo.address);
      const retryDatagram = Buffer.allocUnsafe(quic.MAX_DATAGRAM_SIZE);
      // Should be quic.packet.retry
      const retryDatagramLength = quic.retry(
        header.scid, // Client initial packet source ID
        header.dcid, // Client initial packet destination ID
        connId, // Server's new source ID that is derived
        Buffer.from(token),
        header.version,
        retryDatagram
      );
      socket.send(
        retryDatagram,
        0,
        retryDatagramLength,
        rinfo.port,
        rinfo.address,
        (e) => {
          // The error can be a DNS error, although not in this case
          console.log('Error stateless retry', e);
        }
      );
      return;
    }


    // This is the DCID that is acquired from inside the token
    // Which was the ORIGINAL DCID that was first sent (the ID that the remote side allocated to us the server)
    // So we don't take into the account the current DCID
    // This is why we have odcid prefix
    const odcid = await validateToken(key, rinfo.address, Buffer.from(token));

    if (odcid == null) {
      console.log('INVALID TOKEN');
      return;
    }

    // Our derived conn ID, should not be required
    if (connId.byteLength !== dcid.byteLength) {
      console.log('INVALID SCID/DCID LENGTH');
      return;
    }

    // The server side SCID is the packet's DCID
    // We don't actually use the derived conn ID at all here
    const scid = Buffer.from(header.dcid);

    // Great now we have a "connection", this is how we establish a connection
    // Let's see if I can attach event handlers to the connection
    const conn = quic.Connection.accept(
      scid,
      odcid,
      {
        addr: socket.address().address,
        port: socket.address().port
      },
      {
        addr: rinfo.address,
        port: rinfo.port
      },
      config
    );

    // What performs GC for all these client objects being created?

    client = {
      conn,
      partial_responses: new Map()
    };

    clients.set(scid.toString('binary'), client);

    // CREATE CONN
    // HEADER.DCID - this becomes the SCID from the server perspective
    // ODCID (original)
    //

    // In the C case, the scid becomes
    // conn_io->cid which becomes the first parameter of
    // quiche_accept
    /*
      The scid parameter represents the server’s source connection ID,
      while the optional odcid parameter represents the original destination ID
      the client sent before a stateless retry
    */

    // In the RS case
    // The initial packet's DCID
    // is copied to the SCID
    // then it is used as the server's SCID

    // Then the only usage of the derived CONNID
    // Is for the retry packet
    // In fact, in the C example, it uses a randomly generated CONNID
    // It does not even derive anything

    // Ok so the at the end the packet's dcid and the original dcid
    // is what is being used
    // The derived connid or randomly generated connid was only ever used in the retry packet

    // However it also tries looking it up using the derived conn id
    // in case it doesn't find it based on the hdr.dcid

    // The C code only checks dcid... which is what comes out of the packeg
    // So it is pretty strange to even bother looking up by the derived conn ID

  } else {
    client = clients.get(dcid.toString('binary')) ||
             clients.get(connId.toString('binary'));
  }

  const recvInfo = {
    to: {
      addr: socket.address().address,
      port: socket.address().port
    },
    from: {
      addr: rinfo.address,
      port: rinfo.port
    },
  };

  let recvLength
  try {
    recvLength = client.conn.recv(data, recvInfo);
  } catch(e) {
    console.log('Error receiving', e);
    // Ignore this packet if you can't do anything about it
    return;
  }

  // Now we have to check the connection status...
  if (client.conn.isInEarlyData() || client.conn.isEstablished()) {
    // This is when we handle writable streams
    // Process readable streams

  }

  // This part we actually need to RUN even if we get a timeout event
  // We may want to trigger something here...

  // So the idea is that
  // upon a timeout event, we want to run a function

  // At the same time
  // If it is a timeout
  // We only want to call the on_timeout()
  // and not process reading packets
  // Which means we then proceed to the send loop

  // So the sending loop can occur separately
  // Interesting
  // We can trigger things based on internal events
  // BUt right now "send" loop is triggered not on stream writes
  // But bsaed on when there's an event
  // This feels like something we could potentially separate

  // UDP socket in -> stream read handling

  // Stream writes -> stream write handling
  // but we don't have a concept of a stream write yet
  // And we have to create multiple streams
  // Each one may trigger it
  // We need to being in the streams too

}

async function mintToken(
  key: CryptoKey,
  dcid: Buffer,
  sourceAddress: string
): Promise<Buffer> {
  // Remember these are BYTES
  // The IP must be fully formed
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
  // The original destination connection ID is therefore correct
  return Buffer.from(msg.dcid, 'base64url');
}

void main();
