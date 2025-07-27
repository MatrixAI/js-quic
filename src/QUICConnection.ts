import type { Connection, RecvInfo } from './native/index.js';
import type {
  Host,
  Port,
  QUICConfig,
  RemoteInfo,
  ConnectionId,
  ConnectionIdString,
} from './types.js';
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
  }: {
    serverName?: string;
    config: QUICConfig;
    scid: Uint8Array;
    sourceHost: Host;
    sourcePort: Port;
    host: Host;
    port: Port;
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
  }: {
    serverName?: string;
    config: QUICConfig;
    scid: QUICConnectionId;
    dcid: QUICConnectionId;
    sourceHost: Host;
    sourcePort: Port;
    host: Host;
    port: Port;
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
  ) {
    if (config.cert != null) {
      const certPEMs = utils.collectPEMs(this.config.cert);
      this.certDERs = certPEMs.map(utils.pemToDER);
    }
    if (this.config.ca != null) {
      const caPEMs = utils.collectPEMs(this.config.ca);
      this.caDERs = caPEMs.map(utils.pemToDER);
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
      // This.checkState();
    }

    // TODO: check and dispatch state changes;
    this.send$.next(this.connectionId_);
  }

  /**
   * This just retrieves data from the underlying connection object
   */
  // TODO: define simple send
  public send() {
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
      // This.checkState();
    }
  }

  // TODO: define simple state checks
  protected checkState(): void {
    console.log('peerStreamsLeftBidi', this.connection.peerStreamsLeftBidi());
    console.log('peerStreamsLeftUni', this.connection.peerStreamsLeftUni());
    console.log(
      'maxSendUdpPayloadSize',
      this.connection.maxSendUdpPayloadSize(),
    );
    console.log('timeout', this.connection.timeout());
    console.log('activeSourceCids', this.connection.activeSourceCids());
    console.log('maxActiveSourceCids', this.connection.maxActiveSourceCids());
    console.log('sourceCidsLeft', this.connection.sourceCidsLeft());
    console.log('retiredScidNext', this.connection.retiredScidNext());
    console.log('availableDcids', this.connection.availableDcids());
    console.log('traceId', this.connection.traceId());
    console.log('applicationProto', this.connection.applicationProto());
    console.log('serverName', this.connection.serverName());
    console.log('session', this.connection.session());
    console.log('sourceId', this.connection.sourceId());
    console.log('destinationId', this.connection.destinationId());
    console.log('isEstablished', this.connection.isEstablished());
    console.log('isResumed', this.connection.isResumed());
    console.log('isInEarlyData', this.connection.isInEarlyData());
    console.log('isReadable', this.connection.isReadable());
    console.log('isDraining', this.connection.isDraining());
    console.log('isClosed', this.connection.isClosed());
    console.log('isTimedOut', this.connection.isTimedOut());
    console.log('peerError', this.connection.peerError());
    console.log('localError', this.connection.localError());
    console.log('stats', this.connection.stats());
  }
}

export default QUICConnection;
