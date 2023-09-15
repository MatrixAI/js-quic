import type { X509Certificate } from '@peculiar/x509';
import * as peculiarWebcrypto from '@peculiar/webcrypto';
import * as x509 from '@peculiar/x509';

/**
 * WebCrypto polyfill from @peculiar/webcrypto
 * This behaves differently with respect to Ed25519 keys
 * See: https://github.com/PeculiarVentures/webcrypto/issues/55
 */
const webcrypto = new peculiarWebcrypto.Crypto();

x509.cryptoProvider.set(webcrypto);

async function randomBytes(data: ArrayBuffer) {
  webcrypto.getRandomValues(new Uint8Array(data));
}

/**
 * Generates RSA keypair
 */
async function generateKeyPairRSA(): Promise<{
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
}> {
  const keyPair = await webcrypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  return {
    publicKey: await webcrypto.subtle.exportKey('jwk', keyPair.publicKey),
    privateKey: await webcrypto.subtle.exportKey('jwk', keyPair.privateKey),
  };
}

/**
 * Generates ECDSA keypair
 */
async function generateKeyPairECDSA(): Promise<{
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
}> {
  const keyPair = await webcrypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true,
    ['sign', 'verify'],
  );
  return {
    publicKey: await webcrypto.subtle.exportKey('jwk', keyPair.publicKey),
    privateKey: await webcrypto.subtle.exportKey('jwk', keyPair.privateKey),
  };
}

/**
 * Generates Ed25519 keypair
 * This uses `@peculiar/webcrypto` API
 */
