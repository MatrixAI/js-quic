import type { Opaque } from '../types';

type QuicheTimeInstant = Opaque<'QuicheTimeInstant', object>;

interface Config {
  loadCertChainFromPemFile(file: string): void;
  loadPrivKeyFromPemFile(file: string): void;
  loadVerifyLocationsFromFile(file: string): void;
  loadVerifyLocationsFromDirectory(dir: string): void;
  verifyPeer(verify: boolean): void;
  grease(grease: boolean): void;
  logKeys(): void;
  setTicketKey(key: Uint8Array): void;
  enableEarlyData(): void;
  setApplicationProtos(protosList: Array<string>): void;
  setApplicationProtosWireFormat(protos: Uint8Array): void;
  setMaxIdleTimeout(timeout: number): void;
  setMaxRecvUdpPayloadSize(size: number): void;
  setMaxSendUdpPayloadSize(size: number): void;
  setInitialMaxData(v: number): void;
  setInitialMaxStreamDataBidiLocal(v: number): void;
  setInitialMaxStreamDataBidiRemote(v: number): void;
  setInitialMaxStreamDataUni(v: number): void;
  setInitialMaxStreamsBidi(v: number): void;
  setInitialMaxStreamsUni(v: number): void;
  setAckDelayExponent(v: number): void;
  setMaxAckDelay(v: number): void;
  setActiveConnectionIdLimit(v: number): void;
  setDisableActiveMigration(v: boolean): void;
  setCcAlgorithmName(name: string): void;
  setCcAlgorithm(algo: CongestionControlAlgorithm): void;
  enableHystart(v: boolean): void;
  enablePacing(v: boolean): void;
  enableDgram(
    enabled: boolean,
    recvQueueLen: number,
    sendQueueLen: number,
  ): void;
  setMaxStreamWindow(v: number): void;
  setMaxConnectionWindow(v: number): void;
  setStatelessResetToken(v?: bigint | undefined | null): void;
  setDisableDcidReuse(v: boolean): void;
}

interface ConfigConstructor {
  new (): Config;
  withBoringSslCtx(
    verifyPeer: boolean,
    verifyAllowFail: boolean,
    ca?: Uint8Array | undefined | null,
    key?: Array<Uint8Array> | undefined | null,
    cert?: Array<Uint8Array> | undefined | null,
    sigalgs?: string | undefined | null,
  ): Config;
}

interface Connection {
  setKeylog(path: string): void;
  setSession(session: Uint8Array): void;
  recv(data: Uint8Array, recvInfo: RecvInfo): number;
  send(data: Uint8Array): [number, SendInfo] | null;
  sendOnPath(
    data: Uint8Array,
    from?: HostPort | undefined | null,
    to?: HostPort | undefined | null,
  ): [number, SendInfo] | null;
  sendQuantum(): number;
  sendQuantumOnPath(localHost: HostPort, peerHost: HostPort): number;
  streamRecv(streamId: number, data: Uint8Array): [number, boolean] | null;
  streamSend(streamId: number, data: Uint8Array, fin: boolean): number | null;
  streamPriority(streamId: number, urgency: number, incremental: boolean): void;
  streamShutdown(streamId: number, direction: Shutdown, err: number): void | null;
  streamCapacity(streamId: number): number;
  streamReadable(streamId: number): boolean;
  streamWritable(streamId: number, len: number): boolean;
  streamFinished(streamId: number): boolean;
  peerStreamsLeftBidi(): number;
  peerStreamsLeftUni(): number;
  readable(): StreamIter;
  writable(): StreamIter;
  maxSendUdpPayloadSize(): number;
  dgramRecv(data: Uint8Array): number | null;
  dgramRecvVec(): Uint8Array | null;
  dgramRecvPeek(data: Uint8Array, len: number): number | null;
  dgramRecvFrontLen(): number | null;
  dgramRecvQueueLen(): number;
  dgramRecvQueueByteSize(): number;
  dgramSendQueueLen(): number;
  dgramSendQueueByteSize(): number;
  isDgramSendQueueFull(): boolean;
  isDgramRecvQueueFull(): boolean;
  dgramSend(data: Uint8Array): void | null;
  dgramSendVec(data: Uint8Array): void | null;
  dgramPurgeOutgoing(f: (arg0: Uint8Array) => boolean): void;
  dgramMaxWritableLen(): number | null;
  timeout(): number | null;
  onTimeout(): void;
  probePath(localHost: HostPort, peerHost: HostPort): number;
  migrateSource(localHost: HostPort): number;
  migrate(localHost: HostPort, peerHost: HostPort): number;
  newSourceCid(
    scid: Uint8Array,
    resetToken: bigint,
    retireIfNeeded: boolean,
  ): number;
  activeSourceCids(): number;
  maxActiveSourceCids(): number;
  sourceCidsLeft(): number;
  retireDestinationCid(dcidSeq: number): void;
  pathEventNext(): PathEvent;
  retiredScidNext(): Uint8Array | null;
  availableDcids(): number;
  pathsIter(from: HostPort): HostIter;
  close(app: boolean, err: number, reason: Uint8Array): void | null;
  traceId(): string;
  applicationProto(): Uint8Array;
  serverName(): string | null;
  peerCertChain(): Array<Uint8Array> | null;
  session(): Uint8Array | null;
  sourceId(): Uint8Array;
  destinationId(): Uint8Array;
  isEstablished(): boolean;
  isResumed(): boolean;
  isInEarlyData(): boolean;
  isReadable(): boolean;
  isPathValidated(from: HostPort, to: HostPort): boolean;
  isDraining(): boolean;
  isClosed(): boolean;
  isTimedOut(): boolean;
  peerError(): ConnectionError | null;
  localError(): ConnectionError | null;
  stats(): Stats;
  pathStats(): Array<PathStats>;
  sendAckEliciting(): void;
}

