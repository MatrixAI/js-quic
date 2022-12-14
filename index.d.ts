export class ExternalObject<T> {
  readonly '': {
    readonly '': unique symbol
    [K: symbol]: T
  }
}
export const MAX_CONN_ID_LEN: number
export const MIN_CLIENT_INITIAL_LEN: number
export const PROTOCOL_VERSION: number
/**
 * This maximum datagram size to SEND to the UDP socket
 * It must be used with `config.set_max_recv_udp_payload_size` and such
 * But on the receiving side, we actually use the maximum which is 65535
 */
export const MAX_DATAGRAM_SIZE: number
/**
 * This is the maximum size of the packet to be received from the socket
 * This is what you use to receive packets on the UDP socket
 * And you send it to the connection as well
 */
export const MAX_UDP_PACKET_SIZE: number
/** Equivalent to quiche::CongestionControlAlgorithm */
export const enum CongestionControlAlgorithm {
  Reno = 0,
  CUBIC = 1,
  BBR = 2
}
export interface ConnectionError {
  isApp: boolean
  errorCode: number
  reason: Array<number>
}
export interface Stats {
  recv: number
  sent: number
  lost: number
  retrans: number
  sentBytes: number
  recvBytes: number
  lostBytes: number
  streamRetransBytes: number
  pathsCount: number
  peerMaxIdleTimeout: number
  peerMaxUdpPayloadSize: number
  peerInitialMaxData: number
  peerInitialMaxStreamDataBidiLocal: number
  peerInitialMaxStreamDataBidiRemote: number
  peerInitialMaxStreamDataUni: number
  peerInitialMaxStreamsBidi: number
  peerInitialMaxStreamsUni: number
  peerAckDelayExponent: number
  peerMaxAckDelay: number
  peerDisableActiveMigration: boolean
  peerActiveConnIdLimit: number
  peerMaxDatagramFrameSize?: number
}
/** Equivalent to quiche::Shutdown enum */
export const enum Shutdown {
  Read = 0,
  Write = 1
}
export interface HostPort {
  host: string
  port: number
}
export interface SendInfo {
  /** The local address the packet should be sent from. */
  from: HostPort
  /** The remote address the packet should be sent to. */
  to: HostPort
  /** The time to send the packet out for pacing. */
  at: ExternalObject<Instant>
}
export interface RecvInfo {
  /** The remote address the packet was received from. */
  from: HostPort
  /** The local address the packet was sent to. */
  to: HostPort
}
/**
 * Equivalent to quiche::PathStats
 *
 * This is missing the validation_state because it is in a private module
 * that I cannot access
 */
