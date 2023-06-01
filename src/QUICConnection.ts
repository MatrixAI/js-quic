import type { PromiseCancellable } from '@matrixai/async-cancellable';
import type { ContextTimed } from '@matrixai/contexts';
import type QUICSocket from './QUICSocket';
import type QUICConnectionMap from './QUICConnectionMap';
import type QUICConnectionId from './QUICConnectionId';
import type { Host, Port, RemoteInfo, StreamId } from './types';
import type { Connection, ConnectionErrorCode, SendInfo } from './native/types';
import type { StreamCodeToReason, StreamReasonToCode } from './types';
import type { QUICConfig, ConnectionMetadata } from './types';
import { StartStop, ready, status } from '@matrixai/async-init/dist/StartStop';
import Logger from '@matrixai/logger';
import { Lock } from '@matrixai/async-locks';
import { destroyed } from '@matrixai/async-init';
import { Timer } from '@matrixai/timer';
import { buildQuicheConfig } from './config';
import QUICStream from './QUICStream';
import { quiche } from './native';
import * as events from './events';
import * as utils from './utils';
import * as errors from './errors';
import { promise } from './utils';
import { context, timedCancellable } from '@matrixai/contexts/dist/decorators';

/**
 * Think of this as equivalent to `net.Socket`.
 * Errors here are emitted to the connection only.
 * Not to the server.
 *
 * Events (events are executed post-facto):
 * - connectionStream
 * - connectionDestroy
 * - connectionError
 * - streamDestroy
 */
interface QUICConnection extends StartStop {}
@StartStop()
class QUICConnection extends EventTarget {
  /**
   * This determines when it is a client or server connection.
   */
  public readonly type: 'client' | 'server';

  /**
   * This is the source connection ID.
   */
  public readonly connectionId: QUICConnectionId;

  /**
   * Internal native connection object.
   * @internal
   */
  public readonly conn: Connection;

  /**
   * Internal conn state transition lock.
   * This is used to serialize state transitions to `conn`.
   * This is also used by `QUICSocket`.
   * @internal
   */
  public readonly connLock: Lock = new Lock();

  /**
   * Internal stream map.
   * This is also used by `QUICStream`.
   * @internal
   */
  public readonly streamMap: Map<StreamId, QUICStream> = new Map();

  /**
   * Connection establishment.
   * This can resolve or reject.
   * Rejections cascade down to `secureEstablishedP` and `closedP`.
   */
  public readonly establishedP: Promise<void>;

  /**
   * Connection has been verified and secured.
   * This can only happen after `establishedP`.
   * On the server side, being established means it is also secure established.
   * On the client side, after being established, the client must wait for the
   * first short frame before it is also secure established.
   * This can resolve or reject.
   * Rejections cascade down to `closedP`.
   */
  public readonly secureEstablishedP: Promise<void>;

  /**
   * Connection closed promise.
   * This can resolve or reject.
   */
  public readonly closedP: Promise<void>;

  /**
   * Logger.
   */
  protected logger: Logger;

  /**
   * Underlying socket.
   */
  protected socket: QUICSocket;

  /**
   * Converts reason to code.
   * Used during `QUICStream` creation.
   */
  protected reasonToCode: StreamReasonToCode;

  /**
   * Converts code to reason.
   * Used during `QUICStream` creation.
   */
  protected codeToReason: StreamCodeToReason;

  /**
   * Stream ID increment lock.
   */
  protected streamIdLock: Lock = new Lock();

  /**
   * Client initiated bidirectional stream starts at 0.
   * Increment by 4 to get the next ID.
   */
  protected streamIdClientBidi: StreamId = 0b00 as StreamId;

  /**
   * Server initiated bidirectional stream starts at 1.
   * Increment by 4 to get the next ID.
   */
  protected streamIdServerBidi: StreamId = 0b01 as StreamId;

  /**
   * Client initiated unidirectional stream starts at 2.
   * Increment by 4 to get the next ID.
   */
  protected streamIdClientUni: StreamId = 0b10 as StreamId;

  /**
   * Server initiated unidirectional stream starts at 3.
   * Increment by 4 to get the next ID.
   */
  protected streamIdServerUni: StreamId = 0b11 as StreamId;

  /**
   * Internal conn timer. This is used to tick the state transitions on the
   * conn.
   */
  protected connTimer?: Timer;

