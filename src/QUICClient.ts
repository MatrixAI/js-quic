import type { PromiseCancellable } from '@matrixai/async-cancellable';
import type { ContextTimed, ContextTimedInput } from '@matrixai/contexts';
import type { QUICClientCrypto, Host, QUICClientConfigInput, ResolveHostname } from './types';
import type { Config } from './native/types';
import type {
  StreamCodeToReason,
  StreamReasonToCode,
} from './types';
import Logger from '@matrixai/logger';
import { CreateDestroy, ready } from '@matrixai/async-init/dist/CreateDestroy';
import { running } from '@matrixai/async-init';
import { timedCancellable, context } from '@matrixai/contexts/dist/decorators';
import { quiche } from './native';
import * as utils from './utils';
import * as errors from './errors';
import * as events from './events';
import { clientDefault, minIdleTimeout } from './config';
import QUICSocket from './QUICSocket';
import QUICConnection from './QUICConnection';
import QUICConnectionId from './QUICConnectionId';

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
      localHost?: string;
      localPort?: number;
      crypto: QUICClientCrypto;
      config?: QUICClientConfigInput;
      socket: QUICSocket;
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
      crypto,
      config = {},
      socket,
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
      crypto: QUICClientCrypto;
      config?: QUICClientConfigInput;
      socket?: QUICSocket;
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
    let [host_] = await utils.resolveHost(
      host,
      resolveHostname
    );
    const [localHost_] = await utils.resolveHost(
      localHost,
      resolveHostname
    );
    const port_ = utils.toPort(port);
    const localPort_ = utils.toPort(localPort);
    // If the target host is in fact a zero IP, it cannot be used
    // as a target host, so we need to resolve it to a non-zero IP
    // in this case, 0.0.0.0 is resolved to 127.0.0.1 and :: and ::0 is
    // resolved to ::1
    host_ = utils.resolvesZeroIP(host_);
    // FIXME: is this even needed?
    // This error promise is only used during `connection.start()`.
    const { p: socketErrorP, rejectP: rejectSocketErrorP } =
      utils.promise<never>();
    const handleQUICSocketError = (e: events.EventQUICSocketError) => {
      rejectSocketErrorP(e.detail);
    };
    let isSocketShared: boolean;
    if (socket == null) {
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
      if (!socket[running]) {
        throw new errors.ErrorQUICClientSocketNotRunning();
      }
      isSocketShared = true;
    }
    socket.addEventListener('socketError', handleQUICSocketError, {
      once: true,
    });
    // Check that the target `host` is compatible with the bound socket host
    if (
      socket.type === 'ipv4' &&
      !utils.isIPv4(host_) &&
      !utils.isIPv4MappedIPv6(host_)
    ) {
      throw new errors.ErrorQUICClientInvalidHost(
        `Cannot connect to ${host_} on an IPv4 QUICClient`,
      );
    } else if (
      socket.type === 'ipv6' &&
      (!utils.isIPv6(host_) || utils.isIPv4MappedIPv6(host_))
    ) {
      throw new errors.ErrorQUICClientInvalidHost(
        `Cannot connect to ${host_} on an IPv6 QUICClient`,
      );
    } else if (socket.type === 'ipv4&ipv6' && !utils.isIPv6(host_)) {
      throw new errors.ErrorQUICClientInvalidHost(
        `Cannot send to ${host_} on a dual stack QUICClient`,
      );
    } else if (
      socket.type === 'ipv4' &&
      utils.isIPv4MappedIPv6(socket.host) &&
      !utils.isIPv4MappedIPv6(host_)
    ) {
      throw new errors.ErrorQUICClientInvalidHost(
        `Cannot connect to ${host_} an IPv4 mapped IPv6 QUICClient`,
      );
    }

    const abortController = new AbortController();
    const abortHandler = () => {
      abortController.abort(ctx.signal.reason);
    };
    ctx.signal.addEventListener('abort', abortHandler);

    // This needs to turn to a constructor
    // With a concurrent start
    const connection = new QUICConnection({
      type: 'client',
      scid,
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
    const client = new this({
      socket,
      connection,
      isSocketShared,
      logger,
    });

    // The issue is calling `send` here
    // Is where we are awaiting the connection to be ready
    // While this is happening the socket is doing concurrent recv & send pairs
    // We will need to add ourselves to the socket as well

    socket.connectionMap.set(connection.connectionId, connection);
    connection.addEventListener(
      events.EventQUICConnectionError.name,
      client.handleEventQUICConnectionError,
      { once: true },
    );
    connection.addEventListener(
      events.EventQUICConnectionStopped.name,
      client.handleEventQUICConnectionStopped,
      { once: true },
    );
    try {
      await connection.start(ctx);
    } catch (e) {
      connection.removeEventListener(
        events.EventQUICConnectionStopped.name,
        client.handleEventQUICConnectionStopped
      );
      connection.removeEventListener(
        events.EventQUICConnectionError.name,
        client.handleEventQUICConnectionError
      );
      socket.connectionMap.delete(connection.connectionId);
      if (!client.isSocketShared) {
        // This can be idempotent
        // If stop fails, it is a software bug
        await socket.stop({ force: true });
      }
      // TODO: if creation failed then we throw this failure
      //  Need a new error
      throw e;
    }
    // Setting up client events
    client.addEventListener( events.EventQUICClientError.name, client.handleEventQUICClientError, {once: true})
    // Setting up socket events
    socket.addEventListener(events.EventQUICSocketError.name, client.handleEventQUICSocketError, {once: true});
    socket.addEventListener(events.EventQUICSocketStopped.name, client.handleEventQUICSocketStopped, {once: true});
    // Setting up connection events
    connection.addEventListener(events.EventQUICConnectionStream.name, client.handleEventQUICConnectionStream);
    connection.addEventListener(events.EventQUICConnectionError.name, client.handleEventQUICConnectionError, {once: true});
    connection.addEventListener(events.EventQUICConnectionStopped.name, client.handleEventQUICConnectionStopped, {once: true});

    address = utils.buildAddress(host_, port);
    logger.info(`Created ${this.name} to ${address}`);
    return client;
  }

  public readonly isSocketShared: boolean;
  protected socket: QUICSocket;
  protected logger: Logger;
  protected config: Config;
  protected _connection: QUICConnection;

  protected handleEventQUICClientError = async (evt: events.EventQUICClientError) => {
    const error = evt.detail;
    this.logger.error(
      `${error.name}${'description' in error ? `: ${error.description}` : ''}${
        error.message !== undefined ? `- ${error.message}` : ''
      }`,
    );
    // If destroy fails, it is a software bug
    await this.destroy({ force: true });
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
      new events.EventQUICClientError({
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
      new events.EventQUICClientError({
        detail: new errors.ErrorQUICClientSocketNotRunning(),
      }),
    );
  };

  // re-emit the event upwards
  protected handleEventQUICConnectionStream = (e: events.EventQUICConnectionStream) => {
    this.dispatchEvent(e.clone());
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
    this.dispatchEvent(new events.EventQUICClientError({ detail: Error('QUIC CONNECTION ENDED')}))
    // TODO: trigger stop of QUICClient as well.
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
    this._connection = connection;
  }

  @ready(new errors.ErrorQUICClientDestroyed())
  public get host(): string {
    return this.socket.host;
  }

  @ready(new errors.ErrorQUICClientDestroyed())
  public get port(): number {
    return this.socket.port;
  }

  @ready(new errors.ErrorQUICClientDestroyed())
  public get connection() {
    return this._connection;
  }

  /**
   * Force destroy means that we don't destroy gracefully.
   * This should only occur when an error occurs from the socket
   * or from the connection. If the socket is stopped or the connection
   * is stopped, then we also force destroy.
   * Suppose the socket failed, and we attempt to stop the connection.
   * The connection may attempt to stop gracefully. That would result in
   * an exception because the socket send method no longer works.
   */
  public async destroy({
    force = false,
  }: {
    force?: boolean;
  } = {}) {
    this.logger.info(`Destroy ${this.constructor.name}`);
    // Remove connection events
    this._connection.removeEventListener(events.EventQUICConnectionStopped.name, this.handleEventQUICConnectionStopped);
    this._connection.removeEventListener(events.EventQUICConnectionError.name, this.handleEventQUICConnectionError);
    this._connection.addEventListener(events.EventQUICConnectionStream.name, this.handleEventQUICConnectionStream);
    // remove socket events
    this.socket.addEventListener(events.EventQUICSocketStopped.name, this.handleEventQUICSocketStopped);
    this.socket.addEventListener(events.EventQUICSocketError.name, this.handleEventQUICSocketError);
    // Remove client events
    this.addEventListener( events.EventQUICClientError.name, this.handleEventQUICClientError)
    // Listen on all connection events
    await this._connection.stop({ force });
    if (!this.isSocketShared) {
      await this.socket.stop({ force });
    }
    this.logger.info(`Destroyed ${this.constructor.name}`);
  }
}

export default QUICClient;
