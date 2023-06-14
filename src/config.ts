import type { Config as QuicheConfig } from './native/types';
import { quiche } from './native';

// All the algos chrome supports + ed25519
const supportedPrivateKeyAlgosDefault =
  'ed25519:RSA+SHA256:RSA+SHA384:RSA+SHA512:ECDSA+SHA256:ECDSA+SHA384:ECDSA+SHA512:RSA-PSS+SHA256:RSA-PSS+SHA384:RSA-PSS+SHA512';

export type TlsConfig =
  | {
      certChainPem: string | null;
      privKeyPem: string | null;
    }
  | {
      certChainFromPemFile: string | null;
      privKeyFromPemFile: string | null;
    };

type QUICConfig = {
  tlsConfig: TlsConfig | undefined;
  verifyPem: string | undefined;
  verifyFromPemFile: string | undefined;
  supportedPrivateKeyAlgos: string | undefined;
  verifyPeer: boolean;
  logKeys: string | undefined;
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

const clientDefault: QUICConfig = {
  tlsConfig: undefined,
  verifyPem: undefined,
  verifyFromPemFile: undefined,
  supportedPrivateKeyAlgos: supportedPrivateKeyAlgosDefault,
  logKeys: undefined,
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
  applicationProtos: ['http/0.9'],
  enableEarlyData: true,
};

const serverDefault: QUICConfig = {
  tlsConfig: undefined,
  verifyPem: undefined,
  verifyFromPemFile: undefined,
  supportedPrivateKeyAlgos: supportedPrivateKeyAlgosDefault,
  logKeys: undefined,
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
  applicationProtos: ['http/0.9'],
  enableEarlyData: true,
};

function buildQuicheConfig(config: QUICConfig): QuicheConfig {
  let certChainPem: Buffer | null = null;
  let privKeyPem: Buffer | null = null;
  if (config.tlsConfig != null && 'certChainPem' in config.tlsConfig) {
    if (config.tlsConfig.certChainPem != null) {
      certChainPem = Buffer.from(config.tlsConfig.certChainPem);
    }
    if (config.tlsConfig.privKeyPem != null) {
      privKeyPem = Buffer.from(config.tlsConfig.privKeyPem);
    }
  }
  const quicheConfig: QuicheConfig = quiche.Config.withBoringSslCtx(
    certChainPem,
    privKeyPem,
    config.supportedPrivateKeyAlgos ?? null,
    config.verifyPem != null ? Buffer.from(config.verifyPem) : null,
    config.verifyPeer,
    (...args): boolean => {
      console.log(args);
      return true;
    }
  );
  if (config.tlsConfig != null && 'certChainFromPemFile' in config.tlsConfig) {
    if (config.tlsConfig?.certChainFromPemFile != null) {
      quicheConfig.loadCertChainFromPemFile(
        config.tlsConfig.certChainFromPemFile,
      );
    }
    if (config.tlsConfig?.privKeyFromPemFile != null) {
      quicheConfig.loadPrivKeyFromPemFile(config.tlsConfig.privKeyFromPemFile);
    }
  }
  if (config.verifyFromPemFile != null) {
    quicheConfig.loadVerifyLocationsFromFile(config.verifyFromPemFile);
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