  /**
   * Keep alive timer.
   * If the max idle time is set to >0, the connection can time out on idleness.
   * Idleness is where there is no response from the other side. This can happen
   * from the beginning to the establishment of the connection and while the
   * connection is established. Normally there is nothing that will keep the
   * connection alive if there is no activity. This keep alive mechanism will
   * trigger ping frames to ensure that there is connection activity.
   * If the max idle time is set to 0, the connection never times out on idleness.
   * However this keep alive mechanism will continue to work in case you need
   * activity on the connection for some reason.
   * Note that the timer used for the `ContextTimed` in `QUICClient.createQUICClient`
   * is independent of the max idle time. This keep alive mechanism will only
   * start working after secure establishment.
   */
  protected keepAliveTimer?: Timer;

  /**
   * This can change on every `recv` call
   */
  protected _remoteHost: Host;

  /**
   * This can change on every `recv` call
   */
  protected _remotePort: Port;

  /**
   * Bubble up all QUIC stream events.
   */
  protected handleQUICStreamEvents = (e: events.QUICStreamEvent) => {
    this.dispatchEvent(e);
  };

  protected resolveEstablishedP: () => void;
  protected rejectEstablishedP: (reason?: any) => void;
  protected resolveSecureEstablishedP: () => void;
  protected rejectSecureEstablishedP: (reason?: any) => void;
  protected resolveClosedP: () => void;
  protected rejectClosedP: (reason?: any) => void;

  public constructor({
    type,
    scid,
    dcid,
    remoteInfo,
    config,
    socket,
    reasonToCode = () => 0,
    codeToReason = (type, code) => new Error(`${type} ${code}`),
    logger,
  }: {
    type: 'client';
    scid: QUICConnectionId;
    dcid?: undefined;
    remoteInfo: RemoteInfo;
    config: QUICConfig;
    socket: QUICSocket;
    reasonToCode?: StreamReasonToCode;
    codeToReason?: StreamCodeToReason;
    logger?: Logger;
  } | {
    type: 'server';
    scid: QUICConnectionId;
    dcid: QUICConnectionId;
    remoteInfo: RemoteInfo;
    config: QUICConfig;
    socket: QUICSocket;
    reasonToCode?: StreamReasonToCode;
    codeToReason?: StreamCodeToReason;
    logger?: Logger;
  }) {
    super();
    this.logger = logger ?? new Logger(`${this.constructor.name} ${scid}`);
    const quicheConfig = buildQuicheConfig(config);
    let conn: Connection;
    if (type === 'client')  {
      // This message will be connected to the `this.start`
      this.logger.info(`Connect ${this.constructor.name}`);
      conn = quiche.Connection.connect(
        null,
        scid,
        {
          host: socket.host,
          port: socket.port,
        },
        {
          host: remoteInfo.host,
          port: remoteInfo.port,
        },
        quicheConfig,
      );
    } else if (type === 'server') {
      // This message will be connected to `this.start`
      this.logger.info(`Accept ${this.constructor.name}`);
      conn = quiche.Connection.accept(
        scid,
        dcid,
        {
          host: socket.host,
          port: socket.port,
        },
        {
          host: remoteInfo.host,
          port: remoteInfo.port,
        },
        quicheConfig,
      );
    }
    // This will output to the log keys file path
    if (config.logKeys != null) {
      conn!.setKeylog(config.logKeys);
    }
    this.type = type;
    this.conn = conn!;
    this.connectionId = scid;
    this.socket = socket;
    this.reasonToCode = reasonToCode;
    this.codeToReason = codeToReason;
    this._remoteHost = remoteInfo.host;
    this._remotePort = remoteInfo.port;
    const {
      p: establishedP,
      resolveP: resolveEstablishedP,
      rejectP: rejectEstablishedP,
    } = utils.promise();
    this.establishedP = establishedP;
    this.resolveEstablishedP = resolveEstablishedP;
    this.rejectEstablishedP = rejectEstablishedP;
    const {
      p: secureEstablishedP,
      resolveP: resolveSecureEstablishedP,
      rejectP: rejectSecureEstablishedP
    } = utils.promise();
    this.secureEstablishedP = secureEstablishedP;
    this.resolveSecureEstablishedP = resolveSecureEstablishedP;
    this.rejectSecureEstablishedP = rejectSecureEstablishedP;
    const {
      p: closedP,
      resolveP: resolveClosedP,
      rejectP: rejectClosedP,
    } = utils.promise();
    this.closedP = closedP;
    this.resolveClosedP = resolveClosedP;
    this.rejectClosedP = rejectClosedP;

    // !!!!
    // Should we do this only on `start`?
    // That way, upon calling start
    // The `socket.connectionMap` can be done!
    // THE server does it ever call `await start()`?
    // No cause `connectionNew` needs to give you back the connection instance object

    // The server does need to trigger `conn.start()`
    // However it does not need to do this for `connectionNew`



    // Registers this connection instance to the socket
    // socket.connectionMap.set(scid, this);
    // ^- I want to know where this should go
    // It seems that it should be in the `start` function now
    // Because, the opposite is in the `stop`
    // This also means in order for this to occur
    // Then the server must also call `start` not just client
    // For the connection to be "started"
    // The QUIC Socket shouldn't bother "handling" such a call though
    // It just need the conn
    // But it could also expect that upon getting a new connection
    // That it would have already been registerd on the socket
    // Then it just `this.connectionMap.get(dcid)`

    // I think this setting must happen inside the `start`
    // Therefore the server must also then trigger the start
    // But it must catch any exceptions, as events
    // It wouldn't wait for this promise though...
    // But you may have a dangling promise?
    // But I wonder if dangling promises are a problem?
    // Because JS sort of forgets about it...
    // Well it doesn't keep the node process open
    // But the GC may not garbage collect it
    // Cause if it is waiting on promise to be resolved
    // Yes it can e GCed... I'm pretyt sure it can
    // So a void promise could work...
    // But also another issue is whihle a connection is starting
    // There's no way to cancel is there?
    // If you are destroying a server, you have to be able to stop
    // connections that are starting, connections that are stopping
    // and ready connections too

    // Ok so `start` is what registers it
    // Makes sense

  }

