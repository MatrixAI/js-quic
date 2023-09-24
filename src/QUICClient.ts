import type { PromiseCancellable } from '@matrixai/async-cancellable';
import type { ContextTimed, ContextTimedInput } from '@matrixai/contexts';
import type {
  Host,
  Port,
  QUICClientCrypto,
  QUICClientConfigInput,
  ResolveHostname,
  StreamCodeToReason,
  StreamReasonToCode,
} from './types';
import type { Config } from './native/types';
import Logger from '@matrixai/logger';
import { AbstractEvent, EventAll } from '@matrixai/events';
import { running } from '@matrixai/async-init';
import {
  CreateDestroy,
  destroyed,
  ready,
  status,
} from '@matrixai/async-init/dist/CreateDestroy';
import { timedCancellable, context } from '@matrixai/contexts/dist/decorators';
import QUICSocket from './QUICSocket';
import QUICConnection from './QUICConnection';
import QUICConnectionId from './QUICConnectionId';
import { quiche, ConnectionErrorCode } from './native';
import { clientDefault, minIdleTimeout } from './config';
import * as utils from './utils';
import * as events from './events';
import * as errors from './errors';

interface QUICClient extends CreateDestroy {}
@CreateDestroy({
  eventDestroy: events.EventQUICClientDestroy,
  eventDestroyed: events.EventQUICClientDestroyed,
})
class QUICClient extends EventTarget {
  /**
   * Creates a QUIC client.
   *
   * @param opts
   * @param opts.host - target host where wildcards are resolved to point locally.
   * @param opts.port - target port
   * @param opts.localHost - defaults to `::` (dual-stack)
   * @param opts.localPort - defaults 0
   * @param opts.socket - optional shared QUICSocket
   * @param opts.crypto - client needs to generate random bytes
   * @param opts.config - defaults to `clientDefault`
   * @param opts.resolveHostname - defaults to using OS DNS resolver
   * @param opts.reuseAddr - reuse existing port
   * @param opts.ipv6Only - force using IPv6 even when using `::`
   * @param opts.reasonToCode - maps stream error reasons to stream error codes
   * @param opts.codeToReason - maps stream error codes to reasons
   * @param opts.logger
   * @param ctx
   *
   * @throws {errors.ErrorQUICClientCreateTimeout} - if timed out
   * @throws {errors.ErrorQUICClientSocketNotRunning} - if shared socket is not running
   * @throws {errors.ErrorQUICClientInvalidHost} - if local host is incompatible with target host
   * @throws {errors.ErrorQUICSocket} - if socket start failed
   * @throws {errors.ErrorQUICConnection} - if connection start failed
   */
  public static createQUICClient(
    opts: {
      host: string;
      port: number;
      localHost?: string;
      localPort?: number;
      crypto: QUICClientCrypto;
      config?: QUICClientConfigInput;
      resolveHostname?: ResolveHostname;
      reuseAddr?: boolean;
      ipv6Only?: boolean;
      reasonToCode?: StreamReasonToCode;
      codeToReason?: StreamCodeToReason;
      logger?: Logger;
    },
    ctx?: Partial<ContextTimedInput>,
  ): PromiseCancellable<QUICClient>;
  public static createQUICClient(
    opts: {
      host: string;
      port: number;
      socket: QUICSocket;
      crypto: QUICClientCrypto;
      config?: QUICClientConfigInput;
      reuseAddr?: boolean;
      ipv6Only?: boolean;
      reasonToCode?: StreamReasonToCode;
      codeToReason?: StreamCodeToReason;
      logger?: Logger;
    },
    ctx?: Partial<ContextTimedInput>,
  ): PromiseCancellable<QUICClient>;
  @timedCancellable(true, minIdleTimeout, errors.ErrorQUICClientCreateTimeout)
  public static async createQUICClient(
    {
      host,
      port,
      localHost = '::',
      localPort = 0,
      socket,
      crypto,
      config = {},
      resolveHostname = utils.resolveHostname,
      reuseAddr,
      ipv6Only,
      reasonToCode,
      codeToReason,
      logger = new Logger(`${this.name}`),
    }: {
      host: string;
      port: number;
      localHost?: string;
      localPort?: number;
      socket?: QUICSocket;
      crypto: QUICClientCrypto;
      config?: QUICClientConfigInput;
      resolveHostname?: ResolveHostname;
      reuseAddr?: boolean;
      ipv6Only?: boolean;
      reasonToCode?: StreamReasonToCode;
      codeToReason?: StreamCodeToReason;
      logger?: Logger;
    },
    @context ctx: ContextTimed,
  ): Promise<QUICClient> {
    let address = utils.buildAddress(host, port);
    logger.info(`Create ${this.name} to ${address}`);
    const quicConfig = {
      ...clientDefault,
      ...config,
    };
    // SCID for the client is randomly generated
    // DCID is also randomly generated, but by the quiche library
    const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
    await crypto.ops.randomBytes(scidBuffer);
    const scid = new QUICConnectionId(scidBuffer);
    // Validating host and port types
    let [host_, udpType] = await utils.resolveHost(host, resolveHostname);
    const port_ = utils.toPort(port);
    // If the target host is in fact a zero IP, it cannot be used
    // as a target host, so we need to resolve it to a non-zero IP
    // in this case, 0.0.0.0 is resolved to 127.0.0.1 and :: and ::0 is
    // resolved to ::1.
    host_ = utils.resolvesZeroIP(host_);
    let isSocketShared: boolean;
    if (socket == null) {
      const [localHost_] = await utils.resolveHost(localHost, resolveHostname);
      const localPort_ = utils.toPort(localPort);
      socket = new QUICSocket({
        resolveHostname,
        logger: logger.getChild(QUICSocket.name),
      });
      isSocketShared = false;
      await socket.start({
        host: localHost_,
        port: localPort_,
        reuseAddr,
        ipv6Only,
      });
    } else {
      isSocketShared = true;
      // If the socket is shared, it must already be started
      if (!socket[running]) {
        throw new errors.ErrorQUICServerSocketNotRunning();
      }
    }
    try {
      // Check that the target `host` is compatible with the bound socket host
      // Also transform it if need be
      host_ = utils.validateTarget(
        socket.host,
        socket.type,
        host_,
        udpType,
        errors.ErrorQUICClientInvalidHost,
      );
    } catch (e) {
      if (!isSocketShared) {
        await socket.stop({ force: true });
      }
      throw e;
    }
    let connection: QUICConnection;
    try {
      connection = new QUICConnection({
        type: 'client',
        scid,
        serverName: host,
        socket,
        remoteInfo: {
          host: host_,
          port: port_,
        },
        config: quicConfig,
        reasonToCode,
        codeToReason,
        logger: logger.getChild(`${QUICConnection.name} ${scid.toString()}`),
      });
    } catch (e) {
      if (!isSocketShared) {
        await socket.stop({ force: true });
      }
      throw e;
    }
    const client = new this({
      socket,
      connection,
      isSocketShared,
      logger,
    });
    if (!isSocketShared) {
      socket.addEventListener(EventAll.name, client.handleEventQUICSocket);
    }
    socket.addEventListener(
      events.EventQUICSocketStopped.name,
      client.handleEventQUICSocketStopped,
      { once: true },
    );
    connection.addEventListener(
      EventAll.name,
      client.handleEventQUICConnection,
    );
    connection.addEventListener(
      events.EventQUICConnectionError.name,
      client.handleEventQUICConnectionError,
    );
    connection.addEventListener(
      events.EventQUICConnectionSend.name,
      client.handleEventQUICConnectionSend,
    );
    connection.addEventListener(
      events.EventQUICConnectionStopped.name,
      client.handleEventQUICConnectionStopped,
      { once: true },
    );
    client.addEventListener(
      events.EventQUICClientError.name,
      client.handleEventQUICClientError,
    );
    client.addEventListener(
      events.EventQUICClientClose.name,
      client.handleEventQUICClientClose,
      { once: true },
    );
    // We have to start the connection after associating the event listeners on
    // the client, because the client bridges the push flow from the connection
    // to the socket.
    socket.connectionMap.set(connection.connectionId, connection);
    try {
      await connection.start(undefined, ctx);
    } catch (e) {
      socket.connectionMap.delete(connection.connectionId);
      socket.removeEventListener(
        events.EventQUICSocketStopped.name,
        client.handleEventQUICSocketStopped,
      );
      if (!isSocketShared) {
        socket.removeEventListener(EventAll.name, client.handleEventQUICSocket);
        await socket.stop({ force: true });
      }
      connection.removeEventListener(
        EventAll.name,
        client.handleEventQUICConnection,
      );
      connection.removeEventListener(
        events.EventQUICConnectionError.name,
        client.handleEventQUICConnectionError,
      );
      connection.removeEventListener(
        events.EventQUICConnectionSend.name,
        client.handleEventQUICConnectionSend,
      );
      connection.removeEventListener(
        events.EventQUICConnectionStopped.name,
        client.handleEventQUICConnectionStopped,
      );
      client.removeEventListener(
        events.EventQUICClientError.name,
        client.handleEventQUICClientError,
      );
      client.removeEventListener(
        events.EventQUICClientClose.name,
        client.handleEventQUICClientClose,
      );
      throw e;
    }
    address = utils.buildAddress(host_, port);
    logger.info(`Created ${this.name} to ${address}`);
    return client;
  }

