import type { PromiseCancellable } from '@matrixai/async-cancellable';
import type {
  Host,
  Port,
  QUICClientCrypto,
  ResolveHostname,
  QUICClientConfigInput,
  StreamCodeToReason,
  StreamReasonToCode,
} from './types.js';
import type { Config } from './native/types.js';
import type { ConnectionErrorCode } from './native/types.js';
import type { Observable } from 'rxjs';
import Logger from '@matrixai/logger';
import { running } from '@matrixai/async-init';
import { createDestroy } from '@matrixai/async-init';
import { firstValueFrom, merge, ReplaySubject } from 'rxjs';
import QUICSocket from './QUICSocket.js';
import QUICConnection from './QUICConnection.js';
import quiche from './native/quiche.js';
import { clientDefault } from './config.js';
import * as utils from './utils.js';
import * as events from './events.js';
import * as errors from './errors.js';
interface QUICClient extends createDestroy.CreateDestroy {}
@createDestroy.CreateDestroy({
  eventDestroy: events.EventQUICClientDestroy,
  eventDestroyed: events.EventQUICClientDestroyed,
})
class QUICClient {
  /**
   * Creates a QUIC client.
   *
   * @param opts
   * @param opts.host - target host where wildcards are resolved to point locally.
   * @param opts.port - target port
   * @param opts.serverName - The expected name of the server you are connecting to, defaults to host.
   * @param opts.localHost - defaults to `::` (dual-stack)
   * @param opts.localPort - defaults 0
   * @param opts.socket - optional shared QUICSocket
   * @param opts.crypto - client needs to generate random bytes
   * @param opts.config - defaults to `clientDefault`
   * @param opts.resolveHostname - defaults to using OS DNS resolver
   * @param opts.reuseAddr - reuse existing port
   * @param opts.ipv6Only - force using IPv6 even when using `::`
   * @param opts.reasonToCode - maps stream error reasons to stream error codes
   * @param opts.codeToReason - maps stream error codes to reasons
   * @param opts.logger
   * @param abortObservable
   *
   * @throws {errors.ErrorQUICClientCreateTimeout} - if timed out
   * @throws {errors.ErrorQUICClientSocketNotRunning} - if shared socket is not running
   * @throws {errors.ErrorQUICClientInvalidHost} - if local host is incompatible with target host
   * @throws {errors.ErrorQUICSocket} - if socket start failed
   * @throws {errors.ErrorQUICConnection} - if connection start failed
   */
  public static createQUICClient(
    opts: {
      host: string;
      port: number;
      serverName?: string;
      localHost?: string;
      localPort?: number;
      crypto: QUICClientCrypto;
      config?: QUICClientConfigInput;
      resolveHostname?: ResolveHostname;
      reuseAddr?: boolean;
      ipv6Only?: boolean;
      reasonToCode?: StreamReasonToCode;
      codeToReason?: StreamCodeToReason;
      logger?: Logger;
    },
    abortObservable?: Observable<unknown>,
  ): PromiseCancellable<QUICClient>;
  public static createQUICClient(
    opts: {
      host: string;
      port: number;
      serverName?: string;
      socket: QUICSocket;
      crypto: QUICClientCrypto;
      config?: QUICClientConfigInput;
      reuseAddr?: boolean;
      ipv6Only?: boolean;
      reasonToCode?: StreamReasonToCode;
      codeToReason?: StreamCodeToReason;
      logger?: Logger;
    },
    abortObservable?: Observable<unknown>,
  ): PromiseCancellable<QUICClient>;
  public static async createQUICClient(
    {
      host,
      port,
      serverName,
      localHost = '::',
      localPort = 0,
      socket,
      crypto,
      config = {},
      resolveHostname = utils.resolveHostname,
      reuseAddr,
      ipv6Only,
      logger = new Logger(`${this.name}`),
    }: {
      host: string;
      port: number;
      serverName?: string;
      localHost?: string;
      localPort?: number;
      socket?: QUICSocket;
      crypto: QUICClientCrypto;
      config?: QUICClientConfigInput;
      resolveHostname?: ResolveHostname;
      reuseAddr?: boolean;
      ipv6Only?: boolean;
      logger?: Logger;
    },
    abortObservable?: Observable<unknown>,
  ): Promise<QUICClient> {
    // Setting up abort observable
    const abort = new ReplaySubject<unknown>(1);
    abortObservable?.subscribe(abort);
    let address = utils.buildAddress(host, port);
    logger.info(`Create ${this.name} to ${address}`);
    const quicConfig = {
      ...clientDefault,
      ...config,
    };
    // SCID for the client is randomly generated
    // DCID is also randomly generated, but by the quiche library
    const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
    await crypto.ops.randomBytes(scidBuffer);
    const scid = Buffer.from(scidBuffer);
    // Validating host and port types
    const [tmpHost, udpType] = await utils.resolveHost(host, resolveHostname);
    const port_ = utils.toPort(port);
    // If the target host is in fact a zero IP, it cannot be used
    // as a target host, so we need to resolve it to a non-zero IP
    // in this case, 0.0.0.0 is resolved to 127.0.0.1 and :: and ::0 is
    // resolved to ::1.
    let host_ = tmpHost;
    host_ = utils.resolvesZeroIP(host_);
    let isSocketShared: boolean;
    if (socket == null) {
      const [localHost_] = await utils.resolveHost(localHost, resolveHostname);
      const localPort_ = utils.toPort(localPort);
      socket = new QUICSocket({
        resolveHostname,
        logger: logger.getChild(QUICSocket.name),
      });
      isSocketShared = false;
      await socket.start({
        host: localHost_,
        port: localPort_,
        reuseAddr,
        ipv6Only,
      });
    } else {
      isSocketShared = true;
      // If the socket is shared, it must already be started
      if (!socket[running]) {
        throw new errors.ErrorQUICServerSocketNotRunning();
      }
    }
    try {
      // Check that the target `host` is compatible with the bound socket host
      // Also transform it if need be
      host_ = utils.validateTarget(
        socket.host,
        socket.type,
        host_,
        udpType,
        errors.ErrorQUICClientInvalidHost,
      );
    } catch (e) {
      if (!isSocketShared) {
        await socket.stop({ force: true });
      }
      throw e;
    }
    const connection = QUICConnection.connectionConnect({
      serverName: serverName ?? host,
      scid: scid,
      config: quicConfig,
      sourceHost: socket.host,
      sourcePort: socket.port,
      host: host_,
      port: port_,
      logger: logger.getChild('connection'),
    });
    const client = new this({
      socket,
      connection,
      isSocketShared,
      logger,
    });
    socket.addEventListener(
      events.EventQUICSocketStopped.name,
      client.handleEventQUICSocketStopped,
      { once: true },
    );
    // TODO: handle events here
    client.addEventListener(
      events.EventQUICClientError.name,
      client.handleEventQUICClientError,
    );
    client.addEventListener(
      events.EventQUICClientClose.name,
      client.handleEventQUICClientClose,
      { once: true },
    );
    // We have to start the connection after associating the event listeners on
    // the client, because the client bridges the push flow from the connection
    // to the socket.
    connection.send$.subscribe(socket.socketSend$);
    socket.connectionMap.set(connection.connectionId_, connection);
    connection.processSend();

    // Waiting for establishment or failure
    let aborted = false;
    abort.subscribe(() => {
      aborted = true;
    });
    try {
      await firstValueFrom(
        merge(connection.established$, connection.closed$, abort),
        { defaultValue: undefined },
      );
      if (connection.isTimedOut) throw Error('TMP IMP connection timed out');
      if (connection.peerError !== null) {
        throw Error(
          `TMP IMP peer errored with code ${connection.peerError.errorCode}`,
        );
      }
      if (connection.localError !== null) {
        throw Error(
          `TMP IMP local errored with code ${connection.localError.errorCode}`,
        );
      }
      if (aborted) throw Error('TMP IMP connection aborted');
    } catch (e) {
      if (!isSocketShared) {
        await socket.stop({ force: true });
      }
      throw e;
    } finally {
      abort.complete();
    }

    // Set up intermediate abort signal
    address = utils.buildAddress(host_, port);
    logger.info(`Created ${this.name} to ${address}`);
    return client;
  }

