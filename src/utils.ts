import type {
  Callback,
  PromiseDeconstructed,
  ConnectionId,
  ConnectionIdString,
  Host,
  Hostname
} from './types';
import dns from 'dns';
import { IPv4, IPv6, Validator } from 'ip-num';
import * as errors from './errors';

/**
 * This will resolve a hostname to the first host.
 * It could be an IPv6 address or IPv4 address.
 * This uses the OS's DNS resolution system.
 */
async function resolveHostname(hostname: Hostname): Promise<Host> {
  const result = await dns.promises.lookup(
    hostname,
    { family: 0, all: false, verbatim: true }
  );
  return result.address as Host;
}

/**
 * This will resolve a Host or Hostname to Host and `udp4` or `udp6`.
 * The `resolveHostname` can be overridden.
 */
async function resolveHost(
  host: Host | Hostname,
  resolveHostname: (hostname: Hostname) => Host | PromiseLike<Host>
): Promise<[Host, 'udp4' | 'udp6']> {
  const [isIPv4] = Validator.isValidIPv4String(host);
  const [isIPv6] = Validator.isValidIPv6String(host);
  if (isIPv4) {
    return [host as Host, 'udp4'];
  } else if (isIPv6) {
    return [host as Host, 'udp6'];
  } else {

    console.log('NEITHER IPV4 nor IPV6');

    host = await resolveHostname(host as Hostname);
    return resolveHost(host, resolveHostname);
  }
}

/**
 * Convert callback-style to promise-style
 * If this is applied to overloaded function
 * it will only choose one of the function signatures to use
 */
function promisify<
  T extends Array<unknown>,
  P extends Array<unknown>,
  R extends T extends [] ? void : T extends [unknown] ? T[0] : T,
>(
  f: (...args: [...params: P, callback: Callback<T>]) => unknown,
): (...params: P) => Promise<R> {
  // Uses a regular function so that `this` can be bound
  return function (...params: P): Promise<R> {
    return new Promise((resolve, reject) => {
      const callback = (error, ...values) => {
        if (error != null) {
          return reject(error);
        }
        if (values.length === 0) {
          (resolve as () => void)();
        } else if (values.length === 1) {
          resolve(values[0] as R);
        } else {
          resolve(values as R);
        }
        return;
      };
      params.push(callback);
      f.apply(this, params);
    });
  };
}

/**
 * Deconstructed promise
 */
function promise<T = void>(): PromiseDeconstructed<T> {
  let resolveP, rejectP;
  const p = new Promise<T>((resolve, reject) => {
    resolveP = resolve;
    rejectP = reject;
  });
  return {
    p,
    resolveP,
    rejectP,
  };
}

/**
 * Zero-copy wraps ArrayBuffer-like objects into Buffer
 * This supports ArrayBuffer, TypedArrays and the NodeJS Buffer
 */
function bufferWrap(
  array: BufferSource,
  offset?: number,
  length?: number,
): Buffer {
  if (Buffer.isBuffer(array)) {
    return array;
  } else if (ArrayBuffer.isView(array)) {
    return Buffer.from(
      array.buffer,
      offset ?? array.byteOffset,
      length ?? array.byteLength,
    );
  } else {
    return Buffer.from(array, offset, length);
  }
}

/**
 * Given host and port, create an address string.
 */
function buildAddress(host: string, port: number = 0): string {
  let address: string;
  const [isIPv4] = Validator.isValidIPv4String(host);
  const [isIPv6] = Validator.isValidIPv6String(host);
  if (isIPv4) {
    address = `${host}:${port}`;
  } else if (isIPv6) {
    address = `[${host}]:${port}`;
  } else {
    address = `${host}:${port}`;
  }
  return address;
}

function isHostWildcard(host: Host): boolean {
  return host === '0.0.0.0' || host === '::';
}

/**
 * Zero IPs should be resolved to localhost when used as the target
 * This is usually done automatically, but utp-native doesn't do this
 */
function resolvesZeroIP(host: Host): Host {
  const [isIPv4] = Validator.isValidIPv4String(host);
  const [isIPv6] = Validator.isValidIPv6String(host);
  const zeroIPv4 = new IPv4('0.0.0.0');
  const zeroIPv6 = new IPv6('::');
  if (isIPv4 && new IPv4(host).isEquals(zeroIPv4)) {
    return '127.0.0.1' as Host;
  } else if (isIPv6 && new IPv6(host).isEquals(zeroIPv6)) {
    return '::1' as Host;
  } else {
    return host;
  }
}

function encodeConnectionId(connId: ConnectionId): ConnectionIdString {
  return connId.toString('hex') as ConnectionIdString;
}

function decodeConnectionId(connIdString: ConnectionIdString): ConnectionId {
  return Buffer.from(connIdString, 'hex') as ConnectionId;
}

function never(): never {
  throw new errors.ErrorQUICUndefinedBehaviour();
}

export {
  resolveHostname,
  resolveHost,
  promisify,
  promise,
  bufferWrap,
  buildAddress,
  resolvesZeroIP,
  isHostWildcard,
  encodeConnectionId,
  decodeConnectionId,
  never,
};
