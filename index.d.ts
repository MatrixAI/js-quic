/* tslint:disable */
/* eslint-disable */

/* auto-generated by NAPI-RS */

export class ExternalObject<T> {
  readonly '': {
    readonly '': unique symbol
    [K: symbol]: T
  }
}
export const MAX_DATAGRAM_SIZE: number
export interface Host {
  ip: string
  port: number
}
export interface SendInfo {
  /** The local address the packet should be sent from. */
  from: Host
  /** The remote address the packet should be sent to. */
  to: Host
  /** The time to send the packet out for pacing. */
  at: ExternalObject<Instant>
}
export interface ConnectionSendReturn {
  length: number
  info?: SendInfo
}
export class Config {
  constructor()
  verifyPeer(verify: boolean): void
  setMaxIdleTimeout(timeout: number): void
}
export class Connection {
  /**
   * Constructs QUIC Connection
   *
   * This can take both IP addresses and hostnames
   */
  constructor(config: Config, localHost: string, localPort: number, remoteHost: string, remotePort: number)
  send(data: Buffer): unknown[]
}