interface ConnectionConstructor {
  connect(
    serverName: string | undefined | null,
    scid: Uint8Array,
    localHost: HostPort,
    remoteHost: HostPort,
    config: Config,
  ): Connection;
  accept(
    scid: Uint8Array,
    odcid: Uint8Array | undefined | null,
    localHost: HostPort,
    remoteHost: HostPort,
    config: Config,
  ): Connection;
}

interface Header {
  ty: Type;
  version: number;
  dcid: Uint8Array;
  scid: Uint8Array;
  token?: Uint8Array;
  versions?: Array<number>;
}

interface HeaderConstructor {
  fromSlice(data: Uint8Array, dcidLen: number): Header;
}

enum CongestionControlAlgorithm {
  Reno = 0,
  CUBIC = 1,
  BBR = 2,
}

enum Shutdown {
  Read = 0,
  Write = 1,
}

enum Type {
  Initial = 0,
  Retry = 1,
  Handshake = 2,
  ZeroRTT = 3,
  VersionNegotiation = 4,
  Short = 5,
}

enum ConnectionErrorCode {
  NoError = 0,
  InternalError = 1,
  ConnectionRefused = 2,
  FlowControlError = 3,
  StreamLimitError = 4,
  StreamStateError = 5,
  FinalSizeError = 6,
  FrameEncodingError = 7,
  TransportParameterError = 8,
  ConnectionIdLimitError = 9,
  ProtocolViolation = 10,
  InvalidToken = 11,
  ApplicationError = 12,
  CryptoBufferExceeded = 13,
  KeyUpdateError = 14,
  AEADLimitReached = 15,
  NoViablePath = 16,
}

type ConnectionError = {
  isApp: boolean;
  errorCode: number;
  reason: Uint8Array;
};

type Stats = {
  recv: number;
  sent: number;
  lost: number;
  retrans: number;
  sentBytes: number;
  recvBytes: number;
  lostBytes: number;
  streamRetransBytes: number;
  pathsCount: number;
  peerMaxIdleTimeout: number;
  peerMaxUdpPayloadSize: number;
  peerInitialMaxData: number;
  peerInitialMaxStreamDataBidiLocal: number;
  peerInitialMaxStreamDataBidiRemote: number;
  peerInitialMaxStreamDataUni: number;
  peerInitialMaxStreamsBidi: number;
  peerInitialMaxStreamsUni: number;
  peerAckDelayExponent: number;
  peerMaxAckDelay: number;
  peerDisableActiveMigration: boolean;
  peerActiveConnIdLimit: number;
  peerMaxDatagramFrameSize?: number;
};

type HostPort = {
  host: string;
  port: number;
};

type SendInfo = {
  /** The local address the packet should be sent from. */
  from: HostPort;
  /** The remote address the packet should be sent to. */
  to: HostPort;
  /** The time to send the packet out for pacing. */
  at: QuicheTimeInstant;
};

type RecvInfo = {
  /** The remote address the packet was received from. */
  from: HostPort;
  /** The local address the packet was sent to. */
  to: HostPort;
};

type PathStats = {
  localHost: HostPort;
  peerHost: HostPort;
  active: boolean;
  recv: number;
  sent: number;
  lost: number;
  retrans: number;
  rtt: number;
  cwnd: number;
  sentBytes: number;
  recvBytes: number;
  lostBytes: number;
  streamRetransBytes: number;
  pmtu: number;
  deliveryRate: number;
};

type PathEvent =
  | {
      type: 'New';
      local: HostPort;
      peer: HostPort;
    }
  | {
      type: 'Validated';
      local: HostPort;
      peer: HostPort;
    }
  | {
      type: 'Closed';
      local: HostPort;
      peer: HostPort;
    }
  | {
      type: 'ReusedSourceConnectionId';
      seq: number;
      old: [HostPort, HostPort];
      new: [HostPort, HostPort];
    }
  | {
      type: 'PeerMigrated';
      old: HostPort;
      new: HostPort;
    };

type StreamIter = {
  [Symbol.iterator](): Iterator<number, void, void>;
};

type HostIter = {
  [Symbol.iterator](): Iterator<HostPort, void, void>;
};

type PathStatsIter = {
  [Symbol.iterator](): Iterator<PathStats, void, void>;
};

export { CongestionControlAlgorithm, Shutdown, Type, ConnectionErrorCode };

export type {
  QuicheTimeInstant,
  ConnectionError,
  Stats,
  HostPort as Host,
  SendInfo,
  RecvInfo,
  PathStats,
  StreamIter,
  HostIter,
  PathStatsIter,
  PathEvent,
  Config,
  ConfigConstructor,
  Connection,
  ConnectionConstructor,
  Header,
  HeaderConstructor,
};
