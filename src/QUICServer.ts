import type {
  Host,
  RemoteInfo,
  StreamCodeToReason,
  StreamReasonToCode,
  QUICConfig,
  ServerCrypto,
  VerifyCallback,
} from './types';
import type { Header } from './native/types';
import type QUICConnectionMap from './QUICConnectionMap';

import Logger from '@matrixai/logger';
import { running } from '@matrixai/async-init';
import { ready, StartStop } from '@matrixai/async-init/dist/StartStop';
import { Evented, EventDefault } from '@matrixai/events';
import * as events from './events';
import { serverDefault } from './config';
import QUICConnectionId from './QUICConnectionId';
import QUICConnection from './QUICConnection';
import { quiche } from './native';
import * as utils from './utils';
import * as errors from './errors';
import QUICSocket from './QUICSocket';
import { never } from './utils';

/**
 * You must provide an error handler `addEventListener('error')`.
 * Otherwise, errors will just be ignored.
 *
 * If you are encapsulating evented stuff, you have to handle them.
 * If not, you can ignore them. OR you must re-emit them.
 * If you re-emit you must wrap them.
 *
 *
 * Events:
 *
 * - serverStop
 * - serverError - (could be a QUICSocketErrorEvent OR QUICServerErrorEvent)
 * - serverConnection
 * - connectionStream - when new stream is created from a connection
 * - connectionStop- when connection is stopped
 * - connectionError - connection error event
 * - streamDestroy - when stream is destroyed
 * - socketError - this also results in a server error
 * - socketStop
 */
interface QUICServer extends Evented {}
@StartStop({
  eventStart: events.EventQUICServerStart,
  eventStarted: events.EventQUICServerStarted,
  eventStop: events.EventQUICServerStop,
  eventStopped: events.EventQUICServerStopped,
})
class QUICServer {
  public readonly isSocketShared: boolean;

  protected logger: Logger;
  protected crypto: {
    key: ArrayBuffer;
    ops: ServerCrypto;
  };
  protected config: QUICConfig;
  protected socket: QUICSocket;
  protected reasonToCode: StreamReasonToCode | undefined;
  protected codeToReason: StreamCodeToReason | undefined;
  protected verifyCallback: VerifyCallback | undefined;
  protected connectionMap: QUICConnectionMap;
  protected minIdleTimeout: number | undefined;

  /**
   * Handle the QUIC socket error.
   * If the `QUICSocket` hits an error, it's an error for `QUICServer`.
   */
  protected handleEventQUICSocketError = async (evt: events.EventQUICSocketError) => {
    try {
      if (!this.isSocketShared) {
        await this.socket.stop({ force: true });
      }
    } catch (err) {
      throw err; // I think it would be a software error

      // This only happens if we fail to stop the socket!
      // this.dispatchEvent(
      //   new events.EventQUICServerError({
      //     detail: new errors.ErrorQUICServer(
      //       'Failed handling QUIC socket error',
      //       { cause: new AggregateError([err, evt.detail]) }
      //     )
      //   })
      // );
      // return;
    }
    this.dispatchEvent(
      new events.EventQUICServerError({
        detail: evt
      })
    );
  };

  /**
   * Handle the QUIC socket stop.
   * If the socket is injected, it's always an error, because this `QUICServer` should be stopped first.
   * Otherwise it is not possible for the socket to be stopped, unless we are the ones who called it.
   */
  protected handleEventQUICSocketStopped = async (evt: events.EventQUICSocketStopped) => {
    if (this.isSocketShared) {
      this.dispatchEvent(
        new events.EventQUICServerError({
          detail: evt
        })
      );
    }
  };

  /**
   * Handle the QUIC connection error.
   * This is done per QUIC connection.
   */
  protected handleEventQUICConnectionError = async (evt: events.EventQUICConnectionError) => {
    const connection = evt.target as QUICConnection;
    try {
      await connection.stop({ force: true });
    } catch (err) {
      // I think this would be a software error!
      throw err;
      // this.dispatchEvent(
      //   new events.EventQUICServerError({
      //     detail: new errors.ErrorQUICServer(
      //       'Failed handling QUIC connection error',
      //       { cause: new AggregateError([err, evt.detail]) }
      //     )
      //   })
      // );
      // return;
    }
  };

  /**
   * Handle the QUIC connection stop.
   * This is done per connectoin.
   * This removes it from the connection map.
   */
  protected handleEventQUICConnectionStopped = async (evt: events.EventQUICConnectionStopped) => {
    const connection = evt.target as QUICConnection;
    connection.removeEventListener(
      events.EventQUICConnectionStopped.name,
      this.handleEventQUICConnectionStopped,
    );
    connection.removeEventListener(
      events.EventQUICConnectionError.name,
      this.handleEventQUICConnectionError,
    );
    this.socket.connectionMap.delete(connection.connectionId);
  };

