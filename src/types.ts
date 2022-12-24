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

export type {
  Opaque,
  Callback,
  PromiseDeconstructed,
};
