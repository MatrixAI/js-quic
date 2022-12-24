export { default as QUICServer } from './QUICServer';
export { default as QUICStream } from './QUICStream';
export { default as QUICConnection } from './QUICConnection';
export * as utils from './utils';
export * as errors from './errors';
export * as native from './native';
export * from './types';

// import { webcrypto } from 'crypto';
// import dgram from 'dgram';
// const native = require('../index.node');

// // This will need to use the binary string as the key
// // These are ConnectionId as keys
// // Each of these CONTAIN a "CLIENT"
// // A client is a structure containing an existing quiche connection
// // AND also a map of partial responses...
// const clients = new Map<string, any>();

// async function main () {

//   // HMAC key for signing and verification
//   const key = await webcrypto.subtle.generateKey(
//     {
//       name: 'HMAC',
//       hash: 'SHA-256',
//     },
//     true,
//     ['sign', 'verify'],
//   );


//   // Calling abortController.abort() is the same as socket.close()
//   const abortController = new AbortController();

//   // Binding to `::` will listen on 0.0.0.0 and all ipv6 interfaces

//   const socket = dgram.createSocket({
//     type: 'udp6',
//     reuseAddr: false,
//     ipv6Only: false,
//     recvBufferSize: undefined,
//     sendBufferSize: undefined,
//     signal: abortController.signal,
//   });

//   const config = new native.Config();
//   config.verifyPeer(false);
//   config.grease(true);
//   config.setMaxIdleTimeout(5000);
//   config.setMaxRecvUdpPayloadSize(native.MAX_DATAGRAM_SIZE);
//   config.setMaxSendUdpPayloadSize(native.MAX_DATAGRAM_SIZE);
//   config.setInitialMaxData(10000000);
//   config.setInitialMaxStreamDataBidiLocal(1000000);
//   config.setInitialMaxStreamDataBidiRemote(1000000);
//   config.setApplicationProtos(
//     [
//       'hq-interop',
//       'hq-29',
//       'hq-28',
//       'hq-27',
//       'http/0.9'
//     ]
//   );

//   // These set the allowed/supported ALPN
//   // The ALPN is a field that is sent on the initial TLS handshake Client Hello message
//   // It lists the protocols that are supported

//   /*

//   It looks like:

//     Extension: application_layer_protocol_negotiation (len=14)
//         Type: application_layer_protocol_negotiation (16)
//         Length: 14
//         ALPN Extension Length: 12
//         ALPN Protocol
//             ALPN string length: 2
//             ALPN Next Protocol: h2
//             ALPN string length: 8
//             ALPN Next Protocol: http/1.1

//     It seems to say the h2, then the next one is http/1.1.
//     So I guess these are all "registered" alpn protocol strings

//     The server answers with a Server Hello message. With these ALPN fields:

//     Extension: application_layer_protocol_negotiation (len=5)
//         Type: application_layer_protocol_negotiation (16)
//         Length: 5
//         ALPN Extension Length: 3
//         ALPN Protocol
//             ALPN string length: 2
//             ALPN Next Protocol: h2

//     Here it is answering with h2.

//   */

//   // So what are these h3-?
//   // They are the draft versions
//   // I think since it's no longer a draft, then it should work fine as just h3.
//   // But this is also assuming we want to use HTTP3
//   // If we just want raw QUIC packets, then what does this mean?
//   // hq means HTTP + QUIC, it's not the same as HTTP3
//   // So it's possible none of this matters if we aren't trying to be HTTP3 compatible
//   // config.setApplicationProtos(
//   //   [
//   //     'h3',
//   //     'h3-29',
//   //     'h3-28',
//   //     'h3-27',
//   //   ]
//   // );

//   // This is the concurrent limit for how many streams can be opened locally
//   config.setInitialMaxStreamsBidi(100);
//   // The concurrent limit for how many unidirectional streams
//   config.setInitialMaxStreamsUni(100);
//   // This means in total 200 possible streams?

