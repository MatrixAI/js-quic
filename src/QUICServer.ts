import type {
  Host,
  Port,
  RemoteInfo,
  StreamCodeToReason,
  StreamReasonToCode,
  QUICConfig,
  QUICServerCrypto,
  QUICServerConfigInput,
  ResolveHostname,
} from './types';
import type { Header, ConnectionErrorCode } from './native/types';
import Logger from '@matrixai/logger';
import { AbstractEvent, EventAll } from '@matrixai/events';
import { StartStop, ready, running, status } from '@matrixai/async-init/dist/StartStop';
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

  protected _closed: boolean = false;
  public readonly closedP: Promise<void>;
  protected resolveClosedP: () => void;

  protected handleEventQUICServerError = (
    evt: events.EventQUICServerError,
  ) => {
    const error = evt.detail;
    this.logger.error(utils.formatError(error));
    if (error instanceof errors.ErrorQUICServerInternal) {
      // Use `EventError` to deal with this
      throw error;
    }
    this.dispatchEvent(
      new events.EventQUICConnectionClose({
        detail: error
      })
    );
  };

  /**
   * Close event for QUICServer.
   * This means we are closing, but an error state may have already occurred.
   * Unlike node's net objects, `close` doesn't mean closed.
   */
  protected handleEventQUICServerClose = async (
    evt: events.EventQUICServerClose
  ) => {
    const error = evt.detail;

    // ERROR could be socket not running or undefined
    // This means if the socket is not running, the socket is already stopped
    // If it is undefined, it means it's a regular normal stop of the quic server

    // So here we are saying that if we are doing a normal stop
    // Connections are first shutdown, then close event is dispatched
    // We end up stopping the socket if it is encapsulated

    if (!(error instanceof errors.ErrorQUICServerSocketNotRunning)) {
      // Only stop the socket if it was encapsulated
      if (!this.isSocketShared) {
        // Remove the stopped listener, as we intend to stop the socket
        this.socket.removeEventListener(
          events.EventQUICSocketStopped.name,
          this.handleEventQUICSocketStopped
        );
        try {
          // Force stop of the socket even if it had a connection map
          // This is because we will be stopping this `QUICServer` which
          // which will stop all the relevant connections
          await this.socket.stop({ force: true });
        } catch (e) {
          // Caller error would mean a domain error here
          const e_ = new errors.ErrorQUICServerInternal(
            'Failed to stop QUICSocket',
            { cause: e }
          );
          this.dispatchEvent(
            new events.EventQUICServerError({ detail: e_ })
          );
        }
      }
    }
    this._closed = true;
    this.resolveClosedP();
    if (this[running] && this[status] !== 'stopping') {
      if (error !== undefined) {
        // Failing this is a software error
        await this.stop({
          isApp: true,
          errorCode: 1, // 1 is reserved for general application error
          reason: Buffer.from(error.message),
          force: true,
        });
      } else {
        // Failing this is a software error
        await this.stop({ force: true });
      }
    }
  };

  // This should only be done if it is encapsulated
  protected handleEventQUICSocket = (evt: EventAll) => {
    if (evt.detail instanceof AbstractEvent) {
      this.dispatchEvent(evt.detail.clone());
    }
  };

  /**
   * If the QUIC socket stopped while this is running, then this is
   * a runtime error.
   * This must be attached once.
   */
  protected handleEventQUICSocketStopped = () => {
    const e = new errors.ErrorQUICServerSocketNotRunning();
    this.removeEventListener(
      EventAll.name,
      this.handleEventQUICSocket
    );
    this.dispatchEvent(
      new events.EventQUICServerError({
        detail: e,
      }),
    );
  };

  protected handleEventQUICConnection = (evt: EventAll) => {
    if (evt.detail instanceof AbstractEvent) {
      this.dispatchEvent(evt.detail.clone());
    }
  };

  /**
   * This must be attached multiple times.
   */
  protected handleEventQUICConnectionSend = async (evt: events.EventQUICConnectionSend) => {
    try {
      await this.socket.send_(
        evt.detail.msg,
        evt.detail.port,
        evt.detail.address,
      );
    } catch (e) {
      // Caller error means a domain error here
      const e_ = new errors.ErrorQUICServerInternal(
        'Failed to send data on the QUICSocket',
        {
          data: evt.detail,
          cause: e,
        }
      );
      this.dispatchEvent(
        new events.EventQUICServerError({ detail: e_ })
      );
    }
  };

  /**
   * This must be attached once.
   */
  protected handleEventQUICConnectionStopped = (
    evt: events.EventQUICConnectionStopped
  ) => {
    const quicConnection = evt.target as QUICConnection;
    quicConnection.removeEventListener(
      events.EventQUICConnectionSend.name,
      this.handleEventQUICConnectionSend
    );
    quicConnection.removeEventListener(
      EventAll.name,
      this.handleEventQUICConnection
    );
    this.socket.connectionMap.delete(quicConnection.connectionId);
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
    this.config = {
      ...serverDefault,
      ...config,
    };
    this.reasonToCode = reasonToCode;
    this.codeToReason = codeToReason;
    this.minIdleTimeout = minIdleTimeout;
    const {
      p: closedP,
      resolveP: resolveClosedP,
    } = utils.promise();
    this.closedP = closedP;
    this.resolveClosedP = resolveClosedP;
  }

  @ready(new errors.ErrorQUICServerNotRunning())
  public get host(): Host {
    return this.socket.host;
  }

  @ready(new errors.ErrorQUICServerNotRunning())
  public get port(): Port {
    return this.socket.port;
  }

  /**
   * This just means the server is no longer accepting connections.
   * Like deregistered from a server.
   */
  public get closed() {
    return this._closed;
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
    this.socket.setServer(this);
    this.addEventListener(
      events.EventQUICServerError.name,
      this.handleEventQUICServerError,
    );
    this.addEventListener(
      events.EventQUICServerClose.name,
      this.handleEventQUICServerClose,
      { once: true }
    );
    this.socket.addEventListener(
      events.EventQUICSocketStopped.name,
      this.handleEventQUICSocketStopped,
      { once: true },
    );
    if (!this.isSocketShared) {
      this.socket.addEventListener(
        EventAll.name,
        this.handleEventQUICSocket
      );
    }
    this.logger.info(`Started ${this.constructor.name} on ${address}`);
  }

  /**
   * Stops the QUICServer
   */
  public async stop({
    isApp = true,
    errorCode = 0,
    reason = new Uint8Array(),
    force = true,
    }:
      | {
          isApp: false;
          errorCode?: ConnectionErrorCode;
          reason?: Uint8Array;
          force?: boolean;
        }
      | {
          isApp?: true;
          errorCode?: number;
          reason?: Uint8Array;
          force?: boolean;
        } = {},
  ) {
    let address: string | undefined;
    if (this.socket[running]) {
      address = utils.buildAddress(this.socket.host, this.socket.port);
    }
    this.logger.info(
      `Stop ${this.constructor.name}${address != null ? ` on ${address}` : ''}`
    );
    // Stop answering new connections
    this.socket.unsetServer();
    const connectionsDestroyP: Array<Promise<void>> = [];
    for (const connection of this.socket.connectionMap.serverConnections.values()) {
      connectionsDestroyP.push(
        connection.stop({
          isApp,
          errorCode,
          reason,
          force,
        })
      );
    }
    // This will wait for connection timeouts to occur
    // It might be a bit slow, if that's the case
    await Promise.all(connectionsDestroyP);
    if (!this._closed) {
      // If this succeeds, then we are just transitioned to close
      // This will trigger noop recursion, that's fine
      this.dispatchEvent(
        new events.EventQUICServerClose()
      );
    }
    // Wait for the socket to be closed
    await this.closedP;
    this.removeEventListener(
      events.EventQUICServerError.name,
      this.handleEventQUICServerError,
    );
    this.removeEventListener(
      events.EventQUICServerClose.name,
      this.handleEventQUICServerClose,
    );
    // The socket may not have been stopped if it is shared
    // In which case we just remove our listener here
    this.socket.removeEventListener(
      events.EventQUICSocketStopped.name,
      this.handleEventQUICSocketStopped,
    );
    if (!this.isSocketShared) {
      this.socket.removeEventListener(
        EventAll.name,
        this.handleEventQUICSocket
      );
    }
    this.logger.info(
      `Stopped ${this.constructor.name}${address != null ? ` on ${address}` : ''}`
    );
  }

  /**
   * @internal
   */
  @ready(new errors.ErrorQUICServerNotRunning())
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
        await this.socket.send_(
          versionDatagram,
          0,
          versionDatagramLength,
          remoteInfo.port,
          remoteInfo.host,
        );
      } catch (e) {
        // This is a caller error
        // Not a domain error for QUICServer
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
        await this.socket.send_(
          retryDatagram,
          0,
          retryDatagramLength,
          remoteInfo.port,
          remoteInfo.host,
        );
      } catch (e) {
        // This is a caller error
        // Not a domain error for QUICServer
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
      events.EventQUICConnectionSend.name,
      this.handleEventQUICConnectionSend
    );
    connection.addEventListener(
      events.EventQUICConnectionStopped.name,
      this.handleEventQUICConnectionStopped,
      { once: true },
    );
    connection.addEventListener(
      EventAll.name,
      this.handleEventQUICConnection
    );
    try {
      await connection.start(
        {
          data,
          remoteInfo
        },
        { timer: this.minIdleTimeout }
      );
    } catch (e) {
      connection.removeEventListener(
        events.EventQUICConnectionSend.name,
        this.handleEventQUICConnectionSend
      );
      connection.removeEventListener(
        events.EventQUICConnectionStopped.name,
        this.handleEventQUICConnectionStopped
      );
      connection.removeEventListener(
        EventAll.name,
        this.handleEventQUICConnection
      );
      this.socket.connectionMap.delete(connection.connectionId);
      // This could be due to a runtime IO exception or start timeout
      // Failing this is a caller error
      throw new errors.ErrorQUICServerNewConnection(
        'Failed to start accepted connection',
        { cause: e }
      );
    }
    // This connection is now started and ready to be used
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
