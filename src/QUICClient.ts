import type { ConnectionId, ConnectionIdString, Crypto, Host, Hostname, Port } from './types';
import type { Header, Config, Connection } from './native/types';
import dgram from 'dgram';
import Logger from '@matrixai/logger';
import { Validator } from 'ip-num';
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
  protected connection: QUICConnection;
  protected connectionMap: QUICConnectionMap;

  public static async createQUICClient({
    host = '::' as Host,
    port = 0 as Port,
    localHost = '::' as Host,
    localPort = 0 as Port,
    crypto,
    socket,
    resolveHostname = utils.resolveHostname,
    logger = new Logger(`${this.name}`),
  }: {
    // Remote host/port
    host?: Host | Hostname,
    port?: Port,

    // If you want to use a local host/prot
    // Starting a quic server is just purely host and port
    // this is also the local host and port
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
    let client: QUICClient;
    const scid = new QUICConnectionId(quiche.MAX_CONN_ID_LEN);
    await crypto.ops.randomBytes(scid);
    const config = new quiche.Config();
    config.verifyPeer(false);
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
    // Resolve the host via DNS
    const [host_] = await utils.resolveHost(host, resolveHostname);
    logger.info(`Create ${this.name} to ${address}`);

    if (socket == null) {
      socket = new QUICSocket({
        crypto,
        resolveHostname,
        logger: logger.getChild(QUICSocket.name)
      });
      isSocketShared = false;
      await socket.start({
        host: localHost,
        port: localPort
      });
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
      client = new QUICClient({
        crypto,
        socket,
        connection,
        isSocketShared,
        logger
      });
    } else {
      if (!socket[running]) {
        throw new errors.ErrorQUICClientSocketNotRunning();
      }
      isSocketShared = true;
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
      client = new QUICClient({
        crypto,
        socket,
        isSocketShared,
        connection,
        logger
      });
    }
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
    this.dispatchEvent(e);
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
    this.connection = connection;
    if (!isSocketShared) {
      this.socket.addEventListener('error', this.handleQUICSocketError);
    }
  }

  @ready(new errors.ErrorQUICClientDestroyed())
  public get host() {
    return this.socket.host;
  }

  @ready(new errors.ErrorQUICClientDestroyed())
  public get port() {
    return this.socket.port;
  }

  public async destroy() {
    const address = utils.buildAddress(this.socket.host, this.socket.port);
    this.logger.info(`Destroy ${this.constructor.name} on ${address}`);
    // Destroy the current connection too


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
