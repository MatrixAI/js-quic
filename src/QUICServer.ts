import type { ConnectionId, Crypto, Host, QUICConnectionMap } from './types';
import type { Header, Config, Connection } from './native/types';
import dgram from 'dgram';
import { Validator } from 'ip-num';
import Logger from '@matrixai/logger';
import { running } from '@matrixai/async-init';
import { StartStop, ready } from '@matrixai/async-init/dist/StartStop';
import QUICConnection from './QUICConnection';
import { quiche, Type } from './native';
import * as events from './events';
import * as utils from './utils';
import * as errors from './errors';
import QUICSocket from './QUICSocket';


/**
 * You must provide a error handler `addEventListener('error')`.
 * Otherwise errors will just be ignored.
 *
 * 'close'
 * 'connection'
 * 'error'
 * 'listen'
 */

interface QUICServer extends StartStop {}
@StartStop()
class QUICServer extends EventTarget {

  protected socket: QUICSocket;
  protected connectionMap: QUICConnectionMap;

  // Host and port of the server?
  // Well this is not relevnat here
  // protected host: string;
  // protected port: number;

  public readonly isSocketShared: boolean;
  protected logger: Logger;
  protected crypto: {
    key: ArrayBuffer;
    ops: Crypto;
  };
  protected config: Config;


  @ready(new errors.ErrorQUICServerNotRunning())
  public get host() {
    return this.socket.host;
  }

  @ready(new errors.ErrorQUICServerNotRunning())
  public get port() {
    return this.socket.port;
  }

  //     // Let's use hex strings instead
  //     const connectionId = scid.toString('hex') as ConnectionId;

  //     connection = new QUICConnection({
  //       // Note that if a connection ID changes, how do we deal with this?
  //       connectionId,
  //       connection: conn,
  //       connections: this.connections,
  //       handleTimeout: this.handleTimeout,
  //       logger: this.logger.getChild(`${QUICConnection.name} ${scid.toString('hex')}`)
  //     });

  //     // Nobody else really has acess to this
  //     // The problem is that we don't really hand over the connection the end user
  //     // Therefore they wouldn't event know to associate an error handler on the connection
  //     // Which means any exceptions would end up being thrown into the node runtime and crash it
  //     // So how would we deal with this?

  //     // The user already has to attach an error handler for every server
  //     // then attach it again for every connection
  //     connection.addEventListener('error', () => {
  //       console.log('CONNECTION HAS A ERROR');
  //     });

  //     this.connections.set(
  //       connectionId,
  //       connection
  //     );

  //     this.dispatchEvent(
  //       new events.QUICConnectionEvent({ detail: connection })
  //     );

  //   } else {
  //     this.logger.debug(`QUIC packet is for an existing connection`);
  //     connection = this.connections.get(
  //       dcid.toString('hex') as ConnectionId
  //     )!;
  //     if (connection == null) {
  //       connection = this.connections.get(
  //         connId.toString('hex') as ConnectionId
  //       )!;
  //     }
  //   }

  //   const recvInfo = {
  //     to: {
  //       host: this.socket.address().address,
  //       port: this.socket.address().port
  //     },
  //     from: {
  //       host: rinfo.address,
  //       port: rinfo.port
  //     },
  //   };

  //   connection.recv(data, recvInfo);

  //   // When the application receives QUIC packets from the peer (that is, any time recv() is also called).
  //   // When the connection timer expires (that is, any time on_timeout() is also called).
  //   // When the application sends data to the peer (for example, any time stream_send() or stream_shutdown() are called).
  //   // When the application receives data from the peer (for example any time stream_recv() is called).

  //   const ps: Array<Promise<void>> = [];
  //   for (const connection of this.connections.values()) {
  //     const data = connection.send();
  //     if (data == null) {
  //       break;
  //     }
  //     const [dataSend, sendInfo] = data;
  //     ps.push((async () => {
  //       try {
  //         await socketSend(
  //           dataSend,
  //           sendInfo.to.port,
  //           sendInfo.to.host
  //         );
  //       } catch (e) {
  //         this.dispatchEvent(new events.QUICServerErrorEvent({ detail: e }))
  //       }
  //     })());
  //   }
  //   await Promise.all(ps);

  //   // seems we iterate over the connections that are closed here
  //   // and end up removing them
  //   // and this is done on all the connections
  //   // seems kind of slow
  //   // but that seems to be an issue

  //   for (const connection of this.connections.values()) {
  //     if (connection.isClosed()) {
  //       this.connections.delete(connection.connectionId);
  //     }
  //   }

