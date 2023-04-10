import { AbstractError } from '@matrixai/errors';

class ErrorQUIC<T> extends AbstractError<T> {
  static description = 'QUIC error';
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
  static description = 'QUIC Server cannot start with an unstarted shared QUIC socket';
}

class ErrorQUICClient<T> extends ErrorQUIC<T> {
  static description = 'QUIC Client error';
}

class ErrorQUICClientDestroyed<T> extends ErrorQUICClient<T> {
  static description = 'QUIC Client is destroyed';
}

class ErrorQUICClientSocketNotRunning<T> extends ErrorQUICClient<T> {
  static description = 'QUIC Client cannot be created with an unstarted shared QUIC socket';
}

class ErrorQUICClientInvalidHost<T> extends ErrorQUICClient<T> {
  static description = 'QUIC Client cannot be created with the specified host';
}

class ErrorQUICConnection<T> extends ErrorQUIC<T> {
  static description = 'QUIC Connection error';
}

class ErrorQUICConnectionDestroyed<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection is destroyed';
}

class ErrorQUICConnectionTimeout<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection reached idle timeout';
}

class ErrorQUICStream<T> extends ErrorQUIC<T> {
  static description = 'QUIC Stream error';
}

class ErrorQUICStreamDestroyed<T> extends ErrorQUICStream<T> {
  static description = 'QUIC Stream is destroyed';
}

class ErrorQUICStreamLocked<T> extends ErrorQUICStream<T> {
  static description = 'QUIC Stream is locked and is not closed on readable or writable';
}

class ErrorQUICStreamClose<T> extends ErrorQUICStream<T> {
  static description = 'QUIC Stream force close';
}

class ErrorQUICUndefinedBehaviour<T> extends ErrorQUIC<T> {
  static description = 'This should never happen';
}

export {
  ErrorQUIC,
  ErrorQUICSocket,
  ErrorQUICSocketNotRunning,
  ErrorQUICSocketServerDuplicate,
  ErrorQUICSocketConnectionsActive,
  ErrorQUICSocketInvalidBindAddress,
  ErrorQUICSocketInvalidSendAddress,
  ErrorQUICServer,
  ErrorQUICServerNotRunning,
  ErrorQUICServerSocketNotRunning,
  ErrorQUICClient,
  ErrorQUICClientDestroyed,
  ErrorQUICClientSocketNotRunning,
  ErrorQUICClientInvalidHost,
  ErrorQUICConnection,
  ErrorQUICConnectionDestroyed,
  ErrorQUICConnectionTimeout,
  ErrorQUICStream,
  ErrorQUICStreamDestroyed,
  ErrorQUICStreamLocked,
  ErrorQUICStreamClose,
  ErrorQUICUndefinedBehaviour,
};
