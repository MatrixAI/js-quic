import type { Timer } from '@matrixai/timer';
import type QUICStream from './QUICStream';

type ContextCancellable = {
  signal: AbortSignal;
};

type ContextTimed = ContextCancellable & {
  timer: Timer;
};

/**
 * Opaque types are wrappers of existing types
 * that require smart constructors
 */
type Opaque<K, T> = T & { readonly [brand]: K };
declare const brand: unique symbol;

/**
 * Generic callback
 */
type Callback<P extends Array<any> = [], R = any, E extends Error = Error> = {
  (e: E, ...params: Partial<P>): R;
  (e?: null | undefined, ...params: P): R;
};

/**
 * Deconstructed promise
 */
type PromiseDeconstructed<T> = {
  p: Promise<T>;
  resolveP: (value: T | PromiseLike<T>) => void;
  rejectP: (reason?: any) => void;
};

type ConnectionId = Opaque<'ConnectionId', Buffer>;

type ConnectionIdString = Opaque<'ConnectionIdString', string>;

/**
 * Crypto utility object
 * Remember ever Node Buffer is an ArrayBuffer
 */
type Crypto = {
  sign(key: ArrayBuffer, data: ArrayBuffer): Promise<ArrayBuffer>;
  verify(
    key: ArrayBuffer,
    data: ArrayBuffer,
    sig: ArrayBuffer,
  ): Promise<boolean>;
  randomBytes(data: ArrayBuffer): Promise<void>;
};

type StreamId = Opaque<'StreamId', number>;

/**
 * Host is always an IP address
 */
type Host = Opaque<'Host', string>;

/**
 * Hostnames are resolved to IP addresses
 */
type Hostname = Opaque<'Hostname', string>;

/**
 * Ports are numbers from 0 to 65535
 */
type Port = Opaque<'Port', number>;

/**
 * Combination of `<HOST>:<PORT>`
 */
type Address = Opaque<'Address', string>;

type QUICStreamMap = Map<StreamId, QUICStream>;

type RemoteInfo = {
  host: Host;
  port: Port;
};

/**
 * Maps reason (most likely an exception) to a stream code.
 * Use `0` to indicate unknown/default reason.
 */
type StreamReasonToCode = (
  type: 'recv' | 'send',
  reason?: any,
) => number | PromiseLike<number>;

/**
 * Maps code to a reason. 0 usually indicates unknown/default reason.
 */
type StreamCodeToReason = (
  type: 'recv' | 'send',
  code: number,
) => any | PromiseLike<any>;

type ConnectionMetadata = {
  remoteCertificates: Array<string> | null;
  localHost: Host;
  localPort: Port;
  remoteHost: Host;
  remotePort: Port;
};

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
   * Allows verification to fail, used with verifyPeer to request certs but
   * preform manual verification on the application level.
   * Defaults to false
   */
  verifyAllowFail: boolean;

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
   * This controls the interval for keeping alive an idle connection.
   * This time will be used to send a ping frame to keep the connection alive.
   * This is only useful if the `maxIdleTimeout` is set to greater than 0.
   * This is defaulted to `undefined`.
   * This is not a quiche option.
   */
  keepAliveIntervalTime?: number;

  /**
   * Maximum number of milliseconds to wait for an idle connection.
   * If this time is exhausted with no answer from the peer, then
   * the connection will timeout. This applies to any open connection.
   * Note that the QUIC client will repeatedly send initial packets to
   * a non-responding QUIC server up to this time.
   * This is defaulted to `0` meaning infinite time.
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
   * The 2 numbers are receive queue length and send queue length.
   * This defaults to `[false, 0, 0]`.
   */
  enableDgram: [boolean, number, number];

  disableActiveMigration: boolean;

  /**
   * Application protocols is necessary for ALPN.
   * This is must be non-empty, otherwise there will be a
   * `NO_APPLICATION_PROTOCOL` error.
   * Choose from: https://www.iana.org/assignments/tls-extensiontype-values/tls-extensiontype-values.xhtml#alpn-protocol-ids
   * For HTTP3, use `['h3', 'h3-29', 'h3-28', 'h3-27']`.
   * Both the client and server must share the ALPN in order to establish a
   * connection.
   * This defaults to `['quic']` as a placeholder ALPN.
   */
  applicationProtos: string[];

  enableEarlyData: boolean;
};

export type {
  Opaque,
  Callback,
  PromiseDeconstructed,
  ConnectionId,
  ConnectionIdString,
  Crypto,
  StreamId,
  Host,
  Hostname,
  Port,
  Address,
  QUICStreamMap,
  RemoteInfo,
  StreamReasonToCode,
  StreamCodeToReason,
  ConnectionMetadata,
  QUICConfig,
  ContextCancellable,
  ContextTimed,
};
