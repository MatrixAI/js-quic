import { webcrypto } from 'crypto';

async function sleep(ms: number): Promise<void> {
  return await new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Generate 256-bit HMAC key using webcrypto.
 * Web Crypto prefers using the `CryptoKey` type.
 * But to be fully generic, we use the `ArrayBuffer` type.
 * In production, prefer to use libsodium as it would be faster.
 */
async function generateKey(): Promise<ArrayBuffer> {
  const cryptoKey = await webcrypto.subtle.generateKey(
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const key = await webcrypto.subtle.exportKey('raw', cryptoKey);
  return key;
}

/**
 * Signs using the 256-bit HMAC key
 * Web Crypto has to use the `CryptoKey` type.
 * But to be fully generic, we use the `ArrayBuffer` type.
 * In production, prefer to use libsodium as it would be faster.
 */
async function sign(key: ArrayBuffer, data: ArrayBuffer) {
  const cryptoKey = await webcrypto.subtle.importKey(
    'raw',
    key,
    {
      name: 'HMAC',
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  );
  return webcrypto.subtle.sign(
    'HMAC',
    cryptoKey,
    data
  );
}

/**
 * Verifies using 256-bit HMAC key
 * Web Crypto prefers using the `CryptoKey` type.
 * But to be fully generic, we use the `ArrayBuffer` type.
 * In production, prefer to use libsodium as it would be faster.
 */
async function verify(key: ArrayBuffer, data: ArrayBuffer, sig: ArrayBuffer) {
  const cryptoKey = await webcrypto.subtle.importKey(
    'raw',
    key,
    {
      name: 'HMAC',
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  );
  return webcrypto.subtle.verify(
    'HMAC',
    cryptoKey,
    sig,
    data
  );
}

async function randomBytes(data: ArrayBuffer) {
  webcrypto.getRandomValues(new Uint8Array(data));
}

export {
  sleep,
  generateKey,
  sign,
  verify,
  randomBytes
};
