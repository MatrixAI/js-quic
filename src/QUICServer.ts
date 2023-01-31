import type { ConnectionId, Crypto, Host, Hostname, Port, RemoteInfo } from './types';
import type { Header, Config } from './native/types';
import type QUICConnectionMap from './QUICConnectionMap';
import QUICConnectionId from './QUICConnectionId';
import Logger from '@matrixai/logger';
import { running } from '@matrixai/async-init';
import { StartStop, ready } from '@matrixai/async-init/dist/StartStop';
import QUICConnection from './QUICConnection';
import { quiche } from './native';
import * as events from './events';
import * as utils from './utils';
import * as errors from './errors';
import QUICSocket from './QUICSocket';


/**
 * You must provide a error handler `addEventListener('error')`.
 * Otherwise errors will just be ignored.
 *
 * Events:
 * - connection
 * - error - (could be a QUICSocketErrorEvent OR QUICServerErrorEvent)
 * - stop
 */
interface QUICServer extends StartStop {}
@StartStop()
class QUICServer extends EventTarget {

  public readonly isSocketShared: boolean;

  protected logger: Logger;
  protected crypto: {
    key: ArrayBuffer;
    ops: Crypto;
  };
  protected config: Config;
  protected socket: QUICSocket;

  protected connectionMap: QUICConnectionMap;

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
    resolveHostname = utils.resolveHostname,
    logger,
  }: {
    crypto: {
      key: ArrayBuffer;
      ops: Crypto;
    },
    socket?: QUICSocket;
    resolveHostname?: (hostname: Hostname) => Host | PromiseLike<Host>;
    logger?: Logger;
  }) {
    super();
    this.logger = logger ?? new Logger(this.constructor.name);
    this.crypto = crypto;
    if (socket == null) {
      this.socket = new QUICSocket({
        crypto,
        resolveHostname,
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
    config.setMaxIdleTimeout(6000);
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

  @ready(new errors.ErrorQUICServerNotRunning())
  public get host() {
    return this.socket.host;
  }

  @ready(new errors.ErrorQUICServerNotRunning())
  public get port() {
    return this.socket.port;
  }

  /**
   * Starts the QUICServer
   *
   * If the QUIC socket is shared, then it is expected that it is already started.
   * In which case, the `host` and `port` parameters here are ignored.
   */
  public async start({
    host = '::' as Host,
    port = 0 as Port
  }: {
    host?: Host | Hostname,
    port?: Port,
  } = {}) {
    let address: string;
    if (!this.isSocketShared) {
      address = utils.buildAddress(host, port);
      this.logger.info(`Start ${this.constructor.name} on ${address}`);
      await this.socket.start({ host, port });
      this.socket.addEventListener(
        'error',
        this.handleQUICSocketError
      );
      address = utils.buildAddress(this.socket.host, this.socket.port);
    } else {
      // If the socket is shared, it must already be started
      if (!this.socket[running]) {
        throw new errors.ErrorQUICServerSocketNotRunning();
      }
      address = utils.buildAddress(this.socket.host, this.socket.port);
      this.logger.info(`Start ${this.constructor.name} on ${address}`);
    }
    this.logger.info(`Started ${this.constructor.name} on ${address}`);
  }

  /**
   * Stops the QUICServer
   */
  public async stop() {
    const address = utils.buildAddress(this.socket.host, this.socket.port);
    this.logger.info(`Stop ${this.constructor.name} on ${address}`);
    for (const connection of this.connectionMap.serverConnections.values()) {
      await connection.destroy();
    }
    if (!this.isSocketShared) {
      // If the socket is not shared, then it can be stopped
      await this.socket.stop();
      this.socket.removeEventListener(
        'error',
        this.handleQUICSocketError
      );
    }
    this.dispatchEvent(new events.QUICServerStopEvent());
    this.logger.info(`Stopped ${this.constructor.name} on ${address}`);
  }

  public async newConnection(
    data: Buffer,
    remoteInfo: RemoteInfo,
    header: Header,
    dcid: QUICConnectionId,
    scid: QUICConnectionId,
  ): Promise<QUICConnection | undefined> {
    const peerAddress = utils.buildAddress(remoteInfo.host, remoteInfo.port);
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
          remoteInfo.port,
          remoteInfo.host,
        );
      } catch (e) {
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
        dcid,
        remoteInfo.host
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
          remoteInfo.port,
          remoteInfo.host,
        );
      } catch (e) {
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
      remoteInfo.host
    );
    if (dcidOriginal == null) {
      this.logger.debug(`QUIC packet token failed validation due to missing DCID`);
      return;
    }
    // Check that the newly-derived DCID (passed in as the SCID) is the same
    // length as the packet DCID.
    // This ensures that the derivation process hasn't changed.
    if (scid.byteLength !== header.dcid.byteLength) {
      this.logger.debug(`QUIC packet token failed validation due to mismatched length`);
      return;
    }
    // Here we shall re-use the originally-derived DCID as the SCID
    scid = new QUICConnectionId(header.dcid);
    this.logger.debug(`Accepting new connection from QUIC packet`);
    const connection = await QUICConnection.acceptQUICConnection({
      scid,
      dcid: dcidOriginal,
      socket: this.socket,
      remoteInfo,
      config: this.config,
      logger: this.logger.getChild(`${QUICConnection.name} ${scid}`)
    });

    this.dispatchEvent(new events.QUICServerConnectionEvent({ detail: connection }));

    // A new conn ID means a new connection
    // the old connection gets removed
    // so one has to be aware of this
    // Either that, or there is a seamless migration to a new connection ID
    // In which case we need to manage it somehow

    return connection;
  }

  /**
   * Creates a retry token.
   * This will embed peer host IP and DCID into the token.
   * It will authenticate the data by providing a signature signed by our key.
   */
  protected async mintToken(
    dcid: QUICConnectionId,
    peerHost: Host
  ): Promise<Buffer> {
    const msgData = { dcid: dcid.toString(), host: peerHost };
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
  ): Promise<QUICConnectionId | undefined> {
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
      msgData = JSON.parse(msgBuffer.toString())
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
    return QUICConnectionId.fromString(msgData.dcid);
  }

}

export default QUICServer;