  public get remoteHost() {
    return this._remoteHost;
  }

  public get remotePort() {
    return this._remotePort;
  }

  public get localHost() {
    return this.socket.host;
  }

  public get localPort() {
    return this.socket.port;
  }

  // So this is a CreateDestroy
  // when created, this doesn't actually mean this is possible
  // It is because, the connection isn't even fully established
  // There's several stages after it
  // Since there is `secureEstablishedP` and `closeP`
  // These 2 technically translate to the `start` and `stop`
  // The reason you need this is because the QUIC Socket needs to be able to do recv and send
  // On the connection instance
  // Therefore, one must be able to CREATE it to get the instance
  // Generally creation implies starting
  // That's the problem here

  // I think if this was swapped to a `StartStop`
  // we can actually instead have...
  // the ability to "construct" it
  // then start/stop independnetly
  // then start/stop can wait for certain events
  // while you can proceed to call recv/send on the connection object
  // just by having it constructed!



  /**
   * This is the same as basically waiting for `secureEstablishedP`
   * While this is occurring one can call the `recv` and `send` to make this happen
   */



  public start(ctx?: Partial<ContextTimed>): PromiseCancellable<void>;
  @timedCancellable(true, Infinity, errors.ErrorQUICConnectionStartTimeOut)
  public async start(@context ctx: ContextTimed): Promise<void> {
    this.logger.info(`Start ${this.constructor.name}`);
    ctx.signal.throwIfAborted();
    ctx.signal.addEventListener('abort', (r) => {
      this.rejectEstablishedP(r);
      this.rejectSecureEstablishedP(r);

      // Is this actually true?
      // Technically the connection is closed
      this.rejectClosedP(r);
    });
    // Set the connection up
    this.socket.connectionMap.set(this.connectionId, this);
    // Waits for the first short packet after establishment
    // This ensures that TLS has been established and verified on both sides
    await this.secureEstablishedP;
    // After this is done
    // We need to established the keep alive interval time
    this.startKeepAliveTimer();
    // Do we remove the on abort event listener?
    // I forgot...
    this.logger.info(`Started ${this.constructor.name}`);
  }

