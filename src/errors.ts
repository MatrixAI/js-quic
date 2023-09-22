import type { POJO } from '@matrixai/errors';
import type { ConnectionError, CryptoError } from './native';
import AbstractError from '@matrixai/errors/dist/AbstractError';

class ErrorQUIC<T> extends AbstractError<T> {
  static description = 'QUIC error';
}

class ErrorQUICHostInvalid<T> extends AbstractError<T> {
  static description = 'Host provided was not valid';
}

class ErrorQUICPortInvalid<T> extends AbstractError<T> {
  static description = 'Port provided was not valid';
}

class ErrorQUICConfig<T> extends ErrorQUIC<T> {
  static description = 'QUIC config error';
}

class ErrorQUICSocket<T> extends ErrorQUIC<T> {
  static description = 'QUIC Socket error';
}

class ErrorQUICSocketNotRunning<T> extends ErrorQUICSocket<T> {
  static description = 'QUIC Socket is not running';
}

class ErrorQUICSocketConnectionsActive<T> extends ErrorQUICSocket<T> {
  static description = 'QUIC Socket has active connections';
}

class ErrorQUICSocketInvalidBindAddress<T> extends ErrorQUICSocket<T> {
  static description = 'QUIC Socket cannot bind to the specified address';
}

class ErrorQUICSocketInvalidSendAddress<T> extends ErrorQUICSocket<T> {
  static description = 'QUIC Socket cannot send to the specified address';
}

class ErrorQUICSocketInternal<T> extends ErrorQUICSocket<T> {
  static description = 'QUIC Socket internal error';
}

class ErrorQUICServer<T> extends ErrorQUIC<T> {
  static description = 'QUIC Server error';
}

class ErrorQUICServerNotRunning<T> extends ErrorQUICServer<T> {
  static description = 'QUIC Server is not running';
}

class ErrorQUICServerSocketNotRunning<T> extends ErrorQUICServer<T> {
  static description =
    'QUIC Server cannot start with an unstarted shared QUIC socket';
}

class ErrorQUICServerNewConnection<T> extends ErrorQUICServer<T> {
  static description = 'QUIC Server creating a new connection';
}

class ErrorQUICServerInternal<T> extends ErrorQUICServer<T> {
  static description = 'QUIC Server internal error';
}

class ErrorQUICClient<T> extends ErrorQUIC<T> {
  static description = 'QUIC Client error';
}

class ErrorQUICClientCreateTimeout<T> extends ErrorQUICClient<T> {
  static description = 'QUIC Client create timeout';
}

class ErrorQUICClientDestroyed<T> extends ErrorQUICClient<T> {
  static description = 'QUIC Client is destroyed';
}

class ErrorQUICClientSocketNotRunning<T> extends ErrorQUICClient<T> {
  static description =
    'QUIC Client cannot be created with an unstarted shared QUIC socket';
}

class ErrorQUICClientInvalidHost<T> extends ErrorQUICClient<T> {
  static description = 'QUIC Client cannot be created with the specified host';
}

class ErrorQUICClientInternal<T> extends ErrorQUICClient<T> {
  static description = 'QUIC Client internal error';
}

class ErrorQUICConnection<T> extends ErrorQUIC<T> {
  static description = 'QUIC Connection error';
}

class ErrorQUICConnectionNotRunning<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection is not running';
}

class ErrorQUICConnectionConfigInvalid<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC connection invalid configuration';
}

class ErrorQUICConnectionClosed<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection cannot be restarted because it has already been closed';
}

class ErrorQUICConnectionStartData<T> extends ErrorQUIC<T> {
  static description = 'QUIC Connection start requires data when it is a server connection';
}

class ErrorQUICConnectionStartTimeout<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection start timeout';
}

/**
 * Note that TlsFail error codes are documented here:
 * https://github.com/google/boringssl/blob/master/include/openssl/ssl.h
 */
class ErrorQUICConnectionLocal<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection local error';
  declare data: POJO & ConnectionError;
  constructor(
    message: string = '',
    options: {
      timestamp?: Date;
      data: POJO & ConnectionError;
      cause?: T;
    }
  ) {
    super(message, options);
  }
}

class ErrorQUICConnectionLocalTLS<T> extends ErrorQUICConnectionLocal<T> {
  static description = 'QUIC Connection local TLS error';
  declare data: POJO & ConnectionError & {
    errorCode: CryptoError;
  };
  constructor(
    message: string = '',
    options: {
      timestamp?: Date;
      data: POJO & ConnectionError & {
        errorCode: CryptoError;
      };
      cause?: T;
    }
  ) {
    super(message, options);
  }
}

/**
 * Note that TlsFail error codes are documented here:
 * https://github.com/google/boringssl/blob/master/include/openssl/ssl.h
 */
class ErrorQUICConnectionPeer<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection peer error';
  declare data: POJO & ConnectionError;
  constructor(
    message: string = '',
    options: {
      timestamp?: Date;
      data: POJO & ConnectionError;
      cause?: T;
    }
  ) {
    super(message, options);
  }
}