export interface PathStats {
  localHost: HostPort
  peerHost: HostPort
  active: boolean
  recv: number
  sent: number
  lost: number
  retrans: number
  rtt: number
  cwnd: number
  sentBytes: number
  recvBytes: number
  lostBytes: number
  streamRetransBytes: number
  pmtu: number
  deliveryRate: number
}
export const enum Type {
  Initial = 0,
  Retry = 1,
  Handshake = 2,
  ZeroRTT = 3,
  VersionNegotiation = 4,
  Short = 5
}
export function negotiateVersion(scid: Uint8Array, dcid: Uint8Array, data: Uint8Array): number
export function retry(scid: Uint8Array, dcid: Uint8Array, newScid: Uint8Array, token: Uint8Array, version: number, out: Uint8Array): number
export function versionIsSupported(version: number): boolean
export class Config {
  constructor()
  loadCertChainFromPemFile(file: string): void
  loadPrivKeyFromPemFile(file: string): void
  loadVerifyLocationsFromFile(file: string): void
  loadVerifyLocationsFromDirectory(dir: string): void
  verifyPeer(verify: boolean): void
  grease(grease: boolean): void
  logKeys(): void
  setTicketKey(key: Uint8Array): void
  enableEarlyData(): void
  setApplicationProtos(protosList: Array<string>): void
  setApplicationProtosWireFormat(protos: Uint8Array): void
  setMaxIdleTimeout(timeout: number): void
  setMaxRecvUdpPayloadSize(size: number): void
  setMaxSendUdpPayloadSize(size: number): void
  setInitialMaxData(v: number): void
  setInitialMaxStreamDataBidiLocal(v: number): void
  setInitialMaxStreamDataBidiRemote(v: number): void
  setInitialMaxStreamDataUni(v: number): void
  setInitialMaxStreamsBidi(v: number): void
  setInitialMaxStreamsUni(v: number): void
  setAckDelayExponent(v: number): void
  setMaxAckDelay(v: number): void
  setActiveConnectionIdLimit(v: number): void
  setDisableActiveMigration(v: boolean): void
  setCcAlgorithmName(name: string): void
  setCcAlgorithm(algo: CongestionControlAlgorithm): void
  enableHystart(v: boolean): void
  enablePacing(v: boolean): void
  enableDgram(enabled: boolean, recvQueueLen: number, sendQueueLen: number): void
  setMaxConnectionWindow(v: number): void
  setStatelessResetToken(v?: bigint | undefined | null): void
  setDisableDcidReuse(v: boolean): void
}
export class Connection {
  /**
   * Creates QUIC Client Connection
   *
   * This can take both IP addresses and hostnames
   */
  static connect(serverName: string | undefined | null, scid: Uint8Array, localHost: HostPort, remoteHost: HostPort, config: Config): Connection
  static accept(scid: Uint8Array, odcid: Uint8Array | undefined | null, localHost: HostPort, remoteHost: HostPort, config: Config): Connection
  setSession(session: Uint8Array): void
  recv(data: Uint8Array, recvInfo: RecvInfo): number
  /**
   * Sends a QUIC packet
   *
   * This writes to the data buffer passed in.
   * The buffer must be allocated to the size of MAX_DATAGRAM_SIZE.
   * This will return a JS array of `[length, send_info]`.
   * It is possible for the length to be 0.
   * You may then send a 0-lenght buffer.
   * If there is nothing to be sent a Done error will be thrown.
   */
  send(data: Uint8Array): [number, SendInfo]
  sendOnPath(data: Uint8Array, from?: HostPort | undefined | null, to?: HostPort | undefined | null): [number, SendInfo | null]
  sendQuantum(): number
  sendQuantumOnPath(localHost: HostPort, peerHost: HostPort): number
  streamRecv(streamId: number, data: Uint8Array): [number, boolean]
  streamSend(streamId: number, data: Uint8Array, fin: boolean): number
  streamPriority(streamId: number, urgency: number, incremental: boolean): void
  streamShutdown(streamId: number, direction: Shutdown, err: number): void
  streamCapacity(streamId: number): number
  streamReadable(streamId: number): boolean
  streamWritable(streamId: number, len: number): boolean
  streamFinished(streamId: number): boolean
  peerStreamsLeftBidi(): number
  peerStreamsLeftUni(): number
  readable(): StreamIter
  writable(): StreamIter
  maxSendUdpPayloadSize(): number
  dgramRecv(data: Uint8Array): number
  dgramRecvVec(): Uint8Array | null
  dgramRecvPeek(data: Uint8Array, len: number): number
  dgramRecvFrontLen(): number | null
  dgramRecvQueueLen(): number
  dgramRecvQueueByteSize(): number
  dgramSendQueueLen(): number
  dgramSendQueueByteSize(): number
  isDgramSendQueueFull(): boolean
  isDgramRecvQueueFull(): boolean
  dgramSend(data: Uint8Array): void
  dgramSendVec(data: Uint8Array): void
  dgramPurgeOutgoing(f: (arg0: Uint8Array) => boolean): void
  /**
   * Maximum dgram size
   *
   * Use this to determine the size of the dgrams being send and received
   * I'm not sure if this is also necessary for send and recv?
   */
  dgramMaxWritableLen(): number | null
  timeout(): number | null
  onTimeout(): void
  probePath(localHost: HostPort, peerHost: HostPort): number
  migrateSource(localHost: HostPort): number
  migrate(localHost: HostPort, peerHost: HostPort): number
  newSourceCid(scid: Uint8Array, resetToken: bigint, retireIfNeeded: boolean): number
  activeSourceCids(): number
  maxActiveSourceCids(): number
  sourceCidsLeft(): number
  retireDestinationCid(dcidSeq: number): void
  pathEventNext(): object
  retiredScidNext(): Uint8Array | null
  availableDcids(): number
  pathsIter(from: HostPort): HostIter
  close(app: boolean, err: number, reason: Uint8Array): void
  traceId(): string
  applicationProto(): Uint8Array
  serverName(): string | null
  peerCertChain(): Array<Uint8Array> | null
  session(): Uint8Array | null
  sourceId(): Uint8Array
  destinationId(): Uint8Array
  isEstablished(): boolean
  isResumed(): boolean
  isInEarlyData(): boolean
  isReadable(): boolean
  isPathValidated(from: HostPort, to: HostPort): boolean
  isDraining(): boolean
  isClosed(): boolean
  isTimedOut(): boolean
  peerError(): ConnectionError | null
  localError(): ConnectionError | null
  stats(): Stats
  /**
   * Path stats as an array
   *
   * Normally this would be an iterator.
   * However the iterator can only exist in the lifetime of the connection.
   * This collects the all the data, converts them to our PathStats
   * Then returns it all as 1 giant array.
   *
   * https://stackoverflow.com/q/74609430/582917
   * https://stackoverflow.com/q/50343130/582917
   */
  pathStats(): Array<PathStats>
}
export class StreamIter {
  [Symbol.iterator](): Iterator<number, void, void>
}
export class HostIter {
  [Symbol.iterator](): Iterator<HostPort, void, void>
}
export class PathStatsIter {
  [Symbol.iterator](): Iterator<PathStats, void, void>
}
export class Header {
  ty: Type
  version: number
  dcid: Uint8Array
  scid: Uint8Array
  token?: Uint8Array
  versions?: Array<number>
  static fromSlice(data: Uint8Array, dcidLen: number): Header
}
