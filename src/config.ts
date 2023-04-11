import type { Config as QuicheConfig } from './native/types';
import { quiche } from './native';

type QUICConfig = {
  certChainPem: string | null | undefined;
  privKeyPem: string | null | undefined;
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
  certChainPem: null,
  privKeyPem: null,
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
  applicationProtos: [
    'hq-interop',
    'hq-29',
    'hq-28',
    'hq-27',
    'http/0.9'
  ],
  enableEarlyData: true,
};

const serverDefault: QUICConfig = {
  certChainPem: null,
  privKeyPem: null,
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
  applicationProtos: [
    'hq-interop',
    'hq-29',
    'hq-28',
    'hq-27',
    'http/0.9'
  ],
  enableEarlyData: true,
};

function buildQuicheConfig(config: QUICConfig): QuicheConfig {
  const quicheConfig: QuicheConfig = quiche.Config.withBoringSslCtx(
    config.certChainPem != null ? Buffer.from(config.certChainPem) : null,
    config.privKeyPem != null ? Buffer.from(config.privKeyPem) : null,
  )
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
  quicheConfig.setInitialMaxStreamDataBidiLocal(config.initialMaxStreamDataBidiLocal);
  quicheConfig.setInitialMaxStreamDataBidiRemote(config.initialMaxStreamDataBidiRemote);
  quicheConfig.setInitialMaxStreamsBidi(config.initialMaxStreamsBidi);
  quicheConfig.setInitialMaxStreamsUni(config.initialMaxStreamsUni);
  quicheConfig.setDisableActiveMigration(config.disableActiveMigration);
  quicheConfig.setApplicationProtos(config.applicationProtos);
  return quicheConfig;
}

export {
  clientDefault,
  serverDefault,
  buildQuicheConfig,
};

export type {
  QUICConfig,
};
