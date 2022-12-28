import type { ConnectionId, Crypto } from './types';
import type { Header, Config, Connection } from './native/types';
import dgram from 'dgram';
import { Validator } from 'ip-num';
import Logger from '@matrixai/logger';
import QUICConnection from './QUICConnection';
import { quiche, Type } from './native';
import * as events from './events';
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

  // we need to make the error event emit out side
  // ith as to be default
  // stopImmediatePropagation
  // but that's from the one that is registered
  // so this is a bit of a problem!

  protected socket: dgram.Socket;
  protected host: string;
  protected port: number;
  protected logger: Logger;
  protected crypto: {
    key: ArrayBuffer;
    ops: Crypto;
  };
  protected config: Config;
  protected connections: Map<ConnectionId, QUICConnection> = new Map();

  protected handleMessage = async (data: Buffer, rinfo: dgram.RemoteInfo) => {
    const receiveAddress = utils.buildAddress(rinfo.address, rinfo.port);
    this.logger.debug(`Receiving UDP packet from ${receiveAddress}`);
    const socketSend = utils.promisify(this.socket.send).bind(this.socket);
    let header: Header;
    try {
      // Maximum length of a connection ID
      header = quiche.Header.fromSlice(data, quiche.MAX_CONN_ID_LEN);
    } catch (e) {
      // Only `InvalidPacket` is a valid error here
      if (e.message !== 'InvalidPacket') {
        this.dispatchEvent(new events.QUICServerErrorEvent({ detail: e }));
        return;
      }
      this.logger.debug(`Received UDP packet is not a QUIC packet`);
      return;
    }
    this.logger.debug(
      `Processing ${Object.keys(quiche.Type)[header.ty]} QUIC packet`
    );
    const dcid: Buffer = Buffer.from(header.dcid);
    const dcidSignature = utils.bufferWrap(await this.crypto.ops.sign(this.crypto.key, dcid));
    const connId = dcidSignature.subarray(0, quiche.MAX_CONN_ID_LEN);

    // This is going to be the wrapped QUICConnection
    let connection: QUICConnection;

    // Check if this packet corresponds to an existing connection
    if (
      !this.connections.has(dcid.toString('binary') as ConnectionId) &&
      !this.connections.has(connId.toString('binary') as ConnectionId)
    ) {

      if (header.ty !== quiche.Type.Initial) {
        return;
      }

      // Version Negotiation
      if (!quiche.versionIsSupported(header.version)) {
        const versionDatagram = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        const versionDatagramLength = quiche.negotiateVersion(
          header.scid,
          header.dcid,
          versionDatagram
        );
        try {
          await socketSend(
            versionDatagram,
            0,
            versionDatagramLength,
            rinfo.port,
            rinfo.address,
          );
        } catch (e) {
          this.dispatchEvent(new events.QUICServerErrorEvent({ detail: e }));
        }
        return;
      }

      const token: Uint8Array | undefined = header.token;
      if (token == null) {
        return;
      }

      // Stateless Retry
      if (token.byteLength === 0) {
        const token = await this.mintToken(
          Buffer.from(header.dcid),
          rinfo.address
        );
        const retryDatagram = Buffer.allocUnsafe(
          quiche.MAX_DATAGRAM_SIZE
        );
        const retryDatagramLength = quiche.retry(
          header.scid, // Client initial packet source ID
          header.dcid, // Client initial packet destination ID
          connId, // Server's new source ID that is derived
          token,
          header.version,
          retryDatagram
        );
        try {
          await socketSend(
            retryDatagram,
            0,
            retryDatagramLength,
            rinfo.port,
            rinfo.address,
          );
        } catch (e) {
          this.dispatchEvent(new events.QUICServerErrorEvent({ detail: e }));
        }
        return;
      }

      const odcid = await this.validateToken(
        Buffer.from(token),
        rinfo.address,
      );
      if (odcid == null) {
        return;
      }

      if (connId.byteLength !== dcid.byteLength) {
        return;
      }

      const scid = Buffer.from(header.dcid);

      const conn = quiche.Connection.accept(
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

      const connectionId = scid.toString('binary') as ConnectionId;

      // Should also pass in all the connections too
      // to allow for garbage collection?
      connection = new QUICConnection({
        connectionId,
        connection: conn,
        connections: this.connections,
        handleTimeout: this.handleTimeout
      });

      // Nobody else really has acess to this
      // The problem is that we don't really hand over the connection the end user
      // Therefore they wouldn't event know to associate an error handler on the connection
      // Which means any exceptions would end up being thrown into the node runtime and crash it
      // So how would we deal with this?

      // The user already has to attach an error handler for every server
      // then attach it again for every connection
      connection.addEventListener('error', () => {
        console.log('CONNECTION HAS A ERROR');
      });

      this.connections.set(
        connectionId,
        connection
      );

      // We now have a connection!
      this.dispatchEvent(
        new events.QUICConnectionEvent({ detail: connection })
      );

    } else {
      connection = this.connections.get(
        dcid.toString('binary') as ConnectionId
      )!;
      if (connection == null) {
        connection = this.connections.get(
          connId.toString('binary') as ConnectionId
        )!;
      }
    }

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

    connection.recv(data, recvInfo);

    // When the application receives QUIC packets from the peer (that is, any time recv() is also called).
    // When the connection timer expires (that is, any time on_timeout() is also called).
    // When the application sends data to the peer (for example, any time stream_send() or stream_shutdown() are called).
    // When the application receives data from the peer (for example any time stream_recv() is called).

    const ps: Array<Promise<void>> = [];
    for (const connection of this.connections.values()) {
      const data = connection.send();
      if (data == null) {
        break;
      }
      const [dataSend, sendInfo] = data;
      ps.push((async () => {
        try {
          await socketSend(
            dataSend,
            sendInfo.to.port,
            sendInfo.to.addr
          );
        } catch (e) {
          this.dispatchEvent(new events.QUICServerErrorEvent({ detail: e }))
        }
      })());
    }
    await Promise.all(ps);

    // seems we iterate over the connections that are closed here
    // and end up removing them
    // and this is done on all the connections
    // seems kind of slow
    // but that seems to be an issue

    for (const connection of this.connections.values()) {
      if (connection.isClosed()) {
        this.connections.delete(connection.connectionId);
      }
    }

  };

  protected handleTimeout = async () => {
    const socketSend = utils.promisify(this.socket.send).bind(this.socket);

    const ps: Array<Promise<void>> = [];
    for (const connection of this.connections.values()) {
      const data = connection.send();
      if (data == null) {
        break;
      }
      const [dataSend, sendInfo] = data;
      ps.push((async () => {
        try {
          await socketSend(
            dataSend,
            sendInfo.to.port,
            sendInfo.to.addr
          );
        } catch (e) {
          this.dispatchEvent(new events.QUICServerErrorEvent({ detail: e }))
        }
      })());
    }
    await Promise.all(ps);

    for (const connection of this.connections.values()) {
      if (connection.isClosed()) {
        this.connections.delete(connection.connectionId);
      }
    }
  };


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
    logger?: Logger;
  }) {
    super();
    this.logger = logger ?? new Logger(this.constructor.name);
    this.crypto = crypto;

    // Also need to sort out the configuration
    const config = new quiche.Config();

    // Change this to TLSConfig
    // Private key PEM
    // Cert Chain PEM
    config.loadCertChainFromPemFile(
      './tmp/localhost.crt'
    );
    config.loadPrivKeyFromPemFile(
      './tmp/localhost.key'
    );
    config.verifyPeer(false);
    config.grease(true);
    config.setMaxIdleTimeout(5000);
    config.setMaxRecvUdpPayloadSize(quiche.MAX_DATAGRAM_SIZE);
    config.setMaxSendUdpPayloadSize(quiche.MAX_DATAGRAM_SIZE);
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
    config.enableEarlyData();
  }

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
    this.socket.on('message', this.handleMessage);
    this.socket.on('error', (e) => {
      this.dispatchEvent(
        new events.QUICServerErrorEvent({ detail: e })
      );
    });
    address = utils.buildAddress(this.host, this.port);
    this.logger.info(`Started ${this.constructor.name} on ${address}`);
  }

  public async stop() {
    const address = utils.buildAddress(this.host, this.port);
    this.logger.info(`Stopping ${this.constructor.name} on ${address}`);

    // Here we are attempting to gracefully stop all the connections
    // Not sure if there's any relevant code we should be using
    for (const connection of this.connections.values()) {
      await connection.stop();
    }

    // If we want to close the socket
    // this is all we need to do
    // There's no waiting for connections to stop
    // Cause that doesn't exist on the UDP socket level
    this.socket.close();
    this.logger.info(`Stopped ${this.constructor.name} on ${address}`);
  }

  protected async mintToken(data, sourceAddress): Promise<Buffer> {
    const msg = {
      addr: sourceAddress,
      dcid: data.toString('base64url'),
    };
    const msgJSON = JSON.stringify(msg);
    const msgData = Buffer.from(msgJSON);
    const sig = Buffer.from(await this.crypto.ops.sign(this.crypto.key, msgData));
    const token = {
      msg: msgData.toString('base64url'),
      sig: sig.toString('base64url'),
    };
    return Buffer.from(JSON.stringify(token));
  }

  protected async validateToken(data, sourceAddress): Promise<Buffer | undefined> {
    const token = JSON.parse(data.toString());
    const msgData = Buffer.from(token.msg, 'base64url');
    const sig = Buffer.from(token.sig, 'base64url');
    // If the token was not issued by us
    const check = await this.crypto.ops.verify(this.crypto.key, msgData, sig);
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

}

export default QUICServer;
