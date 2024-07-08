import type QUICStream from './QUICStream';
import type { CryptoError } from './native';

/**
 * Opaque types are wrappers of existing types
 * that require smart constructors
 */
type Opaque<K, T> = T & { readonly [brand]: K };
declare const brand: unique symbol;

type Class<T> = new (...args: any[]) => T;

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

type RemoteInfo = {
  host: Host;
  port: Port;
};

/**
 * Client crypto utility object
 * Remember every Node Buffer is an ArrayBuffer
 */
type ClientCryptoOps = {
  randomBytes(data: ArrayBuffer): Promise<void>;
};

/**
 * Server crypto utility object
 * Remember every Node Buffer is an ArrayBuffer
 */
type ServerCryptoOps = {
  sign(key: ArrayBuffer, data: ArrayBuffer): Promise<ArrayBuffer>;
  verify(
    key: ArrayBuffer,
    data: ArrayBuffer,
    sig: ArrayBuffer,
  ): Promise<boolean>;
};

type QUICClientCrypto = {
  ops: ClientCryptoOps;
};

type QUICServerCrypto = {
  key: ArrayBuffer;
  ops: ServerCryptoOps;
};

/**
 * Custom hostname resolution. It is expected this returns an IP address.
 */
type ResolveHostname = (hostname: string) => string | PromiseLike<string>;

/**
 * Custom TLS verification callback.
 * The peer cert chain will be passed as the first parameter.
 * The CA certs will also be available as a second parameter.
 * The certs are in DER binary format.
 * It will be an empty array if there were no CA certs.
 * If it fails, return a `CryptoError` code.
 */
type TLSVerifyCallback = (
  certs: Array<Uint8Array>,
  ca: Array<Uint8Array>,
) => PromiseLike<CryptoError | undefined>;

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
   * Servers will not request peer certs unless this is true.
   * Server certs are always sent
   */
  verifyPeer: boolean;

  /**
   * Optional explicit server name, defaults to host
   */
  serverName?: string;

  /**
   * Custom TLS verification callback.
   * It is expected that the callback will throw an error if the verification
   * fails.
   * Will be ignored if `verifyPeer` is false.
   */
  verifyCallback?: TLSVerifyCallback;

  /**
   * Enables the logging of secret keys to a file path.
   * Use this with wireshark to decrypt the QUIC packets for debugging.
   * This defaults to undefined.
   */
  logKeys?: string;

  /**
   * Enable "Generate Random extensions and Sustain Extensibility".
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
   * This defaults to 24 MiB.
   */
  maxConnectionWindow: number;

  /**
   * This defaults to 16 MiB.
   */
  maxStreamWindow: number;

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

  /**
   * Defines the size of the Buffer used to read out data from the readable stream.
   * This affects amount of memory reserved by the stream.
   */
  readableChunkSize: number;
};

type QUICClientConfigInput = Partial<QUICConfig>;

type QUICServerConfigInput = Partial<QUICConfig> & {
  serverName?: string;
  key: string | Array<string> | Uint8Array | Array<Uint8Array>;
  cert: string | Array<string> | Uint8Array | Array<Uint8Array>;
};

type ConnectionId = Opaque<'ConnectionId', Buffer>;

type ConnectionIdString = Opaque<'ConnectionIdString', string>;

type ConnectionMetadata = {
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  localCertsChain: Array<Uint8Array>;
  localCACertsChain: Array<Uint8Array>;
  remoteCertsChain: Array<Uint8Array>;
};

type StreamId = Opaque<'StreamId', number>;

/**
 * Maps reason (most likely an exception) to a stream code.
 * Use `0` to indicate unknown/default reason.
 */
type StreamReasonToCode = (type: 'read' | 'write', reason?: any) => number;

/**
 * Maps code to a reason. 0 usually indicates unknown/default reason.
 */
type StreamCodeToReason = (type: 'read' | 'write', code: number) => any;

type QUICStreamMap = Map<StreamId, QUICStream>;

export type {
  Opaque,
  Class,
  Callback,
  PromiseDeconstructed,
  Host,
  Hostname,
  Port,
  Address,
  RemoteInfo,
  ClientCryptoOps,
  ServerCryptoOps,
  QUICClientCrypto,
  QUICServerCrypto,
  ResolveHostname,
  TLSVerifyCallback,
  QUICConfig,
  QUICClientConfigInput,
  QUICServerConfigInput,
  ConnectionId,
  ConnectionIdString,
  ConnectionMetadata,
  StreamId,
  StreamReasonToCode,
  StreamCodeToReason,
  QUICStreamMap,
};