  public readonly isSocketShared: boolean;
  public readonly connection: QUICConnection;

  protected logger: Logger;
  protected socket: QUICSocket;
  protected config: Config;
  protected _closed: boolean = false;

  /**
   * Handles `EventQUICClientError`.
   *
   * This event propagates all errors from `QUICClient` and `QUICConnection`.
   * This means you can expect that `QUICConnection` errors will be logged
   * twice.
   *
   * Internal errors will be thrown upwards to become an uncaught exception.
   *
   * @throws {errors.ErrorQUICClientInternal}
   * @throws {errors.ErrorQUICConnectionInternal}
   */
  protected handleEventQUICClientError = (evt: events.EventQUICClientError) => {
    const error = evt.detail;
    // Log out the error
    this.logger.info(utils.formatError(error));
    if (
      error instanceof errors.ErrorQUICClientInternal ||
      error instanceof errors.ErrorQUICConnectionInternal
    ) {
      throw error;
    }
    this.dispatchEvent(
      new events.EventQUICClientClose({
        detail: error,
      }),
    );
  };

  /**
   * Handles `EventQUICClientClose`.
   * Registered once.
   *
   * This event propagates errors minus the internal errors.
   * All QUIC connections always close with an error, even if it is a graceful.
   *
   * If this event is dispatched first before `QUICClient.destroy`, it represents
   * an evented close. This could originate from the `QUICSocket` or
   * `QUICConnection`. If it was from the `QUICSocket`, then here it will stop
   * the `QUICConnection` with a transport code `InternalError`. If it was
   * from `QUICConnection`, then the `QUICConnection` will already be closing.
   * Therefore, attempting to stop the `QUICConnection` will be idempotent.
   */
  protected handleEventQUICClientClose = async (
    evt: events.EventQUICClientClose,
  ) => {
    const error = evt.detail;
    if (!(error instanceof errors.ErrorQUICClientSocketNotRunning)) {
      // Only stop the socket if it was encapsulated
      if (!this.isSocketShared) {
        // Remove the stopped listener, as we intend to stop the socket
        this.socket.removeEventListener(
          events.EventQUICSocketStopped.name,
          this.handleEventQUICSocketStopped,
        );
        try {
          // Force stop of the socket even if it had a connection map
          // This is because we will be stopping this `QUICClient` which
          //  will stop all the relevant connections
          await this.socket.stop({ force: true });
        } catch (e) {
          const e_ = new errors.ErrorQUICClientInternal(
            'Failed to stop QUICSocket',
            { cause: e },
          );
          this.dispatchEvent(new events.EventQUICClientError({ detail: e_ }));
        }
      }
    }
    this._closed = true;
    if (
      !this[createDestroy.destroyed] &&
      this[createDestroy.status] !== 'destroying'
    ) {
      await this.destroy({ force: true });
    }
  };

