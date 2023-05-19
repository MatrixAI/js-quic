import type { Config as QuicheConfig } from './native/types';
import { quiche } from './native';
import * as errors from './errors';

type QUICConfig = {
  /**
   * Certificate authority certificate in PEM format or Uint8Array buffer
   * containing PEM formatted certificate. Each string or Uint8Array can be
   * one certificate or multiple certificates concatenated together. The order
   * does not matter, each is an independent certificate authority. Multiple
   * concatenated certificate authorities can be passed. They are all
   * concatenated together.
   *
   * When this is not set, this defaults to the operating system's CA
   * certificates. OpenSSL (and forks of OpenSSL) all support the
   * environment variables `SSL_CERT_DIR` and `SSL_CERT_FILE`.
   */
  ca?: string | Array<string> | Uint8Array | Array<Uint8Array>;

  /**
   * Private key as a PEM string or Uint8Array buffer containing PEM formatted
   * key. You can pass multiple keys. The number of keys must match the number
   * of certs. Each key must be associated to the the corresponding cert chain.
   *
   * Currently multiple key and certificate chains is not supported.
   */
  key?: string | Array<string> | Uint8Array | Array<Uint8Array>;

  /**
   * X.509 certificate chain in PEM format or Uint8Array buffer containing
   * PEM formatted certificate chain. Each string or Uint8Array is a
   * certificate chain in subject to issuer order. Multiple certificate chains
   * can be passed. The number of certificate chains must match the number of
   * keys. Each certificate chain must be associated to the corresponding key.
   *
   * Currently multiple key and certificate chains is not supported.
   */
  cert?: string | Array<string> | Uint8Array | Array<Uint8Array>;

  /**
   * Colon separated list of supported signature algorithms.
   *
   * When this is not set, this defaults to the following list:
   * - rsa_pkcs1_sha256
   * - rsa_pkcs1_sha384
   * - rsa_pkcs1_sha512
   * - rsa_pss_rsae_sha256
   * - rsa_pss_rsae_sha384
   * - rsa_pss_rsae_sha512
   * - ecdsa_secp256r1_sha256
   * - ecdsa_secp384r1_sha384
   * - ecdsa_secp521r1_sha512
   * - ed25519
   */
  sigalgs?: string;

  /**
   * Verify the other peer.
   * Clients by default set this to true.
   * Servers by default set this to false.
   */
  verifyPeer: boolean;

  logKeys?: string;
  grease: boolean;
  maxIdleTimeout: number;
  maxRecvUdpPayloadSize: number;
  maxSendUdpPayloadSize: number;
  initialMaxData: number;
  initialMaxStreamDataBidiLocal: number;
  initialMaxStreamDataBidiRemote: number;
  initialMaxStreamsBidi: number;
  initialMaxStreamsUni: number;
  disableActiveMigration: boolean;
  applicationProtos: string[];
  enableEarlyData: boolean;
};

/**
 * BoringSSL does not support:
 * - rsa_pss_pss_sha256
 * - rsa_pss_pss_sha384
 * - rsa_pss_pss_sha512
 * - ed448
 */
const sigalgs = [
  'rsa_pkcs1_sha256',
  'rsa_pkcs1_sha384',
  'rsa_pkcs1_sha512',
  'rsa_pss_rsae_sha256',
  'rsa_pss_rsae_sha384',
  'rsa_pss_rsae_sha512',
  'ecdsa_secp256r1_sha256',
  'ecdsa_secp384r1_sha384',
  'ecdsa_secp521r1_sha512',
  'ed25519',
].join(':');

const clientDefault: QUICConfig = {
  sigalgs,
  verifyPeer: true,
  grease: true,
  maxIdleTimeout: 5000,
  maxRecvUdpPayloadSize: quiche.MAX_DATAGRAM_SIZE,
  maxSendUdpPayloadSize: quiche.MAX_DATAGRAM_SIZE,
  initialMaxData: 10000000,
  initialMaxStreamDataBidiLocal: 1000000,
  initialMaxStreamDataBidiRemote: 1000000,
  initialMaxStreamsBidi: 100,
  initialMaxStreamsUni: 100,
  disableActiveMigration: true,
  // Test if this is needed
  applicationProtos: ['http/0.9'],
  enableEarlyData: true,
};

const serverDefault: QUICConfig = {
  sigalgs,
  verifyPeer: false,
  grease: true,
  maxIdleTimeout: 5000,
  maxRecvUdpPayloadSize: quiche.MAX_DATAGRAM_SIZE,
  maxSendUdpPayloadSize: quiche.MAX_DATAGRAM_SIZE,
  initialMaxData: 10000000,
  initialMaxStreamDataBidiLocal: 1000000,
  initialMaxStreamDataBidiRemote: 1000000,
  initialMaxStreamsBidi: 100,
  initialMaxStreamsUni: 100,
  disableActiveMigration: true,
  // Test if this is needed
  applicationProtos: ['http/0.9'],
  enableEarlyData: true,
};

