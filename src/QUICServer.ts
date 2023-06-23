import type {
  Host,
  Hostname,
  Port,
  RemoteInfo,
  StreamCodeToReason,
  StreamReasonToCode,
  QUICConfig,
  ServerCrypto,
  VerifyCallback,
} from './types';
import type { Header } from './native/types';
import type QUICConnectionMap from './QUICConnectionMap';
import Logger from '@matrixai/logger';
import { running } from '@matrixai/async-init';
import { ready, StartStop } from '@matrixai/async-init/dist/StartStop';
import * as events from './events';
import { serverDefault } from './config';
import QUICConnectionId from './QUICConnectionId';
import QUICConnection from './QUICConnection';
import { quiche } from './native';
import * as utils from './utils';
import * as errors from './errors';
import QUICSocket from './QUICSocket';

/**
 * You must provide a error handler `addEventListener('error')`.
 * Otherwise errors will just be ignored.
 *
 * Events:
 * - serverStop
 * - serverError - (could be a QUICSocketErrorEvent OR QUICServerErrorEvent)
 * - serverConnection
 * - connectionStream - when new stream is created from a connection
 * - connectionError - connection error event
 * - connectionDestroy - when connection is destroyed
 * - streamDestroy - when stream is destroyed
 * - socketError - this also results in a server error
 * - socketStop
 */
interface QUICServer extends StartStop {}
@StartStop()
class QUICServer extends EventTarget {
  public readonly isSocketShared: boolean;

  protected logger: Logger;
  protected crypto: {
    key: ArrayBuffer;
    ops: ServerCrypto;
  };
  protected config: QUICConfig;
  protected socket: QUICSocket;
  protected reasonToCode: StreamReasonToCode | undefined;
  protected codeToReason: StreamCodeToReason | undefined;
  protected verifyCallback: VerifyCallback | undefined;
  protected connectionMap: QUICConnectionMap;

  protected handleQUICSocketEvents = (e: events.QUICSocketEvent) => {
    const event = new Event('asd');
    this.dispatchEvent(event);
    this.dispatchEvent(event);
    if (e instanceof events.QUICSocketErrorEvent) {
      this.dispatchEvent(
        new events.QUICServerErrorEvent({
          detail: e.detail,
        }),
      );
    }
  };

  protected handleQUICConnectionEvents = (e: events.QUICConnectionEvent) => {
    this.dispatchEvent(e);
  };

