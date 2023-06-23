import type { X509Certificate } from '@peculiar/x509';
import * as x509 from '@peculiar/x509';
import * as asn1 from '@peculiar/asn1-schema';
import * as asn1X509 from '@peculiar/asn1-x509';
import * as asn1Pkcs8 from '@peculiar/asn1-pkcs8';
import { fc } from '@fast-check/jest';
import { Crypto } from '@peculiar/webcrypto';
import sodium from 'sodium-native';
import * as testsUtils from './utils';

/**
 * WebCrypto polyfill from @peculiar/webcrypto
 * This behaves differently with respect to Ed25519 keys
 * See: https://github.com/PeculiarVentures/webcrypto/issues/55
 */
const webcrypto = new Crypto();

/**
 * Monkey patches the global crypto object polyfill
 */
globalThis.crypto = webcrypto;

// Setting provider
x509.cryptoProvider.set(webcrypto);

/**
 * Imports Ed25519 public `CryptoKey` from key buffer.
 * If `publicKey` is already `CryptoKey`, then this just returns it.
 */
async function importPublicKey(publicKey: BufferSource): Promise<CryptoKey> {
  return webcrypto.subtle.importKey(
    'raw',
    publicKey,
    {
      name: 'EdDSA',
      namedCurve: 'Ed25519',
    },
    true,
    ['verify'],
  );
}

/**
 * Imports Ed25519 private `CryptoKey` from key buffer.
 * If `privateKey` is already `CryptoKey`, then this just returns it.
 */
async function importPrivateKey(privateKey: BufferSource): Promise<CryptoKey> {
  return await webcrypto.subtle.importKey(
    'jwk',
    {
      alg: 'EdDSA',
      kty: 'OKP',
      crv: 'Ed25519',
      d: bufferWrap(privateKey).toString('base64url'),
    },
    {
      name: 'EdDSA',
      namedCurve: 'Ed25519',
    },
    true,
    ['sign'],
  );
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

function privateKeyToPEM(privateKey: Buffer): string {
  const pkcs8 = new asn1Pkcs8.PrivateKeyInfo({
    privateKeyAlgorithm: new asn1X509.AlgorithmIdentifier({
      algorithm: x509.idEd25519,
    }),
    privateKey: new asn1Pkcs8.PrivateKey(
      new asn1.OctetString(privateKey).toASN().toBER(),
    ),
  });
  const data = Buffer.from(asn1.AsnSerializer.serialize(pkcs8));
  const contents =
    data
      .toString('base64')
      .replace(/(.{64})/g, '$1\n')
      .trimEnd() + '\n';
  return `-----BEGIN PRIVATE KEY-----\n${contents}-----END PRIVATE KEY-----\n`;
}

function certToPEM(cert: X509Certificate): string {
  return cert.toString('pem') + '\n';
}

type KeyPair = {
  privateKey: Buffer;
  publicKey: Buffer;
};



/**
 * Extracts Ed25519 Public Key from Ed25519 Private Key
 * The returned buffers are guaranteed to unpooled.
 * This means the underlying `ArrayBuffer` is safely transferrable.
 */
function publicKeyFromPrivateKeyEd25519(privateKey: Buffer): Buffer {
  const publicKey = Buffer.allocUnsafeSlow(sodium.crypto_sign_PUBLICKEYBYTES);
  sodium.crypto_sign_seed_keypair(
    publicKey,
    Buffer.allocUnsafe(sodium.crypto_sign_SECRETKEYBYTES),
    privateKey,
  );
  return publicKey;
}

const privateKeyArb = fc
  .uint8Array({
    minLength: 32,
    maxLength: 32,
  })
  .map((v) => Buffer.from(v));

const publicKeyArb = (privateKey: fc.Arbitrary<Buffer> = privateKeyArb) =>
  privateKey.map((privateKey) => publicKeyFromPrivateKeyEd25519(privateKey));

const keyPairArb = (
  privateKey: fc.Arbitrary<Buffer> = privateKeyArb,
): fc.Arbitrary<KeyPair> =>
  privateKey.chain((privateKey) =>
    fc.record({
      privateKey: fc.constant(privateKey),
      publicKey: publicKeyArb(fc.constant(privateKey)),
    }),
  );

const keyPairsArb = (min: number = 1, max?: number) =>
  fc.array(keyPairArb(), {
    minLength: min,
    maxLength: max ?? min,
    size: 'xsmall',
  });

// const tlsConfigArb = (keyPairs: fc.Arbitrary<Array<KeyPair>> = keyPairsArb()) =>
//   keyPairs
//     .map(async (keyPairs) => await createTLSConfigWithChain(keyPairs))
//     .noShrink();

// const tlsConfigWithCaRSAArb = fc.record({
//   type: fc.constant('RSA'),
//   ca: fc.constant(certFixtures.tlsConfigMemRSACa),
//   tlsConfig: certFixtures.tlsConfigRSAExampleArb,
// });
//
// const tlsConfigWithCaOKPArb = fc.record({
//   type: fc.constant('OKP'),
//   ca: fc.constant(certFixtures.tlsConfigMemOKPCa),
//   tlsConfig: certFixtures.tlsConfigOKPExampleArb,
// });
//
// const tlsConfigWithCaECDSAArb = fc.record({
//   type: fc.constant('ECDSA'),
//   ca: fc.constant(certFixtures.tlsConfigMemECDSACa),
//   tlsConfig: certFixtures.tlsConfigECDSAExampleArb,
// });

// const tlsConfigWithCaGENOKPArb = tlsConfigArb().map(async (configProm) => {
//   const config = await configProm;
//   return {
//     type: fc.constant('GEN-OKP'),
//     tlsConfig: {
//       certChainPem: config.certChainPem,
//       privKeyPem: config.privKeyPem,
//     },
//     ca: {
//       certChainPem: config.caPem,
//       privKeyPem: '',
//     },
//   };
// });
//
// const tlsConfigWithCaArb = fc
//   .oneof(
//     tlsConfigWithCaRSAArb,
//     tlsConfigWithCaOKPArb,
//     tlsConfigWithCaECDSAArb,
//     tlsConfigWithCaGENOKPArb,
//   )
//   .noShrink();

export {
  privateKeyArb,
  publicKeyArb,
  keyPairArb,
  keyPairsArb,
  // tlsConfigArb,
  // tlsConfigWithCaArb,
  // tlsConfigWithCaRSAArb,
  // tlsConfigWithCaOKPArb,
  // tlsConfigWithCaECDSAArb,
  // tlsConfigWithCaGENOKPArb,
};