  /**
   * The `applicationError` if the connection close is due to the transport
   * layer or due to the application layer.
   * If `applicationError` is true, you can use any number as the `errorCode`.
   * The other peer must should understand the `errorCode`.
   * If `applicationError` is false, you must use `errorCode` from
   * `ConnectionErrorCode`.
   * The default `applicationError` is true because a normal graceful close
   * is an application error.
   * The default `errorCode` of 0 means no error or general error.
   * This is the same as basically waiting for `closedP`.
   */
  public async stop({
    applicationError = true,
    errorCode = 0,
    errorMessage = '',
    force  = false
  }: {
    applicationError?: false;
    errorCode?: ConnectionErrorCode;
    errorMessage?: string;
    force?: boolean;
  } | {
    applicationError: true;
    errorCode?: number;
    errorMessage?: string;
    force?: boolean;
  }= {}) {
    this.logger.info(`Stop ${this.constructor.name}`);
    const streamDestroyPs: Array<Promise<void>> = [];
    for (const stream of this.streamMap.values()) {
      // TODO: ensure that `stream.destroy` understands `force`
      // Without it, it should be graceful
      // With it, then it should assume the rest of the system could be broken
      streamDestroyPs.push(stream.destroy({ force }));
    }
    await Promise.all(streamDestroyPs);
    // Do we do this afterwards or before?
    this.stopKeepAliveTimer();
    try {
      // We need to lock the connLock
      // Note that this has no timeout
      // We must have any deadlocks here!
      // Plus ctx isn't accepted by the async-locks yet
      // If already closed this will error out
      // But nothing will happen
      await this.connLock.withF(async () => {
        // If this is already closed, then `Done` will be thrown
        // Otherwise it can send `CONNECTION_CLOSE` frame
        // This can be 0x1c close at the QUIC layer or no errors
        // Or it can be 0x1d for application close with an error
        // Upon receiving a `CONNECTION_CLOSE`, you can send back
        // 1 packet containing a `CONNECTION_CLOSE` frame too
        // (with `NO_ERROR` code if appropriate)
        // It must enter into a draining state, and no other packets can be sent
        this.conn.close(applicationError, errorCode, Buffer.from(errorMessage));
        // If we get a `Done` exception we don't bother calling send
        // The send only gets sent if the `Done` is not the case
        await this.send();
      });
    } catch (e) {
      // If the connection is already closed, `Done` will be thrown
      if (e.message !== 'Done') {
        // No other exceptions are expected
        utils.never();
      }
    }

    // Now we await for the closedP
    await this.closedP;

    // I believe the conn timer would always be cancelled
    // At the very end... so maybe we don't need to do this?
    // This may not be needed
    this.stopTimer();

    // The reason we only delete afterwards
    // Is because we do it before we are opened (or just constructed)
    // Techincally it was constructed, and then we added ourselves to it
    // But during `start` we are just waiting
    this.socket.connectionMap.delete(this.connectionId);
    this.logger.info(`Stopped ${this.constructor.name}`);
  }

  /**
   * I don't know if this makes any sense
   */
  @ready(new errors.ErrorQUICConnectionNotRunning())
  public getRemoteCerts(): Array<string> | undefined {
    const certsDER = this.conn.peerCertChain();
    if (certsDER == null) return;
    return certsDER.map(utils.certificateDERToPEM);
  }

  // /**
  //  * Destroys the connection.
  //  * The `applicationError` if the connection close is due to the transport
  //  * layer or due to the application layer.
  //  * If `applicationError` is true, you can use any number as the `errorCode`.
  //  * The other peer must should understand the `errorCode`.
  //  * If `applicationError` is false, you must use `errorCode` from
  //  * `ConnectionErrorCode`.
  //  * The default `applicationError` is true because a normal graceful close
  //  * is an application error.
  //  * The default `errorCode` of 0 means no error or general error.
  //  */
  // public async destroy({
  //   applicationError = true,
  //   errorCode = 0,
  //   errorMessage = '',
  //   force = false,
  // }: {
  //   applicationError?: false;
  //   errorCode?: ConnectionErrorCode;
  //   errorMessage?: string;
  //   force?: boolean;
  // } | {
  //   applicationError: true;
  //   errorCode?: number;
  //   errorMessage?: string;
  //   force?: boolean;
  // }= {}) {
  //   this.logger.info(`Destroy ${this.constructor.name}`);

  //   // console.time('stream destroy');

  //   // Handle destruction concurrently
  //   const destroyProms: Array<Promise<void>> = [];
  //   for (const stream of this.streamMap.values()) {
  //     if (force) {
  //       destroyProms.push(stream.destroy());
  //     } else {
  //       const destroyProm = promise();
  //       stream.addEventListener('destroy', () => destroyProm.resolveP(), {
  //         once: true,
  //       });
  //       destroyProms.push(destroyProm.p);
  //     }
  //   }
  //   await Promise.all(destroyProms);

  //   try {
  //     // If this is already closed, then `Done` will be thrown
  //     // Otherwise it can send `CONNECTION_CLOSE` frame
  //     // This can be 0x1c close at the QUIC layer or no errors
  //     // Or it can be 0x1d for application close with an error
  //     // Upon receiving a `CONNECTION_CLOSE`, you can send back
  //     // 1 packet containing a `CONNECTION_CLOSE` frame too
  //     // (with `NO_ERROR` code if appropriate)
  //     // It must enter into a draining state, and no other packets can be sent
  //     this.conn.close(applicationError, errorCode, Buffer.from(errorMessage));
  //   } catch (e) {
  //     // If the connection is already closed, `Done` will be thrown
  //     if (e.message !== 'Done') {
  //       // No other exceptions are expected
  //       utils.never();
  //     }
  //   }
  //   // console.timeEnd('conn close');

