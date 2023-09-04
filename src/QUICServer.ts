import type {
  Host,
  RemoteInfo,
  StreamCodeToReason,
  StreamReasonToCode,
  QUICConfig,
  QUICServerCrypto,
  QUICServerConfigInput,
  ResolveHostname,
} from './types';
import type { Header } from './native/types';
import Logger from '@matrixai/logger';
import { StartStop, ready, running } from '@matrixai/async-init/dist/StartStop';
import QUICSocket from './QUICSocket';
import QUICConnection from './QUICConnection';
import QUICConnectionId from './QUICConnectionId';
import { quiche } from './native';
import { serverDefault } from './config';
import * as events from './events';
import * as utils from './utils';
import * as errors from './errors';

interface QUICServer extends StartStop {}
@StartStop({
  eventStart: events.EventQUICServerStart,
  eventStarted: events.EventQUICServerStarted,
  eventStop: events.EventQUICServerStop,
  eventStopped: events.EventQUICServerStopped,
})
class QUICServer {
  /**
   * Determines whether the socket is injected or not
   */
  public readonly isSocketShared: boolean;

  /**
   * Crypto utility used during connection negotiation.
   */
  public crypto: QUICServerCrypto;

  /**
   * Custom reason to code converter for new connections.
   */
  public reasonToCode?: StreamReasonToCode;

  /**
   * Custom code to reason converted for new connections.
   */
  public codeToReason?: StreamCodeToReason;

  /**
   * The minimum idle timeout to be used for new connections.
   */
  public minIdleTimeout?: number;

  protected logger: Logger;

  /**
   * Configuration for new connections.
   */
  protected config: QUICConfig;

  /**
   * Socket that this server is registered on.
   */
  protected socket: QUICSocket;

  /**
   * This must be attached once.
   */
  protected handleEventQUICServerError = async (
    evt: events.EventQUICServerError,
  ) => {
    const error = evt.detail;
    this.logger.error(
      `${error.name}${'description' in error ? `: ${error.description}` : ''}${
        error.message !== undefined ? `- ${error.message}` : ''
      }`,
    );
    // If stop fails, it is a software bug
    await this.stop({ force: true });
  };

  /**
   * This must be attached once.
   */
  protected handleEventQUICSocketError = async (
    evt: events.EventQUICSocketError,
  ) => {
    if (!this.isSocketShared) {
      // This can be idempotent
      // If stop fails, it is a software bug
      await this.socket.stop({ force: true });
    }
    this.dispatchEvent(
      new events.EventQUICServerError({
        detail: evt.detail,
      }),
    );
  };

  /**
   * If the QUIC socket stopped while this is running, then this is
   * a runtime error.
   * This must be attached once.
   */
  protected handleEventQUICSocketStopped = () => {
    this.dispatchEvent(
      new events.EventQUICServerError({
        detail: new errors.ErrorQUICServerSocketNotRunning(),
      }),
    );
  };

  /**
   * If the connection timed out, it's an error
   * If the connection experiences runtime IO errors, it's an error
   * If the remote side closed the connection with an error, it's an error
   * If the remote side closed the connection without error, it's not an error
   * If the local side closed the connection with an error, it's not an error
   * If the local side closed the connection without error, it's not an error
   */
  protected handleEventQUICConnectionError = async (
    evt: events.EventQUICConnectionError,
  ) => {
    const connection = evt.target as QUICConnection;
    const error = evt.detail;
    this.logger.error(
      `${error.name}${
        'description' in error ? `: ${error.description}` : ''
      }${error.message !== undefined ? `- ${error.message}` : ''}`,
    );
    // Because force is used, streams are immediately canceled
    // The connection will send its `CONNECTION_CLOSE` frame
    // However quiche will wait in a draining state until idle timeout
    // There is no expected acknowledgement from the other side
    // If packets are still received, they can be ignored
    // If stop fails, it is a software bug
    await connection.stop({ force: true });
  };

  protected handleEventQUICConnectionStopped = (evt: events.EventQUICConnectionStopped) => {
    const connection = evt.target as QUICConnection;
    this.socket.connectionMap.delete(connection.connectionId);
  };