  public constructor({
    crypto,
    config,
    socket,
    resolveHostname = utils.resolveHostname,
    reasonToCode,
    codeToReason,
    verifyCallback,
    minIdleTimeout,
    logger,
  }: {
    crypto: {
      key: ArrayBuffer;
      ops: ServerCrypto;
    };
    config: Partial<QUICConfig> & {
      key: string | Array<string> | Uint8Array | Array<Uint8Array>;
      cert: string | Array<string> | Uint8Array | Array<Uint8Array>;
    };
    socket?: QUICSocket;
    resolveHostname?: (hostname: string) => Host | PromiseLike<Host>;
    reasonToCode?: StreamReasonToCode;
    codeToReason?: StreamCodeToReason;
    verifyCallback?: VerifyCallback;
    minIdleTimeout?: number;
    logger?: Logger;
  }) {
    const quicConfig = {
      ...serverDefault,
      ...config,
    };
    this.logger = logger ?? new Logger(this.constructor.name);
    this.crypto = crypto;
    if (socket == null) {
      this.socket = new QUICSocket({
        resolveHostname,
        logger: this.logger.getChild(QUICSocket.name),
      });
      this.isSocketShared = false;
    } else {
      this.socket = socket;
      this.isSocketShared = true;
    }
    // Registers itself to the socket
    this.socket.registerServer(this);
    // Shares the socket connection map as well
    this.connectionMap = this.socket.connectionMap;
    this.config = quicConfig;
    this.reasonToCode = reasonToCode;
    this.codeToReason = codeToReason;
    this.verifyCallback = verifyCallback;
    this.minIdleTimeout = minIdleTimeout;
  }

  @ready(new errors.ErrorQUICServerNotRunning())
  public get host(): string {
    return this.socket.host;
  }

  @ready(new errors.ErrorQUICServerNotRunning())
  public get port(): number {
    return this.socket.port;
  }

  /**
   * Starts the QUICServer
   *
   * If the QUIC socket is shared, then it is expected that it is already started.
   * In which case, the `host` and `port` parameters here are ignored.
   */
  public async start({
    host = '::',
    port = 0,
    reuseAddr,
    ipv6Only,
  }: {
    host?: string;
    port?: number;
    reuseAddr?: boolean;
    ipv6Only?: boolean;
  } = {}) {
    let address: string;
    if (!this.isSocketShared) {
      address = utils.buildAddress(host, port);
      this.logger.info(`Start ${this.constructor.name} on ${address}`);
      await this.socket.start({ host, port, reuseAddr, ipv6Only });
      address = utils.buildAddress(this.socket.host, this.socket.port);
    } else {
      // If the socket is shared, it must already be started
      if (!this.socket[running]) {
        throw new errors.ErrorQUICServerSocketNotRunning();
      }
      address = utils.buildAddress(this.socket.host, this.socket.port);
      this.logger.info(`Start ${this.constructor.name} on ${address}`);
    }
    this.socket.addEventListener(
      events.EventQUICSocketError.name,
      this.handleEventQUICSocketError,
      { once: true }
    );
    this.socket.addEventListener(
      events.EventQUICSocketStopped.name,
      this.handleEventQUICSocketStopped,
      { once: true }
    );
    this.logger.info(`Started ${this.constructor.name} on ${address}`);
  }

  /**
   * Stops the QUICServer
   */
  public async stop({
    force = false,
    error,
  }: {
    force?: boolean;
    error?: Error;
  } = {}) {
    const address = utils.buildAddress(this.socket.host, this.socket.port);
    this.logger.info(`Stop ${this.constructor.name} on ${address}`);
    const destroyProms: Array<Promise<void>> = [];
    for (const connection of this.connectionMap.serverConnections.values()) {
      destroyProms.push(
        connection.stop({
          applicationError: true,
          force,
        }),
      );
    }
    await Promise.all(destroyProms);
    this.socket.removeEventListener(
      events.EventQUICSocketStopped.name,
      this.handleEventQUICSocketStopped
    );
    this.socket.removeEventListener(
      events.EventQUICSocketError.name,
      this.handleEventQUICSocketError
    );
    if (!this.isSocketShared) {
      // If the socket is not shared, then it can be stopped
      await this.socket.stop();
    }
    this.logger.info(`Stopped ${this.constructor.name} on ${address}`);
  }