  //   // console.time('conn destroy send');

  //   // Sending if
  //   this.logger.error('SEND BEFORE WAIT FOR CLOSE P');
  //   await this.send();
  //   // If it is not closed, it could still be draining

  //   // This depends on the the `this.resolveCloseP()`
  //   // When that is called, the connection is considered closed
  //   this.logger.error('>>>> WAIT FOR CLOSE P');

  //   // This is false
  //   this.logger.error(`>>>> Connection is closed? ${this.conn.isClosed()}`);
  //   // This is true
  //   this.logger.error(`>>>> Connection is draining? ${this.conn.isDraining()}`);

  //   await this.closedP;

  //   this.logger.error('>>>> PASS CLOSED P');

  //   this.socket.connectionMap.delete(this.connectionId);

  //   // console.timeEnd('conn destroy send');

  //   // Checking if timed out
  //   if (this.conn.isTimedOut()) {
  //     this.logger.error('Connection timed out');
  //     this.dispatchEvent(
  //       new events.QUICSocketErrorEvent({
  //         detail: new errors.ErrorQUICConnectionTimeout(),
  //       }),
  //     );
  //   }
  //   this.dispatchEvent(new events.QUICConnectionDestroyEvent());
  //   // Clean up timeout if it's still running
  //   if (this.timer != null) {
  //     clearTimeout(this.timer);
  //     delete this.timer;
  //   }

  //   this.logger.error('DESTROYED');

  //   this.logger.info(`Destroyed ${this.constructor.name}`);
  // }

  /**
   * Called when the socket receives data from the remote side intended for this connection.
   * UDP -> Connection -> Stream
   * This pushes data to the streams.
   * When the connection is draining, we can still receive data.
   * However, no streams are allowed to read or write.
   *
   * This method must not throw any exceptions.
   * Any errors must be emitted as events.
   * @internal
   */
  @ready(new errors.ErrorQUICConnectionNotRunning(), false, ['stopping'])
  public recv(data: Uint8Array, remoteInfo: RemoteInfo) {

    // Recv is not an async function anymore

    this.logger.debug('RECV CALLED');
    try {
      // The remote info may have changed on each receive
      // here we update!
      // This still requires testing to see what happens
      this._remoteHost = remoteInfo.host;
      this._remotePort = remoteInfo.port;
      // Used by quiche
      const recvInfo = {
        to: {
          host: this.localHost,
          port: this.localPort,
        },
        from: {
          host: remoteInfo.host,
          port: remoteInfo.port,
        },
      };
      try {
        this.conn.recv(data, recvInfo);
        this.logger.info(`RECEIVED ${data.byteLength} of data`);
      } catch (e) {
        this.logger.error(`recv error ${e.message}`);
        // Depending on the exception, the `this.conn.recv`
        // may have automatically started closing the connection
        if (e.message === 'TlsFail') {
          const newError = new errors.ErrorQUICConnectionTLSFailure(undefined, {
            data: {
              localError: this.conn.localError(),
              peerError: this.conn.peerError(),
            },
          });
          this.dispatchEvent(
            new events.QUICConnectionErrorEvent({ detail: newError }),
          );
        } else {
          this.dispatchEvent(
            new events.QUICConnectionErrorEvent({
              detail: new errors.ErrorQUICConnection(e.message, {
                cause: e,
                data: {
                  localError: this.conn.localError(),
                  peerError: this.conn.peerError(),
                },
              }),
            }),
          );
        }
        return;
      }
      this.dispatchEvent(new events.QUICConnectionRecvEvent());
      // Here we can resolve our promises!
      if (this.conn.isEstablished()) {
        this.resolveEstablishedP();
      }
      if (this.conn.isClosed()) {
        if (this.resolveCloseP != null) {
          // console.log('RESOLVE CLOSE P1');
          this.resolveCloseP();
        }
        return;
      }
      if (this.conn.isInEarlyData() || this.conn.isEstablished()) {
        const readIds: Array<number> = [];
        for (const streamId of this.conn.readable() as Iterable<StreamId>) {
          let quicStream = this.streamMap.get(streamId);
          if (quicStream == null) {
            // The creation will set itself to the stream map
            quicStream = await QUICStream.createQUICStream({
              streamId,
              connection: this,
              codeToReason: this.codeToReason,
              reasonToCode: this.reasonToCode,
              // maxReadableStreamBytes: this.maxReadableStreamBytes,
              // maxWritableStreamBytes: this.maxWritableStreamBytes,
              logger: this.logger.getChild(`${QUICStream.name} ${streamId}`),
            });
            this.dispatchEvent(
              new events.QUICConnectionStreamEvent({ detail: quicStream }),
            );
          }
          readIds.push(quicStream.streamId);
          quicStream.read();
          quicStream.dispatchEvent(new events.QUICStreamReadableEvent());
        }
        if (readIds.length > 0) {
          this.logger.info(`processed reads for ${readIds}`);
        }
        const writeIds: Array<number> = [];
        for (const streamId of this.conn.writable() as Iterable<StreamId>) {
          let quicStream = this.streamMap.get(streamId);
          if (quicStream == null) {
            // The creation will set itself to the stream map
            quicStream = await QUICStream.createQUICStream({
              streamId,
              connection: this,
              codeToReason: this.codeToReason,
              reasonToCode: this.reasonToCode,
              // maxReadableStreamBytes: this.maxReadableStreamBytes,
              logger: this.logger.getChild(`${QUICStream.name} ${streamId}`),
            });
            this.dispatchEvent(
              new events.QUICConnectionStreamEvent({ detail: quicStream }),
            );
          }
          quicStream.dispatchEvent(new events.QUICStreamWritableEvent());
          writeIds.push(quicStream.streamId);
          quicStream.write();
        }
        if (writeIds.length > 0) {
          this.logger.info(`processed writes for ${writeIds}`);
        }
      }
    } finally {
      this.garbageCollectStreams('recv');
      this.logger.debug('RECV FINALLY');
      // Set the timeout
      this.checkTimeout();
      // If this call wasn't executed in the midst of a destroy
      // and yet the connection is closed or is draining, then
      // we need to destroy this connection
      if (
        this[status] !== 'destroying' &&
        (this.conn.isClosed() || this.conn.isDraining())
      ) {
        this.logger.debug('CALLING DESTROY 2');
        // Destroy in the background, we still need to process packets
        void this.destroy().catch(() => {});
      }
    }
  }