  public constructor(opts: {
    crypto: QUICServerCrypto;
    config: QUICServerConfigInput;
    resolveHostname?: ResolveHostname;
    reasonToCode?: StreamReasonToCode;
    codeToReason?: StreamCodeToReason;
    minIdleTimeout?: number;
    logger?: Logger;
  });
  public constructor(opts: {
    crypto: QUICServerCrypto;
    config: QUICServerConfigInput;
    socket: QUICSocket;
    reasonToCode?: StreamReasonToCode;
    codeToReason?: StreamCodeToReason;
    minIdleTimeout?: number;
    logger?: Logger;
  });
  public constructor({
    crypto,
    config,
    socket,
    resolveHostname = utils.resolveHostname,
    reasonToCode,
    codeToReason,
    minIdleTimeout,
    logger,
  }: {
    crypto: QUICServerCrypto;
    config: QUICServerConfigInput;
    socket?: QUICSocket;
    resolveHostname?: ResolveHostname;
    reasonToCode?: StreamReasonToCode;
    codeToReason?: StreamCodeToReason;
    minIdleTimeout?: number;
    logger?: Logger;
  }) {
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
    this.config = {
      ...serverDefault,
      ...config,
    };
    this.reasonToCode = reasonToCode;
    this.codeToReason = codeToReason;
    this.minIdleTimeout = minIdleTimeout;
  }

  @ready(new errors.ErrorQUICServerNotRunning())
  public get host(): string {
    return this.socket.host;
  }

  @ready(new errors.ErrorQUICServerNotRunning())
  public get port(): number {
    return this.socket.port;
  }

  /**
   * Starts the QUICServer
   *
   * If the QUIC socket is shared, then it is expected that it is already started.
   * In which case, the `host` and `port` parameters here are ignored.
   */
  public async start({
    host = '::',
    port = 0,
    reuseAddr,
    ipv6Only,
  }: {
    host?: string;
    port?: number;
    reuseAddr?: boolean;
    ipv6Only?: boolean;
  } = {}) {
    let address: string;
    if (!this.isSocketShared) {
      address = utils.buildAddress(host, port);
      this.logger.info(`Start ${this.constructor.name} on ${address}`);
      await this.socket.start({ host, port, reuseAddr, ipv6Only });
      address = utils.buildAddress(this.socket.host, this.socket.port);
    } else {
      // If the socket is shared, it must already be started
      if (!this.socket[running]) {
        throw new errors.ErrorQUICServerSocketNotRunning();
      }
      address = utils.buildAddress(this.socket.host, this.socket.port);
      this.logger.info(`Start ${this.constructor.name} on ${address}`);
    }
    this.socket.addEventListener(
      events.EventQUICSocketError.name,
      this.handleEventQUICSocketError,
      { once: true },
    );
    this.socket.addEventListener(
      events.EventQUICSocketStopped.name,
      this.handleEventQUICSocketStopped,
      { once: true },
    );
    this.addEventListener(
      events.EventQUICServerError.name,
      this.handleEventQUICServerError,
      { once: true }
    );
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
    const address = utils.buildAddress(this.socket.host, this.socket.port);
    this.logger.info(`Stop ${this.constructor.name} on ${address}`);
    const destroyProms: Array<Promise<void>> = [];
    for (const connection of this.socket.connectionMap.serverConnections.values()) {
      destroyProms.push(
        connection.stop({
          applicationError: true,
          force,
        }).then(() => {
          connection.removeEventListener(
            events.EventQUICConnectionError.name,
            this.handleEventQUICConnectionError
          );
          connection.removeEventListener(
            events.EventQUICConnectionStopped.name,
            this.handleEventQUICConnectionStopped
          );
        })
      );
    }
    await Promise.all(destroyProms);
    // Remove just before stopping to avoid handling expected stop
    this.socket.removeEventListener(
      events.EventQUICSocketStopped.name,
      this.handleEventQUICSocketStopped,
    );
    if (!this.isSocketShared) {
      await this.socket.stop();
    }
    this.socket.removeEventListener(
      events.EventQUICSocketError.name,
      this.handleEventQUICSocketError,
    );
    this.removeEventListener(
      events.EventQUICServerError.name,
      this.handleEventQUICSocketError,
    );
    this.logger.info(`Stopped ${this.constructor.name} on ${address}`);
  }

