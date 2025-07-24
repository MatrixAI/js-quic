import type { Connection, RecvInfo } from './native/index.js';
import type { Host, Port, QUICConfig, RemoteInfo } from './types.js';
import { quiche } from './native/index.js';
import { buildQuicheConfig } from './config.js';
import * as errors from './errors.js';
import * as utils from './utils.js';
import QUICConnectionId from './QUICConnectionId.js';

enum ConnectionType {
  CLIENT = 0,
  SERVER = 1,
}

type ConnectionId = string;

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
    scid: ConnectionId;
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

    const quicheConfig = buildQuicheConfig(config);

    const connection = quiche.Connection.connect(
      serverName,
      Buffer.from(scid, 'hex'),
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
    scid: ConnectionId;
    dcid: ConnectionId;
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
      Buffer.from(scid, 'hex'),
      Buffer.from(dcid, 'hex'),
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

  public get connectionId(): ConnectionId {
    const sourceId = this.connection.sourceId();
    return Buffer.from(sourceId).toString('hex');
  }

  public get connectionIdPeer(): ConnectionId {
    const sourceId = this.connection.destinationId();
    return Buffer.from(sourceId).toString('hex');
  }

  public get connectionIdShared(): ConnectionId {
    const sourceId = this.connection.sourceId();
    const destinationId = this.connection.destinationId();
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
      if (e.message === 'TlsFail') {
        // TODO: error out TLS observable
        console.error('tls error', e);
        return;
      } else {
        // TODO dispatch connection error
        console.error('connection error', e);
        return;
      }
    }

    // TODO: check and dispatch state changes;
    // TODO: check and dispatch send event

    throw Error('TMP IMP not implemented');
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
    }
  }

  // TODO: define simple state checks
}
