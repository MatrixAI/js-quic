import type { Crypto, Host, Hostname, Port } from '@/types';
import { webcrypto } from 'crypto';
import Logger, { LogLevel, StreamHandler } from '@matrixai/logger';
import QUICClient from '@/QUICClient';
import QUICServer from '@/QUICServer';
import QUICConnection from '@/QUICConnection';
import * as events from '@/events';
import * as utils from '@/utils';
import * as testsUtils from './utils';
import * as tls from 'tls';


const certChain = `
-----BEGIN CERTIFICATE-----
MIIC0TCCAoOgAwIBAgIQBkNidOqLcACYmcuYTfBvfzAFBgMrZXAwQDE+MDwGA1UE
AxM1dmxzanBiamQ3MDN2MXVlYnU5ZDFxZWs1ZTE5ZDYxMDBkOG44cXBjMWdraG9q
dXRsc2ExNjAwHhcNMjMwNDEyMDMzNjQ2WhcNMjMwNDEyMDM1MzI2WjBAMT4wPAYD
VQQDEzV2ZjlrZ2w5MTJ0MmxkaGNsaG1vbmo4ajE5MWU4NzBrNzJjM2Qxb2Zrc2Vl
ZGNuaDduYTRsZzAqMAUGAytlcAMhAHppCqQi6KrYsrG2LzRMKQuQcFDiYNocPpxz
msvE91Ero4IBkTCCAY0wDAYDVR0TBAUwAwEB/zALBgNVHQ8EBAMCAf4wRQYDVR0l
BD4wPAYIKwYBBQUHAwEGCCsGAQUFBwMCBggrBgEFBQcDAwYIKwYBBQUHAwQGCCsG
AQUFBwMIBggrBgEFBQcDCTCBlgYDVR0RBIGOMIGLgjV2ZjlrZ2w5MTJ0MmxkaGNs
aG1vbmo4ajE5MWU4NzBrNzJjM2Qxb2Zrc2VlZGNuaDduYTRsZ4cEfwAAAYcQAAAA
AAAAAAAAAAAAAAAAAYY6cGs6Ly92ZjlrZ2w5MTJ0MmxkaGNsaG1vbmo4ajE5MWU4
NzBrNzJjM2Qxb2Zrc2VlZGNuaDduYTRsZzAdBgNVHQ4EFgQUw/bBoGFsa35sm6vr
tUP2DFb4rvUwHgYLKwYBBAGDvk8CAgEEDxYNMS4wLjEtYWxwaGEuMDBRBgsrBgEE
AYO+TwICAgRCBEBBhLfXUK22guEGmVaeOydwKJTpkC/EqXPrPiKAwnMcOqwmaADJ
Tf3qeF8jCUTNkSzfSosSiZVQZTd7hZ+3aXsLMAUGAytlcANBAFOzcMmuaar9ddXr
Klgb0rFviTYrBJcJ8B9ZfGa55NZm/IP0tlZEfg1IHzae/ca6aDc4S9Tq+6QzaEqt
QNWLTAw=
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIC0TCCAoOgAwIBAgIQBkNidOiwcACGVfU86PK1vTAFBgMrZXAwQDE+MDwGA1UE
AxM1dmxzanBiamQ3MDN2MXVlYnU5ZDFxZWs1ZTE5ZDYxMDBkOG44cXBjMWdraG9q
dXRsc2ExNjAwHhcNMjMwNDEyMDMzNjQ2WhcNMjQwNDExMDMzNjQ2WjBAMT4wPAYD
VQQDEzV2bHNqcGJqZDcwM3YxdWVidTlkMXFlazVlMTlkNjEwMGQ4bjhxcGMxZ2to
b2p1dGxzYTE2MDAqMAUGAytlcAMhAK8nlc2nAP4fOX5LQ6dQrgpaYIANRdGssDCk
cT92vFBMo4IBkTCCAY0wDAYDVR0TBAUwAwEB/zALBgNVHQ8EBAMCAf4wRQYDVR0l
BD4wPAYIKwYBBQUHAwEGCCsGAQUFBwMCBggrBgEFBQcDAwYIKwYBBQUHAwQGCCsG
AQUFBwMIBggrBgEFBQcDCTCBlgYDVR0RBIGOMIGLgjV2bHNqcGJqZDcwM3YxdWVi
dTlkMXFlazVlMTlkNjEwMGQ4bjhxcGMxZ2tob2p1dGxzYTE2MIcEfwAAAYcQAAAA
AAAAAAAAAAAAAAAAAYY6cGs6Ly92bHNqcGJqZDcwM3YxdWVidTlkMXFlazVlMTlk
NjEwMGQ4bjhxcGMxZ2tob2p1dGxzYTE2MDAdBgNVHQ4EFgQUa4ZvvTwywvz85bcu
4iizM9fViB8wHgYLKwYBBAGDvk8CAgEEDxYNMS4wLjEtYWxwaGEuMDBRBgsrBgEE
AYO+TwICAgRCBEBOYl4h6T/dslmDGM0nXMagUJisoVu3TRrbfPkvlBCdc4KUTree
jedorMB3d8+L1WV1mCr5BzUChESFZ8NOPHkBMAUGAytlcANBAPyIki/6vOsIz/T6
i2J07zvMs9omg7Kjn1HS4M4MSzwljBvMF3VY7Q2fbGWz1IAZAWwmO9JvQv3boejZ
mw7iaQw=
-----END CERTIFICATE-----
`
const privateKey = `
-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIPX4FqPs5hDcshMDvEQGFsWyrySEGY3G3eSzTXBEFkrG
-----END PRIVATE KEY-----
`
const tlsConfig = {
  certChainPem: certChain,
  privKeyPem: privateKey,
}