  /**
   * Called when the socket has to send back data on this connection.
   * This is better understood as "flushing" the connection send buffer.
   * This is because the data to send actually comes from the quiche library
   * and any data that is currently buffered on the streams.
   * It will send everything into the UDP socket.
   *
   * UDP <- Connection <- Stream
   *
   * Call this if `recv` is called.
   * Call this if timer expires.
   * Call this if stream is written.
   * Call this if stream is read.
   *
   * We can push the connection into the stream.
   * The streams have access to the connection object.
   *
   * This method must not throw any exceptions.
   * Any errors must be emitted as events.
   * @internal
   */
  @ready(new errors.ErrorQUICConnectionNotRunning(), false, ['stopping'])
  public async send(): Promise<void> {
    // console.log('SEND CALLED');
    this.logger.debug('SEND CALLED');
    // console.log('-------------CHECKING IS CLOSED');
    if (this.conn.isClosed()) {
      // console.log('FINISH CHECKING IS CLOSED');
      if (this.resolveCloseP != null) {
        this.logger.warn('RESOLVE CLOSE P2' + new Date());
        // console.log('RESOLVE CLOSE P2', new Date());
        this.resolveCloseP();
      }
      return;
    } else if (this.conn.isDraining()) {
      return;
    }
    let numSent = 0;
    try {
      const sendBuffer = new Uint8Array(quiche.MAX_DATAGRAM_SIZE);
      let sendLength: number;
      let sendInfo: SendInfo;
      while (true) {

        this.logger.error('--> WHILE LOOP ITERATION');

        try {
          [sendLength, sendInfo] = this.conn.send(sendBuffer);
        } catch (e) {
          this.logger.debug(`SEND FAILED WITH ${e.message}`);
          if (e.message === 'Done') {
            this.logger.error('--> DONE AFTER CONN SEND');

            this.logger.error(`--> IS CONN CLOSED? ${this.conn.isClosed()}`);

            if (this.conn.isClosed()) {
              this.logger.debug('SEND CLOSED');
              if (this.resolveCloseP != null) {
                // console.log('RESOLVE CLOSE P3');
                this.resolveCloseP();
              }
              return;
            }
            this.logger.debug('SEND IS DONE');

            this.logger.error('--> FINISH WHILE LOOP');
            return;
          }
          this.logger.error('Failed to send, cleaning up');
          try {
            // If the `this.conn.send` failed, then this close
            // may not be able to be sent to the outside
            // It's possible a second call to `this.conn.send` will succeed
            // Otherwise a timeout will occur, which will eventually destroy
            // this connection

            this.conn.close(
              false,
              quiche.ConnectionErrorCode.InternalError,
              Buffer.from('Failed to send data', 'utf-8'), // The message!
            );
          } catch (e) {
            // Only `Done` is possible, no other errors are possible
            if (e.message !== 'Done') {
              utils.never();
            }
          }
          this.dispatchEvent(
            new events.QUICConnectionErrorEvent({
              detail: new errors.ErrorQUICConnection(e.message, {
                cause: e,
                data: {
                  localError: this.conn.localError(),
                  peerError: this.conn.peerError(),
                },
              }),
            }),
          );
          return;
        }

        this.logger.error('--> SEND ON SOCKET');

        try {
          this.logger.debug(
            `ATTEMPTING SEND ${sendLength} bytes to ${sendInfo.to.port}:${sendInfo.to.host}`,
          );

          await this.socket.send(
            sendBuffer,
            0,
            sendLength,
            sendInfo.to.port,
            sendInfo.to.host,
          );
          this.logger.info(`SENT ${sendLength} of data`);
        } catch (e) {
          this.logger.error(`send error ${e.message}`);
          this.dispatchEvent(
            new events.QUICConnectionErrorEvent({ detail: e }),
          );
          return;
        }
        this.dispatchEvent(new events.QUICConnectionSendEvent());
        numSent += 1;
      }
    } finally {
      this.logger.error("--> SEND's FINALLY");

      if (numSent > 0) this.garbageCollectStreams('send');
      this.logger.debug('SEND FINALLY');

      this.logger.error('--> CHECK TIMEOUT');

      this.logger.error(`--> IS CONN CLOSED? ${this.conn.isClosed()}`);
      this.logger.error(`--> IS CONN DRAINING? ${this.conn.isDraining()}`);

      this.checkTimeout();
      if (
        this[status] !== 'destroying' &&
        (this.conn.isClosed() || this.conn.isDraining())
      ) {

        this.logger.error('--> CALLING VOID DESTROY');

        // Ignore errors and run in background
        void this.destroy().catch(() => {});
      } else if (
        this[status] === 'destroying' &&
        this.conn.isClosed() &&
        this.resolveCloseP != null
      ) {

        this.logger.error('--> RESOLVE CLOSE P4');

        // console.log('RESOLVE CLOSE P4');
        // If we flushed the draining, then this is what will happen
        this.resolveCloseP();
      }
    }
  }