//   config.setDisableActiveMigration(true);

//   // after we create a socket
//   // We need to use a same address

//   socket.bind(
//     0,
//     '::'
//   );

//   // Connection ID is a random thing
//   const connId = Buffer.alloc(native.MAX_CONN_ID_LEN);
//   webcrypto.getRandomValues(connId);


//   // Socket is bound AND listening
//   socket.on('listening', () => {
//     // This ends up being `::` and `IPv6` and random port
//     console.log(socket.address());
//   });

//   // If we are listening immediately ideally we have already setup this thing.

//   socket.on('message', async (data: Buffer, rinfo: dgram.RemoteInfo) => {

//     // This constructs a header
//     // This parsing MAY fail... if we don't have something
//     // This may throw an exception

//     let header;
//     try {
//       header = native.Header.fromSlice(
//         data,
//         native.MAX_CONN_ID_LEN
//       );
//     } catch (e) {
//       console.log('THIS IS NOT A QUIC DGRAM', e.message);
//       // We can ignore this and continue working on the next message
//       return;
//     }

//     console.log('WE GOT A QUIC PACKET');

//     // Ok so this is using hmac SIGNING of the conn ID seed and the DCID
//     // WHy is this needed?
//     // This is to prevent spoofing of the connection ID
//     // and to prevent the connection ID from being used for other purposes
//     // Conn id seed is a KEY

//     // The dcid should be the connection ID... of the other side trying to connect to us

//     const dcid: Buffer = Buffer.from(header.dcid);

//     // The CONN ID SIGNATURE becomes its own connection ID?
//     const connIdSig = Buffer.from(await webcrypto.subtle.sign(
//       'HMAC',
//       key,
//       dcid
//     ));
//     // Slice to the size of the CONN ID LENGTH (this could be 32 bits or 64 bits)
//     const connId = connIdSig.slice(0, native.MAX_CONN_ID_LEN);

//     // If we ALREADY have a connection based on this header.dcid


//     /*
// When we receive a ClientHello split across multiple Initial packets we
// end up creating multiple connections in the example servers due to the
// fact that we only store the server-generated destination connection ID,
// and not the original client-generated destination connection ID, in the
// HashMap used to associate incoming packets to connections.

// This changes how we generate the server-generated destination connection
// ID by making it more deterministic and based on the client-generated
// connection ID, and then do a double lookup for both the raw dcid and the
// deterministically-generated one.

// Unfortunately due to the fact that we use the normal Rust HashMap we
// can't have multiple keys pointing to the same connection, so we can't
// store the client-generated connection ID directly. In practice we could
// have a double layer HashMap, but then we'd run into problems when
// removing connections because we might not have the original destination
// connection ID (e.g. when we don't do Retry), so we would leak memory.
//     */

//     // Translation:
//     // It is possible that the `ClientHello` message
//     // has been split up to multiple initial packets
//     // This is a form of "packet fragmentation"
//     // Server generated destinatio conn ID
//     // The client generated destination conn ID is not used
//     // So now the server generated destination connection ID
//     // is deterministically derived from the client generated destination connection ID
//     // It does a double lookup for both the client generated destination connection ID
//     // Multiple keys can point to the same connection in JS
//     // So we could share the Connection object for the 2 keys here

//     /*
//       Each connection possesses a set of connection identifiers,
//       or connection IDs, each of which can identify the connection.
//       Connection IDs are independently selected by endpoints; each
//       endpoint selects the connection IDs that its peer uses.

//       I see so if A is connected to B, A identifies B with some conn ID.

//       Whereas B also identifies A with some conn ID.

//       However these do not have the same.

//       Right now it looks like if B is a server, then B generates a conn ID
//       based on A's conn ID of B using the HMAC signature process.

//       Which itself is done through a random key on process launch.

//       Each connection possesses a set of connection identifiers,
//       or connection IDs, each of which can identify the connection.
//       Connection IDs are independently selected by endpoints; each
//       endpoint selects the connection IDs that its peer uses.
//     */

