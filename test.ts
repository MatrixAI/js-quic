
import { quiche } from './src/native';
import QUICServer from './src/QUICServer';
import * as testsUtils from './tests/utils';
import { promise } from './src/utils';
import { Host } from './src';
import QUICClient from './src/QUICClient';
import Logger, { formatting, LogLevel, StreamHandler } from '@matrixai/logger';
import { TlsConfig } from './src/config';
import path from 'path';

async function main() {
  const logger = new Logger(`${QUICClient.name} Test`, LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  const crypto = {
    key: await testsUtils.generateKey(),
    ops: {
      sign: testsUtils.sign,
      verify: testsUtils.verify,
      randomBytes: testsUtils.randomBytes,
    },
  };
  const verifyPemFile = path.join(__dirname, './tests/fixtures/certs/rsaCA.crt');
  const tlsConfigs1: TlsConfig = {
    privKeyFromPemFile: path.join(__dirname, './tests/fixtures/certs/rsa1.key'),
    certChainFromPemFile: path.join(__dirname, './tests/fixtures/certs/rsa1.crt'),
  };
  console.log(tlsConfigs1);
  const tlsConfigs2: TlsConfig = {
    privKeyFromPemFile: path.join(__dirname, './tests/fixtures/certs/rsa2.key'),
    certChainFromPemFile: path.join(__dirname, './tests/fixtures/certs/rsa2.crt'),
  };
  const server = new QUICServer({
    crypto,
    logger: logger.getChild(QUICServer.name),
    config: {
      tlsConfig: tlsConfigs1,
      verifyFromPemFile: verifyPemFile,
      verifyPeer: true,
    },
  });
  const handleConnectionEventProm = promise<any>();
  server.addEventListener(
    'connection',
    handleConnectionEventProm.resolveP,
  );
  await server.start({
    host: '127.0.0.1' as Host,
  });
  // Connection should succeed
  const client = await QUICClient.createQUICClient({
    host: '::ffff:127.0.0.1' as Host,
    port: server.port,
    localHost: '::' as Host,
    crypto,
    logger: logger.getChild(QUICClient.name),
    config: {
      tlsConfig: tlsConfigs2,
      verifyFromPemFile: verifyPemFile,
      verifyPeer: true,
    },
  });
  await handleConnectionEventProm.p;
  await client.destroy();
  await server.stop();
}

void main().then(() => {});
