import type { Connection, RecvInfo } from './native/index.js';
import type {
  Host,
  Port,
  QUICConfig,
  RemoteInfo,
  ConnectionId,
  ConnectionIdString,
} from './types.js';
import type * as nativeTypes from './native/types.js';
import type Logger from '@matrixai/logger';
import { Subject } from 'rxjs';
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

  // TODO: define observables here
  public readonly error$: Subject<void> = new Subject();
  // A send event must be emmitted after the following
  //  - when a recv is processed
  //  - After a timeout event when `onTimeout()` is called
  //  - When the application interacts with the streams
  public readonly send$: Subject<QUICConnectionId> = new Subject();

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
    this.isEstablished$.subscribe((v) =>
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
    this.draining$.subscribe((v) =>
      this.logger.warn(`CHANGED isDraining$ true`),
    );
    this.closed$.subscribe((v) => this.logger.warn(`CHANGED isClosed$ true`));
    this.isTimedOut$.subscribe((v) =>
      this.logger.warn(`CHANGED isTimedOut$ ${v}`),
    );
    this.peerError$.subscribe((v) =>
      this.logger.warn(`CHANGED peerError$ ${v}`),
    );
    this.localError$.subscribe((v) =>
      this.logger.warn(`CHANGED localError$ ${v}`),
    );
    this.peerCertChain$.subscribe((v) => this.logger.warn(`GOT peerCertChain`));
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
      if (this.connection.localError() == null) {
        console.log('local error?', this.connection.localError());
        // TODO: internal connection error.
        return;
      }
      // TODO: check and dispatch a peer error if there is one
      if (e.message === 'TlsFail') {
        // TODO: error out TLS observable
        console.error('tls error', e);
        return;
      } else {
        // TODO dispatch connection error
        console.error('connection error', e);
        return;
      }
    } finally {
      this.checkState();
    }

    // TODO: check and dispatch state changes;
    this.tiggerSend();
  }

  /**
   * This just retrieves data from the underlying connection object
   */
  // TODO: define simple send
  public send() {
    if (this.connection.isDraining()) {
      this.logger.warn('skipping due to draining state');
      return;
    }
    const sendBuffer = Buffer.allocUnsafe(this.config.maxSendUdpPayloadSize);
    try {
      const result = this.connection.send(sendBuffer);
      if (result == null) return;
      const [sendLength, sendInfo] = result;
      return {
        data: sendBuffer.subarray(0, sendLength),
        host: sendInfo.to.host,
        port: sendInfo.to.port,
      };
    } catch (e) {
      // TODO: dispatch connection error
      console.error('connection error', e);
      throw e;
    } finally {
      this.checkState();
    }
  }

  protected tiggerSend() {
    if (this.connection.isDraining()) return;
    this.send$.next(this.connectionId_);
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
    this.isEstablished;
    this.isResumed;
    this.isInEarlyData;
    this.isReadable;
    this.isDraining;
    this.isClosed;
    this.isTimedOut;
    this.peerError;
    this.localError;
    this.peerCertChain;
  }

  protected timeoutTimer: NodeJS.Timeout | undefined;
  protected timeout$: Subject<void> = new Subject();
  protected handleTimeout = () => {
    this.connection.onTimeout();
    this.timeout$.next();
    this.checkState();
    this.tiggerSend();
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
  public readonly isEstablished$: Subject<boolean> = new Subject();
  public get isEstablished() {
    const value = this.connection.isEstablished();
    const updated = value !== this.isEstablished_;
    this.isEstablished_ = value;
    if (updated) this.isEstablished$.next(value);
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
  public readonly draining$: Subject<void> = new Subject();
  public get isDraining() {
    const value = this.connection.isDraining();
    const updated = value !== this.isDraining_;
    this.isDraining_ = value;
    if (updated) this.draining$.next();
    return value;
  }

  protected isClosed_ = false;
  public readonly closed$: Subject<void> = new Subject();
  public get isClosed() {
    const value = this.connection.isClosed();
    const updated = value !== this.isClosed_;
    this.isClosed_ = value;
    if (updated) this.closed$.next();
    return value;
  }

  protected isTimedOut_ = false;
  public readonly isTimedOut$: Subject<boolean> = new Subject();
  public get isTimedOut() {
    const value = this.connection.isTimedOut();
    const updated = value !== this.isTimedOut_;
    this.isTimedOut_ = value;
    if (updated) this.isTimedOut$.next(value);
    return value;
  }

  protected peerError_: nativeTypes.ConnectionError | undefined = undefined;
  public readonly peerError$: Subject<nativeTypes.ConnectionError> =
    new Subject();
  public get peerError() {
    const value = this.connection.peerError();
    if (this.peerError_ != null && value != null) {
      this.peerError_ = value;
      this.peerError$.next(value);
    }
    return value;
  }

  protected localError_: nativeTypes.ConnectionError | undefined = undefined;
  public readonly localError$: Subject<nativeTypes.ConnectionError> =
    new Subject();
  public get localError() {
    const value = this.connection.localError();
    if (this.localError_ != null && value != null) {
      this.localError_ = value;
      this.localError$.next(value);
    }
    return value;
  }

  protected peerCertChain_: Array<string> | undefined = undefined;
  public readonly peerCertChain$: Subject<Array<string>> = new Subject();
  public get peerCertChain() {
    const value = this.connection.peerCertChain();
    if (this.peerCertChain_ == null && value != null) {
      this.peerCertChain_ = value.map((v) => Buffer.from(v).toString('utf-8'));
      this.peerCertChain$.next(this.peerCertChain_);
    }
    return this.peerCertChain_;
  }

  public kill() {
    this.connection.close(true, 42, Buffer.from('some reason!'));
    this.tiggerSend();
  }
}

export default QUICConnection;
