/**
 * JS binding to NAPI quiche dynamic library.
 * This code was derived from the auto-generated binding and declaration
 * files provided by napi-rs.
 */
import type {
  ConnectionErrorCode,
  CongestionControlAlgorithm,
  Shutdown,
  Type,
  ConfigConstructor,
  ConnectionConstructor,
  HeaderConstructor,
} from './types';
import process from 'process';
import fs from 'fs';
import path from 'path';

interface Quiche {
  MAX_CONN_ID_LEN: number;
  MIN_CLIENT_INITIAL_LEN: number;
  PROTOCOL_VERSION: number;
  MAX_DATAGRAM_SIZE: number;
  MAX_UDP_PACKET_SIZE: number;
  CongestionControlAlgorithm: typeof CongestionControlAlgorithm;
  Shutdown: typeof Shutdown;
  Type: typeof Type;
  ConnectionErrorCode: typeof ConnectionErrorCode;
  negotiateVersion(
    scid: Uint8Array,
    dcid: Uint8Array,
    data: Uint8Array,
  ): number;
  retry(
    scid: Uint8Array,
    dcid: Uint8Array,
    newScid: Uint8Array,
    token: Uint8Array,
    version: number,
    out: Uint8Array,
  ): number;
  versionIsSupported(version: number): boolean;
  Config: ConfigConstructor;
  Connection: ConnectionConstructor;
  Header: HeaderConstructor;
}

const projectRoot = path.join(__dirname, '../../');

let nativeBinding: Quiche;

/**
 * For desktop we only support win32, darwin and linux.
 * Mobile OS support is pending.
 */
switch (process.platform) {
  case 'win32':
    switch (process.arch) {
      case 'x64':
        nativeBinding = requireBinding('win32-x64-msvc');
        break;
      case 'ia32':
        nativeBinding = requireBinding('win32-ia32-msvc');
        break;
      case 'arm64':
        nativeBinding = requireBinding('win32-arm64-msvc');
        break;
      default:
        throw new Error(`Unsupported architecture on Windows: ${process.arch}`);
    }
    break;
  case 'darwin':
    switch (process.arch) {
      case 'x64':
        nativeBinding = requireBinding('darwin-x64');
        break;
      case 'arm64':
        nativeBinding = requireBinding('darwin-arm64');
        break;
      default:
        throw new Error(`Unsupported architecture on macOS: ${process.arch}`);
    }
    break;
  case 'linux':
    switch (process.arch) {
      case 'x64':
        if (isMusl()) {
          nativeBinding = requireBinding('linux-x64-musl');
        } else {
          nativeBinding = requireBinding('linux-x64-gnu');
        }
        break;
      case 'arm64':
        if (isMusl()) {
          nativeBinding = requireBinding('linux-arm64-musl');
        } else {
          nativeBinding = requireBinding('linux-arm64-gnu');
        }
        break;
      case 'arm':
        nativeBinding = requireBinding('linux-arm-gnueabihf');
        break;
      default:
        throw new Error(`Unsupported architecture on Linux: ${process.arch}`);
    }
    break;
  default:
    throw new Error(
      `Unsupported OS: ${process.platform}, architecture: ${process.arch}`,
    );
}

function isMusl(): boolean {
  const report = process.report?.getReport() as
    | {
        header: {
          glibcVersionRuntime: string;
        };
      }
    | undefined;
  return typeof report?.header?.glibcVersionRuntime !== 'string';
}

function requireBinding(target: string) {
  const localBinding = fs.existsSync(
    path.join(projectRoot, `quic.${target}.node`),
  );
  if (localBinding) {
    return require(path.join(projectRoot, `quic.${target}.node`));
  } else {
    return require(`@matrixai/quic-${target}`);
  }
}

export default nativeBinding;

export type { Quiche };
