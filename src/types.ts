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

type ConnectionId = Opaque<'ConnectionId', string>;

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
};

type StreamId = Opaque<'StreamId', number>;

export type {
  Opaque,
  Callback,
  PromiseDeconstructed,
  ConnectionId,
  Crypto,
  StreamId,
};
