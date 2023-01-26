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

class ErrorQUICClientNotRunning<T> extends ErrorQUICClient<T> {
  static description = 'QUIC Client is not running';
}

class ErrorQUICConnection<T> extends ErrorQUIC<T> {
  static description = 'QUIC Connection error';
}

class ErrorQUICConnectionDestroyed<T> extends ErrorQUICConnection<T> {
  static description = 'QUIC Connection is destroyed';
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
  ErrorQUICServer,
  ErrorQUICServerNotRunning,
  ErrorQUICServerSocketNotRunning,
  ErrorQUICClient,
  ErrorQUICClientNotRunning,
  ErrorQUICConnection,
  ErrorQUICConnectionDestroyed,
  ErrorQUICStream,
  ErrorQUICStreamDestroyed,
  ErrorQUICStreamLocked,
  ErrorQUICStreamClose,
  ErrorQUICUndefinedBehaviour,
};
