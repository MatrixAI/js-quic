import type { PromiseCancellable } from '@matrixai/async-cancellable';
import type { ContextTimed } from '@matrixai/contexts';
import type QUICSocket from './QUICSocket';
import type QUICConnectionMap from './QUICConnectionMap';
import type QUICConnectionId from './QUICConnectionId';
import type { Host, Port, RemoteInfo, StreamId } from './types';
import type { Connection, ConnectionErrorCode, SendInfo } from './native/types';
import type { StreamCodeToReason, StreamReasonToCode } from './types';
import type { QUICConfig, ConnectionMetadata } from './types';
import { StartStop, ready, status, running } from '@matrixai/async-init/dist/StartStop';
import Logger from '@matrixai/logger';
import { Lock, LockBox, Monitor, RWLockWriter } from '@matrixai/async-locks';
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
 * - connectionStop
 * - connectionError - can occur due to a timeout too
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
   * Internal stream map.
   * This is also used by `QUICStream`.
   * @internal
   */
  public readonly streamMap: Map<StreamId, QUICStream> = new Map();

  /**
   * Logger.
   */
  protected logger: Logger;

  /**
   * Underlying socket.
   */
  protected socket: QUICSocket;

  protected config: QUICConfig;

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
  protected connTimeOutTimer?: Timer;

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
  protected keepAliveIntervalTimer?: Timer;

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

  /**
   * Connection establishment.
   * This can resolve or reject.
   * Rejections cascade down to `secureEstablishedP` and `closedP`.
   */
  protected establishedP: Promise<void>;

  /**
   * Connection has been verified and secured.
   * This can only happen after `establishedP`.
   * On the server side, being established means it is also secure established.
   * On the client side, after being established, the client must wait for the
   * first short frame before it is also secure established.
   * This can resolve or reject.
   * Rejections cascade down to `closedP`.
   */
  protected secureEstablishedP: Promise<void>;

  /**
   * Connection closed promise.
   * This can resolve or reject.
   */
  protected closedP: Promise<void>;

  protected wasEstablished: boolean = false;

  protected resolveEstablishedP: () => void;
  protected rejectEstablishedP: (reason?: any) => void;
  protected resolveSecureEstablishedP: () => void;
  protected rejectSecureEstablishedP: (reason?: any) => void;
  protected resolveClosedP: () => void;
  protected rejectClosedP: (reason?: any) => void;

  protected lastErrorMessage?: string;

  protected lockbox = new LockBox<RWLockWriter>();
  protected readonly lockCode = 'Lock';

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
    this.config = config;
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
    this.resolveEstablishedP = () => {

      // Upon the first time you call this, it is now true
      // But prior to this

      this.wasEstablished = true;
      resolveEstablishedP();
    };
    this.rejectEstablishedP = rejectEstablishedP;

    // We can do something where, once you "resolve"
    // Then it is in fact established
    // Alternatively, we can just bind into the `establishedP` here
    // Does this become a dangling promsie?
    // Cause it is `void` here
    // I think it's better to use the `resolveEstablishedP`



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
    if (this.config.keepAliveIntervalTime != null) {
      this.startKeepAliveIntervalTimer(
        this.config.keepAliveIntervalTime
      );
    }
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
  public async stop(
    {
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
    }= {},
    mon: Monitor<RWLockWriter>,
  ) {
    this.logger.info(`Stop ${this.constructor.name}`);
    await mon.withF(this.lockCode, async () => {

    const streamDestroyPs: Array<Promise<void>> = [];
    for (const stream of this.streamMap.values()) {
      streamDestroyPs.push(stream.destroy({ force }));
    }
    await Promise.all(streamDestroyPs);
    // Do we do this afterwards or before?
    this.stopKeepAliveIntervalTimer();
    try {
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
    } catch (e) {
      // If the connection is already closed, `Done` will be thrown
      if (e.message !== 'Done') {
        // No other exceptions are expected
        utils.never();
      }
    }

    // Now we await for the closedP
    await this.closedP;

    // The reason we only delete afterwards
    // Is because we do it before we are opened (or just constructed)
    // Techincally it was constructed, and then we added ourselves to it
    // But during `start` we are just waiting
    this.socket.connectionMap.delete(this.connectionId);

    this.dispatchEvent(new events.QUICConnectionStopEvent());
    });
    this.logger.info(`Stopped ${this.constructor.name}`);
  }

  /**
   * Gets an array of certificates in PEM format start on the leaf.
   */
  @ready(new errors.ErrorQUICConnectionNotRunning())
  public getRemoteCertsChain(): Array<string> {
    const certsDER = this.conn.peerCertChain();
    if (certsDER == null) return [];
    return certsDER.map(utils.certificateDERToPEM);
  }

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
  public recv(data: Uint8Array, remoteInfo: RemoteInfo) {
    try {
      // The remote information may be changed on each receive
      // However to do so would mean connection migration,
      // which is is not yet supported
      this._remoteHost = remoteInfo.host;
      this._remotePort = remoteInfo.port;
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
        // This can process concatenated QUIC packets
        // This may mutate `data`
        this.conn.recv(data, recvInfo);
      } catch (e) {
        if (e.message !== 'TlsFail') {
          // No other exceptions are expected
          utils.never();
        }
        // Do note that if we get a TlsFail
        // We must proceed without throwing any exceptions
        // But we must "save" the error here
        // We don't need the save the localError or remoteError
        // Cause that will be "saved"
        // Only this e.message <- this will be whatever is the last message
        this.lastErrorMessage = e.message;
      }

      // We don't actually "fail"
      // the closedP until we proceed
      // But note that if there's an error

      if (this.conn.isEstablished()) {
        this.resolveEstablishedP();


        if (this.type === 'server') {
          // For server connections, if we are established
          // we are secure established
          this.resolveSecureEstablishedP();
        } else if (this.type === 'client') {

          // We need a hueristic to indicate whether we are securely established

          // If we are already established
          // AND IF, we are getting a packet after establishment
          // And we didn't result in an error
          // Neither draining, nor closed, nor timed out

          // For server connections
          // If we are already established, then we are secure established

          // To know if the server is also established
          // We need to know the NEXT recv after we are already established
          // So we received something, and that allows us to be established
          // UPON the next recv
          // We need to ensure:
          // 1. No errors
          // 2. Not draining
          // 3. No
          // YES the main thing is that there is no errors
          // I think that's the KEY
          // But we must only switch
          // If were "already" established
          // That this wasn't the first time we were established

        }
      }

      // We also need to know whether this is our first short frame
      // After we are already established
      // This may not be robust
      // Cause technically
      // What if we were "concatenated" packet
      // Then it could be a problem right?


      if (this.conn.isClosed()) {
        this.resolveClosedP();
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
  public async send(mon: Monitor<RWLockWriter>): Promise<void> {
    await mon.withF(this.lockCode, async () => {
      const sendBuffer = new Uint8Array(quiche.MAX_DATAGRAM_SIZE);
      let sendLength: number;
      let sendInfo: SendInfo;
      try {
        // Send until `Done`
        while (true) {
          try {
            [sendLength, sendInfo] = this.conn.send(sendBuffer);
          } catch (e) {
            if (e.message === 'Done') {
              break;
            }
            throw e;
          }
          await this.socket.send(
            sendBuffer,
            0,
            sendLength,
            sendInfo.to.port,
            sendInfo.to.host,
          );
        }
      } catch (e) {

        // If called `stop` due to an error here
        // we MUST not call `this.send` again
        // in fact, we do a hard-stop
        // There's no need to even have a timeout at all
        // Remember this exception COULD be due to `e`
        // It could be due to `localError` or `remoteError`
        // All of this is possbile
        // Generally at least one of them is the reason

        // the error has to be one or the other

        await this.stop({
          error: e
        });

        // We need to finish without any exceptions
        return;
      }
      if (this.conn.isClosed()) {

        // But if it is closed with no error
        // Then we just have to proceed!
        // Plus if we are called here

        await this.stop({
          error: this.conn.localError() ?? this.conn.remoteError(),
        });

      } else {
        // In all other cases, reset the conn timer
        this.setConnTimeOutTimer();
      }
    });
  }

  protected setConnTimeOutTimer(): void {
    const connTimeOutHandler = async () => {
      // This can only be called when the timeout has occurred
      // This transitions the connection state
      this.conn.onTimeout();

      // At this point...
      // we check the conditions on the connection
      // This way we can RESOLVE things like
      // conn closed or established or other things
      // or if we are draining
      // if we have timed out... etc
      // All state changes need to result in reaction
      // Is established is not required
      // But we can have a bunch of things that check and react accordingly
      // So if it is timed out, it gets closed too
      // But if it is is timed out due to idle we raise an error

      if (this.conn.isTimedOut()) {

        // This is just a dispatch on the connection error
        // Note that this may cause the client to attempt
        // to stop the socket and stuff
        // The client should ignore this event error
        // Because it's actually being handled
        // On the other hand...
        // If we randomly fail here
        // It's correct to properly raise an event
        // To bubble up....

        this.dispatchEvent(
          new events.QUICConnectionErrorEvent({
            detail: new errors.ErrorQUICConnectionTimeout()
          })
        );
      }

      // At the same time, we may in fact be closed too
      if (this.conn.isClosed()) {
        // We actually finally closed here
        // Actually the question is that this could be an error
        // The act of closing is an error?
        // That's confusing
        this.resolveClosedP();
        // If we are not stopping nor are we stopped
        // And we are not running, call await this stop

        // We need to trigger this as well by calling stop
        // What happens if we are starting too?
        if (this[running] && this[status] !== 'stopping') {
          // If we are already stopping, stop multiple times is idempotent
          // Wait if we call stop multiple times
          // Actually we may already be stopping
          // But also that if the status is starting
          // But also if we are starting
          // Resolve the closeP
          // is technicaly an error!

          await this.stop();
        }

        // Finish
        return;
      }

      // Note that a `0` timeout is still a valid timeout
      const timeout = this.conn.timeout();
      // If this is `null`, then technically there's nothing to do
      if (timeout == null) return;
      this.connTimeOutTimer = new Timer({
        delay: timeout,
        handler: connTimeOutHandler
      });
    };
    // Note that a `0` timeout is still a valid timeout
    const timeout = this.conn.timeout();
    // If this is `null` there's nothing to do
    if (timeout == null) return;
    // If there was an existing timer, we cancel it and set a new one
    if (this.connTimeOutTimer != null) {
      this.connTimeOutTimer.cancel();
    }
    this.connTimeOutTimer = new Timer({
      delay: timeout,
      handler: connTimeOutHandler
    });
  }

  /**
   * Starts the keep alive interval timer.
   * Make sure to set the interval to be less than then the `maxIdleTime` unless
   * if the `maxIdleTime` is `0`.
   * If the `maxIdleTime` is `0`, then this is not needed to keep the connection
   * open. However it can still be useful to maintain liveness for NAT purposes.
   */
  protected startKeepAliveIntervalTimer(ms: number): void {
    const keepAliveHandler = async () => {
      // Intelligently schedule a PING frame.
      // If the connection has already sent ack-eliciting frames
      // then this is a noop.
      await this.connLock.withF(async () => {
        this.conn.sendAckEliciting();
        await this.send();
      });
      this.keepAliveIntervalTimer = new Timer({
        delay: ms,
        handler: keepAliveHandler
      });
    };
    this.keepAliveIntervalTimer = new Timer({
      delay: ms,
      handler: keepAliveHandler
    });
  }

  /**
   * Stops the keep alive interval timer
   */
  protected stopKeepAliveIntervalTimer(): void {
    this.keepAliveIntervalTimer?.cancel();
  }









  /**
   * Creates a new stream on the connection.
   * Only supports bidi streams atm.
   * This is a serialised call, it must be blocking.
   */
  @ready(new errors.ErrorQUICConnectionNotRunning())
  public async streamNew(streamType: 'bidi' = 'bidi'): Promise<QUICStream> {

    // You wouldn't want AsyncMonitor here
    // The problem is that we want re-entrant contexts


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

  // /**
  //  * Used to update or disable the keep alive interval.
  //  * Calling this will reset the delay before the next keep alive.
  //  */
  // @ready(new errors.ErrorQUICConnectionNotRunning())
  // public setKeepAlive(intervalDelay?: number) {
  //   // Clearing timeout prior to update
  //   if (this.keepAliveInterval != null) {
  //     clearTimeout(this.keepAliveInterval);
  //     delete this.keepAliveInterval;
  //   }
  //   // Setting up keep alive interval
  //   if (intervalDelay != null) {
  //     this.keepAliveInterval = setInterval(async () => {
  //       // Trigger an ping frame and send
  //       this.conn.sendAckEliciting();
  //       await this.send();
  //     }, intervalDelay);
  //   }
  // }
  //
  // // Timeout handling, these methods handle time keeping for quiche.
  // // Quiche will request an amount of time, We then call `onTimeout()` after that time has passed.
  // protected deadline: number = 0;
  // protected onTimeout = async () => {
  //   this.logger.warn('ON TIMEOUT CALLED ' + new Date());
  //   this.logger.debug('timeout on timeout');
  //   // Clearing timeout
  //   clearTimeout(this.timer);
  //   delete this.timer;
  //   this.deadline = Infinity;
  //   // Doing timeout actions
  //   // console.time('INTERNAL ON TIMEOUT');
  //   this.conn.onTimeout();
  //   // console.timeEnd('INTERNAL ON TIMEOUT');
  //   this.logger.warn('BEFORE CALLING SEND' + new Date());
  //   if (this[destroyed] === false) await this.send();
  //   this.logger.warn('AFTER CALLING SEND ' + new Date());
  //   if (
  //     this[status] !== 'destroying' &&
  //     (this.conn.isClosed() || this.conn.isDraining())
  //   ) {
  //     this.logger.debug('CALLING DESTROY 3');
  //     // Destroy in the background, we still need to process packets
  //     void this.destroy().catch(() => {});
  //   }
  //   this.logger.warn('BEFORE CHECK TIMEOUT' + new Date());
  //   this.checkTimeout();
  //   this.logger.warn('AFTER CHECK TIMEOUT' + new Date());
  // };

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
  // protected checkTimeout = () => {
  //   this.logger.debug('timeout checking timeout');
  //   // During construction, this ends up being null
  //   const time = this.conn.timeout();
  //   this.logger.error(`THE TIME (${this.times}): ` + time + ' ' + new Date());
  //   this.times++;
  //
  //   if (time == null) {
  //     // Clear timeout
  //     if (this.timer != null) this.logger.debug('timeout clearing timeout');
  //     clearTimeout(this.timer);
  //     delete this.timer;
  //     this.deadline = Infinity;
  //   } else {
  //     const newDeadline = Date.now() + time;
  //     if (this.timer != null) {
  //       if (time === 0) {
  //         this.logger.debug('timeout triggering instant timeout');
  //         // Skip timer and call onTimeout
  //         setImmediate(this.onTimeout);
  //       } else if (newDeadline < this.deadline) {
  //         this.logger.debug(`timeout updating timer with ${time} delay`);
  //         clearTimeout(this.timer);
  //         delete this.timer;
  //         this.deadline = newDeadline;
  //
  //         this.logger.warn('BEFORE SET TIMEOUT 1: ' + time);
  //
  //         this.timer = setTimeout(this.onTimeout, time);
  //       }
  //     } else {
  //       if (time === 0) {
  //         this.logger.debug('timeout triggering instant timeout');
  //         // Skip timer and call onTimeout
  //         setImmediate(this.onTimeout);
  //         return;
  //       }
  //       this.logger.debug(`timeout creating timer with ${time} delay`);
  //       this.deadline = newDeadline;
  //
  //       this.logger.warn('BEFORE SET TIMEOUT 2: ' + time);
  //
  //       this.timer = setTimeout(this.onTimeout, time);
  //     }
  //   }
  // };

  // protected garbageCollectStreams(where: string) {
  //   const nums: Array<number> = [];
  //   // Only check if packets were sent
  //   for (const [streamId, quicStream] of this.streamMap) {
  //     // Stream sending can finish after a packet is sent
  //     nums.push(streamId);
  //     quicStream.read();
  //   }
  //   if (nums.length > 0) {
  //     this.logger.info(`checking read finally ${where} for ${nums}`);
  //   }
  // }
}

export default QUICConnection;
