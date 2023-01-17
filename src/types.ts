import type dgram from 'dgram';
import type QUICConnection from './QUICConnection';
import type QUICStream from './QUICStream';

/**
 * Opaque types are wrappers of existing types
 * that require smart constructors
 */
type Opaque<K, T> = T & { readonly [brand]: K };
declare const brand: unique symbol;

/**
 * Generic callback
 */
type Callback<P extends Array<any> = [], R = any, E extends Error = Error> = {
  (e: E, ...params: Partial<P>): R;
  (e?: null | undefined, ...params: P): R;
};

/**
 * Deconstructed promise
 */
type PromiseDeconstructed<T> = {
  p: Promise<T>;
  resolveP: (value: T | PromiseLike<T>) => void;
  rejectP: (reason?: any) => void;
};

type ConnectionId = Opaque<'ConnectionId', Buffer>;

type ConnectionIdString = Opaque<'ConnectionIdString', string>;

/**
 * Crypto utility object
 * Remember ever Node Buffer is an ArrayBuffer
 */
type Crypto = {
  sign(
    key: ArrayBuffer,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer>;
  verify(
    key: ArrayBuffer,
    data: ArrayBuffer,
    sig: ArrayBuffer,
  ): Promise<boolean>;
  randomBytes(
    data: ArrayBuffer,
  ): Promise<void>;
};

type StreamId = Opaque<'StreamId', number>;

/**
 * Host is always an IP address
 */
type Host = Opaque<'Host', string>;

/**
 * Hostnames are resolved to IP addresses
 */
type Hostname = Opaque<'Hostname', string>;

/**
 * Ports are numbers from 0 to 65535
 */
type Port = Opaque<'Port', number>;

/**
 * Combination of `<HOST>:<PORT>`
 */
type Address = Opaque<'Address', string>;

type QUICStreamMap = Map<StreamId, QUICStream>;

type RemoteInfo = {
  host: Host;
  port: Port;
};

export type {
  Opaque,
  Callback,
  PromiseDeconstructed,
  ConnectionId,
  ConnectionIdString,
  Crypto,
  StreamId,
  Host,
  Hostname,
  Port,
  Address,
  QUICStreamMap,
  RemoteInfo,
};