  // /**
  //  * This method must not throw any exceptions.
  //  * Any errors must be emitted as events.
  //  * @internal
  //  */
  // public async connectionNew(
  //   remoteInfo: RemoteInfo,
  //   header: Header,
  //   dcid: QUICConnectionId,
  //   data: Uint8Array,
  // ): Promise<QUICConnection | undefined> {
  //   // If the packet is not an `Initial` nor `ZeroRTT` then we discard the
  //   // packet.
  //   if (
  //     header.ty !== quiche.Type.Initial &&
  //     header.ty !== quiche.Type.ZeroRTT
  //   ) {
  //     return;
  //   }
  //   // Derive the new connection's SCID from the client generated DCID
  //   const scid = new QUICConnectionId(
  //     await this.crypto.ops.sign(this.crypto.key, dcid),
  //     0,
  //     quiche.MAX_CONN_ID_LEN,
  //   );
  //   const peerAddress = utils.buildAddress(remoteInfo.host, remoteInfo.port);
  //   // Version Negotiation
  //   if (!quiche.versionIsSupported(header.version)) {
  //     const versionDatagram = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
  //     const versionDatagramLength = quiche.negotiateVersion(
  //       header.scid,
  //       header.dcid,
  //       versionDatagram,
  //     );
  //     try {
  //       await this.socket.send(
  //         versionDatagram,
  //         0,
  //         versionDatagramLength,
  //         remoteInfo.port,
  //         remoteInfo.host,
  //       );
  //     } catch (e) {
  //       throw new errors.ErrorQUICServerConnectionNegotiation(
  //         `Failed to send version datagram ${peerAddress}`,
  //         { cause: e }
  //       );
  //     }
  //     return;
  //   }
  //   // At this point we are processing an `Initial` packet.
  //   // It is expected that token exists, because if it didn't, there would have
  //   // been a `BufferTooShort` error during parsing.
  //   const token = header.token!;
  //   // Stateless Retry
  //   if (token.byteLength === 0) {
  //     const token = await this.mintToken(dcid, remoteInfo.host);
  //     const retryDatagram = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
  //     const retryDatagramLength = quiche.retry(
  //       header.scid, // Client initial packet source ID
  //       header.dcid, // Client initial packet destination ID
  //       scid, // Server's new source ID that is derived
  //       token,
  //       header.version,
  //       retryDatagram,
  //     );
  //     try {
  //       await this.socket.send(
  //         retryDatagram,
  //         0,
  //         retryDatagramLength,
  //         remoteInfo.port,
  //         remoteInfo.host,
  //       );
  //     } catch (e) {
  //       throw new errors.ErrorQUICServerConnectionNegotiation(
  //         `Failed to send stateless retry datagram to ${peerAddress}`,
  //         { cause: e }
  //       );
  //     }
  //     return;
  //   }
  //   // At this point in time, the packet's DCID is the originally-derived DCID.
  //   // While the DCID embedded in the token is the original DCID that the client first created.
  //   const dcidOriginal = await this.validateToken(
  //     Buffer.from(token),
  //     remoteInfo.host,
  //   );
  //   if (dcidOriginal == null) {
  //     // Failed validation due to missing DCID
  //     return;
  //   }
  //   // Check that the newly-derived DCID (passed in as the SCID) is the same
  //   // length as the packet DCID.
  //   // This ensures that the derivation process hasn't changed.
  //   if (scid.byteLength !== header.dcid.byteLength) {
  //     // Failed validation due to mismatched length
  //     return;
  //   }
  //   // Here we shall re-use the originally-derived DCID as the SCID
  //   const newScid = new QUICConnectionId(header.dcid);

  //   // What is this?
  //   // We don't need this, we can just identify it by the server's SCID
  //   // const clientConnRef = Buffer.from(header.scid).toString('hex').slice(32);

  //   let connection: QUICConnection;
  //   try {
  //     connection = await QUICConnection.createQUICConnection(
  //       {
  //         type: 'server',
  //         scid: newScid,
  //         dcid: dcidOriginal,
  //         socket: this.socket,
  //         remoteInfo,
  //         data,
  //         config: this.config,
  //         reasonToCode: this.reasonToCode,
  //         codeToReason: this.codeToReason,
  //         verifyCallback: this.verifyCallback,
  //         logger: this.logger.getChild(
  //           `${QUICConnection.name} ${scid.toString()}`,
  //         ),
  //       },
  //       { timer: this.minIdleTimeout },
  //     );
  //   } catch (e) {
  //     throw new errors.ErrorQUICServerConnectionCreation(
  //       `Failed to accept a new QUIC connection`,
  //       { cause: e }
  //     );
  //   }

