import type { ConnectionId, ConnectionIdString, Crypto, Host, Hostname, Port } from './types';
import type { Header, Config, Connection } from './native/types';
import dgram from 'dgram';
import dns from 'dns';
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
import QUICConnectionMap from './QUICConnectionMap';

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
  protected connectionMap: QUICConnectionMap;

  public static async createQUICClient({
    host = '::' as Host,
    port = 0 as Port,
    crypto,
    socket,
    resolveHostname = utils.resolveHostname,
    logger = new Logger(`${this.name}`),
  }: {
    host?: Host | Hostname,
    port?: Port,
    crypto: {
      key: ArrayBuffer;
      ops: Crypto;
    },
    socket?: QUICSocket;
    resolveHostname?: (hostname: Hostname) => Host | PromiseLike<Host>;
    logger?: Logger;
  }) {
    let address: string;
    let isSocketShared: boolean;
    let client: QUICClient;
    if (socket == null) {
      address = utils.buildAddress(host, port);
      logger.info(`Create ${this.name} on ${address}`);
      socket = new QUICSocket({
        crypto,
        resolveHostname,
        logger: logger.getChild(QUICSocket.name)
      });
      isSocketShared = false;
      client = new QUICClient({
        crypto,
        socket,
        isSocketShared,
        logger
      });
      await socket.start({
        host,
        port
      });
      address = utils.buildAddress(socket.host, socket.port);
    } else {
      if (!socket[running]) {
        throw new errors.ErrorQUICClientSocketNotRunning();
      }
      isSocketShared = true;
      address = utils.buildAddress(socket.host, socket.port);
      logger.info(`Create ${this.name} on ${address}`);
      client = new QUICClient({
        crypto,
        socket,
        isSocketShared,
        logger
      });
    }
    logger.info(`Created ${this.name} on ${address}`);
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
    logger,
  }: {
    crypto: {
      key: ArrayBuffer;
      ops: Crypto;
    };
    socket: QUICSocket;
    isSocketShared: boolean;
    logger: Logger;
  }) {
    super();
    this.logger = logger;
    this.crypto = crypto;
    this.socket = socket;
    this.isSocketShared = isSocketShared;
    // Registers itself to the socket
    this.socket.registerClient(this);
    // Shares the socket connection map as well
    this.connectionMap = this.socket.connectionMap;
    if (!isSocketShared) {
      this.socket.addEventListener('error', this.handleQUICSocketError);
    }
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
    this.config = config;
  }

  @ready(new errors.ErrorQUICClientDestroyed())
  public get host() {
    return this.socket.host;
  }

  @ready(new errors.ErrorQUICClientDestroyed())
  public get port() {
    return this.socket.port;
  }



  public async start({
    host = '::',
    port = 0
  }: {
    host?: string,
    port?: number,
  } = {}) {

    // QUICConnection.connectQUICConnection


    // We have to fill it out with random stuff
    // Random source connection ID
    // The SCID is what the client uses to identify itself.
    const scid = Buffer.allocUnsafe(quiche.MAX_CONN_ID_LEN);

    // Set the array buffer accordingly
    this.crypto.ops.randomBytes(
      scid.buffer.slice(
        scid.byteOffset,
        scid.byteOffset + scid.byteLength
      )
    );

    // we don't actually use the URL
    // it's not important for us
    // maybe it is useful later.
    // the server name is optional
    // it's only used for verifying the peer certificate
    // however we don't really do this... because we are using custom  verification

    // New QUIC connection, this will start to initiate the handshake
    // const conn = quiche.Connection.connect(
    //   null,
    //   scid,
    //   {
    //     host: this.socket.address().address,
    //     port: this.socket.address().port,
    //   },
    //   {
    //     host: host,
    //     port: port
    //   },
    //   this.config
    // );

    // const data = Buffer.alloc(quiche.MAX_DATAGRAM_SIZE);
    // conn.send(data);

    // Ok we should be creating a `QUICConnection` here
    // just like in the server
    // Then use the `send()` which will give back us the data to be sent out on the UDP socket
    // After sending the INITIAL packet
    // it will then expect to receive data on the UDP socket
    // At that point the receive info is built up
    // Then it is passed to `conn.recv`
    // HOWEVER what if we have multiple connections
    // which ones should be indexing into?
    // Should we be parsing the packet just like on the server side
    // And then identifying the connection based on the SCID or DCID
    // since every client... uses SCID to identify themselves

    // Then it tries to read it until it times out
    // Or if there is no more UDP packets to read
    // This is seems unnceessary  with handle message

    // Check if is closed

    // Process writes if the connection is established

    // Afterwards, it processes all readable streams
    // Deal with closing streams

    // Send out on connection

    // Send out on the socket

    // Check if connection is closed

    // Otherwise go back to the sleep waiting loop


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