async function generateKeyPairEd25519(): Promise<{
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
}> {
  const keyPair = (await webcrypto.subtle.generateKey(
    {
      name: 'EdDSA',
      namedCurve: 'Ed25519',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  return {
    publicKey: await webcrypto.subtle.exportKey('jwk', keyPair.publicKey),
    privateKey: await webcrypto.subtle.exportKey('jwk', keyPair.privateKey),
  };
}

/**
 * Imports public key.
 * This uses `@peculiar/webcrypto` API for Ed25519 keys.
 */
async function importPublicKey(publicKey: JsonWebKey): Promise<CryptoKey> {
  let algorithm;
  switch (publicKey.kty) {
    case 'RSA':
      switch (publicKey.alg) {
        case 'RS256':
          algorithm = {
            name: 'RSASSA-PKCS1-v1_5',
            hash: 'SHA-256',
          };
          break;
        case 'RS384':
          algorithm = {
            name: 'RSASSA-PKCS1-v1_5',
            hash: 'SHA-384',
          };
          break;
        case 'RS512':
          algorithm = {
            name: 'RSASSA-PKCS1-v1_5',
            hash: 'SHA-512',
          };
          break;
        default:
          throw new Error(`Unsupported algorithm ${publicKey.alg}`);
      }
      break;
    case 'EC':
      switch (publicKey.crv) {
        case 'P-256':
          algorithm = {
            name: 'ECDSA',
            namedCurve: 'P-256',
          };
          break;
        case 'P-384':
          algorithm = {
            name: 'ECDSA',
            namedCurve: 'P-384',
          };
          break;
        case 'P-521':
          algorithm = {
            name: 'ECDSA',
            namedCurve: 'P-521',
          };
          break;
        default:
          throw new Error(`Unsupported curve ${publicKey.crv}`);
      }
      break;
    case 'OKP':
      algorithm = {
        name: 'EdDSA',
        namedCurve: 'Ed25519',
      };
      break;
    default:
      throw new Error(`Unsupported key type ${publicKey.kty}`);
  }
  return await webcrypto.subtle.importKey('jwk', publicKey, algorithm, true, [
    'verify',
  ]);
}

/**
 * Imports private key.
 * This uses `@peculiar/webcrypto` API for Ed25519 keys.
 */
async function importPrivateKey(privateKey: JsonWebKey): Promise<CryptoKey> {
  let algorithm;
  switch (privateKey.kty) {
    case 'RSA':
      switch (privateKey.alg) {
        case 'RS256':
          algorithm = {
            name: 'RSASSA-PKCS1-v1_5',
            hash: 'SHA-256',
          };
          break;
        case 'RS384':
          algorithm = {
            name: 'RSASSA-PKCS1-v1_5',
            hash: 'SHA-384',
          };
          break;
        case 'RS512':
          algorithm = {
            name: 'RSASSA-PKCS1-v1_5',
            hash: 'SHA-512',
          };
          break;
        default:
          throw new Error(`Unsupported algorithm ${privateKey.alg}`);
      }
      break;
    case 'EC':
      switch (privateKey.crv) {
        case 'P-256':
          algorithm = {
            name: 'ECDSA',
            namedCurve: 'P-256',
          };
          break;
        case 'P-384':
          algorithm = {
            name: 'ECDSA',
            namedCurve: 'P-384',
          };
          break;
        case 'P-521':
          algorithm = {
            name: 'ECDSA',
            namedCurve: 'P-521',
          };
          break;
        default:
          throw new Error(`Unsupported curve ${privateKey.crv}`);
      }
      break;
    case 'OKP':
      algorithm = {
        name: 'EdDSA',
        namedCurve: 'Ed25519',
      };
      break;
    default:
      throw new Error(`Unsupported key type ${privateKey.kty}`);
  }
  return await webcrypto.subtle.importKey('jwk', privateKey, algorithm, true, [
    'sign',
  ]);
}

async function keyPairRSAToPEM(keyPair: {
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
}): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const publicKey = await importPublicKey(keyPair.publicKey);
  const privatekey = await importPrivateKey(keyPair.privateKey);
  const publicKeySPKI = await webcrypto.subtle.exportKey('spki', publicKey);
  const publicKeySPKIBuffer = Buffer.from(publicKeySPKI);
  const publicKeyPEMBody =
    publicKeySPKIBuffer
      .toString('base64')
      .replace(/(.{64})/g, '$1\n')
      .trimEnd() + '\n';
  const publicKeyPEM = `-----BEGIN PUBLIC KEY-----\n${publicKeyPEMBody}\n-----END PUBLIC KEY-----\n`;
  const privateKeyPKCS8 = await webcrypto.subtle.exportKey('pkcs8', privatekey);
  const privateKeyPKCS8Buffer = Buffer.from(privateKeyPKCS8);
  const privateKeyPEMBody =
    privateKeyPKCS8Buffer
      .toString('base64')
      .replace(/(.{64})/g, '$1\n')
      .trimEnd() + '\n';
  const privateKeyPEM = `-----BEGIN PRIVATE KEY-----\n${privateKeyPEMBody}-----END PRIVATE KEY-----\n`;
  return {
    publicKey: publicKeyPEM,
    privateKey: privateKeyPEM,
  };
}

async function keyPairECDSAToPEM(keyPair: {
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
}): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const publicKey = await importPublicKey(keyPair.publicKey);
  const privatekey = await importPrivateKey(keyPair.privateKey);
  const publicKeySPKI = await webcrypto.subtle.exportKey('spki', publicKey);
  const publicKeySPKIBuffer = Buffer.from(publicKeySPKI);
  const publicKeyPEMBody =
    publicKeySPKIBuffer
      .toString('base64')
      .replace(/(.{64})/g, '$1\n')
      .trimEnd() + '\n';
  const publicKeyPEM = `-----BEGIN PUBLIC KEY-----\n${publicKeyPEMBody}\n-----END PUBLIC KEY-----\n`;
  const privateKeyPKCS8 = await webcrypto.subtle.exportKey('pkcs8', privatekey);
  const privateKeyPKCS8Buffer = Buffer.from(privateKeyPKCS8);
  const privateKeyPEMBody =
    privateKeyPKCS8Buffer
      .toString('base64')
      .replace(/(.{64})/g, '$1\n')
      .trimEnd() + '\n';
  const privateKeyPEM = `-----BEGIN PRIVATE KEY-----\n${privateKeyPEMBody}-----END PRIVATE KEY-----\n`;
  return {
    publicKey: publicKeyPEM,
    privateKey: privateKeyPEM,
  };
}

async function keyPairEd25519ToPEM(keyPair: {
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
}): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const publicKey = await importPublicKey(keyPair.publicKey);
  const privatekey = await importPrivateKey(keyPair.privateKey);
  const publicKeySPKI = await webcrypto.subtle.exportKey('spki', publicKey);
  const publicKeySPKIBuffer = Buffer.from(publicKeySPKI);
  const publicKeyPEMBody =
    publicKeySPKIBuffer
      .toString('base64')
      .replace(/(.{64})/g, '$1\n')
      .trimEnd() + '\n';
  const publicKeyPEM = `-----BEGIN PUBLIC KEY-----\n${publicKeyPEMBody}\n-----END PUBLIC KEY-----\n`;
  const privateKeyPKCS8 = await webcrypto.subtle.exportKey('pkcs8', privatekey);
  const privateKeyPKCS8Buffer = Buffer.from(privateKeyPKCS8);
  const privateKeyPEMBody =
    privateKeyPKCS8Buffer
      .toString('base64')
      .replace(/(.{64})/g, '$1\n')
      .trimEnd() + '\n';
  const privateKeyPEM = `-----BEGIN PRIVATE KEY-----\n${privateKeyPEMBody}-----END PRIVATE KEY-----\n`;
  return {
    publicKey: publicKeyPEM,
    privateKey: privateKeyPEM,
  };
}

