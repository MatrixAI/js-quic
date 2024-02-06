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

class ErrorQUICClient<T> extends ErrorQUIC<T> {
  static description = 'QUIC Client error';
}

class ErrorQUICClientDestroyed<T> extends ErrorQUICClient<T> {
  static description = 'QUIC Client is destroyed';
}

class ErrorQUICClientCreateTimeout<T> extends ErrorQUICClient<T> {
  static description = 'QUIC Client create timeout';
}

class ErrorQUICClientSocketNotRunning<T> extends ErrorQUICClient<T> {
  static description =
    'QUIC Client cannot be created with an unstarted shared QUIC socket';
}

class ErrorQUICClientInvalidArgument<T> extends ErrorQUICClient<T> {
  static description =
    'QUIC Client had a failure relating to an invalid argument';
}

class ErrorQUICClientInvalidHost<T> extends ErrorQUICClient<T> {
  static description = 'QUIC Client cannot be created with the specified host';
}

class ErrorQUICClientInternal<T> extends ErrorQUICClient<T> {
  static description = 'QUIC Client internal error';
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

class ErrorQUICConnection<T> extends ErrorQUIC<T> {
  static description = 'QUIC Connection error';
}

class ErrorQUICConnectionStopping<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection is stopping';
}

class ErrorQUICConnectionNotRunning<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection is not running';
}

class ErrorQUICConnectionClosed<T> extends ErrorQUICConnection<T> {
  static description =
    'QUIC Connection cannot be restarted because it has already been closed';
}

class ErrorQUICConnectionStartData<T> extends ErrorQUIC<T> {
  static description =
    'QUIC Connection start requires data when it is a server connection';
}

class ErrorQUICConnectionStartTimeout<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection start timeout';
}

class ErrorQUICConnectionConfigInvalid<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC connection invalid configuration';
}

class ErrorQUICConnectionLocal<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection local error';
  declare data: POJO & ConnectionError;
  constructor(
    message: string = '',
    options: {
      timestamp?: Date;
      data: POJO & ConnectionError;
      cause?: T;
    },
  ) {
    super(message, options);
  }
}

class ErrorQUICConnectionLocalTLS<T> extends ErrorQUICConnectionLocal<T> {
  static description = 'QUIC Connection local TLS error';
  declare data: POJO &
    ConnectionError & {
      errorCode: CryptoError;
    };
  constructor(
    message: string = '',
    options: {
      timestamp?: Date;
      data: POJO &
        ConnectionError & {
          errorCode: CryptoError;
        };
      cause?: T;
    },
  ) {
    super(message, options);
  }
}

class ErrorQUICConnectionPeer<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection peer error';
  declare data: POJO & ConnectionError;
  constructor(
    message: string = '',
    options: {
      timestamp?: Date;
      data: POJO & ConnectionError;
      cause?: T;
    },
  ) {
    super(message, options);
  }
}

class ErrorQUICConnectionPeerTLS<T> extends ErrorQUICConnectionLocal<T> {
  static description = 'QUIC Connection local TLS error';
  declare data: POJO &
    ConnectionError & {
      errorCode: CryptoError;
    };
  constructor(
    message: string = '',
    options: {
      timestamp?: Date;
      data: POJO &
        ConnectionError & {
          errorCode: CryptoError;
        };
      cause?: T;
    },
  ) {
    super(message, options);
  }
}

class ErrorQUICConnectionIdleTimeout<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection max idle timeout exhausted';
}

class ErrorQUICConnectionInternal<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection internal error';
}

class ErrorQUICStream<T> extends ErrorQUIC<T> {
  static description = 'QUIC Stream error';
}

class ErrorQUICStreamDestroyed<T> extends ErrorQUICStream<T> {
  static description = 'QUIC Stream is destroyed';
}

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
    },
  ) {
    super(message, options);
  }
}

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
    },
  ) {
    super(message, options);
  }
}

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
    },
  ) {
    super(message, options);
  }
}

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
    },
  ) {
    super(message, options);
  }
}

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
  ErrorQUICClientSocketNotRunning,
  ErrorQUICClientInvalidArgument,
  ErrorQUICClientInvalidHost,
  ErrorQUICClientInternal,
  ErrorQUICServer,
  ErrorQUICServerNotRunning,
  ErrorQUICServerSocketNotRunning,
  ErrorQUICServerNewConnection,
  ErrorQUICServerInternal,
  ErrorQUICConnection,
  ErrorQUICConnectionStopping,
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
