import type { PromiseCancellable } from '@matrixai/async-cancellable';
import type { ContextTimed, ContextTimedInput } from '@matrixai/contexts';
import type { Host, Port, QUICClientCrypto, QUICClientConfigInput, ResolveHostname } from './types';
import type { Config } from './native/types';
import type {
  StreamCodeToReason,
  StreamReasonToCode,
} from './types';
import Logger from '@matrixai/logger';
import { running } from '@matrixai/async-init';
import { CreateDestroy, destroyed, ready, status } from '@matrixai/async-init/dist/CreateDestroy';
import { timedCancellable, context } from '@matrixai/contexts/dist/decorators';
import { AbstractEvent, EventAll } from '@matrixai/events';
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
   * Creates a QUIC Client
   *
   * @param opts
   * @param opts.host - peer host where `0.0.0.0` becomes `127.0.0.1` and `::` becomes `::1`
   * @param opts.port
   * @param opts.localHost - defaults to `::` (dual-stack)
   * @param opts.localPort - defaults 0
   * @param opts.crypto - client only needs the ability to generate random bytes
   * @param opts.config - optional config
   * @param opts.socket - optional QUICSocket to use
   * @param opts.resolveHostname - optional hostname resolver
   * @param opts.reasonToCode - optional reason to code map
   * @param opts.codeToReason - optional code to reason map
   * @param opts.logger - optional logger
   * @param ctx
   *
   * @throws {errors.ErrorQUICClientCreateTimeout} - if it timed out
   * @throws {errors.ErrorQUICClientInvalidHost} - incompatible target host with local host
   * @throws {errors.ErrorQUICClientSocketNotRunning} - if injected socket is not running
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
    let [host_, udpType] = await utils.resolveHost(
      host,
      resolveHostname
    );
    const port_ = utils.toPort(port);
    // If the target host is in fact a zero IP, it cannot be used
    // as a target host, so we need to resolve it to a non-zero IP
    // in this case, 0.0.0.0 is resolved to 127.0.0.1 and :: and ::0 is
    // resolved to ::1
    host_ = utils.resolvesZeroIP(host_);
    let isSocketShared: boolean;
    if (socket == null) {
      const [localHost_] = await utils.resolveHost(
        localHost,
        resolveHostname
      );
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
        errors.ErrorQUICClientInvalidHost
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
    socket.addEventListener(
      events.EventQUICSocketStopped.name,
      client.handleEventQUICSocketStopped,
      { once: true }
    );
    if (!isSocketShared) {
      socket.addEventListener(
        EventAll.name,
        client.handleEventQUICSocket
      );
    }
    connection.addEventListener(
      events.EventQUICConnectionError.name,
      client.handleEventQUICConnectionError
    );
    connection.addEventListener(
      events.EventQUICConnectionStopped.name,
      client.handleEventQUICConnectionStopped,
      { once: true }
    );
    connection.addEventListener(
      events.EventQUICConnectionSend.name,
      client.handleEventQUICConnectionSend
    );
    connection.addEventListener(
      EventAll.name,
      client.handleEventQUICConnection
    );
    client.addEventListener(
      events.EventQUICClientError.name,
      client.handleEventQUICClientError
    );
    client.addEventListener(
      events.EventQUICClientClose.name,
      client.handleEventQUICClientClose,
      { once: true }
    );
    // We have to start the connection after associating the event listeners on the client
    // The client bridges the push flow from the connection to the socket
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
        socket.removeEventListener(
          EventAll.name,
          client.handleEventQUICSocket
        );
        // This can be idempotent
        // If stop fails, it is a software bug
        await socket.stop({ force: true });
      }
      connection.removeEventListener(
        events.EventQUICConnectionError.name,
        client.handleEventQUICConnectionError
      );
      connection.removeEventListener(
        events.EventQUICConnectionStopped.name,
        client.handleEventQUICConnectionStopped,
      );
      connection.removeEventListener(
        events.EventQUICConnectionSend.name,
        client.handleEventQUICConnectionSend
      );
      connection.removeEventListener(
        EventAll.name,
        client.handleEventQUICConnection
      );
      client.removeEventListener(
        events.EventQUICClientError.name,
        client.handleEventQUICClientError
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
  public readonly closedP: Promise<void>;

  protected socket: QUICSocket;
  protected logger: Logger;
  protected config: Config;
  protected _closed: boolean = false;
  protected resolveClosedP: () => void;

  protected handleEventQUICClientError = (evt: events.EventQUICClientError) => {
    const error = evt.detail;
    if (
      (
        error instanceof errors.ErrorQUICConnectionLocal
        ||
        error instanceof errors.ErrorQUICConnectionPeer
      )
      && (
        (!error.data.isApp && error.data.errorCode === ConnectionErrorCode.NoError)
        ||
        (error.data.isApp && error.data.errorCode === 0)
      )
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
      // Use `EventError` to deal with this
      throw error;
    }
    this.dispatchEvent(
      new events.EventQUICClientClose({
        detail: error
      })
    );
  };

  protected handleEventQUICClientClose = async (
    evt: events.EventQUICClientClose
  ) => {
    const error = evt.detail;
    // If the error is about the connection, then it is already stopping
    // We just need to wait for it
    // If not, this will stop the connection with the derived error
    this.connection.removeEventListener(
      events.EventQUICConnectionError.name,
      this.handleEventQUICConnectionError
    );
    await this.connection.stop({
      isApp: true,
      errorCode: 1, // 1 is reserved for general application error
      reason: Buffer.from(error.message),
      force: true
    });
    if (!(error instanceof errors.ErrorQUICClientSocketNotRunning)) {
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
          const e_ = new errors.ErrorQUICClientInternal(
            'Failed to stop QUICSocket',
            { cause: e }
          );
          this.dispatchEvent(
            new events.EventQUICClientError({ detail: e_ })
          );
        }
      }
    }
    this._closed = true;
    this.resolveClosedP();
    if (!this[destroyed] && this[status] !== 'destroying') {
      // Failing this is a software error
      await this.destroy({ force: true });
    }
  };

  // This should only be done if it is encapsulated
  protected handleEventQUICSocket = (evt: EventAll) => {
    if (evt.detail instanceof AbstractEvent) {
      this.dispatchEvent(evt.detail.clone());
    }
  };

  /**
   * Attached once
   */
  protected handleEventQUICSocketStopped = () => {
    const e = new errors.ErrorQUICClientSocketNotRunning();
    this.removeEventListener(
      EventAll.name,
      this.handleEventQUICSocket
    );
    this.dispatchEvent(
      new events.EventQUICClientError({
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
   * All connection errors are redispatched as client errors.
   * Connecition errors encompass both graceful closes and non-graceful closes.
   * This also includes `ErrorQUICConnectionInternal`
   */
  protected handleEventQUICConnectionError = (evt: events.EventQUICConnectionError) => {
    const error = evt.detail;
    this.dispatchEvent(new events.EventQUICClientError(
      { detail: error }
    ));
  };

  /**
   * This must be attached multiple times.
   */
  protected handleEventQUICConnectionSend = async (evt: events.EventQUICConnectionSend) => {
    try {
      // we want to skip this if the socket has already ended
      if (!(this.socket[running] && this.socket[status] !== 'stopping')) return;
      await this.socket.send_(
        evt.detail.msg,
        evt.detail.port,
        evt.detail.address,
      );
    } catch (e) {
      // Caller error means a domain error here
      const e_ = new errors.ErrorQUICClientInternal(
        'Failed to send data on the QUICSocket',
        {
          data: evt.detail,
          cause: e,
        }
      );
      this.dispatchEvent(
        new events.EventQUICClientError({ detail: e_ })
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
      events.EventQUICConnectionError.name,
      this.handleEventQUICConnectionError
    );
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
    const {
      p: closedP,
      resolveP: resolveClosedP,
    } = utils.promise();
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
   * Force is true now
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
        } = {},
  ) {
    let address: string | undefined;
    if (this.connection[running]) {
      address = utils.buildAddress(
        this.connection.remoteHost,
        this.connection.remotePort
      );
    }
    this.logger.info(
      `Destroy ${this.constructor.name}${address != null ? ` to ${address}` : ''}`
    );
    if (!this._closed) {
      // Failing this is a software error
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
      this.handleEventQUICClientError
    );
    this.removeEventListener(
      events.EventQUICClientClose.name,
      this.handleEventQUICClientClose
    );
    // The socket may not have been stopped if it is shared
    // In which case we just remove our listener here
    this.socket.removeEventListener(
      events.EventQUICSocketStopped.name,
      this.handleEventQUICSocketStopped
    );
    if (!this.isSocketShared) {
      this.socket.removeEventListener(
        EventAll.name,
        this.handleEventQUICSocket
      );
    }
    // Connection listeners do not need to be removed
    // Because it is handled by `this.handleEventQUICConnectionStopped`.
    this.logger.info(
      `Destroyed ${this.constructor.name}${address != null ? ` to ${address}` : ''}`
    );
  }
}

export default QUICClient;