//     let client;
//     if (
//       !clients.has(dcid.toString('binary')) &&
//       !clients.has(connId.toString('binary'))
//     ) {
//       // The client DOES not exist
//       // It is a new client

//       // We have to expose all the types
//       if (header.ty !== native.Type.Initial) {
//         console.log('PACKET is not initial');
//         return;
//       }

//       if (!native.versionIsSupported(header.version)) {

//         // We are going to send a version negotation packet to them
//         let data = Buffer.allocUnsafe(native.MAX_DATAGRAM_SIZE);
//         const versionLen = native.negotiateVersion(
//           header.scid,
//           header.dcid,
//           data
//         );
//         // data = data.slice(0, versionLen);

//         // This is asynchronous remember
//         socket.send(
//           data,
//           0,
//           versionLen,
//           rinfo.port,
//           rinfo.address,
//           (e) => {
//             // The error can be a DNS error, although not in this case
//             console.log('SENT out version negoation', e);
//           }
//         );

//         // now we send out a packet
//         return;
//       }

//       // The source connection ID for this
//       // will be the derived connection ID we made above
//       let scid = Buffer.from(connId);


//       const token: Uint8Array | undefined = header.token; // token always exists in initial packets
//       // But we should probably check right?
//       // What if it doesn't exist?
//       if (token == null) {
//         console.log('INITIAL packet does not have token');
//         return;
//       }

//       // Empty token
//       if (token.byteLength === 0) {
//         // What is a stateless retry?
//         console.log('Doing stateless RETRY');
//         /*
//         /// The token includes the static string `"quiche"` followed by the IP address
//         /// of the client and by the original destination connection ID generated by the
//         /// client.
//         */

//         // The application is responsible for generating the
//         // address validation token to be sent to the client, and
//         // verifying tokens sent back by the client. The generated token
//         // should include the dcid parameter, such that it can be later
//         // extracted from the token and passed to the accept() function
//         // as its odcid parameter.

//         const token = await mintToken(key, dcid, rinfo.address);

//         const data = Buffer.allocUnsafe(native.MAX_DATAGRAM_SIZE);
//         const retryLen = native.retry(
//           header.scid,
//           dcid,
//           scid,
//           Buffer.from(token),
//           header.version,
//           data
//         );

//         socket.send(
//           data,
//           0,
//           retryLen,
//           rinfo.port,
//           rinfo.address,
//           (e) => {
//             // The error can be a DNS error, although not in this case
//             console.log('SENT out stateless retry', e);
//           }
//         );

//         return;
//       }

//       // Ok so now we have a token
//       // it is not empty
//       // I think it's that it would have a buffer, but the buffer could be empty...
//       // Now we validate the token
//       const odcid = await validateToken(key, rinfo.address, Buffer.from(token));

//       if (odcid == null) {
//         console.log('INVALID TOKEN');
//         return;
//       }

//       // I'm not sure if this is necessary
//       // Especially since SCID is being derived from the DCID deterministically
//       // The C version doesn't even check
//       if (scid.byteLength !== dcid.byteLength) {
//         console.log('INVALID SCID/DCID LENGTH');
//         return;
//       }

//       // Overwrite the scid, so we are not using a new one
//       // This assumes the stateless retry has been done
//       // We then have to use it

//       // Assuming we have done the retry packet
//       // then we had already generated a NEW scid
//       // then we send it to them on the retry packet
//       // Now coming back here should mean the DCID now is the same as the on we ahd previously generated
//       // Thus we use the same here, the DCID here is the SCID
//       // This does a new copy of it though
//       scid = Buffer.from(dcid);

//       // We should put retry and related functions under a packet module
//       // rather than putting them all on the top level

//       const conn = native.Connection.accept(
//         scid,
//         odcid,
//         {
//           addr: socket.address().address,
//           port: socket.address().port
//         },
//         {
//           addr: rinfo.address,
//           port: rinfo.port
//         },
//         config
//       );

