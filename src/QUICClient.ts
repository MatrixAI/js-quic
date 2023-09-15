import type { PromiseCancellable } from '@matrixai/async-cancellable';
import type { ContextTimed, ContextTimedInput } from '@matrixai/contexts';
import type { Host, Port, QUICClientCrypto, QUICClientConfigInput, ResolveHostname } from './types';
import type { Config, ConnectionErrorCode } from './native/types';
import type {
  StreamCodeToReason,
  StreamReasonToCode,
} from './types';
import Logger from '@matrixai/logger';
import { running } from '@matrixai/async-init';
import { CreateDestroy, destroyed, ready } from '@matrixai/async-init/dist/CreateDestroy';
import { AbstractEvent, EventAll } from '@matrixai/events';
import { timedCancellable, context } from '@matrixai/contexts/dist/decorators';
import { quiche } from './native';
import * as utils from './utils';
import * as errors from './errors';
import * as events from './events';
import { clientDefault, minIdleTimeout } from './config';
import QUICSocket from './QUICSocket';
import QUICConnection from './QUICConnection';
import QUICConnectionId from './QUICConnectionId';

interface QUICClient extends CreateDestroy {}
@CreateDestroy({
  eventDestroy: events.EventQUICClientDestroy,
  eventDestroyed: events.EventQUICClientDestroyed,
})
class QUICClient extends EventTarget {

