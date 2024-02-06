import type { QUICConfig } from './types';
import type { Config as QuicheConfig } from './native/types';
import { quiche } from './native';
import * as utils from './utils';
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
 * Usually we would create separate timeouts for starting vs keep-alive.
 * Unfortunately quiche only has 1 config option that controls both.
 * And it is not possible to mutate this option after connecting.
 * Therefore, this option is just a way to set a shorter start timeout
 * compared to the idling timeout.
 * If this is the larger than the `maxIdleTimeout` (where `0` means `Infinity`),
 * then this has no effect. This only has an effect if this is set to a number
 * less than `maxIdleTimeout`. Thus, it is the "minimum boundary" of the
 * timeout when starting. While the `maxIdleTimeout` is still the "maximum
 * boundary" when starting.
 * Both `minIdleTimeout` and `maxIdleTimeout` defaults to `Infinity` (where `0`
 * means `Infinity` for `maxIdleTimeout`), thus by default connections will not
 * timeout when starting or during keep-alive.
 */
const minIdleTimeout = Infinity;

const clientDefault: QUICConfig = {
  sigalgs,
  verifyPeer: true,
  grease: true,
  keepAliveIntervalTime: undefined,
  maxIdleTimeout: 0,
  maxRecvUdpPayloadSize: quiche.MAX_DATAGRAM_SIZE, // Default is 65527, but set to 1350
  maxSendUdpPayloadSize: quiche.MAX_DATAGRAM_SIZE, // Default is 1200, but set to 1350
  initialMaxData: 10 * 1024 * 1024,
  initialMaxStreamDataBidiLocal: 1 * 1024 * 1024,
  initialMaxStreamDataBidiRemote: 1 * 1024 * 1024,
  initialMaxStreamDataUni: 1 * 1024 * 1024,
  initialMaxStreamsBidi: 100,
  initialMaxStreamsUni: 100,
  maxConnectionWindow: quiche.MAX_CONNECTION_WINDOW,
  maxStreamWindow: quiche.MAX_STREAM_WINDOW,
  enableDgram: [false, 0, 0],
  disableActiveMigration: true,
  applicationProtos: ['quic'],
  enableEarlyData: true,
  readableChunkSize: 4 * 1024,
};

const serverDefault: QUICConfig = {
  sigalgs,
  verifyPeer: false,
  grease: true,
  keepAliveIntervalTime: undefined,
  maxIdleTimeout: 0,
  maxRecvUdpPayloadSize: quiche.MAX_DATAGRAM_SIZE, // Default is 65527
  maxSendUdpPayloadSize: quiche.MAX_DATAGRAM_SIZE, // Default is 1200, but set to 1350
  initialMaxData: 10 * 1024 * 1024,
  initialMaxStreamDataBidiLocal: 1 * 1024 * 1024,
  initialMaxStreamDataBidiRemote: 1 * 1024 * 1024,
  initialMaxStreamDataUni: 1 * 1024 * 1024,
  initialMaxStreamsBidi: 100,
  initialMaxStreamsUni: 100,
  maxConnectionWindow: quiche.MAX_CONNECTION_WINDOW,
  maxStreamWindow: quiche.MAX_STREAM_WINDOW,
  enableDgram: [false, 0, 0],
  disableActiveMigration: true,
  applicationProtos: ['quic'],
  enableEarlyData: true,
  readableChunkSize: 4 * 1024,
};

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
    const caPEMBuffers = utils.collectPEMs(config.ca);
    caPEMBuffer = utils.textEncoder.encode(caPEMBuffers.join(''));
  }
  // This is an array of private keys in PEM format as buffers
  let keyPEMBuffers: Array<Uint8Array> | undefined;
  if (config.key != null) {
    const keyPEMs = utils.collectPEMs(config.key);
    keyPEMBuffers = keyPEMs.map((k) => utils.textEncoder.encode(k));
  }
  // This is an array of certificate chains in PEM format as buffers
  let certChainPEMBuffers: Array<Uint8Array> | undefined;
  if (config.cert != null) {
    const certPEMsChain = utils.collectPEMs(config.cert);
    certChainPEMBuffers = certPEMsChain.map((c) => utils.textEncoder.encode(c));
  }
  let quicheConfig: QuicheConfig;
  try {
    quicheConfig = quiche.Config.withBoringSslCtx(
      config.verifyPeer,
      config.verifyCallback != null,
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
