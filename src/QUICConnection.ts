import type { Connection, RecvInfo } from './native/index.js';
import type {
  ConnectionIdString,
  Host,
  Port,
  QUICConfig,
  RemoteInfo,
  SendData,
  StreamId,
} from './types.js';
import type * as nativeTypes from './native/types.js';
import type Logger from '@matrixai/logger';
import { ReplaySubject, Subject } from 'rxjs';
import { ConnectionType } from './types.js';
import { CryptoError, quiche } from './native/index.js';
import { buildQuicheConfig } from './config.js';
import * as errors from './errors.js';
import * as utils from './utils.js';
import QUICConnectionId from './QUICConnectionId.js';
import QUICStream from './QUICStream.js';

const LOG_STAGES = true;
const LOG_STATE_CHAGES = true;

class QUICConnection {
  // TODO: define static constructors here;

  static connectionConnect({
    serverName,
    scid,
    config,
    sourceHost,
    sourcePort,
    host,
    port,
    logger,
  }: {
    serverName?: string;
    config: QUICConfig;
    scid: Uint8Array;
    sourceHost: Host;
    sourcePort: Port;
    host: Host;
    port: Port;
    logger: Logger;
  }): QUICConnection {
    // Doing checks.
    if (
      config.keepAliveIntervalTime != null &&
      config.maxIdleTimeout !== 0 &&
      config.keepAliveIntervalTime >= config.maxIdleTimeout
    ) {
      throw new errors.ErrorQUICConnectionConfigInvalid(
        '`keepAliveIntervalTime` must be less than `maxIdleTimeout`',
      );
    }
    if (scid.byteLength !== quiche.MAX_CONN_ID_LEN) {
      throw Error(`connection id bytelength must be ${quiche.MAX_CONN_ID_LEN}`);
    }

    const quicheConfig = buildQuicheConfig(config);

    const connection = quiche.Connection.connect(
      serverName,
      scid,
      {
        host: sourceHost,
        port: sourcePort,
      },
      {
        host: host,
        port: port,
      },
      quicheConfig,
    );
    // This will output to the log keys file path
    if (config.logKeys != null) {
      connection!.setKeylog(config.logKeys);
    }
    const quicConnection = new this(
      ConnectionType.CLIENT,
      connection,
      config,
      sourceHost,
      sourcePort,
      host,
      port,
      logger,
    );
    return quicConnection;
  }

  static connectionAccept({
    scid,
    dcid,
    config,
    sourceHost,
    sourcePort,
    host,
    port,
    logger,
  }: {
    serverName?: string;
    config: QUICConfig;
    scid: QUICConnectionId;
    dcid: QUICConnectionId;
    sourceHost: Host;
    sourcePort: Port;
    host: Host;
    port: Port;
    logger: Logger;
  }) {
    // Doing checks.
    if (
      config.keepAliveIntervalTime != null &&
      config.maxIdleTimeout !== 0 &&
      config.keepAliveIntervalTime >= config.maxIdleTimeout
    ) {
      throw new errors.ErrorQUICConnectionConfigInvalid(
        '`keepAliveIntervalTime` must be less than `maxIdleTimeout`',
      );
    }
    const quicheConfig = buildQuicheConfig(config);
    const connection = quiche.Connection.accept(
      scid,
      dcid,
      {
        host: sourceHost,
        port: sourcePort,
      },
      {
        host: host,
        port: port,
      },
      quicheConfig,
    );
    // This will output to the log keys file path
    if (config.logKeys != null) {
      connection!.setKeylog(config.logKeys);
    }
    const quicConnection = new this(
      ConnectionType.SERVER,
      connection,
      config,
      sourceHost,
      sourcePort,
      host,
      port,
      logger,
    );
    return quicConnection;
  }

  // TODO: define observables here
  public readonly error$: Subject<Error> = new Subject();
  // A send event must be emmitted after the following
  //  - when a recv is processed
  //  - After a timeout event when `onTimeout()` is called
  //  - When the application interacts with the streams
  public readonly send$: Subject<SendData> = new Subject();

  /**
   * Chain of local certificates from leaf to root in DER format.
   */
  protected certDERs: Array<Uint8Array> = [];

