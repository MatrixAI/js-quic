import type { QUICConfig } from './types';
import type { Config as QuicheConfig } from './native/types';
import { quiche } from './native';
import * as errors from './errors';

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

/**
 * Usually we would create separate timeouts for connecting vs idling.
 * Unfortunately quiche only has 1 config option that controls both.
 * And it is not possible to mutate this option after connecting.
 * Therefore, this option is just a way to set a shorter connecting timeout
 * compared to the idling timeout.
 * If this is the larger than the `maxIdleTimeout` (remember that `0` is `Infinity`) for `maxIdleTimeout`, then this has no effect.
 * This only has an effect if this is set to a number less than `maxIdleTimeout`.
 * Thus, it is the "minimum boundary" of the timeout during connecting.
 * While the `maxIdleTimeout` is still the "maximum boundary" during connecting.
 */
const minIdleTimeout = Infinity;

const clientDefault: QUICConfig = {
  sigalgs,
  verifyPeer: true,
  verifyAllowFail: false,
  grease: true,
  keepAliveIntervalTime: undefined,
  maxIdleTimeout: 0,
  maxRecvUdpPayloadSize: quiche.MAX_DATAGRAM_SIZE, // 65527
  maxSendUdpPayloadSize: quiche.MIN_CLIENT_INITIAL_LEN, // 1200,
  initialMaxData: 10 * 1024 * 1024,
  initialMaxStreamDataBidiLocal: 1 * 1024 * 1024,
  initialMaxStreamDataBidiRemote: 1 * 1024 * 1024,
  initialMaxStreamDataUni: 1 * 1024 * 1024,
  initialMaxStreamsBidi: 100,
  initialMaxStreamsUni: 100,
  enableDgram: [false, 0, 0],
  disableActiveMigration: true,
  applicationProtos: ['quic'],
  enableEarlyData: true,
};

const serverDefault: QUICConfig = {
  sigalgs,
  verifyPeer: false,
  verifyAllowFail: false,
  grease: true,
  keepAliveIntervalTime: undefined,
  maxIdleTimeout: 0,
  maxRecvUdpPayloadSize: quiche.MAX_DATAGRAM_SIZE, // 65527
  maxSendUdpPayloadSize: quiche.MIN_CLIENT_INITIAL_LEN, // 1200
  initialMaxData: 10 * 1024 * 1024,
  initialMaxStreamDataBidiLocal: 1 * 1024 * 1024,
  initialMaxStreamDataBidiRemote: 1 * 1024 * 1024,
  initialMaxStreamDataUni: 1 * 1024 * 1024,
  initialMaxStreamsBidi: 100,
  initialMaxStreamsUni: 100,
  enableDgram: [false, 0, 0],
  disableActiveMigration: true,
  applicationProtos: ['quic'],
  enableEarlyData: true,
};

const textDecoder = new TextDecoder('utf-8');
const textEncoder = new TextEncoder();

/**
 * Converts QUICConfig to QuicheConfig.
 * This does not use all the options of QUICConfig.
 * The QUICConfig is still necessary.
 */
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
      config.verifyAllowFail,
      caPEMBuffer,
      keyPEMBuffers,
      certChainPEMBuffers,
      config.sigalgs,
    );
  } catch (e) {
    throw new errors.ErrorQUICConfig(
      `Failed to build Quiche config with custom SSL context: ${e.message}`,
      { cause: e },
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
  quicheConfig.setInitialMaxStreamDataUni(config.initialMaxStreamDataUni);
  quicheConfig.setInitialMaxStreamsBidi(config.initialMaxStreamsBidi);
  quicheConfig.setInitialMaxStreamsUni(config.initialMaxStreamsUni);
  quicheConfig.enableDgram(...config.enableDgram);
  quicheConfig.setDisableActiveMigration(config.disableActiveMigration);
  quicheConfig.setApplicationProtos(config.applicationProtos);
  return quicheConfig;
}

export { minIdleTimeout, clientDefault, serverDefault, buildQuicheConfig };
