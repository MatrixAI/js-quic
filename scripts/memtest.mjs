import Logger, { formatting, LogLevel, StreamHandler } from '@matrixai/logger';
import * as peculiarWebcrypto from '@peculiar/webcrypto';
import * as x509 from '@peculiar/x509';
import * as events from '../dist/events.js';
import * as utils from '../dist/utils.js';
import QUICServer from '../dist/QUICServer.js';
import QUICClient from '../dist/QUICClient.js';
import QUICStream from '../dist/QUICStream.js';

const webcrypto = new peculiarWebcrypto.Crypto();
x509.cryptoProvider.set(webcrypto);

const extendedKeyUsageFlags = {
  serverAuth: '1.3.6.1.5.5.7.3.1',
  clientAuth: '1.3.6.1.5.5.7.3.2',
  codeSigning: '1.3.6.1.5.5.7.3.3',
  emailProtection: '1.3.6.1.5.5.7.3.4',
  timeStamping: '1.3.6.1.5.5.7.3.8',
  ocspSigning: '1.3.6.1.5.5.7.3.9',
};

async function generateKeyHMAC() {
  const cryptoKey = await webcrypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const key = await webcrypto.subtle.exportKey('raw', cryptoKey);
  return key;
}

async function signHMAC(key, data) {
  const cryptoKey = await webcrypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  return webcrypto.subtle.sign('HMAC', cryptoKey, data);
}

async function verifyHMAC(key, data, sig) {
  const cryptoKey = await webcrypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  return webcrypto.subtle.verify('HMAC', cryptoKey, sig, data);
}

async function importPublicKey(publicKey) {
  let algorithm;
  switch (publicKey.kty) {
    case 'RSA':
      switch (publicKey.alg) {
        case 'RS256':
          algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
          break;
        case 'RS384':
          algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' };
          break;
        case 'RS512':
          algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' };
          break;
        default:
          throw new Error(`Unsupported algorithm ${publicKey.alg}`);
      }
      break;
    default:
      throw new Error(`Unsupported key type ${publicKey.kty}`);
  }
  return await webcrypto.subtle.importKey('jwk', publicKey, algorithm, true, [
    'verify',
  ]);
}

async function importPrivateKey(privateKey) {
  let algorithm;
  switch (privateKey.kty) {
    case 'RSA':
      switch (privateKey.alg) {
        case 'RS256':
          algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
          break;
        case 'RS384':
          algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' };
          break;
        case 'RS512':
          algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' };
          break;
        default:
          throw new Error(`Unsupported algorithm ${privateKey.alg}`);
      }
      break;
    default:
      throw new Error(`Unsupported key type ${privateKey.kty}`);
  }
  return await webcrypto.subtle.importKey('jwk', privateKey, algorithm, true, [
    'sign',
  ]);
}

async function generateKeyPairRSA() {
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

async function keyPairRSAToPEM(keyPair) {
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

async function publicKeyFromPrivateKey(privateKey) {
  switch (privateKey.kty) {
    case 'RSA':
      return {
        kty: privateKey.kty,
        alg: privateKey.alg,
        key_ops: ['verify'],
        ext: privateKey.ext,
        n: privateKey.n,
        e: privateKey.e,
      };
    default:
      throw new Error(`Unsupported key type ${privateKey.kty}`);
  }
}

async function generateCertificate({
  certId,
  subjectKeyPair,
  issuerPrivateKey,
  duration,
  subjectAttrsExtra = [],
  issuerAttrsExtra = [],
  now = new Date(),
}) {
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
  const notBeforeDate = new Date(now.getTime() - (now.getTime() % 1000));
  const notAfterDate = new Date(now.getTime() - (now.getTime() % 1000));
  notAfterDate.setSeconds(notAfterDate.getSeconds() + duration);
  if (notBeforeDate < new Date(0)) {
    throw new RangeError(
      '`notBeforeDate` cannot be before 1970-01-01T00:00:00Z',
    );
  }
  if (notAfterDate > new Date(new Date('2050').getTime() - 1)) {
    throw new RangeError('`notAfterDate` cannot be after 2049-12-31T23:59:59Z');
  }
  const subjectNodeId = await webcrypto.subtle.digest(
    'SHA-256',
    await webcrypto.subtle.exportKey('spki', subjectPublicCryptoKey),
  );
  const issuerPublicKey = await publicKeyFromPrivateKey(issuerPrivateKey);
  const issuerPublicCryptoKey = await importPublicKey(issuerPublicKey);
  const issuerNodeId = await webcrypto.subtle.digest(
    'SHA-256',
    await webcrypto.subtle.exportKey('spki', issuerPublicCryptoKey),
  );
  const serialNumber = certId;
  const subjectNodeIdEncoded = Buffer.from(subjectNodeId).toString('hex');
  const issuerNodeIdEncoded = Buffer.from(issuerNodeId).toString('hex');
  const subjectAttrs = [
    { CN: [subjectNodeIdEncoded] },
    ...subjectAttrsExtra.filter((attr) => !('CN' in attr)),
  ];
  const issuerAttrs = [
    { CN: [issuerNodeIdEncoded] },
    ...issuerAttrsExtra.filter((attr) => !('CN' in attr)),
  ];
  const signingAlgorithm = issuerPrivateCryptoKey.algorithm;
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
      new x509.BasicConstraintsExtension(true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign |
          x509.KeyUsageFlags.cRLSign |
          x509.KeyUsageFlags.digitalSignature |
          x509.KeyUsageFlags.nonRepudiation |
          x509.KeyUsageFlags.keyAgreement |
          x509.KeyUsageFlags.keyEncipherment |
          x509.KeyUsageFlags.dataEncipherment,
      ),
      new x509.ExtendedKeyUsageExtension([
        extendedKeyUsageFlags.serverAuth,
        extendedKeyUsageFlags.clientAuth,
        extendedKeyUsageFlags.codeSigning,
        extendedKeyUsageFlags.emailProtection,
        extendedKeyUsageFlags.timeStamping,
        extendedKeyUsageFlags.ocspSigning,
      ]),
      new x509.SubjectAlternativeNameExtension([
        { type: 'dns', value: subjectNodeIdEncoded },
        { type: 'dns', value: 'localhost' },
        { type: 'dns', value: '127.0.0.1' },
        { type: 'dns', value: '::1' },
        { type: 'ip', value: '127.0.0.1' },
        { type: 'ip', value: '::1' },
      ]),
      await x509.SubjectKeyIdentifierExtension.create(subjectPublicCryptoKey),
    ],
  };
  certConfig.signingKey = issuerPrivateCryptoKey;
  return await x509.X509CertificateGenerator.create(certConfig);
}