describe(QUICClient.name, () => {
  const logger = new Logger(`${QUICClient.name} Test`, LogLevel.WARN, [
    new StreamHandler(),
  ]);
  // This has to be setup asynchronously due to key generation
  let crypto: {
    key: ArrayBuffer;
    ops: Crypto;
  };
  let clientErrorEventP;
  let rejectClientErrorEventP;

  let serverErrorEventP;
  let rejectServerErrorEventP;

  let serverStopEventP;
  let resolveServerStopEventP;

  let clientDestroyEventP;
  let resolveClientDestroyEventP;

  let connectionEventP;
  let resolveConnectionEventP;

  let streamEventP;
  let resolveStreamEventP;


  const handleServerErrorEvent = (e: events.QUICServerErrorEvent) => {
    rejectServerErrorEventP(e);
    // const { p, rejectP } = utils.promise<events.QUICServerErrorEvent>();
    // serverErrorEventP = p;
    // rejectServerErrorEventP = rejectP;
  };

  const handleClientErrorEvent = (e: events.QUICClientErrorEvent) => {
    rejectClientErrorEventP(e);
    // const { p, rejectP } = utils.promise<events.QUICClientErrorEvent>();
    // clientErrorEventP = p;
    // rejectClientErrorEventP = rejectP;
  };

  const handleServerStopEvent = (e: events.QUICServerStopEvent) => {
    resolveServerStopEventP(e);
    const { p, resolveP } = utils.promise<events.QUICServerStopEvent>();
    serverStopEventP = p;
    resolveServerStopEventP = resolveP;
  };

  const handleClientDestroyEvent = (e: events.QUICClientDestroyEvent) => {
    resolveClientDestroyEventP(e);
    const { p, resolveP } = utils.promise<events.QUICClientDestroyEvent>();
    clientDestroyEventP = p;
    resolveClientDestroyEventP = resolveP;
  };

  const handleConnectionEventP = (e: events.QUICServerConnectionEvent) => {
    resolveConnectionEventP(e);
    const { p, resolveP } = utils.promise<events.QUICServerConnectionEvent>();
    connectionEventP = p;
    resolveConnectionEventP = resolveP;
  };

  const handleStreamEventP = (e: events.QUICConnectionStreamEvent) => {
    resolveStreamEventP(e);
    const { p, resolveP } = utils.promise<events.QUICConnectionStreamEvent>();
    streamEventP = p;
    resolveStreamEventP = resolveP;
  };

  // We need to test the stream making

  beforeEach(async () => {
    crypto = {
      key: await testsUtils.generateKey(),
      ops: {
        sign: testsUtils.sign,
        verify: testsUtils.verify,
        randomBytes: testsUtils.randomBytes,
      },
    };
  });
  afterEach(async () => {
  });

  // Are we describing a dual stack client!?
  describe('dual stack client', () => {
    let connectionEventP;
    let resolveConnectionEventP;
    let handleConnectionEventP;
    beforeEach(async () => {
      const {
        p,
        resolveP
      } = utils.promise<events.QUICServerConnectionEvent>();
      connectionEventP = p;
      resolveConnectionEventP = resolveP;
      handleConnectionEventP = (e: events.QUICServerConnectionEvent) => {
        resolveConnectionEventP(e);
      };
    });
    test('to ipv4 server succeeds', async () => {
      const server = new QUICServer({
        crypto,
        logger: logger.getChild(QUICServer.name),
        config: {
          ...tlsConfig
        }
      });
      server.addEventListener('connection', handleConnectionEventP);
      await server.start({
        host: '127.0.0.1' as Host,
        port: 55555 as Port
      });
      const client = await QUICClient.createQUICClient({
        host: '::ffff:127.0.0.1' as Host,
        port: server.port,
        localHost: '::' as Host,
        crypto,
        logger: logger.getChild(QUICClient.name),
        config: {
          logKeys: './tmp/keylog.log',
        }
      });
      const conn = (await connectionEventP).detail;
      expect(conn.localHost).toBe('127.0.0.1');
      expect(conn.localPort).toBe(server.port);
      expect(conn.remoteHost).toBe('127.0.0.1');
      expect(conn.remotePort).toBe(client.port);
      await client.destroy();
      await server.stop();
    });
    test('to ipv6 server succeeds', async () => {
      const server = new QUICServer({
        crypto,
        logger: logger.getChild(QUICServer.name),
        config: {
          ...tlsConfig
        }
      });
      server.addEventListener('connection', handleConnectionEventP);
      await server.start({
        host: '::1' as Host,
        port: 0 as Port
      });
      const client = await QUICClient.createQUICClient({
        host: '::1' as Host,
        port: server.port,
        localHost: '::' as Host,
        crypto,
        logger: logger.getChild(QUICClient.name)
      });
      const conn = (await connectionEventP).detail;
      expect(conn.localHost).toBe('::1');
      expect(conn.localPort).toBe(server.port);
      expect(conn.remoteHost).toBe('::1');
      expect(conn.remotePort).toBe(client.port);
      await client.destroy();
      await server.stop();
    });
    test('to dual stack server succeeds', async () => {
      const server = new QUICServer({
        crypto,
        logger: logger.getChild(QUICServer.name),
        config: {
          ...tlsConfig
        }
      });
      server.addEventListener('connection', handleConnectionEventP);
      await server.start({
        host: '::' as Host,
        port: 0 as Port
      });
      const client = await QUICClient.createQUICClient({
        host: '::' as Host, // Will resolve to ::1
        port: server.port,
        localHost: '::' as Host,
        crypto,
        logger: logger.getChild(QUICClient.name)
      });
      const conn = (await connectionEventP).detail;
      expect(conn.localHost).toBe('::');
      expect(conn.localPort).toBe(server.port);
      expect(conn.remoteHost).toBe('::1');
      expect(conn.remotePort).toBe(client.port);
      await client.destroy();
      await server.stop();
    });
  });


  test('', async () => {
    // I want to test that if there's no server what happens
    // Does it keep "dialing"
    // until it times out? Idle connection timeo ut
    // or something else happens
    // Because then on server side we can hole punch back

    const client = await QUICClient.createQUICClient({
      host: '127.0.0.1' as Host,
      port: 55555 as Port,
      localHost: '127.0.0.1' as Host,
      crypto,
      logger: logger.getChild(QUICClient.name),
      config: {
        logKeys: './tmp/keylog.log',
        maxIdleTimeout: 5000,
      }
    });

    // Because it is never established
    // It's basically awaiting forever

  });


  test('dual stack to dual stack', async () => {

    const {
      p: clientErrorEventP,
      rejectP: rejectClientErrorEventP
    } = utils.promise<events.QUICClientErrorEvent>();

    const {
      p: serverErrorEventP,
      rejectP: rejectServerErrorEventP
    } = utils.promise<events.QUICServerErrorEvent>();

    const {
      p: serverStopEventP,
      resolveP: resolveServerStopEventP
    } = utils.promise<events.QUICServerStopEvent>();

    const {
      p: clientDestroyEventP,
      resolveP: resolveClientDestroyEventP
    } = utils.promise<events.QUICClientDestroyEvent>();

    const {
      p: connectionEventP,
      resolveP: resolveConnectionEventP
    } = utils.promise<events.QUICServerConnectionEvent>();

    const {
      p: streamEventP,
      resolveP: resolveStreamEventP
    } = utils.promise<events.QUICConnectionStreamEvent>();

    const server = new QUICServer({
      config: {
        ...tlsConfig
      },
      crypto,
      logger: logger.getChild(QUICServer.name)
    });
    server.addEventListener('error', handleServerErrorEvent);
    server.addEventListener('stop', handleServerStopEvent);

    // Every time I have a promise
    // I can attempt to await 4 promises
    // Then the idea is that this will resolve 4 times
    // Once for each time?
    // If you add once
    // Do you also

    // Fundamentally there could be multiple of these
    // This is not something I can put outside

    server.addEventListener(
      'connection',
      (e: events.QUICServerConnectionEvent) => {
        resolveConnectionEventP(e);

        // const conn = e.detail;
        // conn.addEventListener('stream', (e: events.QUICConnectionStreamEvent) => {
        //   resolveStreamEventP(e);
        // }, { once: true });
      },
      { once: true }
    );

    // Dual stack server
    await server.start({
      host: '::' as Host,
      port: 0 as Port
    });
    // Dual stack client
    const client = await QUICClient.createQUICClient({
      // host: server.host,
      // host: '::ffff:127.0.0.1' as Host,
      host: '::1' as Host,
      port: server.port,
      localHost: '::' as Host,
      crypto,
      logger: logger.getChild(QUICClient.name)
    });
    client.addEventListener('error', handleClientErrorEvent);
    client.addEventListener('destroy', handleClientDestroyEvent);



    // await testsUtils.sleep(1000);

    await expect(connectionEventP).resolves.toBeInstanceOf(events.QUICServerConnectionEvent);
    await client.destroy();
    await expect(clientDestroyEventP).resolves.toBeInstanceOf(events.QUICClientDestroyEvent);
    await server.stop();
    await expect(serverStopEventP).resolves.toBeInstanceOf(events.QUICServerStopEvent);


    // No errors occurred
    await expect(Promise.race([clientErrorEventP, Promise.resolve()])).resolves.toBe(undefined);
    await expect(Promise.race([serverErrorEventP, Promise.resolve()])).resolves.toBe(undefined);
  });
  // test.only('', async () => {
  //
  //   // const p = Promise.reject(new Error('Not implemented'));
  //   const { p, rejectP } = utils.promise();
  //   rejectP(new Error('oh no'));
  //
  //   await expect(Promise.race([p, Promise.resolve()])).resolves.toBe(undefined);
  // });
  // We need to test shared socket later
});
