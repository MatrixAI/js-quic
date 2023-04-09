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
 * Is it an IPv4 address?
 */
function isIPv4(host: string): host is Host {
  const [isIPv4] = Validator.isValidIPv4String(host);
  return isIPv4;
}

/**
 * Is it an IPv6 address?
 * This considers IPv4 mapped IPv6 addresses to also be IPv6 addresses.
 */
function isIPv6(host: string): host is Host {
  const [isIPv6] = Validator.isValidIPv6String(host);
  if (isIPv6) return true;
  // Test if the host is an IPv4 mapped IPv6 address.
  // In the future, `isValidIPv6String` should be able to handle this
  // and this code can be removed.
  return isIPv4MappedIPv6(host);
}

/**
 * There are 2 kinds of IPv4 mapped IPv6 addresses.
 * 1. ::ffff:127.0.0.1 - dotted decimal version
 * 2. ::ffff:7f00:1 - hex version
 * Both are accepted by Node's dgram module.
 */
function isIPv4MappedIPv6(host: string): host is Host {
  if (host.startsWith('::ffff:')) {
    try {
      // The `ip-num` package understands `::ffff:7f00:1`
      IPv6.fromString(host);
      return true;
    } catch {
      // But it does not understand `::ffff:127.0.0.1`
      const ipv4 = host.slice('::ffff:'.length);
      if (isIPv4(ipv4)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Takes an IPv4 address and returns the IPv4 mapped IPv6 address.
 * This produces the dotted decimal variant.
 */
function toIPv4MappedIPv6(host: string): Host {
  if (!isIPv4(host)) {
    throw new TypeError('Invalid IPv4 address');
  }
  return '::ffff:' + host as Host;
}

/**
 * Extracts the IPv4 portion out of the IPv4 mapped IPv6 address.
 * Can handle both the dotted decimal and hex variants.
 * 1. ::ffff:7f00:1
 * 2. ::ffff:127.0.0.1
 * Always returns the dotted decimal variant.
 */
function fromIPv4MappedIPv6(host: string): Host {
  const ipv4 = host.slice('::ffff:'.length);
  if (isIPv4(ipv4)) {
    return ipv4 as Host;
  }
  const matches = ipv4.match(/^([0-9a-fA-F]{1,4}):([0-9a-fA-F]{1,4})$/);
  if (matches == null) {
    throw new TypeError('Invalid IPv4 mapped IPv6 address');
  }
  const ipv4Hex = matches[1].padStart(4, '0') + matches[2].padStart(4, '0');
  const ipv4Hexes = ipv4Hex.match(/.{1,2}/g)!;
  const ipv4Decs = ipv4Hexes.map((h) => parseInt(h, 16));
  return ipv4Decs.join('.') as Host;
}

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
  if (isIPv4(host)) {
    return [host as Host, 'udp4'];
  } else if (isIPv6(host)) {
    return [host as Host, 'udp6'];
  } else {
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
  if (isIPv4(host)) {
    address = `${host}:${port}`;
  } else if (isIPv6(host)) {
    address = `[${host}]:${port}`;
  } else {
    address = `${host}:${port}`;
  }
  return address;
}

function isHostWildcard(host: Host): boolean {
  return (
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::0' ||
    host === '::ffff:0.0.0.0' ||
    host === '::ffff:0:0'
  );
}

/**
 * Zero IPs should be resolved to localhost when used as the target
 */
function resolvesZeroIP(host: Host): Host {
  const zeroIPv4 = new IPv4('0.0.0.0');
  // This also covers `::0`
  const zeroIPv6 = new IPv6('::');
  if (isIPv4MappedIPv6(host)) {
    const ipv4 = fromIPv4MappedIPv6(host);
    if (new IPv4(ipv4).isEquals(zeroIPv4)) {
      return toIPv4MappedIPv6('127.0.0.1');
    } else {
      return host;
    }
  } else if (isIPv4(host) && new IPv4(host).isEquals(zeroIPv4)) {
    return '127.0.0.1' as Host;
  } else if (isIPv6(host) && new IPv6(host).isEquals(zeroIPv6)) {
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
  isIPv4,
  isIPv6,
  isIPv4MappedIPv6,
  toIPv4MappedIPv6,
  fromIPv4MappedIPv6,
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