const extendedKeyUsageFlags = {
  serverAuth: '1.3.6.1.5.5.7.3.1',
  clientAuth: '1.3.6.1.5.5.7.3.2',
  codeSigning: '1.3.6.1.5.5.7.3.3',
  emailProtection: '1.3.6.1.5.5.7.3.4',
  timeStamping: '1.3.6.1.5.5.7.3.8',
  ocspSigning: '1.3.6.1.5.5.7.3.9',
};

/**
 * Generate x509 certificate.
 * Duration is in seconds.
 * X509 certificates currently use `UTCTime` format for `notBefore` and `notAfter`.
 * This means:
 *   - Only second resolution.
 *   - Minimum date for validity is 1970-01-01T00:00:00Z (inclusive).
 *   - Maximum date for valdity is 2049-12-31T23:59:59Z (inclusive).
 */
async function generateCertificate({
  certId,
  subjectKeyPair,
  issuerPrivateKey,
  duration,
  subjectAttrsExtra = [],
  issuerAttrsExtra = [],
  now = new Date(),
}: {
  certId: string;
  subjectKeyPair: {
    publicKey: JsonWebKey;
    privateKey: JsonWebKey;
  };
  issuerPrivateKey: JsonWebKey;
  duration: number;
  subjectAttrsExtra?: Array<{ [key: string]: Array<string> }>;
  issuerAttrsExtra?: Array<{ [key: string]: Array<string> }>;
  now?: Date;
}): Promise<X509Certificate> {
  const certIdNum = parseInt(certId);
  const iss = certIdNum === 0 ? certIdNum : certIdNum - 1;
  const sub = certIdNum;
  const subjectPublicCryptoKey = await importPublicKey(
    subjectKeyPair.publicKey,
  );
  const subjectPrivateCryptoKey = await importPrivateKey(
    subjectKeyPair.privateKey,
  );
  const issuerPrivateCryptoKey = await importPrivateKey(issuerPrivateKey);
  if (duration < 0) {
    throw new RangeError('`duration` must be positive');
  }
  // X509 `UTCTime` format only has resolution of seconds
  // this truncates to second resolution
  const notBeforeDate = new Date(now.getTime() - (now.getTime() % 1000));
  const notAfterDate = new Date(now.getTime() - (now.getTime() % 1000));
  // If the duration is 0, then only the `now` is valid
  notAfterDate.setSeconds(notAfterDate.getSeconds() + duration);
  if (notBeforeDate < new Date(0)) {
    throw new RangeError(
      '`notBeforeDate` cannot be before 1970-01-01T00:00:00Z',
    );
  }
  if (notAfterDate > new Date(new Date('2050').getTime() - 1)) {
    throw new RangeError('`notAfterDate` cannot be after 2049-12-31T23:59:59Z');
  }
  const serialNumber = certId;
  // The entire subject attributes and issuer attributes
  // is constructed via `x509.Name` class
  // By default this supports on a limited set of names:
  // CN, L, ST, O, OU, C, DC, E, G, I, SN, T
  // If custom names are desired, this needs to change to constructing
  // `new x509.Name('FOO=BAR', { FOO: '1.2.3.4' })` manually
  // And each custom attribute requires a registered OID
  // Because the OID is what is encoded into ASN.1
  const subjectAttrs = [
    {
      CN: [`${sub}`],
    },
    // Filter out conflicting CN attributes
    ...subjectAttrsExtra.filter((attr) => !('CN' in attr)),
  ];
  const issuerAttrs = [
    {
      CN: [`${iss}`],
    },
    // Filter out conflicting CN attributes
    ...issuerAttrsExtra.filter((attr) => !('CN' in attr)),
  ];
  const signingAlgorithm: any = issuerPrivateCryptoKey.algorithm;
  if (signingAlgorithm.name === 'ECDSA') {
    // In ECDSA, the signature should match the curve strength
    switch (signingAlgorithm.namedCurve) {
      case 'P-256':
        signingAlgorithm.hash = 'SHA-256';
        break;
      case 'P-384':
        signingAlgorithm.hash = 'SHA-384';
        break;
      case 'P-521':
        signingAlgorithm.hash = 'SHA-512';
        break;
      default:
        throw new TypeError(
          `Issuer private key has an unsupported curve: ${signingAlgorithm.namedCurve}`,
        );
    }
  }
  const certConfig = {
    serialNumber,
    notBefore: notBeforeDate,
    notAfter: notAfterDate,
    subject: subjectAttrs,
    issuer: issuerAttrs,
    signingAlgorithm,
    publicKey: subjectPublicCryptoKey,
    signingKey: subjectPrivateCryptoKey,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign |
          x509.KeyUsageFlags.cRLSign |
          x509.KeyUsageFlags.digitalSignature |
          x509.KeyUsageFlags.nonRepudiation |
          x509.KeyUsageFlags.keyAgreement |
          x509.KeyUsageFlags.keyEncipherment |
          x509.KeyUsageFlags.dataEncipherment,
        true,
      ),
      new x509.ExtendedKeyUsageExtension([
        extendedKeyUsageFlags.serverAuth,
        extendedKeyUsageFlags.clientAuth,
        extendedKeyUsageFlags.codeSigning,
        extendedKeyUsageFlags.emailProtection,
        extendedKeyUsageFlags.timeStamping,
        extendedKeyUsageFlags.ocspSigning,
      ]),
      await x509.SubjectKeyIdentifierExtension.create(subjectPublicCryptoKey),
    ] as Array<x509.Extension>,
  };
  certConfig.signingKey = issuerPrivateCryptoKey;
  return await x509.X509CertificateGenerator.create(certConfig);
}