  /**
   * Creates a new stream on the connection.
   * Only supports bidi streams atm.
   * This is a serialised call, it must be blocking.
   */
  @ready(new errors.ErrorQUICConnectionNotRunning())
  public async streamNew(streamType: 'bidi' = 'bidi'): Promise<QUICStream> {
    // Technically you can do concurrent bidi and uni style streams
    // but no support for uni streams yet
    // So we don't bother with it
    return await this.streamIdLock.withF(async () => {
      let streamId: StreamId;
      if (this.type === 'client' && streamType === 'bidi') {
        streamId = this.streamIdClientBidi;
      } else if (this.type === 'server' && streamType === 'bidi') {
        streamId = this.streamIdServerBidi;
      }

      // If you call this again
      // you will get another stream ID
      // but the problem is that
      // if you call it multiple times concurrently
      // you'll have an issue
      // this can only be called one at a time
      // This is not allowed to be concurrent
      // You cannot open many streams all concurrently
      // since stream creations are serialised

      // If we are in draining state
      // we cannot call this anymore
      // Hre ewe send the stream id
      // with stream capacity will fail
      // We send a 0-length buffer first
      const quicStream = await QUICStream.createQUICStream({
        streamId: streamId!,
        connection: this,
        codeToReason: this.codeToReason,
        reasonToCode: this.reasonToCode,
        // maxReadableStreamBytes: this.maxReadableStreamBytes,
        // maxWritableStreamBytes: this.maxWritableStreamBytes,
        logger: this.logger.getChild(`${QUICStream.name} ${streamId!}`),
      });
      // Ok the stream is opened and working
      if (this.type === 'client' && streamType === 'bidi') {
        this.streamIdClientBidi = (this.streamIdClientBidi + 4) as StreamId;
      } else if (this.type === 'server' && streamType === 'bidi') {
        this.streamIdServerBidi = (this.streamIdServerBidi + 4) as StreamId;
      }
      return quicStream;
    });
  }

