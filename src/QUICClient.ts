import type { ConnectionId, Crypto } from './types';
import type { Header, Config, Connection } from './native/types';
import dgram from 'dgram';
import Logger from '@matrixai/logger';
import { Validator } from 'ip-num';
import { Quiche, quiche, Type } from './native';
import * as utils from './utils';

// because this is meant to be an actual QUIC client object you create
// whereas the other is really an abstraction around a QUIC connection

// we start with a buffer
// each quic client is connected to 1 server?
// yea, so create multiple quic clients
// but also remember that it's the quic connection that matters

// the Crypto might require some randomisation needs

class QUICClient extends EventTarget {

  protected socket: dgram.Socket;

  // Note that this requires DNS resolution
  // One is that host and port of my own socket
  // Another is the host and port of the OTHER connecting system
  // That's also important to understand!
  // protected host: string;
  // protected port: number;

  protected logger: Logger;
  protected crypto: {
    key: ArrayBuffer;
    ops: Crypto;
  };
  protected config: Config;
  protected connections: Map<ConnectionId, Connection>;

  public constructor({
    crypto,
    connections = new Map(),
  }: {
    crypto: {
      key: ArrayBuffer;
      ops: Crypto;
    };
    connections?: Map<ConnectionId, Connection>;
  }) {
    super();
    this.crypto = crypto;
    this.connections = connections;

    // The socket is registered to be readable
    // so it is indeed meant to be done with the `handleMessage`
    // So a single `handleMessage` needs to understand how to route it

    const config = new quiche.Config();
    config.verifyPeer(false);
    config.setApplicationProtos(
      [
        'hq-interop',
        'hq-29',
        'hq-28',
        'hq-27',
        'http/0.9'
      ]
    );
    config.setMaxIdleTimeout(5000);
    config.setMaxRecvUdpPayloadSize(quiche.MAX_DATAGRAM_SIZE);
    config.setMaxSendUdpPayloadSize(quiche.MAX_DATAGRAM_SIZE);
    config.setInitialMaxData(10000000);
    config.setInitialMaxStreamDataBidiLocal(1000000);
    config.setInitialMaxStreamDataBidiRemote(1000000);
    config.setInitialMaxStreamsBidi(100);
    config.setInitialMaxStreamsUni(100);
    config.setDisableActiveMigration(true);

    this.config = config;





  }

  // We need to be able to share the socket
  // especially if the client and server must exist on the same spot
  // and multiple clients too
  // so this is something we need to consider
  public async start({
    host = '::',
    port = 0
  }: {
    host?: string,
    port?: number,
  } = {}) {
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

    // ---

    // We have to fill it out with random stuff
    // Random source connection ID
    // The SCID is what the client uses to identify itself.
    const scid = Buffer.allocUnsafe(quiche.MAX_CONN_ID_LEN);

    // Set the array buffer accordingly
    this.crypto.ops.randomBytes(
      scid.buffer.slice(
        scid.byteOffset,
        scid.byteOffset + scid.byteLength
      )
    );

    // we don't actually use the URL
    // it's not important for us
    // maybe it is useful later.
    // the server name is optional
    // it's only used for verifying the peer certificate
    // however we don't really do this... because we are using custom  verification

    // New QUIC connection, this will start to initiate the handshake
    const conn = quiche.Connection.connect(
      null,
      scid,
      {
        host: this.socket.address().address,
        port: this.socket.address().port,
      },
      {
        host: host,
        port: port
      },
      this.config
    );

    // const data = Buffer.alloc(quiche.MAX_DATAGRAM_SIZE);
    // conn.send(data);

    // Ok we should be creating a `QUICConnection` here
    // just like in the server
    // Then use the `send()` which will give back us the data to be sent out on the UDP socket
    // After sending the INITIAL packet
    // it will then expect to receive data on the UDP socket
    // At that point the receive info is built up
    // Then it is passed to `conn.recv`
    // HOWEVER what if we have multiple connections
    // which ones should be indexing into?
    // Should we be parsing the packet just like on the server side
    // And then identifying the connection based on the SCID or DCID
    // since every client... uses SCID to identify themselves

    // Then it tries to read it until it times out
    // Or if there is no more UDP packets to read
    // This is seems unnceessary  with handle message

    // Check if is closed

    // Process writes if the connection is established

    // Afterwards, it processes all readable streams
    // Deal with closing streams

    // Send out on connection

    // Send out on the socket

    // Check if connection is closed

    // Otherwise go back to the sleep waiting loop


  }

  public async stop() {
    const address = utils.buildAddress(this.host, this.port);
    this.logger.info(`Stopping ${this.constructor.name} on ${address}`);

    this.socket.close();
    this.logger.info(`Stopped ${this.constructor.name} on ${address}`);
  }

}

export default QUICClient;