  //   const handleEventQUICConnectionError = async (
  //     evt: events.EventQUICConnectionError
  //   )  => {
  //     const connection = evt.target as QUICConnection;
  //     try {
  //       await connection.stop();
  //     } catch (err) {
  //       this.dispatchEvent(
  //         new events.EventQUICServerError({
  //           detail: new errors.ErrorQUICServer(
  //             'Failed handling QUIC connection error',
  //             { cause: new AggregateError([err, evt.detail]) }
  //           )
  //         })
  //       );
  //       return;
  //     }
  //   };


  //   const handleEventQUICConnectionStop = (
  //     evt: events.EventQUICConnectionStopped
  //   ) => {
  //     const connection = evt.target as QUICConnection;
  //     this.connectionMap.delete(connection.connectionId);
  //   };

  //   connection.addEventListener(
  //     events.EventQUICConnectionError.name,
  //     this.handleEventQUICConnectionError
  //   );
  //   connection.addEventListener(
  //     events.EventQUICConnectionStopped.name,
  //     this.handleEventQUICConnectionStopped
  //   );

  //   // Consider the idea of "propagating" events outside



  //   // // Handling connection events
  //   // connection.addEventListener(
  //   //   'connectionError',
  //   //   this.handleQUICConnectionEvents,
  //   // );
  //   // connection.addEventListener(
  //   //   'connectionStream',
  //   //   this.handleQUICConnectionEvents,
  //   // );
  //   // connection.addEventListener(
  //   //   'streamDestroy',
  //   //   this.handleQUICConnectionEvents,
  //   // );
  //   connection.addEventListener(
  //     'connectionStop',
  //     (event) => {
  //       connection.removeEventListener(
  //         'connectionError',
  //         this.handleQUICConnectionEvents,
  //       );
  //       connection.removeEventListener(
  //         'connectionStream',
  //         this.handleQUICConnectionEvents,
  //       );
  //       connection.removeEventListener(
  //         'streamDestroy',
  //         this.handleQUICConnectionEvents,
  //       );
  //       this.handleQUICConnectionEvents(event);
  //     },
  //     { once: true },
  //   );
  //   this.dispatchEvent(
  //     new events.QUICServerConnectionEvent({ detail: connection }),
  //   );

  //   return connection;
  // }

  // WHAT if `connectionNew` were to give you back just `QUICConnection`
  // That wasn't actually started yet
  // And so it wasn't asynchronous
  // That way `QUICSocket` can then proceed to do
  // ```
  // this.connectionMap.set(connection.connectionId, connection)
  // await connection.start()
  // ```
  // Then you'd get something a bit smarter
  // You'd have to have a the constructor separate?
  // If I do this, then the socket will be the one managing the lifecycle of the connection
  // Another way is to do it here, with `start` being called here instead
  // But we can make use of the connection map in the socket
  // sincie it is encapsulated