  /**
   * Creates a QUIC Client
   *
   * @param opts
   * @param opts.host - peer host where `0.0.0.0` becomes `127.0.0.1` and `::` becomes `::1`
   * @param opts.port
   * @param opts.localHost - defaults to `::` (dual-stack)
   * @param opts.localPort - defaults 0
   * @param opts.crypto - client only needs the ability to generate random bytes
   * @param opts.config - optional config
   * @param opts.socket - optional QUICSocket to use
   * @param opts.resolveHostname - optional hostname resolver
   * @param opts.reasonToCode - optional reason to code map
   * @param opts.codeToReason - optional code to reason map
   * @param opts.logger - optional logger
   * @param ctx
   *
   * @throws {errors.ErrorQUICClientCreateTimeout} - if it timed out
   * @throws {errors.ErrorQUICClientInvalidHost} - incompatible target host with local host
   * @throws {errors.ErrorQUICClientSocketNotRunning} - if injected socket is not running
   * @throws {errors.ErrorQUICSocket} - if socket start failed
   * @throws {errors.ErrorQUICConnection} - if connection start failed
   */
  public static createQUICClient(
    opts: {
      host: string;
      port: number;
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
    ctx?: Partial<ContextTimedInput>,
  ): PromiseCancellable<QUICClient>;
  public static createQUICClient(
    opts: {
      host: string;
      port: number;
      socket: QUICSocket;
      crypto: QUICClientCrypto;
      config?: QUICClientConfigInput;
      reuseAddr?: boolean;
      ipv6Only?: boolean;
      reasonToCode?: StreamReasonToCode;
      codeToReason?: StreamCodeToReason;
      logger?: Logger;
    },
    ctx?: Partial<ContextTimedInput>,
  ): PromiseCancellable<QUICClient>;
  @timedCancellable(true, minIdleTimeout, errors.ErrorQUICClientCreateTimeout)
  public static async createQUICClient(
    {
      host,
      port,
      localHost = '::',
      localPort = 0,
      socket,
      crypto,
      config = {},
      resolveHostname = utils.resolveHostname,
      reuseAddr,
      ipv6Only,
      reasonToCode,
      codeToReason,
      logger = new Logger(`${this.name}`),
    }: {
      host: string;
      port: number;
      localHost?: string;
      localPort?: number;
      socket?: QUICSocket;
      crypto: QUICClientCrypto;
      config?: QUICClientConfigInput;
      resolveHostname?: ResolveHostname;
      reuseAddr?: boolean;
      ipv6Only?: boolean;
      reasonToCode?: StreamReasonToCode;
      codeToReason?: StreamCodeToReason;
      logger?: Logger;
    },
    @context ctx: ContextTimed,
  ): Promise<QUICClient> {
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
    const scid = new QUICConnectionId(scidBuffer);
    // Validating host and port types
    let [host_] = await utils.resolveHost(
      host,
      resolveHostname
    );
    const port_ = utils.toPort(port);
    // If the target host is in fact a zero IP, it cannot be used
    // as a target host, so we need to resolve it to a non-zero IP
    // in this case, 0.0.0.0 is resolved to 127.0.0.1 and :: and ::0 is
    // resolved to ::1
    host_ = utils.resolvesZeroIP(host_);
    let isSocketShared: boolean;
    if (socket == null) {
      const [localHost_] = await utils.resolveHost(
        localHost,
        resolveHostname
      );
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
      if (
        socket.type === 'ipv4' &&
        !utils.isIPv4(host_) &&
        !utils.isIPv4MappedIPv6(host_)
      ) {
        throw new errors.ErrorQUICClientInvalidHost(
          `Cannot connect to ${host_} on an IPv4 QUICClient`,
        );
      } else if (
        socket.type === 'ipv6' &&
        (!utils.isIPv6(host_) || utils.isIPv4MappedIPv6(host_))
      ) {
        throw new errors.ErrorQUICClientInvalidHost(
          `Cannot connect to ${host_} on an IPv6 QUICClient`,
        );
      } else if (socket.type === 'ipv4&ipv6' && !utils.isIPv6(host_)) {
        throw new errors.ErrorQUICClientInvalidHost(
          `Cannot send to ${host_} on a dual stack QUICClient`,
        );
      } else if (
        socket.type === 'ipv4' &&
        utils.isIPv4MappedIPv6(socket.host) &&
        !utils.isIPv4MappedIPv6(host_)
      ) {
        throw new errors.ErrorQUICClientInvalidHost(
          `Cannot connect to ${host_} an IPv4 mapped IPv6 QUICClient`,
        );
      }
    } catch (e) {
      if (!isSocketShared) {
        await socket.stop({ force: true });
      }
      throw e;
    }
    let connection: QUICConnection;
    try {
      connection = new QUICConnection({
        type: 'client',
        scid,
        socket,
        remoteInfo: {
          host: host_,
          port: port_,
        },
        config: quicConfig,
        reasonToCode,
        codeToReason,
        logger: logger.getChild(`${QUICConnection.name} ${scid.toString()}`),
      });
    } catch (e) {
      if (!isSocketShared) {
        await socket.stop({ force: true });
      }
      throw e;
    }
    const client = new this({
      socket,
      connection,
      isSocketShared,
      logger,
    });
    socket.addEventListener(
      events.EventQUICSocketStopped.name,
      client.handleEventQUICSocketStopped,
      { once: true }
    );
    if (!isSocketShared) {
      socket.addEventListener(
        EventAll.name,
        client.handleEventQUICSocket
      );
    }
    connection.addEventListener(
      events.EventQUICConnectionStopped.name,
      client.handleEventQUICConnectionStopped,
      { once: true }
    );
    connection.addEventListener(
      events.EventQUICConnectionSend.name,
      client.handleEventQUICConnectionSend
    );
    connection.addEventListener(
      EventAll.name,
      client.handleEventQUICConnection
    );
    client.addEventListener(
      events.EventQUICClientError.name,
      client.handleEventQUICClientError
    );
    client.addEventListener(
      events.EventQUICClientClose.name,
      client.handleEventQUICClientClose,
      { once: true }
    );
    // We have to start the connection after associating the event listeners on the client
    // The client bridges the push flow from the connection to the socket
    socket.connectionMap.set(connection.connectionId, connection);
    try {
      await connection.start(undefined, ctx);
    } catch (e) {
      socket.connectionMap.delete(connection.connectionId);
      socket.removeEventListener(
        events.EventQUICSocketStopped.name,
        client.handleEventQUICSocketStopped,
      );
      if (!isSocketShared) {
        socket.removeEventListener(
          EventAll.name,
          client.handleEventQUICSocket
        );
        // This can be idempotent
        // If stop fails, it is a software bug
        await socket.stop({ force: true });
      }
      connection.removeEventListener(
        events.EventQUICConnectionStopped.name,
        client.handleEventQUICConnectionStopped,
      );
      connection.removeEventListener(
        events.EventQUICConnectionSend.name,
        client.handleEventQUICConnectionSend
      );
      connection.removeEventListener(
        EventAll.name,
        client.handleEventQUICConnection
      );
      client.removeEventListener(
        events.EventQUICClientError.name,
        client.handleEventQUICClientError
      );
      client.removeEventListener(
        events.EventQUICClientClose.name,
        client.handleEventQUICClientClose,
      );
      throw e;
    }
    address = utils.buildAddress(host_, port);
    logger.info(`Created ${this.name} to ${address}`);
    return client;
  }

  public readonly isSocketShared: boolean;
  public readonly connection: QUICConnection;
  public readonly closedP: Promise<void>;

  protected socket: QUICSocket;
  protected logger: Logger;
  protected config: Config;
  protected _closed: boolean = false;
  protected resolveClosedP: () => void;

  protected handleEventQUICClientError = async (evt: events.EventQUICClientError) => {
    const error = evt.detail;
    this.logger.error(utils.formatError(error));
  };

  protected handleEventQUICClientClose = async () => {
    // Failing this is a software error
    // If the socket was the reason, it doesn't matter what we put as the code
    // Otherwise the connection was the reason, and it's already stopped
    await this.connection.stop({ force: true });
    // Only stop the socket if it was encapsulated
    if (!this.isSocketShared) {
      // Remove the stopped listener, as we intend to stop the socket
      this.socket.removeEventListener(
        events.EventQUICSocketStopped.name,
        this.handleEventQUICSocketStopped
      );
      try {
        // Force stop of the socket even if it had a connection map
        // This is because we will be stopping this `QUICServer` which
        // which will stop all the relevant connections
        await this.socket.stop({ force: true });
      } catch (e) {
        // Caller error would mean a domain error here
        const e_ = new errors.ErrorQUICClientInternal(
          'Failed to stop QUICSocket',
          { cause: e }
        );
        this.dispatchEvent(
          new events.EventQUICClientError({ detail: e_ })
        );
        // This will not recurse because this handler is attached once
        this.dispatchEvent(new events.EventQUICClientClose());
        // Continue closing the server, because this domain error
        // must lead to stopping the server
      }
    }
    this._closed = true;
    this.resolveClosedP();
    if (!this[destroyed]) {
      // Failing this is a software error
      await this.destroy({ force: true });
    }
  };

  protected handleEventQUICSocketStopped = () => {
    const e = new errors.ErrorQUICClientSocketNotRunning();
    this.dispatchEvent(
      new events.EventQUICClientError({
        detail: e,
      }),
    );
    this.dispatchEvent(new events.EventQUICClientClose());
  };

  /**
   * This must be attached once.
   */
  protected handleEventQUICConnectionStopped = (
    evt: events.EventQUICConnectionStopped
  ) => {
    const quicConnection = evt.target as QUICConnection;
    quicConnection.removeEventListener(
      events.EventQUICConnectionSend.name,
      this.handleEventQUICConnectionSend
    );
    quicConnection.removeEventListener(
      EventAll.name,
      this.handleEventQUICConnection
    );
    this.socket.connectionMap.delete(quicConnection.connectionId);
    this.dispatchEvent(new events.EventQUICClientClose());
  };

  /**
   * This must be attached multiple times.
   */
  protected handleEventQUICConnectionSend = async (evt: events.EventQUICConnectionSend) => {
    const { msg, offset, length, port, address } = evt.detail;
    try {
      await this.socket.send(
        msg,
        offset,
        length,
        port,
        address,
      );
    } catch (e) {
      // Caller error means a domain error here
      const e_ = new errors.ErrorQUICClientInternal(
        'Failed to send data on the QUICSocket',
        {
          data: {
            msg,
            offset,
            length,
            port,
            address,
          },
          cause: e,
        }
      );
      this.dispatchEvent(
        new events.EventQUICClientError({ detail: e_ })
      );
      this.dispatchEvent(new events.EventQUICClientClose());
    }
  };

  protected handleEventQUICConnection = (evt: EventAll) => {
    if (evt.detail instanceof AbstractEvent) {
      this.dispatchEvent(evt.detail.clone());
    }
  };

  // This should only be done if it is encapsulated
  protected handleEventQUICSocket = (evt: EventAll) => {
    if (evt.detail instanceof AbstractEvent) {
      this.dispatchEvent(evt.detail.clone());
    }
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
    super();
    this.logger = logger;
    this.socket = socket;
    this.isSocketShared = isSocketShared;
    this.connection = connection;
    const {
      p: closedP,
      resolveP: resolveClosedP,
    } = utils.promise();
    this.closedP = closedP;
    this.resolveClosedP = resolveClosedP;
  }

  @ready(new errors.ErrorQUICClientDestroyed())
  public get host(): Host {
    return this.socket.host;
  }

  @ready(new errors.ErrorQUICClientDestroyed())
  public get port(): Port {
    return this.socket.port;
  }

  public get closed() {
    return this._closed;
  }

  /**
   * Force is true now
   */
  public async destroy({
    applicationError = true,
    errorCode = 0,
    errorMessage = '',
    force = true,
    }:
      | {
          applicationError?: false;
          errorCode?: ConnectionErrorCode;
          errorMessage?: string;
          force?: boolean;
        }
      | {
          applicationError: true;
          errorCode?: number;
          errorMessage?: string;
          force?: boolean;
        } = {},
  ) {
    this.logger.info(`Destroy ${this.constructor.name}`);
    if (!this._closed) {
      // Failing this is a software error
      await this.connection.stop({
        applicationError,
        errorCode,
        errorMessage,
        force,
      });
      this.dispatchEvent(new events.EventQUICClientClose());
    }
    await this.closedP;
    this.removeEventListener(
      events.EventQUICClientError.name,
      this.handleEventQUICClientError
    );
    this.removeEventListener(
      events.EventQUICClientClose.name,
      this.handleEventQUICClientClose
    );
    // The socket may not have been stopped if it is shared
    // In which case we just remove our listener here
    this.socket.removeEventListener(
      events.EventQUICSocketStopped.name,
      this.handleEventQUICSocketStopped
    );
    if (!this.isSocketShared) {
      this.socket.removeEventListener(
        EventAll.name,
        this.handleEventQUICSocket
      );
    }
    // Connection listeners do not need to be removed
    // Because it is handled by `this.handleEventQUICConnectionStopped`.
    this.logger.info(`Destroyed ${this.constructor.name}`);
  }
}

export default QUICClient;
