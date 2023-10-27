import type {
  Host,
  Port,
  RemoteInfo,
  QUICServerCrypto,
  ResolveHostname,
  QUICConfig,
  QUICServerConfigInput,
  StreamCodeToReason,
  StreamReasonToCode,
} from './types';
import type { Header } from './native/types';
import Logger from '@matrixai/logger';
import { AbstractEvent, EventAll } from '@matrixai/events';
import {
  StartStop,
  ready,
  running,
  status,
} from '@matrixai/async-init/dist/StartStop';
import QUICSocket from './QUICSocket';
import QUICConnection from './QUICConnection';
import QUICConnectionId from './QUICConnectionId';
import { quiche, ConnectionErrorCode } from './native';
import { serverDefault } from './config';
import * as utils from './utils';
import * as events from './events';
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
   * Determines if socket is shared.
   */
  public readonly isSocketShared: boolean;

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
  protected socket: QUICSocket;
  protected crypto: QUICServerCrypto;
  protected config: QUICConfig;
  protected _closed: boolean = false;
  protected _closedP: Promise<void>;
  protected resolveClosedP: () => void;

  /**
   * Handles `EventQUICServerError`.
   *
   * Internal errors will be thrown upwards to become an uncaught exception.
   *
   * @throws {errors.ErrorQUICServerInternal}
   */
  protected handleEventQUICServerError = (evt: events.EventQUICServerError) => {
    const error = evt.detail;
    // Log out error for debugging
    this.logger.info(utils.formatError(error));
    if (error instanceof errors.ErrorQUICServerInternal) {
      throw error;
    }
    this.dispatchEvent(
      new events.EventQUICServerClose({
        detail: error,
      }),
    );
  };

  /**
   * Handles `EventQUICServerClose`.
   * Registered once.
   *
   * This event propagates errors minus the internal errors.
   *
   * If this event is dispatched first before `QUICServer.stop`, it represents
   * an evented close. This could originate from the `QUICSocket`. If it was
   * from the `QUICSocket`, then here it will stop all connections with an
   * transport code `InternalError`.
   */
  protected handleEventQUICServerClose = async (
    evt: events.EventQUICServerClose,
  ) => {
    const error = evt.detail;
    if (!(error instanceof errors.ErrorQUICServerSocketNotRunning)) {
      // Only stop the socket if it was encapsulated
      if (!this.isSocketShared) {
        // Remove the stopped listener, as we intend to stop the socket
        this.socket.removeEventListener(
          events.EventQUICSocketStopped.name,
          this.handleEventQUICSocketStopped,
        );
        try {
          // Force stop of the socket even if it had a connection map
          // This is because we will be stopping this `QUICServer` which
          // which will stop all the relevant connections
          await this.socket.stop({ force: true });
        } catch (e) {
          const e_ = new errors.ErrorQUICServerInternal(
            'Failed to stop QUICSocket',
            { cause: e },
          );
          this.dispatchEvent(new events.EventQUICServerError({ detail: e_ }));
        }
      }
    }
    this._closed = true;
    this.resolveClosedP();
    if (this[running] && this[status] !== 'stopping') {
      if (error !== undefined) {
        await this.stop({
          isApp: false,
          errorCode: ConnectionErrorCode.InternalError,
          reason: Buffer.from(error.description),
          force: true,
        });
      } else {
        await this.stop({ force: true });
      }
    }
  };

  /**
   * Handles all `EventQUICSocket` events.
   * Registered only if the socket is encapsulated.
   */
  protected handleEventQUICSocket = (evt: EventAll) => {
    if (evt.detail instanceof AbstractEvent) {
      this.dispatchEvent(evt.detail.clone());
    }
  };

  /**
   * Handles `EventQUICSocketStopped`.
   * Registered once.
   *
   * It is an error if the socket was stopped while `QUICServer` wasn't
   * stopped.
   */
  protected handleEventQUICSocketStopped = () => {
    const e = new errors.ErrorQUICServerSocketNotRunning();
    this.removeEventListener(EventAll.name, this.handleEventQUICSocket);
    this.dispatchEvent(
      new events.EventQUICServerError({
        detail: e,
      }),
    );
  };

  /**
   * Handles all `EventQUICConnection` events.
   */
  protected handleEventQUICConnection = (evt: EventAll) => {
    if (evt.detail instanceof AbstractEvent) {
      this.dispatchEvent(evt.detail.clone());
    }
  };

  /**
   * Handles `EventQUICConnectionSend`.
   *
   * This will propagate the connection send buffers to the socket.
   * This may be concurrent and multiple send events may be processed
   * at a time.
   */
  protected handleEventQUICConnectionSend = async (
    evt: events.EventQUICConnectionSend,
  ) => {
    // We want to skip this if the socket has already ended
    if (!(this.socket[running] && this.socket[status] !== 'stopping')) return;
    try {
      await this.socket.send_(
        evt.detail.msg,
        evt.detail.port,
        evt.detail.address,
      );
    } catch (e) {
      const e_ = new errors.ErrorQUICServerInternal(
        'Failed to send data on the QUICSocket',
        {
          data: evt.detail,
          cause: e,
        },
      );
      this.dispatchEvent(new events.EventQUICServerError({ detail: e_ }));
    }
  };

  /**
   * Handles `EventQUICConnectionStopped`.
   * Registered once.
   */
  protected handleEventQUICConnectionStopped = (
    evt: events.EventQUICConnectionStopped,
  ) => {
    const quicConnection = evt.target as QUICConnection;
    quicConnection.removeEventListener(
      events.EventQUICConnectionSend.name,
      this.handleEventQUICConnectionSend,
    );
    quicConnection.removeEventListener(
      EventAll.name,
      this.handleEventQUICConnection,
    );
    this.socket.connectionMap.delete(quicConnection.connectionId);
  };

  /**
   * Constructs a QUIC server.
   *
   * @param opts
   * @param opts.crypto - server needs to be able to sign and verify symmetrically.
   * @param opts.config - defaults to `serverDefault`
   * @param opts.socket - optional shared QUICSocket
   * @param opts.resolveHostname - defaults to using OS DNS resolver
   * @param opts.reasonToCode - maps stream error reasons to stream error codes
   * @param opts.codeToReason - maps stream error codes to reasons
   * @param opts.minIdleTimeout - can be set to override the starting timeout
   *                              for accepted connections
   * @param opts.logger
   */
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
    const { p: closedP, resolveP: resolveClosedP } = utils.promise();
    this._closedP = closedP;
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
   * Server is no longer accepting connections.
   */
  public get closed() {
    return this._closed;
  }

  public get closedP(): Promise<void> {
    return this._closedP;
  }

  /**
   * Starts the QUICServer.
   *
   * @param opts
   * @param opts.host - target host, ignored if socket is shared
   * @param opts.port - target port, ignored if socket is shared
   * @param opts.reuseAddr - reuse existing port
   * @param opts.ipv6Only - force using IPv6 even when using `::`
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
      { once: true },
    );
    this.socket.addEventListener(
      events.EventQUICSocketStopped.name,
      this.handleEventQUICSocketStopped,
      { once: true },
    );
    if (!this.isSocketShared) {
      this.socket.addEventListener(EventAll.name, this.handleEventQUICSocket);
    }
    this._closed = false;
    this.logger.info(`Started ${this.constructor.name} on ${address}`);
  }

  /**
   * Stops the QUICServer.
   *
   * @param opts
   * @param opts.isApp - whether the stop is initiated by the application
   * @param opts.errorCode - the error code to send to the peers
   * @param opts.reason - the reason to send to the peers
   * @param opts.force - force controls whether to cancel streams or wait for
   *                     streams to close gracefully
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
      } = {}) {
    let address: string | undefined;
    if (this.socket[running]) {
      address = utils.buildAddress(this.socket.host, this.socket.port);
    }
    this.logger.info(
      `Stop ${this.constructor.name}${address != null ? ` on ${address}` : ''}`,
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
        }),
      );
    }
    await Promise.all(connectionsDestroyP);
    if (!this._closed) {
      this.dispatchEvent(new events.EventQUICServerClose());
    }
    // Wait for the socket to be closed
    await this._closedP;
    // Resets the `closedP`
    const { p: closedP, resolveP: resolveClosedP } = utils.promise();
    this._closedP = closedP;
    this.resolveClosedP = resolveClosedP;
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
        this.handleEventQUICSocket,
      );
    }
    this.logger.info(
      `Stopped ${this.constructor.name}${
        address != null ? ` on ${address}` : ''
      }`,
    );
  }

  /**
   * Accepts new connection from the socket.
   *
   * This performs the new connection handshake.
   *
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
      config: { ...this.config }, // Config must be copied in case it is updated
      reasonToCode: this.reasonToCode,
      codeToReason: this.codeToReason,
      logger: this.logger.getChild(`${QUICConnection.name} ${scid.toString()}`),
    });
    // This unstarted connection is set to the connection map which allows
    // concurrent received packets to trigger the `recv` and `send` pair.
    this.socket.connectionMap.set(connection.connectionId, connection);
    connection.addEventListener(
      events.EventQUICConnectionSend.name,
      this.handleEventQUICConnectionSend,
    );
    connection.addEventListener(
      events.EventQUICConnectionStopped.name,
      this.handleEventQUICConnectionStopped,
      { once: true },
    );
    connection.addEventListener(EventAll.name, this.handleEventQUICConnection);
    try {
      await connection.start(
        {
          data,
          remoteInfo,
        },
        { timer: this.minIdleTimeout },
      );
    } catch (e) {
      connection.removeEventListener(
        events.EventQUICConnectionSend.name,
        this.handleEventQUICConnectionSend,
      );
      connection.removeEventListener(
        events.EventQUICConnectionStopped.name,
        this.handleEventQUICConnectionStopped,
      );
      connection.removeEventListener(
        EventAll.name,
        this.handleEventQUICConnection,
      );
      this.socket.connectionMap.delete(connection.connectionId);
      // This could be due to a runtime IO exception or start timeout
      throw new errors.ErrorQUICServerNewConnection(
        'Failed to start accepted connection',
        { cause: e },
      );
    }
    // This connection is now started and ready to be used
    this.dispatchEvent(
      new events.EventQUICServerConnection({ detail: connection }),
    );
    return connection;
  }

  public updateCrypto(crypto: Partial<QUICServerCrypto>): void {
    this.crypto = {
      ...this.crypto,
      ...crypto,
    };
  }

  /**
   * Updates the `QUICConfig` for new connections.
   * It will not affect existing connections, they will keep using the old
   * `QUICConfig`.
   */
  public updateConfig(config: Partial<QUICServerConfigInput>): void {
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