  /**
   * @internal
   */
  public async acceptConnection(
    remoteInfo: RemoteInfo,
    header: Header,
    dcid: QUICConnectionId,
    data: Uint8Array,
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
      const versionDatagram = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
      const versionDatagramLength = quiche.negotiateVersion(
        header.scid,
        header.dcid,
        versionDatagram,
      );
      try {
        await this.socket.send(
          versionDatagram,
          0,
          versionDatagramLength,
          remoteInfo.port,
          remoteInfo.host,
        );
      } catch (e) {
        throw new errors.ErrorQUICServerNewConnection(
          `Failed to send version datagram ${peerAddress}`,
          { cause: e },
        );
      }
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
      try {
        await this.socket.send(
          retryDatagram,
          0,
          retryDatagramLength,
          remoteInfo.port,
          remoteInfo.host,
        );
      } catch (e) {
        throw new errors.ErrorQUICServerNewConnection(
          `Failed to send stateless retry datagram to ${peerAddress}`,
          { cause: e },
        );
      }
      return;
    }
    // At this point in time, the packet's DCID is the originally-derived DCID.
    // While the DCID embedded in the token is the original DCID that the client first created.
    const dcidOriginal = await this.validateToken(
      Buffer.from(token),
      remoteInfo.host,
    );
    if (dcidOriginal == null) {
      // Failed validation due to missing DCID
      return;
    }
    // Check that the newly-derived DCID (passed in as the SCID) is the same
    // length as the packet DCID.
    // This ensures that the derivation process hasn't changed.
    if (scid.byteLength !== header.dcid.byteLength) {
      // Failed validation due to mismatched length
      return;
    }
    // Here we shall re-use the originally-derived DCID as the SCID
    const newScid = new QUICConnectionId(header.dcid);
    // Construct a QUIC connection that isn't yet started
    const connection = new QUICConnection({
      type: 'server',
      scid: newScid,
      dcid: dcidOriginal,
      socket: this.socket,
      remoteInfo,
      config: this.config,
      reasonToCode: this.reasonToCode,
      codeToReason: this.codeToReason,
      logger: this.logger.getChild(`${QUICConnection.name} ${scid.toString()}`),
    });
    // This unstarted connection is set to the connection map which allows
    // concurrent received packets to trigger the `recv` and `send` pair.
    this.socket.connectionMap.set(connection.connectionId, connection);
    connection.addEventListener(
      events.EventQUICConnectionError.name,
      this.handleEventQUICConnectionError,
      { once: true },
    );
    connection.addEventListener(
      events.EventQUICConnectionStopped.name,
      this.handleEventQUICConnectionStopped,
      { once: true },
    );
    const connectionP = connection.start({ timer: this.minIdleTimeout });
    try {
      // Process initial data for the new accepted connection
      await connection.withMonitor(async (mon) => {
        await mon.lock(connection.lockingKey)();
        await connection.recv(data, remoteInfo, mon);
        await connection.send(mon);
      });
      await connectionP;
    } catch (e) {
      connection.removeEventListener(
        events.EventQUICConnectionStopped.name,
        this.handleEventQUICConnectionStopped
      );
      connection.removeEventListener(
        events.EventQUICConnectionError.name,
        this.handleEventQUICConnectionError
      );
      this.socket.connectionMap.delete(connection.connectionId);
      // This could be due to a runtime IO exception or start timeout
      throw new errors.ErrorQUICServerNewConnection(
        'Failed to start accepted connection',
        { cause: e }
      );
    }
    this.dispatchEvent(
      new events.EventQUICServerConnection({ detail: connection }),
    );
    return connection;
  }

  /**
   * This updates the `QUICConfig` used when new connections are established.
   * Only the parameters that are provided are updated.
   * It will not affect existing connections, they will keep using the old `QUICConfig`
   */
  public updateConfig(
    config: Partial<QUICServerConfigInput>
  ): void {
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