const textDecoder = new TextDecoder('utf-8');
const textEncoder = new TextEncoder();

function buildQuicheConfig(config: QUICConfig): QuicheConfig {
  if (config.key != null && config.cert == null) {
    throw new errors.ErrorQUICConfig(
      'The cert option must be set when key is set',
    );
  } else if (config.key == null && config.cert != null) {
    throw new errors.ErrorQUICConfig(
      'The key option must be set when cert is set',
    );
  } else if (config.key != null && config.cert != null) {
    if (Array.isArray(config.key) && Array.isArray(config.cert)) {
      if (config.key.length !== config.cert.length) {
        throw new errors.ErrorQUICConfig(
          'The number of keys must match the number of certs',
        );
      }
    }
  }
  // This is a concatenated CA certificates in PEM format
  let caPEMBuffer: Uint8Array | undefined;
  if (config.ca != null) {
    let caPEMString = '';
    if (typeof config.ca === 'string') {
      caPEMString = config.ca.trim() + '\n';
    } else if (config.ca instanceof Uint8Array) {
      caPEMString = textDecoder.decode(config.ca).trim() + '\n';
    } else if (Array.isArray(config.ca)) {
      for (const c of config.ca) {
        if (typeof c === 'string') {
          caPEMString += c.trim() + '\n';
        } else {
          caPEMString += textDecoder.decode(c).trim() + '\n';
        }
      }
    }
    caPEMBuffer = textEncoder.encode(caPEMString);
  }
  // This is an array of private keys in PEM format
  let keyPEMBuffers: Array<Uint8Array> | undefined;
  if (config.key != null) {
    const keyPEMs: Array<string> = [];
    if (typeof config.key === 'string') {
      keyPEMs.push(config.key.trim() + '\n');
    } else if (config.key instanceof Uint8Array) {
      keyPEMs.push(textDecoder.decode(config.key).trim() + '\n');
    } else if (Array.isArray(config.key)) {
      for (const k of config.key) {
        if (typeof k === 'string') {
          keyPEMs.push(k.trim() + '\n');
        } else {
          keyPEMs.push(textDecoder.decode(k).trim() + '\n');
        }
      }
    }
    keyPEMBuffers = keyPEMs.map((k) => textEncoder.encode(k));
  }
  // This is an array of certificate chains in PEM format
  let certChainPEMBuffers: Array<Uint8Array> | undefined;
  if (config.cert != null) {
    const certChainPEMs: Array<string> = [];
    if (typeof config.cert === 'string') {
      certChainPEMs.push(config.cert.trim() + '\n');
    } else if (config.cert instanceof Uint8Array) {
      certChainPEMs.push(textDecoder.decode(config.cert).trim() + '\n');
    } else if (Array.isArray(config.cert)) {
      for (const c of config.cert) {
        if (typeof c === 'string') {
          certChainPEMs.push(c.trim() + '\n');
        } else {
          certChainPEMs.push(textDecoder.decode(c).trim() + '\n');
        }
      }
    }
    certChainPEMBuffers = certChainPEMs.map((c) => textEncoder.encode(c));
  }
  let quicheConfig: QuicheConfig;
  try {
    quicheConfig = quiche.Config.withBoringSslCtx(
      config.verifyPeer,
      caPEMBuffer,
      keyPEMBuffers,
      certChainPEMBuffers,
      config.sigalgs,
    );
  } catch (e) {
    throw new errors.ErrorQUICConfig(
      `Failed to build Quiche config with custom SSL context: ${e.message}`,
      { cause: e }
    );
  }
  if (config.logKeys != null) {
    quicheConfig.logKeys();
  }
  if (config.enableEarlyData) {
    quicheConfig.enableEarlyData();
  }
  quicheConfig.grease(config.grease);
  quicheConfig.setMaxIdleTimeout(config.maxIdleTimeout);
  quicheConfig.setMaxRecvUdpPayloadSize(config.maxRecvUdpPayloadSize);
  quicheConfig.setMaxSendUdpPayloadSize(config.maxSendUdpPayloadSize);
  quicheConfig.setInitialMaxData(config.initialMaxData);
  quicheConfig.setInitialMaxStreamDataBidiLocal(
    config.initialMaxStreamDataBidiLocal,
  );
  quicheConfig.setInitialMaxStreamDataBidiRemote(
    config.initialMaxStreamDataBidiRemote,
  );
  quicheConfig.setInitialMaxStreamsBidi(config.initialMaxStreamsBidi);
  quicheConfig.setInitialMaxStreamsUni(config.initialMaxStreamsUni);
  quicheConfig.setDisableActiveMigration(config.disableActiveMigration);
  quicheConfig.setApplicationProtos(config.applicationProtos);
  return quicheConfig;
}

export { clientDefault, serverDefault, buildQuicheConfig };

export type { QUICConfig };
