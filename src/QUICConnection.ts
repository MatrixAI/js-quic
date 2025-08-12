import type { Connection, RecvInfo } from './native/index.js';
import type {
  Host,
  Port,
  QUICConfig,
  RemoteInfo,
  ConnectionIdString,
  SendData,
} from './types.js';
import type * as nativeTypes from './native/types.js';
import type Logger from '@matrixai/logger';
import { ReplaySubject, Subject } from 'rxjs';
import { CryptoError } from './native/index.js';
import { ConnectionType } from './types.js';
import { quiche } from './native/index.js';
import { buildQuicheConfig } from './config.js';
import * as errors from './errors.js';
import * as utils from './utils.js';
import QUICConnectionId from './QUICConnectionId.js';

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

    this.timeout$.subscribe(() => this.logger.warn(`TIMEOUT!`));
    this.established$.subscribe((v) =>
      this.logger.warn(`CHANGED isEstablished$ ${v}`),
    );
    this.isResumed$.subscribe((v) =>
      this.logger.warn(`CHANGED isResumed$ ${v}`),
    );
    this.isInEarlyData$.subscribe((v) =>
      this.logger.warn(`CHANGED isInEarlyData$ ${v}`),
    );
    this.isReadable$.subscribe((v) =>
      this.logger.warn(`CHANGED isReadable$ ${v}`),
    );
    this.draining$.subscribe(() =>
      this.logger.warn(`CHANGED isDraining$ true`),
    );
    this.closed$.subscribe(() => this.logger.warn(`CHANGED isClosed$ true`));
    this.timedOut$.subscribe((v) =>
      this.logger.warn(`CHANGED isTimedOut$ ${v}`),
    );
    this.peerError$.subscribe((v) =>
      this.logger.warn(`CHANGED peerError$ ${v}`),
    );
    this.localError$.subscribe((v) =>
      this.logger.warn(`CHANGED localError$ ${v}`),
    );
    this.peerCertChain$.subscribe(() => this.logger.warn(`GOT peerCertChain`));
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
    this.checkState();
    this.processSend();
  }

  // This will extract send data from connection and emit it on the `sendData$` subject
  public processSend(): void {
    if (this.connection.isDraining()) {
      this.logger.warn('skipping due to draining state');
      return;
    }
    try {
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
      console.error('connection error', e);
      throw e;
    } finally {
      this.checkState();
    }
  }

  // TODO: define simple state checks
  protected checkState(): void {
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
  }

  protected timeoutTimer: NodeJS.Timeout | undefined;
  protected timeout$: Subject<void> = new Subject();
  protected handleTimeout = () => {
    this.connection.onTimeout();
    this.timeout$.next();
    this.checkState();
    this.processSend();
    this.checkTimeout();
  };
  protected checkTimeout() {
    const timeoutDelay = this.connection.timeout();
    clearTimeout(this.timeoutTimer);
    delete this.timeoutTimer;
    if (timeoutDelay == null) return;
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
    this.logger.warn(`draining: ${value}`);
    const updated = value !== this.isDraining_;
    this.isDraining_ = value;
    if (updated) this.draining$.next();
    return value;
  }

  protected isClosed_ = false;
  public readonly closed$: ReplaySubject<void> = new ReplaySubject(1);
  public get isClosed() {
    const value = this.connection.isClosed();
    this.logger.warn(`closed: ${value}`);
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
}

export default QUICConnection;