function certToPEM(cert: X509Certificate): string {
  return cert.toString('pem') + '\n';
}

/**
 * Generate 256-bit HMAC key using webcrypto.
 * Web Crypto prefers using the `CryptoKey` type.
 * But to be fully generic, we use the `ArrayBuffer` type.
 * In production, prefer to use libsodium as it would be faster.
 */
async function generateKeyHMAC(): Promise<ArrayBuffer> {
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
async function signHMAC(key: ArrayBuffer, data: ArrayBuffer) {
  const cryptoKey = await webcrypto.subtle.importKey(
    'raw',
    key,
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  return webcrypto.subtle.sign('HMAC', cryptoKey, data);
}

/**
 * Verifies using 256-bit HMAC key
 * Web Crypto prefers using the `CryptoKey` type.
 * But to be fully generic, we use the `ArrayBuffer` type.
 * In production, prefer to use libsodium as it would be faster.
 */
async function verifyHMAC(
  key: ArrayBuffer,
  data: ArrayBuffer,
  sig: ArrayBuffer,
) {
  const cryptoKey = await webcrypto.subtle.importKey(
    'raw',
    key,
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  return webcrypto.subtle.verify('HMAC', cryptoKey, sig, data);
}

async function generateTLSConfig(
  type: 'RSA' | 'ECDSA' | 'Ed25519'
): Promise<{
  leafKeyPair: { publicKey: JsonWebKey; privateKey: JsonWebKey };
  leafKeyPairPEM: { publicKey: string; privateKey: string };
  leafCert: X509Certificate;
  leafCertPEM: string;
  caKeyPair: { publicKey: JsonWebKey; privateKey: JsonWebKey };
  caKeyPairPEM: { publicKey: string; privateKey: string };
  caCert: X509Certificate;
  caCertPEM: string;
}> {
  let leafKeyPair: { publicKey: JsonWebKey; privateKey: JsonWebKey };
  let leafKeyPairPEM: { publicKey: string; privateKey: string };
  let caKeyPair: { publicKey: JsonWebKey; privateKey: JsonWebKey };
  let caKeyPairPEM: { publicKey: string; privateKey: string };
  switch (type) {
    case 'RSA':
      {
        leafKeyPair = await generateKeyPairRSA();
        leafKeyPairPEM = await keyPairRSAToPEM(leafKeyPair);
        caKeyPair = await generateKeyPairRSA();
        caKeyPairPEM = await keyPairRSAToPEM(caKeyPair);
      }
      break;
    case 'ECDSA':
      {
        leafKeyPair = await generateKeyPairECDSA();
        leafKeyPairPEM = await keyPairECDSAToPEM(leafKeyPair);
        caKeyPair = await generateKeyPairECDSA();
        caKeyPairPEM = await keyPairECDSAToPEM(caKeyPair);
      }
      break;
    case 'Ed25519':
      {
        leafKeyPair = await generateKeyPairEd25519();
        leafKeyPairPEM = await keyPairEd25519ToPEM(leafKeyPair);
        caKeyPair = await generateKeyPairEd25519();
        caKeyPairPEM = await keyPairEd25519ToPEM(caKeyPair);
      }
      break;
  }
  const caCert = await generateCertificate({
    certId: '0',
    issuerPrivateKey: caKeyPair.privateKey,
    subjectKeyPair: caKeyPair,
    duration: 60 * 60 * 24 * 365 * 10,
  });
  const leafCert = await generateCertificate({
    certId: '1',
    issuerPrivateKey: caKeyPair.privateKey,
    subjectKeyPair: leafKeyPair,
    duration: 60 * 60 * 24 * 365 * 10,
  });
  return {
    leafKeyPair,
    leafKeyPairPEM,
    leafCert,
    leafCertPEM: certToPEM(leafCert),
    caKeyPair,
    caKeyPairPEM,
    caCert,
    caCertPEM: certToPEM(caCert),
  };
}


export {
  randomBytes,
  generateKeyPairRSA,
  generateKeyPairECDSA,
  generateKeyPairEd25519,
  keyPairRSAToPEM,
  keyPairECDSAToPEM,
  keyPairEd25519ToPEM,
  generateCertificate,
  certToPEM,
  generateKeyHMAC,
  signHMAC,
  verifyHMAC,
  generateTLSConfig,
};
