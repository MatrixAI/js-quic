import type { POJO } from '@matrixai/errors';
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

class ErrorQUICConnectionStartData<T> extends ErrorQUIC<T> {
  static description = 'QUIC Connection start requires data when it is a server connection';
}

class ErrorQUICConnectionStartTimeout<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection start timeout';
}

/**
 * Note that TlsFail error codes are documented here:
 * https://github.com/google/boringssl/blob/master/include/openssl/ssl.h
 * This can mean local closure of any code!
 */
class ErrorQUICConnectionLocal<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection local error';
}

class ErrorQUICConnectionPeer<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection peer error';
}

class ErrorQUICConnectionIdleTimeout<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection max idle timeout exhausted';
}

class ErrorQUICConnectionInternal<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection internal error';
}

class ErrorQUICConnectionConfigInvalid<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC connection invalid configuration';
}

class ErrorQUICStream<T> extends ErrorQUIC<T> {
  static description = 'QUIC Stream error';
}

class ErrorQUICStreamDestroyed<T> extends ErrorQUICStream<T> {
  static description = 'QUIC Stream is destroyed';
}

class ErrorQUICStreamLocalRead<T> extends ErrorQUICStream<T> {
  static description = 'QUIC Stream locally closed readable side';
}

class ErrorQUICStreamLocalWrite<T> extends ErrorQUICStream<T> {
  static description = 'QUIC Stream locally closed writable side';
}

class ErrorQUICStreamPeerRead<T> extends ErrorQUICStream<T> {
  static description = 'QUIC Stream peer closed readable side';
}

class ErrorQUICStreamPeerWrite<T> extends ErrorQUICStream<T> {
  static description = 'QUIC Stream peer closed writable side';
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
  ErrorQUICConnectionStartData,
  ErrorQUICConnectionStartTimeout,
  ErrorQUICConnectionConfigInvalid,

  // This is useful for understanding what kind of error `ErrorQUICConnection` is
  ErrorQUICConnectionLocal, // Use this one for the secure established P
  ErrorQUICConnectionPeer,
  ErrorQUICConnectionIdleTimeout,
  ErrorQUICConnectionInternal,

  // // This is useful for internal errors
  // ErrorQUICConnectionRecv,
  // ErrorQUICConnectionSend,

  ErrorQUICStream,
  ErrorQUICStreamDestroyed,
  ErrorQUICStreamLocalRead,
  ErrorQUICStreamLocalWrite,
  ErrorQUICStreamPeerRead,
  ErrorQUICStreamPeerWrite,
  ErrorQUICStreamInternal,
};
