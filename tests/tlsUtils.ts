import * as x509 from '@peculiar/x509';
import * as asn1 from '@peculiar/asn1-schema';
import * as asn1X509 from '@peculiar/asn1-x509';
import * as asn1Pkcs8 from '@peculiar/asn1-pkcs8';
import { fc } from '@fast-check/jest';
import { X509Certificate } from '@peculiar/x509';
import { Crypto } from '@peculiar/webcrypto';
import sodium from 'sodium-native';

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
  return (cert.toString('pem') + '\n');
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
    publicKey: Buffer;
    privateKey: Buffer;
  };
  issuerPrivateKey: Buffer;
  duration: number;
  subjectAttrsExtra?: Array<{ [key: string]: Array<string> }>;
  issuerAttrsExtra?: Array<{ [key: string]: Array<string> }>;
  now?: Date;
}): Promise<X509Certificate> {
  const certIdNum = parseInt(certId)
  const iss = certIdNum == 0 ? certIdNum : certIdNum - 1;
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
  const certConfig = {
    serialNumber,
    notBefore: notBeforeDate,
    notAfter: notAfterDate,
    subject: subjectAttrs,
    issuer: issuerAttrs,
    signingAlgorithm: {
      name: 'EdDSA',
    },
    publicKey: subjectPublicCryptoKey,
    signingKey: subjectPrivateCryptoKey,
    extensions: [
      new x509.BasicConstraintsExtension(
        true,
        undefined,
        true,
        ),
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

type KeyPair = {
  privateKey: Buffer;
  publicKey: Buffer;
}

async function createTLSConfigWithChain(
  keyPairs: Array<KeyPair>,
  generateCertId?: () => string,
): Promise<{
  certChainPem: string;
  privKeyPem: string;
  caPem: string;
}> {
  if (keyPairs.length === 0) throw Error('Must have at least 1 keypair');
  let num = -1;
  const defaultNumGen = () => {
    num+=1;
    return `${num}`;
  }
  generateCertId = generateCertId ?? defaultNumGen;
  let previousCert: X509Certificate | null = null;
  let previousKeyPair: KeyPair | null = null;
  const certChain: Array<X509Certificate> = [];
  for (const keyPair of keyPairs) {
    const certId = generateCertId();
    const newCert = await generateCertificate({
      certId,
      duration: 31536000,
      issuerPrivateKey: previousKeyPair?.privateKey ?? keyPair.privateKey,
      subjectKeyPair: keyPair,
      issuerAttrsExtra: previousCert?.subjectName.toJSON(),
    });
    certChain.unshift(newCert);
    previousCert = newCert;
    previousKeyPair = keyPair;
  }
  let certChainPEM = '';
  let caPem: string | null = null;
  for (const certificate of certChain) {
    const pem = certToPEM(certificate)
    caPem = pem;
    certChainPEM += pem;
  }

  return {
    privKeyPem: privateKeyToPEM(previousKeyPair!.privateKey),
    certChainPem: certChainPEM,
    caPem: caPem!,
  };
}

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

const privateKeyArb = fc.uint8Array({
  minLength: 32,
  maxLength: 32,
}).map(v => Buffer.from(v))

const publicKeyArb = (
  privateKey: fc.Arbitrary<Buffer> = privateKeyArb,
) => privateKey.map(privateKey => publicKeyFromPrivateKeyEd25519(privateKey))

const keyPairArb = (
  privateKey: fc.Arbitrary<Buffer> = privateKeyArb,
): fc.Arbitrary<KeyPair> => privateKey.chain( privateKey =>  fc.record({
  privateKey: fc.constant(privateKey),
  publicKey: publicKeyArb(fc.constant(privateKey)),
}));

const keyPairsArb = (min: number = 1, max?: number) => fc.array(keyPairArb(), {
  minLength: min,
  maxLength: max ?? min,
  size: 'xsmall',
});

const tlsConfigArb = (keyPairs: fc.Arbitrary<Array<KeyPair>> = keyPairsArb()) =>
  keyPairs.map(async keyPairs => await createTLSConfigWithChain(keyPairs))
    .noShrink();


export {
  generateCertificate,
  privateKeyArb,
  publicKeyArb,
  keyPairArb,
  keyPairsArb,
  tlsConfigArb,
}