class ErrorQUICConnectionPeerTLS<T> extends ErrorQUICConnectionLocal<T> {
  static description = 'QUIC Connection local TLS error';
  declare data: POJO & ConnectionError & {
    errorCode: CryptoError;
  };
  constructor(
    message: string = '',
    options: {
      timestamp?: Date;
      data: POJO & ConnectionError & {
        errorCode: CryptoError;
      };
      cause?: T;
    }
  ) {
    super(message, options);
  }
}

/**
 * If the connection times out, the `quiche` library does not send a
 * `CONNECTION_CLOSE` frame, the connection is immediately closed.
 */
class ErrorQUICConnectionIdleTimeout<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection max idle timeout exhausted';
}


/**
 * This exception is used only for software errors. This will be thrown
 * upwards, but not dispatched as `EventQUICConnectionError`.
 *
 * Behaviour:
 * * Dispatch AND throw it upwards - this is chosen
 *   - This means this becomes `ErrorQUICConnectionError`
 *     - Do not attempt to close... cannot stop
 *       - Just freeze and end here
 *       - Throw it upwards to become a `EventError`
 *         - Default to uncaught exception
 */
class ErrorQUICConnectionInternal<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection internal error';
}

class ErrorQUICStream<T> extends ErrorQUIC<T> {
  static description = 'QUIC Stream error';
}

class ErrorQUICStreamDestroyed<T> extends ErrorQUICStream<T> {
  static description = 'QUIC Stream is destroyed';
}

/**
 * Locally closed readable with a code.
 */
class ErrorQUICStreamLocalRead<T> extends ErrorQUICStream<T> {
  static description = 'QUIC Stream locally closed readable side';
  declare data: POJO & { code: number };
  constructor(
    message: string = '',
    options: {
      timestamp?: Date;
      data: POJO & {
        code: number;
      };
      cause?: T;
    }
  ) {
    super(message, options);
  }
}

/**
 * If `data.code` exists, it means we wrote out this code.
 * However if `data.code` doesn't exist, then it's a local write close
 * without actually sending any close signal.
 * In most cases this means it was a unidirectional peer stream.
 */

/**
 * Locally closed writable with a code.
 */
class ErrorQUICStreamLocalWrite<T> extends ErrorQUICStream<T> {
  static description = 'QUIC Stream locally closed writable side';
  declare data: POJO & { code: number };
  constructor(
    message: string = '',
    options: {
      timestamp?: Date;
      data: POJO & {
        code: number;
      };
      cause?: T;
    }
  ) {
    super(message, options);
  }
}

/**
 * Peer closed readable with a code.
 */
class ErrorQUICStreamPeerRead<T> extends ErrorQUICStream<T> {
  static description = 'QUIC Stream peer closed readable side';
  declare data: POJO & { code: number };
  constructor(
    message: string = '',
    options: {
      timestamp?: Date;
      data: POJO & {
        code: number;
      };
      cause?: T;
    }
  ) {
    super(message, options);
  }
}

/**
 * Peer closed writable with a code.
 */
class ErrorQUICStreamPeerWrite<T> extends ErrorQUICStream<T> {
  static description = 'QUIC Stream peer closed writable side';
  declare data: POJO & { code: number };
  constructor(
    message: string = '',
    options: {
      timestamp?: Date;
      data: POJO & {
        code: number;
      };
      cause?: T;
    }
  ) {
    super(message, options);
  }
}

/**
 * Unrecoverable QUICStream error.
 */
class ErrorQUICStreamInternal<T> extends ErrorQUICStream<T> {
  static description = 'QUIC Stream internal error';
}

export {
  ErrorQUIC,
  ErrorQUICHostInvalid,
  ErrorQUICPortInvalid,
  ErrorQUICConfig,

  ErrorQUICSocket,
  ErrorQUICSocketNotRunning,
  ErrorQUICSocketConnectionsActive,
  ErrorQUICSocketInvalidBindAddress,
  ErrorQUICSocketInvalidSendAddress,
  ErrorQUICSocketInternal,

  ErrorQUICClient,
  ErrorQUICClientDestroyed,
  ErrorQUICClientCreateTimeout,
  ErrorQUICClientInvalidHost,
  ErrorQUICClientSocketNotRunning,
  ErrorQUICClientInternal,

  ErrorQUICServer,
  ErrorQUICServerNotRunning,
  ErrorQUICServerSocketNotRunning,
  ErrorQUICServerNewConnection,
  ErrorQUICServerInternal,


  ErrorQUICConnection,
  ErrorQUICConnectionNotRunning,
  ErrorQUICConnectionClosed,
  ErrorQUICConnectionStartData,
  ErrorQUICConnectionStartTimeout,
  ErrorQUICConnectionConfigInvalid,
  ErrorQUICConnectionLocal,
  ErrorQUICConnectionLocalTLS,
  ErrorQUICConnectionPeer,
  ErrorQUICConnectionPeerTLS,

  ErrorQUICConnectionIdleTimeout,
  ErrorQUICConnectionInternal,
  ErrorQUICStream,
  ErrorQUICStreamDestroyed,
  ErrorQUICStreamLocalRead,
  ErrorQUICStreamLocalWrite,
  ErrorQUICStreamPeerRead,
  ErrorQUICStreamPeerWrite,
  ErrorQUICStreamInternal,
};
