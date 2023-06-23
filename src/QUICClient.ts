import type { PromiseCancellable } from '@matrixai/async-cancellable';
import type { ContextTimed } from '@matrixai/contexts';
import type { ClientCrypto, Host, Hostname, Port, VerifyCallback } from './types';
import type { Config } from './native/types';
import type QUICConnectionMap from './QUICConnectionMap';
import type {
  QUICConfig,
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
import { clientDefault } from './config';
import QUICSocket from './QUICSocket';
import QUICConnection from './QUICConnection';
import QUICConnectionId from './QUICConnectionId';

/**
 * You must provide a error handler `addEventListener('error')`.
 * Otherwise errors will just be ignored.
 *
 * Use the same event names.
 * However it needs to bubble up.
 * And the right target needs to be used.
 *
 * Events:
 * - clientError encapsulates:
 *   - socketError
 *   - connectionError
 * - clientDestroy
 * - socketStop
 * - connectionStream
 * - connectionStop
 * - streamDestroy
 */
interface QUICClient extends CreateDestroy {}
@CreateDestroy()
class QUICClient extends EventTarget {
  public readonly isSocketShared: boolean;
  protected socket: QUICSocket;
  protected logger: Logger;
  protected config: Config;
  protected _connection: QUICConnection;
  protected connectionMap: QUICConnectionMap;

  /**
   * Creates a QUIC Client
   *
   * @param opts
   * @param opts.host - peer host where `0.0.0.0` becomes `127.0.0.1` and `::` becomes `::1`
   * @param opts.port
   * @param opts.localHost - defaults to `::` (dualstack)
   * @param opts.localPort - defaults 0
   * @param opts.crypto - client only needs the ability to generate random bytes
   * @param opts.config - optional config
   * @param opts.socket - optional QUICSocket to use
   * @param opts.resolveHostname - optional hostname resolver
   * @param opts.reasonToCode - optional reason to code map
   * @param opts.codeToReason - optional code to reason map
   * @param opts.logger - optional logger
   */
  public static createQUICClient(
    opts: {
      host: Host | Hostname;
      port: Port;
      localHost?: Host | Hostname;
      localPort?: Port;
      crypto: {
        ops: ClientCrypto;
      };
      config?: Partial<QUICConfig>;
      socket?: QUICSocket;
      resolveHostname?: (hostname: Hostname) => Host | PromiseLike<Host>;
      reasonToCode?: StreamReasonToCode;
      codeToReason?: StreamCodeToReason;
      verifyCallback?: VerifyCallback;
      logger?: Logger;
    },
    ctx?: Partial<ContextTimed>,
  ): PromiseCancellable<QUICClient>;
  @timedCancellable(true, Infinity, errors.ErrorQUICClientCreateTimeOut)
  public static async createQUICClient(
    {
      host,
      port,
      localHost = '::' as Host,
      localPort = 0 as Port,
      crypto,
      config = {},
      socket,
      resolveHostname = utils.resolveHostname,
      reasonToCode,
      codeToReason,
      verifyCallback,
      logger = new Logger(`${this.name}`),
    }: {
      host: Host | Hostname;
      port: Port;
      localHost?: Host | Hostname;
      localPort?: Port;
      crypto: {
        ops: {
          randomBytes(data: ArrayBuffer): Promise<void>;
        };
      };
      config?: Partial<QUICConfig>;
      socket?: QUICSocket;
      resolveHostname?: (hostname: Hostname) => Host | PromiseLike<Host>;
      reasonToCode?: StreamReasonToCode;
      codeToReason?: StreamCodeToReason;
      verifyCallback?: VerifyCallback;
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
    let [host_] = await utils.resolveHost(host, resolveHostname);
    // If the target host is in fact an zero IP, it cannot be used
    // as a target host, so we need to resolve it to a non-zero IP
    // in this case, 0.0.0.0 is resolved to 127.0.0.1 and :: and ::0 is
    // resolved to ::1
    host_ = utils.resolvesZeroIP(host_);
    // This error promise is only used during `connection.start()`.
    const { p: socketErrorP, rejectP: rejectSocketErrorP } =
      utils.promise<never>();
    const handleQUICSocketError = (e: events.QUICSocketErrorEvent) => {
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
        host: localHost,
        port: localPort,
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
    const connection = new QUICConnection({
      type: 'client',
      scid,
      socket,
      remoteInfo: {
        host: host_,
        port,
      },
      config: quicConfig,
      reasonToCode,
      codeToReason,
      verifyCallback,
      logger: logger.getChild(
        `${QUICConnection.name} ${scid.toString().slice(32)}`,
      ),
    });
    const abortController = new AbortController();
    ctx.signal.addEventListener('abort', (r) => {
      abortController.abort(r);
    });
    console.log('bsd');
    try {
      await Promise.race([
        connection.start({ ...ctx, signal: abortController.signal }),
        socketErrorP.catch(e => {
          console.error(e);
          throw e;
        }),
      ]);
    } catch (e) {
      console.error(e);
      // In case the `connection.start` is on-going, we need to abort it
      abortController.abort(e);
      if (!isSocketShared) {
        // Stop is idempotent
        await socket.stop();
      }
      throw e;
    } finally {
      socket.removeEventListener('socketError', handleQUICSocketError);
    }
    console.log('bsd')
    const client = new this({
      socket,
      connection,
      isSocketShared,
      logger,
    });
    console.log('bsd')
    address = utils.buildAddress(host_, port);
    console.log('bsd')
    logger.info(`Created ${this.name} to ${address}`);
    return client;
  }

  /**
   * This must not throw any exceptions.
   */
  protected handleQUICSocketEvents = async (e: events.QUICSocketEvent) => {
    if (e instanceof events.QUICSocketErrorEvent) {
      // QUIC socket errors are re-emitted but a destroy takes place
      this.dispatchEvent(
        new events.QUICClientErrorEvent({
          detail: new errors.ErrorQUICClient('Socket error', {
            cause: e.detail,
          }),
        }),
      );
      try {
        // Force destroy means don't destroy gracefully
        await this.destroy({
          force: true,
        });
      } catch (e) {
        this.dispatchEvent(
          new events.QUICClientErrorEvent({
            detail: e.detail,
          }),
        );
      }
    } else if (e instanceof events.QUICSocketStopEvent) {
      // If a QUIC socket stopped, we immediately destroy
      // However, the stop will have its own constraints
      try {
        // Force destroy means don't destroy gracefully
        await this.destroy({
          force: true,
        });
      } catch (e) {
        this.dispatchEvent(
          new events.QUICClientErrorEvent({
            detail: e.detail,
          }),
        );
      }
    } else {
      this.dispatchEvent(e);
    }
  };

  /**
   * This must not throw any exceptions.
   */
  protected handleQUICConnectionEvents = async (
    e: events.QUICConnectionEvent,
  ) => {
    if (e instanceof events.QUICConnectionErrorEvent) {
      this.dispatchEvent(
        new events.QUICClientErrorEvent({
          detail: new errors.ErrorQUICClient('Connection error', {
            cause: e.detail,
          }),
        }),
      );
      try {
        // Force destroy means don't destroy gracefully
        await this.destroy({
          force: true,
        });
      } catch (e) {
        this.dispatchEvent(
          new events.QUICClientErrorEvent({
            detail: e.detail,
          }),
        );
      }
    } else if (e instanceof events.QUICConnectionStopEvent) {
      try {
        // Force destroy means don't destroy gracefully
        await this.destroy({
          force: true,
        });
      } catch (e) {
        this.dispatchEvent(
          new events.QUICClientErrorEvent({
            detail: e.detail,
          }),
        );
      }
    } else {
      this.dispatchEvent(e);
    }
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
    // Listen on all socket events
    socket.addEventListener('socketError', this.handleQUICSocketEvents);
    socket.addEventListener('socketStop', this.handleQUICSocketEvents);
    // Listen on all connection events
    connection.addEventListener(
      'connectionStream',
      this.handleQUICConnectionEvents,
    );
    connection.addEventListener(
      'connectionStop',
      this.handleQUICConnectionEvents,
    );
    connection.addEventListener(
      'connectionError',
      this.handleQUICConnectionEvents,
    );
    connection.addEventListener(
      'streamDestroy',
      this.handleQUICConnectionEvents,
    );
  }

  @ready(new errors.ErrorQUICClientDestroyed())
  public get host() {
    return this.socket.host;
  }

  @ready(new errors.ErrorQUICClientDestroyed())
  public get port() {
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
    const address = utils.buildAddress(this.socket.host, this.socket.port);
    this.logger.info(`Destroy ${this.constructor.name} on ${address}`);
    // Listen on all socket events
    this.socket.removeEventListener('socketError', this.handleQUICSocketEvents);
    this.socket.removeEventListener('socketStop', this.handleQUICSocketEvents);
    // Listen on all connection events
    this.connection.removeEventListener(
      'connectionStream',
      this.handleQUICConnectionEvents,
    );
    this.connection.removeEventListener(
      'connectionStop',
      this.handleQUICConnectionEvents,
    );
    this.connection.removeEventListener(
      'connectionError',
      this.handleQUICConnectionEvents,
    );
    this.connection.removeEventListener(
      'streamDestroy',
      this.handleQUICConnectionEvents,
    );
    await this._connection.stop({ force });
    if (!this.isSocketShared) {
      await this.socket.stop({ force });
    }
    this.dispatchEvent(new events.QUICClientDestroyEvent());
    this.logger.info(`Destroyed ${this.constructor.name} on ${address}`);
  }
}

export default QUICClient;