  protected handleTimeout = async () => {
    const socketSend = utils.promisify(this.socket.send).bind(this.socket);
    const ps: Array<Promise<void>> = [];
    for (const connection of this.connectionMap.values()) {
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
            sendInfo.to.host
          );
        } catch (e) {
          this.dispatchEvent(new events.QUICServerErrorEvent({ detail: e }))
        }
      })());
    }
    await Promise.all(ps);
    for (const connection of this.connectionMap.values()) {
      if (connection.isClosed()) {
        this.connectionMap.delete(
          utils.encodeConnectionId(connection.connectionId)
        );
      }
    }
  };

  /**
   * Handle QUIC socket errors
   * This is only used if the socket is not shared
   * If the socket is shared, then it is expected that the user
   * would listen on error events on the socket itself
   * Otherwise this will propagate such errors to the server
   */
  protected handleQUICSocketError = (e: events.QUICSocketErrorEvent) => {
    this.dispatchEvent(e);
  };

  public constructor({
    crypto,
    socket,
    logger,
  }: {
    crypto: {
      key: ArrayBuffer;
      ops: Crypto;
    },
    socket?: QUICSocket;
    logger?: Logger;
  }) {
    super();
    this.logger = logger ?? new Logger(this.constructor.name);
    this.crypto = crypto;
    if (socket == null) {
      this.socket = new QUICSocket({
        crypto,
        logger: this.logger.getChild(QUICSocket.name)
      });
      this.isSocketShared = false;
    } else {
      this.socket = socket;
      this.isSocketShared = true;
    }
    // Registers itself to the socket
    this.socket.registerServer(this);
    // Shares the socket connection map as well
    this.connectionMap = this.socket.connectionMap;


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
    this.config = config;
  }

  /**
   * Starts the QUICServer
   *
   * If the QUIC socket is shared, then it is expected that it is already started.
   * In which case, the `host` and `port` parameters here are ignored.
   */
  public async start({
    host = '::',
    port = 0
  }: {
    host?: string,
    port?: number,
  } = {}) {
    let address;
    if (!this.isSocketShared) {
      address = utils.buildAddress(host, port);
      this.logger.info(`Starting ${this.constructor.name} on ${address}`);
      await this.socket.start({ host, port });
      address = utils.buildAddress(this.socket.host, this.socket.port);
    } else {
      // If the socket is shared, it must already be started
      if (!this.socket[running]) {
        throw new errors.ErrorQUICServerSocketNotRunning();
      }
      address = utils.buildAddress(this.socket.host, this.socket.port);
      this.logger.info(`Starting ${this.constructor.name} on ${address}`);
    }
    this.socket.addEventListener(
      'error',
      this.handleQUICSocketError
    );
    this.logger.info(`Started ${this.constructor.name} on ${address}`);
  }

  /**
   * Stops the QUICServer
   */
  public async stop() {
    const address = utils.buildAddress(this.host, this.port);
    this.logger.info(`Stopping ${this.constructor.name} on ${address}`);
    for (const connection of this.connectionMap.values()) {
      await connection.stop();
    }
    if (!this.isSocketShared) {
      // If the socket is not shared, then it can be stopped
      await this.socket.stop();
    }
    this.socket.removeEventListener(
      'error',
      this.handleQUICSocketError
    );
    this.logger.info(`Stopped ${this.constructor.name} on ${address}`);
  }

  public async handleNewConnection(
    data: Buffer,
    rinfo: dgram.RemoteInfo,
    header: Header,
    scid: ConnectionId,
  ): Promise<QUICConnection | undefined> {
    this.logger.debug(`QUIC packet is for a new connection`);
    const peerAddress = utils.buildAddress(rinfo.address, rinfo.port);
    if (header.ty !== quiche.Type.Initial) {
      this.logger.debug(`QUIC packet must be Initial for new connections`);
      return;
    }
    // Version Negotiation
    if (!quiche.versionIsSupported(header.version)) {
      this.logger.debug(`QUIC packet version is not supported, performing version negotiation`);
      const versionDatagram = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
      const versionDatagramLength = quiche.negotiateVersion(
        header.scid,
        header.dcid,
        versionDatagram
      );
      this.logger.debug(`Send VersionNegotiation packet to ${peerAddress}`);
      try {
        await this.socket.send(
          versionDatagram,
          0,
          versionDatagramLength,
          rinfo.port,
          rinfo.address,
        );
      } catch (e) {
        this.logger.error(
          `Failed sending VersionNegotiation packet to ${peerAddress} - ${e.name}:${e.message}`
        );
        this.dispatchEvent(new events.QUICServerErrorEvent({ detail: e }));
        return;
      }
      this.logger.debug(`Sent VersionNegotiation packet to ${peerAddress}`);
      return;
    }
    // At this point we are processing an `Initial` packet.
    // It is expected that token exists, because if it didn't, there would have
    // been a `BufferTooShort` error during parsing.
    const token = header.token!;
    // Stateless Retry
    if (token.byteLength === 0) {
      const token = await this.mintToken(
        header.dcid as ConnectionId,
        rinfo.address as Host
      );
      const retryDatagram = Buffer.allocUnsafe(
        quiche.MAX_DATAGRAM_SIZE
      );
      const retryDatagramLength = quiche.retry(
        header.scid, // Client initial packet source ID
        header.dcid, // Client initial packet destination ID
        scid, // Server's new source ID that is derived
        token,
        header.version,
        retryDatagram
      );
      this.logger.debug(`Send Retry packet to ${peerAddress}`);
      try {
        await this.socket.send(
          retryDatagram,
          0,
          retryDatagramLength,
          rinfo.port,
          rinfo.address,
        );
      } catch (e) {
        this.logger.error(
          `Failed sending Retry packet to ${peerAddress} - ${e.name}:${e.message}`
        );
        this.dispatchEvent(new events.QUICServerErrorEvent({ detail: e }));
        return;
      }
      this.logger.debug(`Sent Retry packet to ${peerAddress}`);
      return;
    }
    // At this point in time, the packet's DCID is the originally-derived DCID.
    // While the DCID embedded in the token is the original DCID that the client first created.
    const dcidOriginal = await this.validateToken(
      Buffer.from(token),
      rinfo.address as Host
    );
    if (dcidOriginal == null) {
      this.logger.debug(`QUIC packet token failed validation`);
      return;
    }
    // Check that the newly-derived DCID (passed in as the SCID) is the same
    // length as the packet DCID.
    // This ensures that the derivation process hasn't changed.
    if (scid.byteLength !== header.dcid.byteLength) {
      this.logger.debug(`QUIC packet token failed validation`);
      return;
    }
    // Here we shall re-use the originally-derived DCID as the SCID
    scid = header.dcid as ConnectionId;
    this.logger.debug(`Accepting new connection from QUIC packet`);
    const connection = quiche.Connection.accept(
      scid,
      dcidOriginal,
      {
        host: this.socket.host,
        port: this.socket.port,
      },
      {
        host: rinfo.address,
        port: rinfo.port,
      },
      this.config
    );
    // Ok now that we have a connection here
    // do we also return this to the QUICSocket for it to manage?
    // Or do we directly manage the connection map?
    // Note that if a connection ID changes, how do we deal with this?
    // What happens when we timeout?

    return new QUICConnection({
      connectionId: scid,
      connection,
      connections: this.connectionMap,
      handleTimeout: this.handleTimeout,
      logger: this.logger.getChild(`${QUICConnection.name} ${scid.toString('hex')}`)
    });
  }

  /**
   * Creates a retry token.
   * This will embed peer host IP and DCID into the token.
   * It will authenticate the data by providing a signature signed by our key.
   */
  protected async mintToken(
    dcid: ConnectionId,
    peerHost: Host
  ): Promise<Buffer> {
    const msgData = { dcid: utils.encodeConnectionId(dcid), host: peerHost };
    const msgJSON = JSON.stringify(msgData);
    const msgBuffer = Buffer.from(msgJSON);
    const msgSig = Buffer.from(
      await this.crypto.ops.sign(
        this.crypto.key,
        msgBuffer
      )
    );
    const tokenData = {
      msg: msgBuffer.toString('base64url'),
      sig: msgSig.toString('base64url'),
    };
    const tokenJSON = JSON.stringify(tokenData);
    const tokenBuffer = Buffer.from(tokenJSON);
    return tokenBuffer;
  }

  /**
   * Validates the retry token.
   * This will check that the token was signed by us.
   * And it will check that the current host IP is the same as the one put into the token.
   * This proves that the peer can in fact receive and send from the host IP.
   * This returns the DCID inside the token, which was the original DCID.
   */
  protected async validateToken(
    tokenBuffer: Buffer,
    peerHost: Host
  ): Promise<ConnectionId | undefined> {
    let tokenData;
    try {
      tokenData = JSON.parse(tokenBuffer.toString());
    } catch {
      return;
    }
    if (typeof tokenData !== 'object' || tokenData == null) {
      return;
    }
    if (
      typeof tokenData.msg !== 'string' ||
      typeof tokenData.sig !== 'string'
    ) {
      return;
    }
    const msgBuffer = Buffer.from(tokenData.msg, 'base64url');
    const msgSig = Buffer.from(tokenData.sig, 'base64url');
    if (!await this.crypto.ops.verify(
      this.crypto.key,
      msgBuffer,
      msgSig
    )) {
      return;
    }
    let msgData;
    try {
      JSON.parse(msgBuffer.toString())
    } catch {
      return;
    }
    if (typeof msgData !== 'object' || msgData == null) {
      return;
    }
    if (
      typeof msgData.dcid !== 'string' ||
      typeof msgData.host !== 'string'
    ) {
      return;
    }
    if (msgData.host !== peerHost) {
      return;
    }
    return utils.decodeConnectionId(msgData.dcid);
  }

}

export default QUICServer;
