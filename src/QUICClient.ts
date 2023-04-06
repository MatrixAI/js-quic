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
  protected _connection: QUICConnection;
  protected connectionMap: QUICConnectionMap;

  /**
   * Creates a QUIC Client
   * @param options
   * @param options.host - target host, if wildcard, it is resolved to its localhost `0.0.0.0` becomes `127.0.0.1` and `::` becomes `::1`
   */
  public static async createQUICClient({
    host,
    port,
    // The value of this can be `::`
    // But this implies "dual stack" client
    // If you are sharing a UDP socket between client and server
    localHost = '::' as Host,
    localPort = 0 as Port,
    crypto,
    socket,
    resolveHostname = utils.resolveHostname,
    logger = new Logger(`${this.name}`),
  }: {
    // Remote host/port
    host: Host | Hostname,
    port: Port,

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
    const scid = new QUICConnectionId(quiche.MAX_CONN_ID_LEN);
    await crypto.ops.randomBytes(scid);
    const config = new quiche.Config();
    // TODO: disable this (because we still need to run with TLS)
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
    let [host_] = await utils.resolveHost(host, resolveHostname);
    // If the target host is in fact an zero IP, it cannot be used
    // as a target host, so we need to resolve it to a non-zero IP
    // in this case, 0.0.0.0 is resolved to 127.0.0.1 and :: is
    // resolved to ::1
    host_ = utils.resolvesZeroIP(host_);

    // let host_ = host as Host;



    // At thes same time
    // the localHost is NOT allowed to be a zero IP
    // but also we will resolve it too
    // if it is the case
    // but we also need to resolve that host name

    console.log('TARGET HOST', host_);


    logger.info(`Create ${this.name} to ${address}`);

    let connection: QUICConnection;
    if (socket == null) {
      socket = new QUICSocket({
        crypto,
        resolveHostname,
        logger: logger.getChild(QUICSocket.name)
      });
      isSocketShared = false;

      // // The `localHost` is not allowed to be a zero IP
      // let [localHost_] = await utils.resolveHost(localHost, resolveHostname);
      // // So what actually happens if this was actually `::` or `0.0.0.0`?
      // localHost_ = utils.resolvesZeroIP(localHost_);
      // console.log('CLIENT LOCAL HOST RESOLVED', localHost_);


      // If `localHost` is `::`, that should mean this is dual stack (which udp6) packet
      // But the `host` is 127.0.0.1... so it wants to send a udp4 packet
      // Maybe that's the problem here?

      // A dual stack bound socket cannot send IPv4 packets
      // because it is bound to :: and it has to use udp6 packets
      // That's the issue here

      await socket.start({
        host: localHost,
        port: localPort,
        // type: 'udp4'
      });
      connection = await QUICConnection.connectQUICConnection({
        scid,
        socket,
        remoteInfo: {
          host: host_,
          port
        },
        config,
        logger: logger.getChild(`${QUICConnection.name} ${scid}`)
      });
    } else {
      if (!socket[running]) {
        throw new errors.ErrorQUICClientSocketNotRunning();
      }
      isSocketShared = true;
      connection = await QUICConnection.connectQUICConnection({
        scid,
        socket,
        remoteInfo: {
          host: host_,
          port
        },
        config,
        logger: logger.getChild(`${QUICConnection.name} ${scid}`)
      });
    }

    console.log('CLIENT HOST', socket.host);
    console.log('CLIENT PORT', socket.port);

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
    this.dispatchEvent(e);
  };

  /**
   * Handles QUIC connection errors
   * This is always used because QUICClient is
   * one to one with QUICConnection
   */
  protected handleQUICConnectionError = (e: events.QUICConnectionErrorEvent) => {
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
