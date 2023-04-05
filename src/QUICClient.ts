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
    const [host_] = await utils.resolveHost(host, resolveHostname);
    logger.info(`Create ${this.name} to ${address}`);

    let connection: QUICConnection;
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

    // This has to exist already during creation
    // It is not an instance level thing... but we can attach it somewhat?
    // Do we make this a static property?
    connection.addEventListener('error', (e: events.QUICConnectionErrorEvent) => {
      console.log('WE GOT an error', e.detail);
    });

    // the conneciton object is created on the clinet side
    // but nothing is actually done on the QUICCOnnection.connectQUICConnection
    // we actually need to trigger send to flush data to the remote end
    // and we need to do the entire bootstrapping process
    // do we do this in the QUICClient
    // or do we do this in the creation of quic connection?
    // we need to do this in the QUICCLient
    // because the QUICSever is what is does the bootstrapping
    // so we should do it here too
    // and that way we force it here to be the place where the connection is actually bootstrapped

    // Here we start the sending process
    // This flushes the data to the UDP socket
    // This starts the LOOP
    // no error happens here
    // it will all go to the above event
    await connection.send();

    // We have to read back data from the connection now
    // Because it's coming back from the socket?
    // acutally no... because!
    // THE UDP socket handles any data being sent back to us
    // so the initial send is all that is needed!

    // ok but then who calls connection.send again?
    // again the udp socket does, after calling recv, it calls send again
    // and the conversation is started
    // what we have to do here is to WAIT until it is established
    // and we have to bascially WAIT and sleep until this is true
    // this is technically a busy loop
    // because we don't really know when it is established?
    // or we should have it in the connection
    // we can have it as a promise
    // and as soon as estbalished it is true
    // and can always be set to true
    // then we just "resolve" at all times
    // then once resolved always resolved
    // that might be easier
    // since it's part of the loop... essentially
    // no busy loop requried

    // connection.conn.isEstablished();

    // This is waiting for the connection to be established
    // If there's an error like above
    // we have to BREAK here
    // or we can rely on the idea that this promise can be broken if an error gets dispatched
    await connection.establishedP;

    console.log('THE CONNECTION IS REALLY ESTABLISHED!');

    // Note that there is no timeout here

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

  // This actually needs to track the connection error event too
  // THIS IS FOR THE INSTANCE
  // we also need it prior during creation!
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
    this._connection = connection;
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