  public readonly isSocketShared: boolean;
  public readonly connection: QUICConnection;

  protected logger: Logger;
  protected socket: QUICSocket;
  protected config: Config;
  protected _closed: boolean = false;
  protected closedP: Promise<void>;
  protected resolveClosedP: () => void;

  /**
   * Handles `EventQUICClientError`.
   *
   * This event propagates all errors from `QUICClient` and `QUICConnection`.
   * This means you can expect that `QUICConnection` errors will be logged
   * twice.
   *
   * Internal errors will be thrown upwards to become an uncaught exception.
   *
   * @throws {errors.ErrorQUICClientInternal}
   * @throws {errors.ErrorQUICConnectionInternal}
   */
  protected handleEventQUICClientError = (evt: events.EventQUICClientError) => {
    const error = evt.detail;
    if (
      (error instanceof errors.ErrorQUICConnectionLocal ||
        error instanceof errors.ErrorQUICConnectionPeer) &&
      ((!error.data.isApp &&
        error.data.errorCode === ConnectionErrorCode.NoError) ||
        (error.data.isApp && error.data.errorCode === 0))
    ) {
      // Log out the excpetion as an info when it is graceful
      this.logger.info(utils.formatError(error));
    } else {
      // Log out the exception as an error when it is not graceful
      this.logger.error(utils.formatError(error));
    }
    if (
      error instanceof errors.ErrorQUICClientInternal ||
      error instanceof errors.ErrorQUICConnectionInternal
    ) {
      throw error;
    }
    this.dispatchEvent(
      new events.EventQUICClientClose({
        detail: error,
      }),
    );
  };

