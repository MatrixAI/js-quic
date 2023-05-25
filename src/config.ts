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

  /**
   * Enables the logging of secret keys to a file path.
   * Use this with wireshark to decrypt the QUIC packets for debugging.
   * This defaults to undefined.
   */
  logKeys?: string;

  /**
   * Enable "Generate Random extensions and Sustain Extensibilty".
   * This prevents protocol ossification by periodically introducing
   * random no-op values in the optional fields in TLS.
   * This defaults to true.
   */
  grease: boolean;

  /**
   * Maximum number of milliseconds to wait for an idle connection.
   * If this time is exhausted with no answer from the peer, then
   * the connection will timeout. This applies to any open connection.
   * Note that the QUIC client will repeatedly send initial packets to
   * a non-responding QUIC server up to this time.
   * This is defaulted to infinite.
   */
  maxIdleTimeout: number;

  /**
   * Maximum incoming UDP payload size.
   * The maximum IPv4 UDP payload size is 65507.
   * The maximum IPv6 UDP payload size is 65527.
   * This is defaulted to 65527.
   */
  maxRecvUdpPayloadSize: number;

  /**
   * Maximum outgoing UDP payload size.
   *
   * It is advantageous to set this size to be lower than the maximum
   * transmission unit size, which is commonly set to 1500.
   * This is defaulted 1200. It is also the minimum.
   */
  maxSendUdpPayloadSize: number;

  /**
   * Maximum buffer size of incoming stream data for an entire connection.
   * If set to 0, then no incoming stream data is allowed, therefore setting
   * to 0 effectively disables incoming stream data.
   * This defaults to 10 MiB.
   */
  initialMaxData: number;

  /**
   * Maximum buffer size of incoming stream data for a locally initiated
   * bidirectional stream. This is the buffer size for a single stream.
   * If set to 0, this disables incoming stream data for locally initiated
   * bidirectional streams.
   * This defaults to 1 MiB.
   */
  initialMaxStreamDataBidiLocal: number;

  /**
   * Maximum buffer size of incoming stream data for a remotely initiated
   * bidirectional stream. This is the buffer size for a single stream.
   * If set to 0, this disables incoming stream data for remotely initiated
   * bidirectional streams.
   * This defaults to 1 MiB.
   */
  initialMaxStreamDataBidiRemote: number;

  /**
   * Maximum buffer size of incoming stream data for a remotely initiated
   * unidirectional stream. This is the buffer size for a single stream.
   * If set to 0, this disables incoming stream data for remotely initiated
   * unidirectional streams.
   * This defaults to 1 MiB.
   */
  initialMaxStreamDataUni: number;

  /**
   * Maximum number of remotely initiated bidirectional streams.
   * A bidirectional stream is closed once all incoming data is read up to the
   * fin offset or when the stream's read direction is shutdown and all
   * outgoing data is acked by the peer up to the fin offset or when the
   * stream's write direction is shutdown.
   * This defaults to 100.
   */
  initialMaxStreamsBidi: number;

  /**
   * Maximum number of remotely initiated unidirectional streams.
   * A unidirectional stream is closed once all incoming data is read up to the
   * fin offset or when the stream's read direction is shutdown.
   * This defaults to 100.
   */
  initialMaxStreamsUni: number;

  /**
   * Enables receiving dgram.
   * This defaults to true.
   */
  enableDgram: boolean;

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
  maxIdleTimeout: 0,
  maxRecvUdpPayloadSize: quiche.MAX_DATAGRAM_SIZE,
  maxSendUdpPayloadSize: quiche.MIN_CLIENT_INITIAL_LEN,
  initialMaxData: 10 * 1024 * 1024,
  initialMaxStreamDataBidiLocal: 1 * 1024 * 1024,
  initialMaxStreamDataBidiRemote: 1 * 1024 * 1024,
  initialMaxStreamDataUni: 1 * 1024 * 1024,
  initialMaxStreamsBidi: 100,
  initialMaxStreamsUni: 100,
  enableDgram: true,
  disableActiveMigration: true,
  // Test if this is needed
  applicationProtos: ['http/0.9'],
  enableEarlyData: true,
};

const serverDefault: QUICConfig = {
  sigalgs,
  verifyPeer: false,
  grease: true,
  maxIdleTimeout: 0,
  maxRecvUdpPayloadSize: quiche.MAX_DATAGRAM_SIZE,
  maxSendUdpPayloadSize: quiche.MIN_CLIENT_INITIAL_LEN,
  initialMaxData: 10 * 1024 * 1024,
  initialMaxStreamDataBidiLocal: 1 * 1024 * 1024,
  initialMaxStreamDataBidiRemote: 1 * 1024 * 1024,
  initialMaxStreamDataUni: 1 * 1024 * 1024,
  initialMaxStreamsBidi: 100,
  initialMaxStreamsUni: 100,
  enableDgram: true,
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