  /**
   * Array of independent CA certificates in DER format.
   */
  protected caDERs: Array<Uint8Array> = [];

  // Sets everything up
  public constructor(
    public readonly type: ConnectionType,
    public readonly connection: Connection,
    public readonly config: QUICConfig,
    public readonly sourceHost: Host,
    public readonly sourcePort: Port,
    public readonly host: Host,
    public readonly port: Port,
    protected logger: Logger,
  ) {
    if (config.cert != null) {
      const certPEMs = utils.collectPEMs(this.config.cert);
      this.certDERs = certPEMs.map(utils.pemToDER);
    }
    if (this.config.ca != null) {
      const caPEMs = utils.collectPEMs(this.config.ca);
      this.caDERs = caPEMs.map(utils.pemToDER);
    }

    if (LOG_STATE_CHAGES) {
      this.timeout$.subscribe(() => this.logger.warn(`TIMEOUT!`));
    }
    if (LOG_STATE_CHAGES) {
      this.established$.subscribe(() =>
        this.logger.warn(`CHANGED established$`),
      );
    }
    if (LOG_STATE_CHAGES) {
      this.isResumed$.subscribe((v) =>
        this.logger.warn(`CHANGED isResumed$ ${v}`),
      );
    }
    if (LOG_STATE_CHAGES) {
      this.isInEarlyData$.subscribe((v) =>
        this.logger.warn(`CHANGED isInEarlyData$ ${v}`),
      );
    }
    if (LOG_STATE_CHAGES) {
      this.isReadable$.subscribe((v) =>
        this.logger.warn(`CHANGED isReadable$ ${v}`),
      );
    }
    if (LOG_STATE_CHAGES) {
      this.draining$.subscribe(() => this.logger.warn(`CHANGED draining$`));
    }
    if (LOG_STATE_CHAGES) {
      this.closed$.subscribe(() => this.logger.warn(`CHANGED closed$`));
    }
    if (LOG_STATE_CHAGES) {
      this.timedOut$.subscribe(() => this.logger.warn(`CHANGED timedOut$`));
    }
    if (LOG_STATE_CHAGES) {
      this.peerError$.subscribe((v) =>
        this.logger.warn(
          `CHANGED peerError$  app:${v.isApp} code:${
            v.errorCode
          } Reason:${Buffer.from(v.reason).toString()}`,
        ),
      );
    }
    if (LOG_STATE_CHAGES) {
      this.localError$.subscribe((v) =>
        this.logger.warn(
          `CHANGED localError$ app:${v.isApp} code:${
            v.errorCode
          } Reason:${Buffer.from(v.reason).toString()}`,
        ),
      );
    }
    if (LOG_STATE_CHAGES) {
      this.peerCertChain$.subscribe(() =>
        this.logger.warn(`CHANGED peerCertChain$`),
      );
    }
  }

  public get connectionId_(): QUICConnectionId {
    const sourceId = this.connection.sourceId();
    // Zero copy construction of QUICConnectionId
    return new QUICConnectionId(
      sourceId.buffer,
      sourceId.byteOffset,
      sourceId.byteLength,
    );
  }

  public get connectionId(): ConnectionIdString {
    const sourceId = this.connection.sourceId();
    return Buffer.from(sourceId).toString('hex') as ConnectionIdString;
  }

  public get connectionIdPeer(): ConnectionIdString {
    const destinationId = this.connection.destinationId();
    return Buffer.from(destinationId).toString('hex') as ConnectionIdString;
  }

  public get connectionIdShared(): string {
    const sourceId = this.connectionId;
    const destinationId = this.connectionIdPeer;
    return [sourceId, destinationId].sort().join('-');
  }

  // TODO: getters for host and port

  public get closed() {
    return this.connection.isClosed();
  }

