import type {
  Callback,
  PromiseDeconstructed,
  ConnectionId,
  ConnectionIdString,
  Host,
  Port,
  QUICServerCrypto,
} from './types';
import type { Connection } from './native';
import dns from 'dns';
import { IPv4, IPv6, Validator } from 'ip-num';
import QUICConnectionId from './QUICConnectionId';
import * as errors from './errors';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

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

function isIPv4MappedIPv6Hex(host: string): host is Host {
  if (host.startsWith('::ffff:')) {
    try {
      // The `ip-num` package understands `::ffff:7f00:1`
      IPv6.fromString(host);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function isIPv4MappedIPv6Dec(host: string): host is Host {
  if (host.startsWith('::ffff:')) {
    // But it does not understand `::ffff:127.0.0.1`
    const ipv4 = host.slice('::ffff:'.length);
    if (isIPv4(ipv4)) {
      return true;
    }
  }
  return false;
}

/**
 * Takes an IPv4 address and returns the IPv4 mapped IPv6 address.
 * This produces the dotted decimal variant.
 */
function toIPv4MappedIPv6Dec(host: string): Host {
  if (!isIPv4(host)) {
    throw new TypeError('Invalid IPv4 address');
  }
  return ('::ffff:' + host) as Host;
}

/**
 * Takes an IPv4 address and returns the IPv4 mapped IPv6 address.
 * This produces the dotted Hexidecimal variant.
 */
function toIPv4MappedIPv6Hex(host: string): Host {
  if (!isIPv4(host)) {
    throw new TypeError('Invalid IPv4 address');
  }
  return IPv4.fromString(host).toIPv4MappedIPv6().toString() as Host;
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
 * This converts all `IPv4` formats to the `IPv4` decimal format.
 * `IPv4` decimal and `IPv6` hex formatted IPs are left unchanged.
 */
function toCanonicalIp(host: string) {
  if (isIPv4MappedIPv6(host)) {
    return fromIPv4MappedIPv6(host);
  }
  if (isIPv4(host) || isIPv6(host)) {
    return host;
  }
  throw new TypeError('Invalid IP address');
}

/**
 * This will resolve a hostname to the first host.
 * It could be an IPv6 address or IPv4 address.
 * This uses the OS's DNS resolution system.
 */
async function resolveHostname(hostname: string): Promise<Host> {
  const result = await dns.promises.lookup(hostname, {
    family: 0,
    all: false,
    verbatim: true,
  });
  return result.address as Host;
}

/**
 * This will resolve a Host or Hostname to Host and `udp4` or `udp6`.
 * The `resolveHostname` can be overridden.
 */
async function resolveHost(
  host: string,
  resolveHostname: (hostname: string) => string | PromiseLike<string>,
): Promise<[Host, 'udp4' | 'udp6']> {
  if (isIPv4(host)) {
    return [host as Host, 'udp4'];
  } else if (isIPv6(host)) {
    return [host as Host, 'udp6'];
  } else {
    try {
      host = await resolveHostname(host);
      return resolveHost(host, resolveHostname);
    } catch {
      throw new errors.ErrorQUICHostInvalid();
    }
  }
}

/**
 * Converts a Host back to a string.
 */
function fromHost(host: Host): string {
  return host;
}

/**
 * Is it a valid Port?
 */
function isPort(port: any): port is Port {
  if (typeof port !== 'number') return false;
  return port >= 0 && port <= 65535;
}

/**
 * Throws if port is invalid, otherwise returns port as Port.
 */
function toPort(port: any): Port {
  if (!isPort(port)) throw new errors.ErrorQUICPortInvalid();
  return port;
}

/**
 * Converts a Port back to a number.
 */
function fromPort(port: Port): number {
  return port;
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
      return toIPv4MappedIPv6Dec('127.0.0.1');
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

function never(message?: string): never {
  throw new errors.ErrorQUICUndefinedBehaviour(message);
}

async function mintToken(
  dcid: QUICConnectionId,
  peerHost: Host,
  crypto: QUICServerCrypto,
): Promise<Buffer> {
  const msgData = { dcid: dcid.toString(), host: peerHost };
  const msgJSON = JSON.stringify(msgData);
  const msgBuffer = Buffer.from(msgJSON);
  const msgSig = Buffer.from(await crypto.ops.sign(crypto.key, msgBuffer));
  const tokenData = {
    msg: msgBuffer.toString('base64url'),
    sig: msgSig.toString('base64url'),
  };
  const tokenJSON = JSON.stringify(tokenData);
  return Buffer.from(tokenJSON);
}

async function validateToken(
  tokenBuffer: Buffer,
  peerHost: Host,
  crypto: QUICServerCrypto,
): Promise<QUICConnectionId | undefined> {
  let tokenData;
  try {
    tokenData = JSON.parse(tokenBuffer.toString());
  } catch {
    return;
  }
  if (typeof tokenData !== 'object' || tokenData == null) {
    return;
  }
  if (typeof tokenData.msg !== 'string' || typeof tokenData.sig !== 'string') {
    return;
  }
  const msgBuffer = Buffer.from(tokenData.msg, 'base64url');
  const msgSig = Buffer.from(tokenData.sig, 'base64url');
  if (!(await crypto.ops.verify(crypto.key, msgBuffer, msgSig))) {
    return;
  }
  let msgData;
  try {
    msgData = JSON.parse(msgBuffer.toString());
  } catch {
    return;
  }
  if (typeof msgData !== 'object' || msgData == null) {
    return;
  }
  if (typeof msgData.dcid !== 'string' || typeof msgData.host !== 'string') {
    return;
  }
  if (msgData.host !== peerHost) {
    return;
  }
  return QUICConnectionId.fromString(msgData.dcid);
}

async function sleep(ms: number): Promise<void> {
  return await new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Useful for debug printing stream state
 */
function streamStats(
  connection: Connection,
  streamId: number,
  label: string,
): string {
  let streamWritable: string;
  try {
    streamWritable = `${connection.streamWritable(streamId, 0)}`;
  } catch (e) {
    streamWritable = `threw ${e.message}`;
  }
  let streamCapacity: string;
  try {
    streamCapacity = `${connection.streamCapacity(streamId)}`;
  } catch (e) {
    streamCapacity = `threw ${e.message}`;
  }
  let readableIterator = false;
  for (const streamIterElement of connection.readable()) {
    if (streamIterElement === streamId) readableIterator = true;
  }
  let writableIterator = false;
  for (const streamIterElement of connection.writable()) {
    if (streamIterElement === streamId) writableIterator = true;
  }
  return `
  ---${label}---
  isReadable: ${connection.isReadable()},
  readable iterator: ${readableIterator},
  streamReadable: ${connection.streamReadable(streamId)},
  streamFinished: ${connection.streamFinished(streamId)},
  writable iterator: ${writableIterator},
  streamWritable: ${streamWritable},
  streamCapacity: ${streamCapacity},
`;
}

/**
 * Collects PEMs into a PEM chain array.
 * This can be used for keys, certs and ca.
 */
function concatPEMs(
  pems?: string | Array<string> | Uint8Array | Array<Uint8Array>
): Array<string> {
  const pemsChain: Array<string> = [];
  if (typeof pems === 'string') {
    pemsChain.push(pems.trim() + '\n');
  } else if (pems instanceof Uint8Array) {
    pemsChain.push(textDecoder.decode(pems).trim() + '\n');
  } else if (Array.isArray(pems)) {
    for (const c of pems) {
      if (typeof c === 'string') {
        pemsChain.push(c.trim() + '\n');
      } else {
        pemsChain.push(textDecoder.decode(c).trim() + '\n');
      }
    }
  }
  return pemsChain;
}

/**
 * QUIC produces DER encoded certificates when requesting for peer certificates
 */
function derToPEM(der: Uint8Array): string {
  const data = Buffer.from(der.buffer, der.byteOffset, der.byteLength);
  const contents = data.toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trimEnd() + '\n';
  return `-----BEGIN CERTIFICATE-----\n${contents}-----END CERTIFICATE-----\n`;
}

export {
  textEncoder,
  textDecoder,
  isIPv4,
  isIPv6,
  isIPv4MappedIPv6,
  isIPv4MappedIPv6Hex,
  isIPv4MappedIPv6Dec,
  toIPv4MappedIPv6Dec,
  toIPv4MappedIPv6Hex,
  fromIPv4MappedIPv6,
  toCanonicalIp,
  resolveHostname,
  resolveHost,
  fromHost,
  isPort,
  toPort,
  fromPort,
  promisify,
  promise,
  bufferWrap,
  buildAddress,
  resolvesZeroIP,
  isHostWildcard,
  encodeConnectionId,
  decodeConnectionId,
  never,
  mintToken,
  validateToken,
  sleep,
  streamStats,
  concatPEMs,
  derToPEM,
};
