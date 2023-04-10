import type { ConnectionId, ConnectionIdString, Crypto, Host, Hostname, Port } from './types';
import type { Header, Config, Connection } from './native/types';
import Logger from '@matrixai/logger';
import {
  CreateDestroy,
  ready,
  status
} from '@matrixai/async-init/dist/CreateDestroy';
import { running } from '@matrixai/async-init';
import { Quiche, quiche, Type } from './native';
import * as utils from './utils';
import * as errors from './errors';
import * as events from './events';
import QUICSocket from './QUICSocket';
import QUICConnection from './QUICConnection';
import QUICConnectionMap from './QUICConnectionMap';
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
    logger = new Logger(`${this.name}`),
  }: {
    host: Host | Hostname,
    port: Port,
    localHost?: Host | Hostname,
    localPort?: Port,
    crypto: {
      key: ArrayBuffer;
      ops: Crypto;
    },
    socket?: QUICSocket;
    resolveHostname?: (hostname: Hostname) => Host | PromiseLike<Host>;
    logger?: Logger;
  }) {
    let isSocketShared: boolean;
    const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
    await crypto.ops.randomBytes(scidBuffer);
    const scid = new QUICConnectionId(scidBuffer);
    const config = new quiche.Config();
    // TODO: disable this (because we still need to run with TLS)
    config.verifyPeer(false);

    // Here we go...
    // finally we actually can LOG KEYS!!!!
    config.logKeys();
    config.grease(true);
    config.setMaxIdleTimeout(5000);
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
    let address = utils.buildAddress(host, port);
    logger.info(`Create ${this.name} to ${address}`);
    let [host_] = await utils.resolveHost(host, resolveHostname);
    // If the target host is in fact an zero IP, it cannot be used
    // as a target host, so we need to resolve it to a non-zero IP
    // in this case, 0.0.0.0 is resolved to 127.0.0.1 and :: and ::0 is
    // resolved to ::1
    host_ = utils.resolvesZeroIP(host_);
    if (socket == null) {
      socket = new QUICSocket({
        crypto,
        resolveHostname,
        logger: logger.getChild(QUICSocket.name)
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
    // Check that the target `host` is compatible with the bound socket host
    if (
      socket.type === 'ipv4' &&
      (!utils.isIPv4(host_) && !utils.isIPv4MappedIPv6(host_))
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
    } else if (
      socket.type === 'ipv4&ipv6' &&
      !utils.isIPv6(host_)
    ) {
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
        port
      },
      config,
      logger: logger.getChild(`${QUICConnection.name} ${scid}`)
    });

    // This could be a file you know, but who closes the file?
    // I think it would make sense to do during creation, and then shutting down
    // plus is this only for 1 specific connection?

    // Immediately set the key log...
    // Right afterwards
    connection.setKeylog('./keylog');
    // Note that this all should happen during construction
    // That's probably the right thing to do

    const {
      p: errorP,
      rejectP: rejectErrorP
    } = utils.promise();
    const handleConnectionError = (e: events.QUICConnectionErrorEvent) => {
      rejectErrorP(e.detail);
    };
    connection.addEventListener(
      'error',
      handleConnectionError,
      { once: true }
    );
    // This will not raise an error
    await connection.send();

    // This will wait to be established, while also rejecting on error
    await Promise.race([connection.establishedP, errorP]);

    // Remove the temporary connection error handler
    connection.removeEventListener('error', handleConnectionError);

    // Now we create the client

    const client = new QUICClient({
      crypto,
      socket,
      connection,
      isSocketShared,
      logger
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
        detail: e
      })
    );
  };

  /**
   * Handles QUIC connection errors
   * This is always used because QUICClient is
   * one to one with QUICConnection
   */
  protected handleQUICConnectionError = (e: events.QUICConnectionErrorEvent) => {
    this.dispatchEvent(
      new events.QUICClientErrorEvent({
        detail: e
      })
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
      this.socket.addEventListener(
        'error',
        this.handleQUICSocketError
      );
    }
    this._connection = connection;
    this._connection.addEventListener(
      'error',
      this.handleQUICConnectionError
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
    // This is supposed to return a specialised INTERFACE
    // so we aren't just returning QUICConnection
    // the difference between internal interface and external interface
    return this._connection;
  }

  public async destroy() {
    const address = utils.buildAddress(this.socket.host, this.socket.port);
    this.logger.info(`Destroy ${this.constructor.name} on ${address}`);

    // We may want to allow one to specialise this
    await this._connection.destroy();
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