  public constructor({
    crypto,
    config,
    socket,
    resolveHostname = utils.resolveHostname,
    reasonToCode,
    codeToReason,
    verifyCallback,
    logger,
  }: {
    crypto: {
      key: ArrayBuffer;
      ops: {
        sign(key: ArrayBuffer, data: ArrayBuffer): Promise<ArrayBuffer>;
        verify(
          key: ArrayBuffer,
          data: ArrayBuffer,
          sig: ArrayBuffer,
        ): Promise<boolean>;
      };
    };
    config: Partial<QUICConfig> & {
      key: string | Array<string> | Uint8Array | Array<Uint8Array>;
      cert: string | Array<string> | Uint8Array | Array<Uint8Array>;
    };
    socket?: QUICSocket;
    resolveHostname?: (hostname: Hostname) => Host | PromiseLike<Host>;
    reasonToCode?: StreamReasonToCode;
    codeToReason?: StreamCodeToReason;
    verifyCallback?: VerifyCallback;
    logger?: Logger;
  }) {
    super();
    const quicConfig = {
      ...serverDefault,
      ...config,
    };
    this.logger = logger ?? new Logger(this.constructor.name);
    this.crypto = crypto;
    if (socket == null) {
      this.socket = new QUICSocket({
        resolveHostname,
        logger: this.logger.getChild(QUICSocket.name),
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
    this.config = quicConfig;
    this.reasonToCode = reasonToCode;
    this.codeToReason = codeToReason;
    this.verifyCallback = verifyCallback;
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
    port = 0 as Port,
    reuseAddr,
  }: {
    host?: Host | Hostname;
    port?: Port;
    reuseAddr?: boolean;
  } = {}) {
    let address: string;
    if (!this.isSocketShared) {
      address = utils.buildAddress(host, port);
      this.logger.info(`Start ${this.constructor.name} on ${address}`);
      await this.socket.start({ host, port, reuseAddr });
      address = utils.buildAddress(this.socket.host, this.socket.port);
    } else {
      // If the socket is shared, it must already be started
      if (!this.socket[running]) {
        throw new errors.ErrorQUICServerSocketNotRunning();
      }
      address = utils.buildAddress(this.socket.host, this.socket.port);
      this.logger.info(`Start ${this.constructor.name} on ${address}`);
    }

    // Register on all socket events
    this.socket.addEventListener('socketError', this.handleQUICSocketEvents);
    this.socket.addEventListener('socketStop', this.handleQUICSocketEvents);

    this.logger.info(`Started ${this.constructor.name} on ${address}`);
  }

  /**
   * Stops the QUICServer
   */
  public async stop({
    force = false,
  }: {
    force?: boolean;
  } = {}) {
    // Console.time('destroy conn');
    const address = utils.buildAddress(this.socket.host, this.socket.port);
    this.logger.info(`Stop ${this.constructor.name} on ${address}`);
    const destroyProms: Array<Promise<void>> = [];
    for (const connection of this.connectionMap.serverConnections.values()) {
      destroyProms.push(
        connection.stop({
          applicationError: true,
          errorMessage: 'cleaning up connections',
          errorCode: 42,
          force,
        }),
      ); // TODO: fill in with proper details
    }
    await Promise.all(destroyProms);
    // Console.timeEnd('destroy conn');
    this.socket.deregisterServer(this);
    if (!this.isSocketShared) {
      // If the socket is not shared, then it can be stopped
      await this.socket.stop();
    }
    this.socket.removeEventListener('socketError', this.handleQUICSocketEvents);
    this.socket.removeEventListener('socketStop', this.handleQUICSocketEvents);
    this.dispatchEvent(new events.QUICServerStopEvent());
    this.logger.info(`Stopped ${this.constructor.name} on ${address}`);
  }

  // Because the `ctx` is not passed in from the outside
  // It makes sense that this is only done during construction
  // And importantly we just enable the cancellation of this
  // Nothing else really

  /**
   * This method must not throw any exceptions.
   * Any errors must be emitted as events.
   * @internal
   */
  public async connectionNew(
    remoteInfo: RemoteInfo,
    header: Header,
    dcid: QUICConnectionId,
  ): Promise<QUICConnection | undefined> {
    // If the packet is not an `Initial` nor `ZeroRTT` then we discard the
    // packet.
    if (
      header.ty !== quiche.Type.Initial &&
      header.ty !== quiche.Type.ZeroRTT
    ) {
      return;
    }

    // Derive the new connection's SCID from the client generated DCID
    const scid = new QUICConnectionId(
      await this.crypto.ops.sign(this.crypto.key, dcid),
      0,
      quiche.MAX_CONN_ID_LEN,
    );

    const peerAddress = utils.buildAddress(remoteInfo.host, remoteInfo.port);

    // Version Negotiation
    if (!quiche.versionIsSupported(header.version)) {
      this.logger.debug(
        `QUIC packet version is not supported, performing version negotiation`,
      );
      const versionDatagram = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
      const versionDatagramLength = quiche.negotiateVersion(
        header.scid,
        header.dcid,
        versionDatagram,
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
      const token = await this.mintToken(dcid, remoteInfo.host);
      const retryDatagram = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
      const retryDatagramLength = quiche.retry(
        header.scid, // Client initial packet source ID
        header.dcid, // Client initial packet destination ID
        scid, // Server's new source ID that is derived
        token,
        header.version,
        retryDatagram,
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
      remoteInfo.host,
    );
    if (dcidOriginal == null) {
      this.logger.debug(
        `QUIC packet token failed validation due to missing DCID`,
      );
      return;
    }
    // Check that the newly-derived DCID (passed in as the SCID) is the same
    // length as the packet DCID.
    // This ensures that the derivation process hasn't changed.
    if (scid.byteLength !== header.dcid.byteLength) {
      this.logger.debug(
        `QUIC packet token failed validation due to mismatched length`,
      );
      return;
    }
    // Here we shall re-use the originally-derived DCID as the SCID
    const newScid = new QUICConnectionId(header.dcid);
    this.logger.debug(
      `Accepting new connection from QUIC packet from ${remoteInfo.host}:${remoteInfo.port}`,
    );
    const clientConnRef = Buffer.from(header.scid).toString('hex').slice(32);
    const connection = new QUICConnection({
      type: 'server',
      scid: newScid,
      dcid: dcidOriginal,
      socket: this.socket,
      remoteInfo,
      config: this.config,
      reasonToCode: this.reasonToCode,
      codeToReason: this.codeToReason,
      verifyCallback: this.verifyCallback,
      logger: this.logger.getChild(
        `${QUICConnection.name} ${scid.toString().slice(32)}-${clientConnRef}`,
      ),
    });
    try {
      await connection.start(); // TODO: pass ctx
    } catch (e) {
      // Ignoring any errors here as a failure to connect
      return;
    }
    this.dispatchEvent(
      new events.QUICServerConnectionEvent({ detail: connection }),
    );

    // A new conn ID means a new connection
    // the old connection gets removed
    // so one has to be aware of this
    // Either that, or there is a seamless migration to a new connection ID
    // In which case we need to manage it somehow

    return connection;
  }

  /**
   * This updates the `QUICConfig` used when new connections are established.
   * Only the parameters that are provided are updated.
   * It will not affect existing connections, they will keep using the old `QUICConfig`
   */
  public updateConfig(config: Partial<QUICConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
  }

  /**
   * Creates a retry token.
   * This will embed peer host IP and DCID into the token.
   * It will authenticate the data by providing a signature signed by our key.
   */
  protected async mintToken(
    dcid: QUICConnectionId,
    peerHost: Host,
  ): Promise<Buffer> {
    return utils.mintToken(dcid, peerHost, this.crypto);
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
    peerHost: Host,
  ): Promise<QUICConnectionId | undefined> {
    return utils.validateToken(tokenBuffer, peerHost, this.crypto);
  }
}

export default QUICServer;
