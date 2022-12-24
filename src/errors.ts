// Here we are going to have errors
// that are specific to different parts of the QUIC flow
// They are emitted as events mostly
// Not the same as bubbling up to the caller
import { AbstractError } from '@matrixai/errors';

class ErrorQUIC<T> extends AbstractError<T> {
  static description = 'QUIC error';
}

export {
  ErrorQUIC
};
