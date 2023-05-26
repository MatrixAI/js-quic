import type QUICSocket from './QUICSocket';
import type QUICConnectionMap from './QUICConnectionMap';
import type QUICConnectionId from './QUICConnectionId';
import type { Host, Port, RemoteInfo, StreamId } from './types';
import type { Connection, ConnectionErrorCode, SendInfo } from './native/types';
import type { StreamCodeToReason, StreamReasonToCode } from './types';
import type { QUICConfig, ConnectionMetadata } from './types';
import {
  CreateDestroy,
  ready,
  status,
} from '@matrixai/async-init/dist/CreateDestroy';
import Logger from '@matrixai/logger';
import { Lock } from '@matrixai/async-locks';
import { destroyed } from '@matrixai/async-init';
import { buildQuicheConfig } from './config';
import QUICStream from './QUICStream';
import { quiche } from './native';
import * as events from './events';
import * as utils from './utils';
import * as errors from './errors';
import { promise } from './utils';

interface QUICConnectionServer extends CreateDestroy {}
@CreateDestroy()
class QUICConnectionServer extends EventTarget {

  public readonly type: 'client' | 'server';
  public readonly connectionId: QUICConnectionId;

  /**
   * @internal
   */
  public conn: Connection;

  /**
   * @internal
   */
  public connectionMap: QUICConnectionMap;

  protected logger: Logger;
  protected socket: QUICSocket;
  protected reasonToCode: StreamReasonToCode;
  protected codeToReason: StreamCodeToReason;

  // These can change on every `recv` call
  protected _remoteHost: Host;
  protected _remotePort: Port;

  public static async acceptQUICConnection({
    scid,
    dcid,
    socket,
    remoteInfo,
    config,
    reasonToCode = () => 0,
    codeToReason = (type, code) =>
      new Error(`${type.toString()} ${code.toString()}`),
    logger = new Logger(`${this.name} ${scid}`),
  }) {
    logger.info(`Accept ${this.name}`);
    const quicheConfig = buildQuicheConfig(config);
    const conn = quiche.Connection.accept(
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
    // This will output to the log keys file path
    if (config.logKeys != null) {
      conn.setKeylog(config.logKeys);
    }
    const connection = new this({
      type: 'server',
      conn,
      connectionId: scid,
      socket,
      remoteInfo,
      reasonToCode,
      codeToReason,
      logger,
    });
    socket.connectionMap.set(connection.connectionId, connection);
    logger.info(`Accepted ${this.name}`);
    return connection;
  }

  public constructor({
    type,
    conn,
    connectionId,
    socket,
    remoteInfo,
    reasonToCode,
    codeToReason,
    logger,
  }: {
    type: 'client' | 'server';
    conn: Connection;
    connectionId: QUICConnectionId;
    socket: QUICSocket;
    remoteInfo: RemoteInfo;
    reasonToCode: StreamReasonToCode;
    codeToReason: StreamCodeToReason;
    logger: Logger;
  }) {
    super();
    this.logger = logger;
    this.type = type;
    this.conn = conn;
    this.connectionId = connectionId;
    this.connectionMap = socket.connectionMap;
    this.socket = socket;
    this._remoteHost = remoteInfo.host;
    this._remotePort = remoteInfo.port;
    this.reasonToCode = reasonToCode;
    this.codeToReason = codeToReason;

    // THIS WILL ALWALS BE NULL
    // EVEN if we are accepting connection
    const time = this.conn.timeout();
    console.log(time);

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
   * Destroys the connection.
   * The `applicationError` if the connection close is due to the transport
   * layer or due to the application layer.
   * If `applicationError` is true, you can use any number as the `errorCode`.
   * The other peer must should understand the `errorCode`.
   * If `applicationError` is false, you must use `errorCode` from
   * `ConnectionErrorCode`.
   * The default `applicationError` is true because a normal graceful close
   * is an application error.
   * The default `errorCode` of 0 means no error or general error.
   */
  public async destroy({
    applicationError = true,
    errorCode = 0,
    errorMessage = '',
    force = false,
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
    this.logger.info(`Destroy ${this.constructor.name}`);

    try {
      this.conn.close(applicationError, errorCode, Buffer.from(errorMessage));
    } catch (e) {
      // If the connection is already closed, `Done` will be thrown
      if (e.message !== 'Done') {
        // No other exceptions are expected
        utils.never();
      }
    }

    // Now this needs to go ahead and send shit!

    this.logger.info(`Destroyed ${this.constructor.name}`);
  }


}

export default QUICConnectionServer;