//       // Ok great so as long as this works
//       // We should have a connection now
//       clients.set(
//         scid.toString('binary'),
//         {
//           conn,
//           partial_responses: new Map()
//         }
//       );

//     } else {
//       // Try to get it based on the DCID first
//       // If it doesn't work, try to get it from the connID
//       // I don't really understand why this would be neessary
//       // At the beginning the clients have a randomly generated DCID
//       // This gets sent to us, we derive a SCID
//       // A retry packet is sent back with the original DCID, but also the SCID we generated
//       // The client returns back an initial packet with the token
//       // We end up using the DCID in the second initial packet as the SCID
//       // Which seems to be original DCID?
//       // So then if we are not in the initial packet stage
//       // Why would we get a packet in which its dcid isn't in the clients
//       // but the newly derived connId would be?
//       client = clients.get(dcid.toString('binary')) ||
//                clients.get(connId.toString('binary'));
//     }

//     // OK so now we have a connection!
//     // It at this point we can create a receive info
//     // And then run `conn.recv()`
//     // This processes the actual data packets
//     // After doing this
//     // We have to check if the connection
//     // is in early data OR is established
//     // If so, we can then iterate over WRITABLE streams
//     // And handle the writable streams
//     // Then we have to iterate over READABLE streams
//     // And then handle them too


//   });



//   // console.log(native);
// }

// void main();

// async function mintToken(
//   key: CryptoKey,
//   dcid: Buffer,
//   sourceAddress: string
// ): Promise<Buffer> {

//   // Remember these are BYTES
//   // The IP must be fully formed
//   const msg = {
//     addr: sourceAddress,
//     dcid: dcid.toString('base64url'),
//   };

//   const msgJSON = JSON.stringify(msg);
//   const msgData = Buffer.from(msgJSON);

//   const sig = Buffer.from(await webcrypto.subtle.sign('HMAC', key, msgData));

//   // The token must be BOTH sig and data
//   // Essentially it's a signed message, we will be parsing it subsequently
//   const token = {
//     msg: msgData.toString('base64url'),
//     sig: sig.toString('base64url'),
//   };

//   return Buffer.from(JSON.stringify(token));
// }

// // This requires access to a crypto system
// // We will have to take callbacks if we want to allow injection of any crypto to help with this
// // As well with TLS work
// // Validates the stateless retry token
// async function validateToken(key: CryptoKey, sourceAddress: string, tokenData: Buffer) {
//   const token = JSON.parse(tokenData.toString());
//   const msgData = Buffer.from(token.msg, 'base64url');
//   const sig = Buffer.from(token.sig, 'base64url');

//   // If the token was not issued by us
//   const check = await webcrypto.subtle.verify('HMAC', key, sig, msgData);
//   if (!check) {
//     return;
//   }

//   const msg = JSON.parse(msgData.toString());

//   // If the embedded address doesn't match..
//   if (msg.addr !== sourceAddress) {
//     return;
//   }

//   // The original destination connection ID is therefore correct
//   return Buffer.from(msg.dcid, 'base64url');
// }

// // const connId = Buffer.alloc(native.MAX_CONN_ID_LEN);
// // webcrypto.getRandomValues(connId);

// // const connection = native.Connection.connect(
// //   connId,
// //   'localhost',
// //   55551,
// //   '127.0.0.2',
// //   55552,
// //   config,
// // );

// // console.log(connection);

// // // const buf = Buffer.alloc(native.MAX_DATAGRAM_SIZE);

// // // const [l, info] = connection.send(buf);
// // // console.log(l, info);
// // // console.log(buf);

// // // console.log(sendData.out.length);

// // // const s2 = connection.send(buf);
// // // console.log(s2);
// // // console.log(buf);

// // // console.log(sendData2);
// // // console.log(sendData2.out.length);