  /**
   * Handles `EventQUICSocketStopped`.
   * Registered once.
   *
   * It is an error if the socket was stopped while `QUICClient` wasn't
   * destroyed.
   */
  protected handleEventQUICSocketStopped = () => {
    const e = new errors.ErrorQUICClientSocketNotRunning();
    this.dispatchEvent(
      new events.EventQUICClientError({
        detail: e,
      }),
    );
  };

  public constructor({
    socket,
    isSocketShared,
    connection,
    logger,
  }: {
    socket: QUICSocket;
    isSocketShared: boolean;
    connection: QUICConnection;
    logger: Logger;
  }) {
    this.logger = logger;
    this.socket = socket;
    this.isSocketShared = isSocketShared;
    this.connection = connection;
  }

  @createDestroy.ready(new errors.ErrorQUICClientDestroyed())
  public get host(): Host {
    return this.connection.host;
  }

  @createDestroy.ready(new errors.ErrorQUICClientDestroyed())
  public get port(): Port {
    return this.connection.port;
  }

  @createDestroy.ready(new errors.ErrorQUICClientDestroyed())
  public get localHost(): Host {
    return this.socket.host;
  }

  @createDestroy.ready(new errors.ErrorQUICClientDestroyed())
  public get localPort(): Port {
    return this.socket.port;
  }

  public get closed() {
    return this._closed;
  }

  /**
   * Destroy the QUICClient.
   *
   * @param opts
   * @param opts.isApp - whether to destroy is initiated by the application
   * @param opts.errorCode - the error code to send to the peer
   * @param opts.reason - the reason to send to the peer
   * @param opts.force - force controls whether to cancel streams or wait for
   *                     streams to close gracefully
   */
  public async destroy({
    isApp = true,
    errorCode = 0,
    reason = new Uint8Array(),
    force = true,
  }:
    | {
        isApp: false;
        errorCode?: ConnectionErrorCode;
        reason?: Uint8Array;
        force?: boolean;
      }
    | {
        isApp?: true;
        errorCode?: number;
        reason?: Uint8Array;
        force?: boolean;
      } = {}) {
    let address: string | undefined;
    if (this.connection[running]) {
      address = utils.buildAddress(this.connection.host, this.connection.port);
    }
    this.logger.info(
      `Destroy ${this.constructor.name}${
        address != null ? ` to ${address}` : ''
      }`,
    );
    const connectionClosedP = firstValueFrom(this.connection.closed$, {
      defaultValue: undefined,
    });
    if (!this._closed) {
      this.logger.warn('killing!');
      this.connection.kill({
        isApp,
        errorCode,
        reason,
      });
    }
    await connectionClosedP;
    this.removeEventListener(
      events.EventQUICClientError.name,
      this.handleEventQUICClientError,
    );
    this.removeEventListener(
      events.EventQUICClientClose.name,
      this.handleEventQUICClientClose,
    );
    // The socket may not have been stopped if it is shared
    // In which case we just remove our listener here
    this.socket.removeEventListener(
      events.EventQUICSocketStopped.name,
      this.handleEventQUICSocketStopped,
    );
    // Connection listeners do not need to be removed
    // Because it is handled by `this.handleEventQUICConnectionStopped`.
    this.logger.info(
      `Destroyed ${this.constructor.name}${
        address != null ? ` to ${address}` : ''
      }`,
    );
  }
}

export default QUICClient;