  /**
   * This constructs a new connection intended for acceptance.
   * It will not start the connection. The caller must start the connection.
   * The reason it is asynchronous is due to asynchronous operations required
   * prior to constructing a connection. That's the negotiation phase.
   * After you get the connection, you must then start the connection.
   * To do so, you must have the connection already registered as part of the
   * socket connection map.
   */
  public async newConnection(
    remoteInfo: RemoteInfo,
    header: Header,
    dcid: QUICConnectionId,
    data: Uint8Array,
  ): Promise<QUICConnection | undefined> {
    // If the packet is not an `Initial` nor `ZeroRTT` then we discard the
    // packet.
    if (
      header.ty !== quiche.Type.Initial &&
      header.ty !== quiche.Type.ZeroRTT
    ) {
      return;
    }
    // Derive the new connection's SCID from the client generated DCID
    const scid = new QUICConnectionId(
      await this.crypto.ops.sign(this.crypto.key, dcid),
      0,
      quiche.MAX_CONN_ID_LEN,
    );
    const peerAddress = utils.buildAddress(remoteInfo.host, remoteInfo.port);
    // Version Negotiation
    if (!quiche.versionIsSupported(header.version)) {
      const versionDatagram = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
      const versionDatagramLength = quiche.negotiateVersion(
        header.scid,
        header.dcid,
        versionDatagram,
      );
      try {
        await this.socket.send(
          versionDatagram,
          0,
          versionDatagramLength,
          remoteInfo.port,
          remoteInfo.host,
        );
      } catch (e) {
        throw new errors.ErrorQUICServerConnectionNegotiation(
          `Failed to send version datagram ${peerAddress}`,
          { cause: e }
        );
      }
      return;
    }
    // At this point we are processing an `Initial` packet.
    // It is expected that token exists, because if it didn't, there would have
    // been a `BufferTooShort` error during parsing.
    const token = header.token!;
    // Stateless Retry
    if (token.byteLength === 0) {
      const token = await this.mintToken(dcid, remoteInfo.host);
      const retryDatagram = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
      const retryDatagramLength = quiche.retry(
        header.scid, // Client initial packet source ID
        header.dcid, // Client initial packet destination ID
        scid, // Server's new source ID that is derived
        token,
        header.version,
        retryDatagram,
      );
      try {
        await this.socket.send(
          retryDatagram,
          0,
          retryDatagramLength,
          remoteInfo.port,
          remoteInfo.host,
        );
      } catch (e) {
        throw new errors.ErrorQUICServerConnectionNegotiation(
          `Failed to send stateless retry datagram to ${peerAddress}`,
          { cause: e }
        );
      }
      return;
    }
    // At this point in time, the packet's DCID is the originally-derived DCID.
    // While the DCID embedded in the token is the original DCID that the client first created.
    const dcidOriginal = await this.validateToken(
      Buffer.from(token),
      remoteInfo.host,
    );
    if (dcidOriginal == null) {
      // Failed validation due to missing DCID
      return;
    }
    // Check that the newly-derived DCID (passed in as the SCID) is the same
    // length as the packet DCID.
    // This ensures that the derivation process hasn't changed.
    if (scid.byteLength !== header.dcid.byteLength) {
      // Failed validation due to mismatched length
      return;
    }
    // Here we shall re-use the originally-derived DCID as the SCID
    const newScid = new QUICConnectionId(header.dcid);
    // Construct a QUIC connection that isn't yet started
    const connection = new QUICConnection({
      type: 'server',
      scid: newScid,
      dcid: dcidOriginal,
      socket: this.socket,
      remoteInfo,
      config: this.config,
      reasonToCode: this.reasonToCode,
      codeToReason: this.codeToReason,
      verifyCallback: this.verifyCallback,
      logger: this.logger.getChild(
        `${QUICConnection.name} ${scid.toString()}`,
      )
    });
    // We have passed the negotiation, now we have the connection
    // We must set it on our connection map so it may be used in a separate handler
    this.socket.connectionMap.set(connection.connectionId, connection);



    connection.addEventListener(
      events.EventQUICConnectionError.name,
      this.handleEventQUICConnectionError,
      { once: true }
    );
    connection.addEventListener(
      events.EventQUICConnectionStopped.name,
      this.handleEventQUICConnectionStopped,
      { once: true }
    );
    try {
      await connection.start(
        { data },
        { timer: this.minIdleTimeout }
      );
    } catch (e) {
      this.connectionMap.delete(connection.connectionId);
      throw e;
    }

    this.dispatchEvent(
      new events.EventQUICServerConnection({ detail: connection }),
    );
    return connection;
  }


  // we could argue that you need to startConnection here
  // or stopConnection here?
  // but whatever
  // also handlers
  // who owns this connection?
  // It should be the server that does it
  // so we need to attach handlers there

  // the quic socket requries a connection map
  // cause it has to to know when a connection already exist
  // and represents a pending connection
  // that could mean both connection starting, stopping
  // however the server still needs to keep the connection state



  /**
   * This updates the `QUICConfig` used when new connections are established.
   * Only the parameters that are provided are updated.
   * It will not affect existing connections, they will keep using the old `QUICConfig`
   */
  public updateConfig(config: Partial<QUICConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
  }

  /**
   * Creates a retry token.
   * This will embed peer host IP and DCID into the token.
   * It will authenticate the data by providing a signature signed by our key.
   */
  protected async mintToken(
    dcid: QUICConnectionId,
    peerHost: Host,
  ): Promise<Buffer> {
    return utils.mintToken(dcid, peerHost, this.crypto);
  }

  /**
   * Validates the retry token.
   * This will check that the token was signed by us.
   * And it will check that the current host IP is the same as the one put into the token.
   * This proves that the peer can in fact receive and send from the host IP.
   * This returns the DCID inside the token, which was the original DCID.
   */
  protected async validateToken(
    tokenBuffer: Buffer,
    peerHost: Host,
  ): Promise<QUICConnectionId | undefined> {
    return utils.validateToken(tokenBuffer, peerHost, this.crypto);
  }
}

export default QUICServer;