async function generateTLSConfig() {
  let leafKeyPair;
  let leafKeyPairPEM;
  let caKeyPair;
  let caKeyPairPEM;

  leafKeyPair = await generateKeyPairRSA();
  leafKeyPairPEM = await keyPairRSAToPEM(leafKeyPair);
  caKeyPair = await generateKeyPairRSA();
  caKeyPairPEM = await keyPairRSAToPEM(caKeyPair);

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
    leafCertPEM: leafCert.toString('pem') + '\n',
    caKeyPair,
    caKeyPairPEM,
    caCert,
    caCertPEM: caCert.toString('pem') + '\n',
  };
}

// setInterval(() => console.log("Im still alive!"), 5000);

/* eslint-disable no-console */
const main = async () => {
  const logger = new Logger(`${QUICStream.name} Test`, LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  const key = await generateKeyHMAC();
  const serverCrypto = {
    sign: signHMAC,
    verify: verifyHMAC,
  };
  const clientCrypto = {
    randomBytes: (data) => webcrypto.getRandomValues(new Uint8Array(data)),
  };
  const tlsConfig = await generateTLSConfig();
  const server = new QUICServer({
    crypto: {
      key,
      ops: serverCrypto,
    },
    logger: logger.getChild(QUICServer.name),
    config: {
      key: tlsConfig.leafKeyPairPEM.privateKey,
      cert: tlsConfig.leafCertPEM,
      verifyPeer: false,
    },
  });
  let activeStream = undefined;
  let activeConn = undefined;
  // Lets keep all the handling in once place but track when it is done with promises
  server.addEventListener(events.EventQUICServerConnection.name, (e) =>{
    const conn = e.detail;
    conn.addEventListener(
          events.EventQUICConnectionStream.name,
          (streamEvent) => {
            const stream = streamEvent.detail;
            const streamProm = stream.readable.pipeTo(stream.writable);
            if (activeStream != null) throw Error('Active stream should be null')
            activeStream = streamProm;
          },
          { 'once': true },
      );
    if (activeConn != null) throw Error('Active stream should be null')
    activeConn = utils.promise();
    conn.addEventListener(
        events.EventQUICClientDestroyed.name,
        () => {
          activeConn.resolveP()
        },
        { once: true},
    );
    }
  );
  await server.start({ host: '127.0.0.1' });

  const data = Buffer.alloc(1, 0xf0);

  for (let i = 0; i < 100000; i++) {
    // if (i % 500 == 0) console.error('loop', i);
    console.error('loop', i);

    const client = await QUICClient.createQUICClient({
      host: '127.0.0.1',
      port: server.port,
      localHost: '127.0.0.1',
      crypto: {
        ops: clientCrypto,
      },
      logger: logger.getChild(QUICClient.name),
      config: {
        verifyPeer: false,
      },
    });
    const stream = client.connection.newStream();
    const writer = stream.writable.getWriter();
    await writer.write(data);
    await writer.close();
    for await (const _ of stream.readable) {
      // do nothing
    }
    await activeStream;
    await client.destroy({ force: true });
    await activeConn;
    activeConn = undefined;
    activeStream = undefined;
  }

  await server.stop({ force: true });
  console.error('Test passed!');
};

void main();
