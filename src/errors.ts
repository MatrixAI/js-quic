import type { POJO } from '@matrixai/errors';
import AbstractError from '@matrixai/errors/dist/AbstractError';

class ErrorQUIC<T> extends AbstractError<T> {
  static description = 'QUIC error';
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

class ErrorQUICSocketServerDuplicate<T> extends ErrorQUICSocket<T> {
  static description = 'QUIC Socket already has a server that is running';
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

class ErrorQUICServerConnectionFailed<T> extends ErrorQUICServer<T> {
  static description = 'QUIC server failed to create or accept a connection';
}

class ErrorQUICClient<T> extends ErrorQUIC<T> {
  static description = 'QUIC Client error';
}

class ErrorQUICClientCreateTimeOut<T> extends ErrorQUICClient<T> {
  static description = 'QUICC Client create timeout';
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

class ErrorQUICConnection<T> extends ErrorQUIC<T> {
  static description = 'QUIC Connection error';
}

class ErrorQUICConnectionNotRunning<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection is not running';
}

class ErrorQUICConnectionStartTimeOut<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection start timeout';
}

/**
 * Quiche does not create a local or peer error during idle timeout.
 */
class ErrorQUICConnectionIdleTimeOut<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection reached idle timeout';
}

/**
 * These errors arise from the internal quiche connection.
 * These can be local errors (as in the case of TLS verification failure).
 * Or they can be remote errors.
 * If the connection fails to verify the peer, it will be a local error.
 * The error code might be 304.
 * You may want a "cause" though?
 * But it's not always a cause
 * Plus it might be useless
 * Note that the reason can be buffer.
 * Which means it does not need to be a reason
 *
 * Note that TlsFail error codes are documented here:
 * https://github.com/google/boringssl/blob/master/include/openssl/ssl.h
 */
class ErrorQUICConnectionInternal<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection internal conn error';
  public declare data: {
    type: 'local' | 'remote';
    isApp: boolean;
    errorCode: number;
    reason: Uint8Array;
  } & POJO;
}

class ErrorQUICConnectionInvalidConfig<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC connection invalid configuration';
}

class ErrorQUICStream<T> extends ErrorQUIC<T> {
  static description = 'QUIC Stream error';
}

class ErrorQUICStreamDestroyed<T> extends ErrorQUICStream<T> {
  static description = 'QUIC Stream is destroyed';
}

class ErrorQUICStreamClose<T> extends ErrorQUICStream<T> {
  static description = 'QUIC Stream force close';
}

class ErrorQUICStreamCancel<T> extends ErrorQUICStream<T> {
  static description = 'QUIC Stream was cancelled without a provided reason';
}

class ErrorQUICUndefinedBehaviour<T> extends ErrorQUIC<T> {
  static description = 'This should never happen';
}

export {
  ErrorQUIC,
  ErrorQUICConfig,
  ErrorQUICSocket,
  ErrorQUICSocketNotRunning,
  ErrorQUICSocketServerDuplicate,
  ErrorQUICSocketConnectionsActive,
  ErrorQUICSocketInvalidBindAddress,
  ErrorQUICSocketInvalidSendAddress,
  ErrorQUICServer,
  ErrorQUICServerNotRunning,
  ErrorQUICServerSocketNotRunning,
  ErrorQUICServerConnectionFailed,
  ErrorQUICClient,
  ErrorQUICClientCreateTimeOut,
  ErrorQUICClientDestroyed,
  ErrorQUICClientSocketNotRunning,
  ErrorQUICClientInvalidHost,
  ErrorQUICConnection,
  ErrorQUICConnectionNotRunning,
  ErrorQUICConnectionStartTimeOut,
  ErrorQUICConnectionIdleTimeOut,
  ErrorQUICConnectionInternal,
  ErrorQUICConnectionInvalidConfig,
  ErrorQUICStream,
  ErrorQUICStreamDestroyed,
  ErrorQUICStreamClose,
  ErrorQUICStreamCancel,
  ErrorQUICUndefinedBehaviour,
};