  /**
   * Used to update or disable the keep alive interval.
   * Calling this will reset the delay before the next keep alive.
   */
  @ready(new errors.ErrorQUICConnectionNotRunning())
  public setKeepAlive(intervalDelay?: number) {
    // Clearing timeout prior to update
    if (this.keepAliveInterval != null) {
      clearTimeout(this.keepAliveInterval);
      delete this.keepAliveInterval;
    }
    // Setting up keep alive interval
    if (intervalDelay != null) {
      this.keepAliveInterval = setInterval(async () => {
        // Trigger an ping frame and send
        this.conn.sendAckEliciting();
        await this.send();
      }, intervalDelay);
    }
  }

  // Timeout handling, these methods handle time keeping for quiche.
  // Quiche will request an amount of time, We then call `onTimeout()` after that time has passed.
  protected deadline: number = 0;
  protected onTimeout = async () => {
    this.logger.warn('ON TIMEOUT CALLED ' + new Date());
    this.logger.debug('timeout on timeout');
    // Clearing timeout
    clearTimeout(this.timer);
    delete this.timer;
    this.deadline = Infinity;
    // Doing timeout actions
    // console.time('INTERNAL ON TIMEOUT');
    this.conn.onTimeout();
    // console.timeEnd('INTERNAL ON TIMEOUT');
    this.logger.warn('BEFORE CALLING SEND' + new Date());
    if (this[destroyed] === false) await this.send();
    this.logger.warn('AFTER CALLING SEND ' + new Date());
    if (
      this[status] !== 'destroying' &&
      (this.conn.isClosed() || this.conn.isDraining())
    ) {
      this.logger.debug('CALLING DESTROY 3');
      // Destroy in the background, we still need to process packets
      void this.destroy().catch(() => {});
    }
    this.logger.warn('BEFORE CHECK TIMEOUT' + new Date());
    this.checkTimeout();
    this.logger.warn('AFTER CHECK TIMEOUT' + new Date());
  };

  /**
   * Checks the timeout event, should be called whenever the following events happen.
   * 1. `send()` is called
   * 2. `recv()` is called
   * 3. timer times out.
   *
   * This needs to do 3 things.
   * 1. Create a timer if none exists
   * 2. Update the timer if `conn.timeout()` is less than current timeout.
   * 3. clean up timer if `conn.timeout()` is null.
   */
  protected checkTimeout = () => {
    this.logger.debug('timeout checking timeout');
    // During construction, this ends up being null
    const time = this.conn.timeout();
    this.logger.error(`THE TIME (${this.times}): ` + time + ' ' + new Date());
    this.times++;

    if (time == null) {
      // Clear timeout
      if (this.timer != null) this.logger.debug('timeout clearing timeout');
      clearTimeout(this.timer);
      delete this.timer;
      this.deadline = Infinity;
    } else {
      const newDeadline = Date.now() + time;
      if (this.timer != null) {
        if (time === 0) {
          this.logger.debug('timeout triggering instant timeout');
          // Skip timer and call onTimeout
          setImmediate(this.onTimeout);
        } else if (newDeadline < this.deadline) {
          this.logger.debug(`timeout updating timer with ${time} delay`);
          clearTimeout(this.timer);
          delete this.timer;
          this.deadline = newDeadline;

          this.logger.warn('BEFORE SET TIMEOUT 1: ' + time);

          this.timer = setTimeout(this.onTimeout, time);
        }
      } else {
        if (time === 0) {
          this.logger.debug('timeout triggering instant timeout');
          // Skip timer and call onTimeout
          setImmediate(this.onTimeout);
          return;
        }
        this.logger.debug(`timeout creating timer with ${time} delay`);
        this.deadline = newDeadline;

        this.logger.warn('BEFORE SET TIMEOUT 2: ' + time);

        this.timer = setTimeout(this.onTimeout, time);
      }
    }
  };

  protected garbageCollectStreams(where: string) {
    const nums: Array<number> = [];
    // Only check if packets were sent
    for (const [streamId, quicStream] of this.streamMap) {
      // Stream sending can finish after a packet is sent
      nums.push(streamId);
      quicStream.read();
    }
    if (nums.length > 0) {
      this.logger.info(`checking read finally ${where} for ${nums}`);
    }
  }
}

export default QUICConnection;