  /**
   * Handles `EventQUICClientClose`.
   * Registered once.
   *
   * This event propagates errors minus the internal errors.
   * All QUIC connections always close with an error, even if it is a graceful.
   *
   * If this event is dispatched first before `QUICClient.destroy`, it represents
   * an evented close. This could originate from the `QUICSocket` or
   * `QUICConnection`. If it was from the `QUICSocket`, then here it will stop
   * the `QUICConnection` with an transport code `InternalError`. If it was
   * from `QUICConnection`, then the `QUICConnection` will already be closing.
   * Therefore attempting to stop the `QUICConnection` will be idempotent.
   */
  protected handleEventQUICClientClose = async (
    evt: events.EventQUICClientClose,
  ) => {
    const error = evt.detail;
    // Remove the error listener as we intend to stop the connection
    this.connection.removeEventListener(
      events.EventQUICConnectionError.name,
      this.handleEventQUICConnectionError,
    );
    await this.connection.stop({
      isApp: false,
      errorCode: ConnectionErrorCode.InternalError,
      reason: Buffer.from(error.description),
      force: true,
    });
    if (!(error instanceof errors.ErrorQUICClientSocketNotRunning)) {
      // Only stop the socket if it was encapsulated
      if (!this.isSocketShared) {
        // Remove the stopped listener, as we intend to stop the socket
        this.socket.removeEventListener(
          events.EventQUICSocketStopped.name,
          this.handleEventQUICSocketStopped,
        );
        try {
          // Force stop of the socket even if it had a connection map
          // This is because we will be stopping this `QUICClient` which
          // which will stop all the relevant connections
          await this.socket.stop({ force: true });
        } catch (e) {
          const e_ = new errors.ErrorQUICClientInternal(
            'Failed to stop QUICSocket',
            { cause: e },
          );
          this.dispatchEvent(new events.EventQUICClientError({ detail: e_ }));
        }
      }
    }
    this._closed = true;
    this.resolveClosedP();
    if (!this[destroyed] && this[status] !== 'destroying') {
      await this.destroy({ force: true });
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
   * It is an error if the socket was stopped while `QUICClient` wasn't
   * destroyed.
   */
  protected handleEventQUICSocketStopped = () => {
    const e = new errors.ErrorQUICClientSocketNotRunning();
    this.removeEventListener(EventAll.name, this.handleEventQUICSocket);
    this.dispatchEvent(
      new events.EventQUICClientError({
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
   * Handles `EventQUICConnectionError`.
   *
   * All connection errors are redispatched as client errors.
   */
  protected handleEventQUICConnectionError = (
    evt: events.EventQUICConnectionError,
  ) => {
    const error = evt.detail;
    this.dispatchEvent(new events.EventQUICClientError({ detail: error }));
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
    try {
      if (!(this.socket[running] && this.socket[status] !== 'stopping')) return;
      // Uses the raw send method as the port and address is fully resolved
      // and determined by `QUICConnection`.
      await this.socket.send_(
        evt.detail.msg,
        evt.detail.port,
        evt.detail.address,
      );
    } catch (e) {
      const e_ = new errors.ErrorQUICClientInternal(
        'Failed to send data on the QUICSocket',
        {
          data: evt.detail,
          cause: e,
        },
      );
      this.dispatchEvent(new events.EventQUICClientError({ detail: e_ }));
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
      events.EventQUICConnectionError.name,
      this.handleEventQUICConnectionError,
    );
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

  public constructor({
    socket,
    isSocketShared,
    connection,
    logger,
  }: {
    socket: QUICSocket;
    isSocketShared: boolean;
    connection: QUICConnection;
    logger: Logger;
  }) {
    super();
    this.logger = logger;
    this.socket = socket;
    this.isSocketShared = isSocketShared;
    this.connection = connection;
    const { p: closedP, resolveP: resolveClosedP } = utils.promise();
    this.closedP = closedP;
    this.resolveClosedP = resolveClosedP;
  }

  @ready(new errors.ErrorQUICClientDestroyed())
  public get host(): Host {
    return this.connection.remoteHost;
  }

  @ready(new errors.ErrorQUICClientDestroyed())
  public get port(): Port {
    return this.connection.remotePort;
  }

  @ready(new errors.ErrorQUICClientDestroyed())
  public get localHost(): Host {
    return this.socket.host;
  }

  @ready(new errors.ErrorQUICClientDestroyed())
  public get localPort(): Port {
    return this.socket.port;
  }

  public get closed() {
    return this._closed;
  }

  /**
   * Destroy the QUICClient.
   *
   * @param opts
   * @param opts.isApp - whether the destroy is initiated by the application
   * @param opts.errorCode - the error code to send to the peer
   * @param opts.reason - the reason to send to the peer
   * @param opts.force - force controls whether to cancel streams or wait for
   *                     streams to close gracefully
   */
  public async destroy({
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
    if (this.connection[running]) {
      address = utils.buildAddress(
        this.connection.remoteHost,
        this.connection.remotePort,
      );
    }
    this.logger.info(
      `Destroy ${this.constructor.name}${
        address != null ? ` to ${address}` : ''
      }`,
    );
    if (!this._closed) {
      await this.connection.stop({
        isApp,
        errorCode,
        reason,
        force,
      });
    }
    await this.closedP;
    this.removeEventListener(
      events.EventQUICClientError.name,
      this.handleEventQUICClientError,
    );
    this.removeEventListener(
      events.EventQUICClientClose.name,
      this.handleEventQUICClientClose,
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
    // Connection listeners do not need to be removed
    // Because it is handled by `this.handleEventQUICConnectionStopped`.
    this.logger.info(
      `Destroyed ${this.constructor.name}${
        address != null ? ` to ${address}` : ''
      }`,
    );
  }
}

export default QUICClient;