  /**
   * This just shoves data into the underlying connection instance and triggers observable events
   */
  // TODO: define simple recv
  public recv(data: Uint8Array, remoteInfo: RemoteInfo) {
    if (LOG_STAGES) this.logger.warn(`!----- Processing recv -----!`);
    const recvInfo: RecvInfo = {
      to: {
        host: this.sourceHost,
        port: this.sourcePort,
      },
      from: {
        host: remoteInfo.host,
        port: remoteInfo.port,
      },
    };
    try {
      this.connection.recv(data, recvInfo);
    } catch (e) {
      this.logger.warn('failed here');
      if (e.message === 'TlsFail') {
        // TODO: error out TLS observable
        const error = this.localError;
        if (error == null) utils.never('local error information as missing');
        const message = `TLS verification failed with ${
          CryptoError[error.errorCode]
        }(${error.errorCode})`;
        // TODO: make a proper TLS fail error
        this.error$.next(Error(`TMP IMP ` + message));
      } else {
        this.error$.next(Error(`TMP IMP Errored from ${e.message}`));
      }
    }
    this.processStreams();
    this.processSend();
    if (LOG_STAGES) this.logger.warn(`!----- Processing recv done -----!`);
  }

  // This will extract send data from the connection and emit it on the `sendData$` subject
  public processSend(): void {
    if (LOG_STAGES) this.logger.warn(`!----- processSend -----!`);
    try {
      if (this.connection.isDraining()) {
        this.logger.warn('skipping due to draining state');
        return;
      }
      while (true) {
        const sendBuffer = Buffer.allocUnsafe(
          this.config.maxSendUdpPayloadSize,
        );
        const result = this.connection.send(sendBuffer);
        if (result == null) break;
        const [sendLength, sendInfo] = result;
        this.send$.next({
          data: sendBuffer.subarray(0, sendLength),
          host: sendInfo.to.host,
          port: sendInfo.to.port,
          at: sendInfo.at,
        });
      }
    } catch (e) {
      // TODO: dispatch connection error
      this.logger.warn(`failed to process send with ${e.message}`);
      throw e;
    } finally {
      this.checkState();
    }
    if (LOG_STAGES) this.logger.warn(`!----- ProcessSend done -----!`);
  }

  // TODO: define simple state checks
  protected checkState(): void {
    if (LOG_STAGES) this.logger.warn(`!----- checkState -----!`);
    this.checkTimeout();
    // This.logger.warn(`activeSourceCids: ${this.connection.activeSourceCids()}`);
    // this.logger.warn(`maxActiveSourceCids: ${this.connection.maxActiveSourceCids()}`);
    // this.logger.warn(`sourceCidsLeft: ${this.connection.sourceCidsLeft()}`);
    // this.logger.warn(`retiredScidNext: ${this.connection.retiredScidNext()}`);
    // this.logger.warn(`availableDcids: ${this.connection.availableDcids()}`);
    // this.logger.warn(`traceId: ${this.connection.traceId()}`);
    // this.logger.warn(`applicationProto: ${this.connection.applicationProto()}`);
    // this.logger.warn(`serverName: ${this.connection.serverName()}`);
    // this.logger.warn(`session: ${this.connection.session()}`);
    // this.logger.warn(`sourceId: ${this.connection.sourceId()}`);
    // this.logger.warn(`destinationId: ${this.connection.destinationId()}`);
    // this.logger.warn(`stats: ${this.connection.stats()}`);
    void this.isEstablished;
    void this.isResumed;
    void this.isInEarlyData;
    void this.isReadable;
    void this.isDraining;
    void this.isClosed;
    void this.isTimedOut;
    void this.peerError;
    void this.localError;
    void this.peerCertChain;
    if (LOG_STAGES) this.logger.warn(`!----- checkState Done -----!`);
  }

  protected timeoutTimer: NodeJS.Timeout | undefined;
  protected timeout$: Subject<void> = new Subject();
  protected handleTimeout = () => {
    this.logger.warn('HANDLIGN TIMEOUT');
    this.connection.onTimeout();
    this.timeout$.next();
    this.processSend();
    this.checkState();
    this.checkTimeout();
  };
  protected checkTimeout() {
    const timeoutDelay = this.connection.timeout();
    clearTimeout(this.timeoutTimer);
    delete this.timeoutTimer;
    if (timeoutDelay == null) {
      this.logger.warn('DISARMED TIMEOUT');
      return;
    }
    this.logger.warn(`TIMEOUT in ${timeoutDelay}ms`);
    this.timeoutTimer = setTimeout(this.handleTimeout, timeoutDelay + 1);
  }

