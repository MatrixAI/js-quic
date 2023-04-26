import type { Crypto, Host, Hostname, Port } from './types';
import type { Config } from './native/types';
import type { QUICConfig } from './config';
import type QUICConnectionMap from './QUICConnectionMap';
import type { StreamCodeToReason, StreamReasonToCode } from './types';
import Logger from '@matrixai/logger';
import { CreateDestroy, ready } from '@matrixai/async-init/dist/CreateDestroy';
import { destroyed, running } from '@matrixai/async-init';
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
 * Events:
 * - error - (could be a QUICSocketErrorEvent OR QUICClientErrorEvent)
 * - destroy
 */
interface QUICClient extends CreateDestroy {}
@CreateDestroy()
class QUICClient extends EventTarget {
  public readonly isSocketShared: boolean;
  protected socket: QUICSocket;
  protected logger: Logger;
  protected crypto: {
    key: ArrayBuffer;
    ops: Crypto;
  };
  protected config: Config;
  protected _connection: QUICConnection;
  protected connectionMap: QUICConnectionMap;

  /**
   * Creates a QUIC Client
   * @param options
   * @param options.host - target host, if wildcard, it is resolved to its localhost `0.0.0.0` becomes `127.0.0.1` and `::` becomes `::1`
   * @param options.port - defaults to 0
   * @param options.localHost
   * @param options.localPort
   */
  public static async createQUICClient({
    host,
    port,
    localHost = '::' as Host,
    localPort = 0 as Port,
    crypto,
    socket,
    resolveHostname = utils.resolveHostname,
    reasonToCode,
    codeToReason,
    logger = new Logger(`${this.name}`),
    config = {},
  }: {
    host: Host | Hostname;
    port: Port;
    localHost?: Host | Hostname;
    localPort?: Port;
    crypto: {
      key: ArrayBuffer;
      ops: Crypto;
    };
    socket?: QUICSocket;
    resolveHostname?: (hostname: Hostname) => Host | PromiseLike<Host>;
    reasonToCode?: StreamReasonToCode;
    codeToReason?: StreamCodeToReason;
    logger?: Logger;
    config?: Partial<QUICConfig>;
  }) {
    const quicConfig = {
      ...clientDefault,
      ...config,
    };
    const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
    await crypto.ops.randomBytes(scidBuffer);
    const scid = new QUICConnectionId(scidBuffer);
    let address = utils.buildAddress(host, port);
    logger.info(`Create ${this.name} to ${address}`);
    let [host_] = await utils.resolveHost(host, resolveHostname);
    // If the target host is in fact an zero IP, it cannot be used
    // as a target host, so we need to resolve it to a non-zero IP
    // in this case, 0.0.0.0 is resolved to 127.0.0.1 and :: and ::0 is
    // resolved to ::1
    host_ = utils.resolvesZeroIP(host_);
    const { p: errorP, rejectP: rejectErrorP } = utils.promise<never>();
    const handleQUICSocketError = (e: events.QUICSocketErrorEvent) => {
      rejectErrorP(e.detail);
    };
    const handleConnectionError = (e: events.QUICConnectionErrorEvent) => {
      rejectErrorP(e.detail);
    };
    let isSocketShared: boolean;
    if (socket == null) {
      socket = new QUICSocket({
        crypto,
        resolveHostname,
        logger: logger.getChild(QUICSocket.name),
      });
      socket.addEventListener('error', handleQUICSocketError, { once: true });
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
    const connection = await QUICConnection.connectQUICConnection({
      scid,
      socket,
      remoteInfo: {
        host: host_,
        port,
      },
      config: quicConfig,
      reasonToCode,
      codeToReason,
      logger: logger.getChild(
        `${QUICConnection.name} ${scid.toString().slice(32)}-${Math.floor(
          Math.random() * 100,
        )}`,
      ),
    });
    connection.addEventListener('error', handleConnectionError, { once: true });
    logger.debug('CLIENT TRIGGER SEND');
    // This will not raise an error
    await connection.send();
    // This will wait to be established, while also rejecting on error
    try {
      await Promise.race([connection.establishedP, errorP]);
    } catch (e) {
      logger.error(e.toString());
      // Console.error(e);
      logger.debug(`Is shared?: ${isSocketShared}`);
      // Waiting for connection to destroy
      if (connection[destroyed] === false) {
        const destroyedProm = utils.promise<void>();
        connection.addEventListener(
          'destroy',
          () => {
            destroyedProm.resolveP();
          },
          {
            once: true,
          },
        );
        await destroyedProm.p;
      }
      if (!isSocketShared) {
        // Stop our own socket
        await socket.stop();
      }
      throw e;
    }

    // Remove the temporary socket error handler
    socket.removeEventListener('error', handleQUICSocketError);
    // Remove the temporary connection error handler
    connection.removeEventListener('error', handleConnectionError);

    // Now we create the client

    const client = new QUICClient({
      crypto,
      socket,
      connection,
      isSocketShared,
      logger,
    });
    address = utils.buildAddress(host_, port);
    logger.info(`Created ${this.name} to ${address}`);
    return client;
  }

  /**
   * Handle QUIC socket errors
   * This is only used if the socket is not shared
   * If the socket is shared, then it is expected that the user
   * would listen on error events on the socket itself
   * Otherwise this will propagate such errors to the server
   */
  protected handleQUICSocketError = (e: events.QUICSocketErrorEvent) => {
    this.dispatchEvent(
      new events.QUICClientErrorEvent({
        detail: e,
      }),
    );
  };

  /**
   * Handles QUIC connection errors
   * This is always used because QUICClient is
   * one to one with QUICConnection
   */
  protected handleQUICConnectionError = (
    e: events.QUICConnectionErrorEvent,
  ) => {
    this.dispatchEvent(
      new events.QUICClientErrorEvent({
        detail: e,
      }),
    );
  };

  public constructor({
    crypto,
    socket,
    isSocketShared,
    connection,
    logger,
  }: {
    crypto: {
      key: ArrayBuffer;
      ops: Crypto;
    };
    socket: QUICSocket;
    isSocketShared: boolean;
    connection: QUICConnection;
    logger: Logger;
  }) {
    super();
    this.logger = logger;
    this.crypto = crypto;
    this.socket = socket;
    this.isSocketShared = isSocketShared;
    // Registers itself to the socket
    this.socket.registerClient(this);
    if (!isSocketShared) {
      this.socket.addEventListener('error', this.handleQUICSocketError);
    }
    this._connection = connection;
    this._connection.addEventListener('error', this.handleQUICConnectionError);
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
    // This is supposed to return a specialised INTERFACE
    // so we aren't just returning QUICConnection
    // the difference between internal interface and external interface
    return this._connection;
  }

  public async destroy({
    force = false,
  }: {
    force?: boolean;
  } = {}) {
    const address = utils.buildAddress(this.socket.host, this.socket.port);
    this.logger.info(`Destroy ${this.constructor.name} on ${address}`);

    // We may want to allow one to specialise this
    await this._connection.destroy({ force });
    if (!this.isSocketShared) {
      await this.socket.stop();
      this.socket.removeEventListener('error', this.handleQUICSocketError);
    }
    this.dispatchEvent(new events.QUICClientDestroyEvent());
    this.logger.info(`Destroyed ${this.constructor.name} on ${address}`);
  }

  // Unlike the server
  // upon a connection failing/destroying
  // it should result in the CLIENT also being destroyed
}

export default QUICClient;