  protected isEstablished_ = false;
  public readonly established$: ReplaySubject<void> = new ReplaySubject(1);
  public get isEstablished() {
    const value = this.connection.isEstablished();
    const updated = value !== this.isEstablished_;
    this.isEstablished_ = value;
    if (updated) this.established$.next();
    return value;
  }

  protected isResumed_ = false;
  public readonly isResumed$: Subject<boolean> = new Subject();
  public get isResumed() {
    const value = this.connection.isResumed();
    const updated = value !== this.isResumed_;
    this.isResumed_ = value;
    if (updated) this.isResumed$.next(value);
    return value;
  }

  protected isInEarlyData_ = false;
  public readonly isInEarlyData$: Subject<boolean> = new Subject();
  public get isInEarlyData() {
    const value = this.connection.isInEarlyData();
    const updated = value !== this.isInEarlyData_;
    this.isInEarlyData_ = value;
    if (updated) this.isInEarlyData$.next(value);
    return value;
  }

  protected isReadable_ = false;
  public readonly isReadable$: Subject<boolean> = new Subject();
  public get isReadable() {
    const value = this.connection.isReadable();
    const updated = value !== this.isReadable_;
    this.isReadable_ = value;
    if (updated) this.isReadable$.next(value);
    return value;
  }

  protected isDraining_ = false;
  public readonly draining$: ReplaySubject<void> = new ReplaySubject(1);
  public get isDraining() {
    const value = this.connection.isDraining();
    const updated = value !== this.isDraining_;
    this.isDraining_ = value;
    if (updated) this.draining$.next();
    return value;
  }

  protected isClosed_ = false;
  public readonly closed$: ReplaySubject<void> = new ReplaySubject(1);
  public get isClosed() {
    const value = this.connection.isClosed();
    const updated = value !== this.isClosed_;
    this.isClosed_ = value;
    if (updated) this.closed$.next();
    return value;
  }

  protected isTimedOut_ = false;
  public readonly timedOut$: ReplaySubject<void> = new ReplaySubject(1);
  public get isTimedOut() {
    const value = this.connection.isTimedOut();
    const updated = value !== this.isTimedOut_;
    this.isTimedOut_ = value;
    if (updated) this.timedOut$.next();
    return value;
  }

  protected peerError_: nativeTypes.ConnectionError | undefined = undefined;
  public readonly peerError$: ReplaySubject<nativeTypes.ConnectionError> =
    new ReplaySubject(1);
  public get peerError() {
    const value = this.connection.peerError();
    if (this.peerError_ == null && value != null) {
      this.peerError_ = value;
      this.peerError$.next(value);
      this.error$.next(
        Error(`TMP IMP failed with peerError ${value.errorCode}`),
      );
    }
    return value;
  }

  protected localError_: nativeTypes.ConnectionError | undefined = undefined;
  public readonly localError$: ReplaySubject<nativeTypes.ConnectionError> =
    new ReplaySubject(1);
  public get localError() {
    const value = this.connection.localError();
    if (this.localError_ == null && value != null) {
      this.localError_ = value;
      this.localError$.next(value);
      this.error$.next(
        Error(`TMP IMP failed with localError ${value.errorCode}`),
      );
    }
    return value;
  }

  protected peerCertChain_: Array<string> | undefined = undefined;
  public readonly peerCertChain$: ReplaySubject<Array<string>> =
    new ReplaySubject(1);
  public get peerCertChain() {
    const value = this.connection.peerCertChain();
    if (this.peerCertChain_ == null && value != null) {
      this.peerCertChain_ = value.map((v) => Buffer.from(v).toString('utf-8'));
      this.peerCertChain$.next(this.peerCertChain_);
    }
    return this.peerCertChain_;
  }

  public kill({
    isApp,
    errorCode,
    reason,
  }: {
    isApp: boolean;
    errorCode: number;
    reason: Uint8Array;
  }) {
    this.connection.close(isApp, errorCode, reason);
    this.processSend();
  }

  // Stream related methods
  // TODO: we need a stream map for tracking existing streams
  // TODO: we need a stream ID tracker for avoiding used streamIds, assuming this is actually a problem
  // TODO: time to update quiche

  /**
   * Client initiated bidirectional stream starts at 0.
   * Increment by 4 to get the next ID.
   */
  protected streamIdClientBidi: StreamId = 0b00;

  /**
   * Server initiated bidirectional stream starts at 1.
   * Increment by 4 to get the next ID.
   */
  protected streamIdServerBidi: StreamId = 0b10;

  /**
   * Client initiated unidirectional stream starts at 2.
   * Increment by 4 to get the next ID.
   */
  protected streamIdClientUni: StreamId = 0b01;

  /**
   * Server initiated unidirectional stream starts at 3.
   * Increment by 4 to get the next ID.
   */
  protected streamIdServerUni: StreamId = 0b11;

  /**
   * The step each new stream ID is incremented
   */
  protected streamIdStep: StreamId = 4;

  protected streamMap: Map<StreamId, QUICStream> = new Map();

  public stream$: Subject<QUICStream> = new Subject();

  // Process streams by iterating over the readable and writable iterators
  // and letting the streams know there is data.
  public processStreams(): void {
    if (LOG_STAGES) this.logger.warn(`!----- processStreams -----!`);
    // Checking readable
    if (LOG_STAGES) this.logger.warn(`!----- processStreams readables -----!`);
    for (const streamId of this.connection.readable()) {
      this.logger.warn(`stream readable ${streamId}`);
      let quicStream = this.streamMap.get(streamId);
      if (quicStream == null) {
        this.logger.warn(`creating new stream for ${streamId} on readable`);
        quicStream = new QUICStream(
          streamId,
          this,
          this.logger.getChild(`QuicStream_${streamId}`),
        );
        this.setupQuicStream(quicStream);
        this.stream$.next(quicStream);
      }
      quicStream.readReady$.next();
    }
    if (LOG_STAGES) this.logger.warn(`!----- processStreams writables -----!`);
    for (const streamId of this.connection.writable()) {
      let quicStream = this.streamMap.get(streamId);
      if (quicStream == null) {
        this.logger.warn(`creating new stream for ${streamId} on writable`);
        quicStream = new QUICStream(
          streamId,
          this,
          this.logger.getChild(`QuicStream_${streamId}`),
        );
        this.setupQuicStream(quicStream);
        this.stream$.next(quicStream);
      }
      quicStream.writeReady$.next();
    }
    if (LOG_STAGES) this.logger.warn(`!----- processStreams done -----!`);
  }

  /**
   * Creates a new QUIC stream on the connection.
   */
  public newStream(type: 'bidi' | 'uni' = 'bidi'): QUICStream {
    let streamId: StreamId;
    if (this.type === ConnectionType.CLIENT && type === 'bidi') {
      streamId = this.streamIdClientBidi;
      this.streamIdClientBidi += this.streamIdStep;
    } else if (this.type === ConnectionType.SERVER && type === 'bidi') {
      streamId = this.streamIdServerBidi;
      this.streamIdServerBidi += this.streamIdStep;
    } else if (this.type === ConnectionType.CLIENT && type === 'uni') {
      streamId = this.streamIdClientUni;
      this.streamIdClientUni += this.streamIdStep;
    } else if (this.type === ConnectionType.SERVER && type === 'uni') {
      streamId = this.streamIdServerUni;
      this.streamIdServerUni += this.streamIdStep;
    }
    const quicStream = new QUICStream(
      streamId!,
      this,
      this.logger.getChild(`QuicStream_${streamId!}`),
    );
    this.setupQuicStream(quicStream);
    const result = this.connection.streamSend(
      quicStream.id,
      Buffer.alloc(0),
      false,
    );
    this.logger.warn(
      `Stream ${streamId!} initiated with zero length message ${result}`,
    );
    this.processSend();
    return quicStream;
  }

  protected setupQuicStream(quicStream: QUICStream): void {
    this.streamMap.set(quicStream.id, quicStream);
    quicStream.complete$.subscribe(() => {
      this.streamMap.delete(quicStream.id);
      this.logger.warn(
        `streamMap delete ${quicStream.id} with ${this.streamMap.size} streams remaining`,
      );
    });
  }
}

export default QUICConnection;
