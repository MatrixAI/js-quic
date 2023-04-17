import type { Crypto, Host, Hostname, Port } from '@/types';
import { webcrypto } from 'crypto';
import Logger, { LogLevel, StreamHandler, formatting } from '@matrixai/logger';
import QUICClient from '@/QUICClient';
import QUICServer from '@/QUICServer';
import QUICConnection from '@/QUICConnection';
import * as events from '@/events';
import * as utils from '@/utils';
import * as testsUtils from './utils';
import * as tls from 'tls';
import * as errors from '@/errors';
import { fc } from '@fast-check/jest';
import * as tlsUtils from './tlsUtils';
import * as certFixtures from './fixtures/certFixtures';


const privKeyPem = `
-----BEGIN RSA PRIVATE KEY-----
MIIEogIBAAKCAQEAovJl4noV+8myMOOhG+/1kpsAvmGaiz3o3+gnAINpFiUvANWU
LUhoyyeQAzCom2yOl6WEH1574Hz6jsnwB3BFDj1wcBtbjMlwYpqfkJYsRQGIrOGD
VGI3PSpcBWGOdfPnREAQrp5cL1TKRSuFtyjZR2lZY4DxUAr6JEmC2aOObv7gcr1W
nhdO9PnY9aXhF2aVXsThkp8izP2ET9C7OmpMdajnVVbTW4PFU5YLnKFZFY5CmnaR
08QWFByxGVKDkt5c3sPvBnI0Dfc1LvfCKFJZ4CtJs7+i+O2Y2ticLwur678wvXO9
OGN6CIIC2A9c4H8I8qpE+N/frYfTg/E7/j0dbQIDAQABAoIBAB99SpU21LLA6q+p
/cOBXurDC6S/Bfessik7GvZtbsx5yRiXLbiGisHf1mPXbm4Cz5ecw+iwAK6EWINp
oPo/BwlWdDkmAE43y4Eysm1lqA552mjWd+PByz0Fx5y+mqJOzT2SR+cG8XewIhq1
63RW745uXHjvPTMju+1xS1k101u9lL0VCo5cfPpS12fLYiVtR721CayWydfABuc9
Xbj38G6lw5QGipjS+r7t588dKa9APMffKZPB3q0g65TZrOd0hjvZMQMvPe5aY3SP
UpLD3GhmO/0Khsl31WkZSDPkogPBq6BqvJZa/qrSQHIh9pUX6FFOTCw3ANWQutMH
681LRsECgYEAz5pLp5BrMfg/ToPMaLKcpYiY//UhI+ZjUJ8aL51D8Jl4DOAUN1ge
tpBKDRm0ayLOdFeok9S8CQItrAvkFyHBiRK6R1CgyXqSCdBRPsqdN74+K0DsEloU
nNdXejGGijSSezBcvNYVlJC+7yKLgpC2wK36oLFEPHdNJPIC3wZBtFECgYEAyO8L
/6KfVOaUJCc02vUAU8Ap6bVA5xlXD4sxI5w6FCwcHCzlAoHGsjA2aWsnxi43z41p
pRR9IySUEPZxmh76Tzs9+Dthshkjrrx8CuTIky37BIzFDioqH2Ncj5+DCAly3IU4
NjCMQOp+Yx5u9UZfkdcJj31+JUCBn1BdW22Z3F0CgYB9ftdW/t1eAqQ6UUAC1l4N
Tuq2Z7dV3VKSDOumdtn4Gr3QgrCV2CYQ1F5/VteSoCLPf6H/Y20bwP5c7389YIF+
3BxROfNIeFjJp+1FGPQ7Gzy3pvJOEbg+K4rM6h1bdHZME6sr1/qJqYpSQr60+cgP
59wGwcHvD2tJ9yY3LbAQUQKBgDefZPTpMa4w/kVbzRfnxqVohrG5iTPwIdedsoan
ErTO2SE7lFGzVyuwiP95uFL2LGD6Rop6N4Ho+EwRzLTbanNQdQEofwzsRKJ0buod
FyEXE2vZBBu9tFdoDBF+GKm6498DyeHGYqz9vOr3W8PuLTqUCoN8O9VYHAncF1vd
5T/JAoGAeWb5iqhDhkrZDSi5GreFh2zVlDanZJqQn4UpUhotO4gtKDzMqM/rxV95
RZ7zsFD22yY06cXePpMOfw4qAUDZuwoZgVH5MLW3IWJPkg++nG6GfTBaHmYmXK/M
uPSJlPjTsCL+dUX+7VbrfntypnVALhtX3bZo3rsQQmUci/NjDhU=
-----END RSA PRIVATE KEY-----
`

const certChainPem = `
-----BEGIN CERTIFICATE-----
MIIDJjCCAg6gAwIBAgIRAImdTwINUpu7qX/uYWmVT44wDQYJKoZIhvcNAQELBQAw
FDESMBAGA1UEAxMJbG9jYWxob3N0MB4XDTIzMDQxMDA1MDk1OVoXDTI0MDQwOTA1
MDk1OVowFDESMBAGA1UEAxMJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEFAAOC
AQ8AMIIBCgKCAQEAovJl4noV+8myMOOhG+/1kpsAvmGaiz3o3+gnAINpFiUvANWU
LUhoyyeQAzCom2yOl6WEH1574Hz6jsnwB3BFDj1wcBtbjMlwYpqfkJYsRQGIrOGD
VGI3PSpcBWGOdfPnREAQrp5cL1TKRSuFtyjZR2lZY4DxUAr6JEmC2aOObv7gcr1W
nhdO9PnY9aXhF2aVXsThkp8izP2ET9C7OmpMdajnVVbTW4PFU5YLnKFZFY5CmnaR
08QWFByxGVKDkt5c3sPvBnI0Dfc1LvfCKFJZ4CtJs7+i+O2Y2ticLwur678wvXO9
OGN6CIIC2A9c4H8I8qpE+N/frYfTg/E7/j0dbQIDAQABo3MwcTAOBgNVHQ8BAf8E
BAMCBaAwHQYDVR0lBBYwFAYIKwYBBQUHAwEGCCsGAQUFBwMCMB0GA1UdDgQWBBR0
zbkYQmSgopJsbuNKOQV9qjYu7TAhBgNVHREEGjAYhwR/AAABhxAAAAAAAAAAAAAA
AAAAAAABMA0GCSqGSIb3DQEBCwUAA4IBAQAWLolrv0NuKqhZndYLPCT3C013Qo6y
QeQPbyZbJgHhRZd2feP8sEQ1U4f48OKL5ejWEKOaUvH/sVI9Jume4ve2xOxqz+ST
csZqUqinnUT/12jwGOys2IIEPBnlMxBFon54G336+LGgl9CX+rXKeJZgIbmZpcCa
J948KRJwJ4E4UgnNIY/e4J5nCpScA0b5GlmcvpoV5yBoIf6vvnrWeyyl4rotPx9Q
jm/r7v5BQrwMjbcrLCA9Nob5tSMEHDjlvt4cNzOnMWdsjB735QaMsA8qZX8m2NpX
jti9iwz2QT6q1s+PjS/gbflIO3j4FP4XOEQGtWm9iqPbVhoUIB9PBED3
-----END CERTIFICATE-----
`

const tlsArb = fc.constant(certFixtures.tlsConfigFileRSA1);
// const tlsArb = tlsUtils.tlsConfigArb(tlsUtils.keyPairsArb(1));
// const tlsArb = fc.constant({
//   certChainPem,
//   privKeyPem,
// });
describe(QUICClient.name, () => {
  const logger = new Logger(`${QUICClient.name} Test`, LogLevel.DEBUG, [
    new StreamHandler(formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`),
  ]);
  // This has to be setup asynchronously due to key generation
  let crypto: {
    key: ArrayBuffer;
    ops: Crypto;
  };

  let tlsConfig: {
    certChainPem: string | null;
    privKeyPem: string | null;
  } | {
    certChainFromPemFile: string | null;
    privKeyFromPemFile: string | null;
  };

  // We need to test the stream making
  beforeEach(async () => {
    tlsConfig = await fc.sample(tlsArb, 1)[0]
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
          tlsConfig
        }
      });
      server.addEventListener('connection', handleConnectionEventP);
      await server.start({
        host: '127.0.0.1' as Host,
      });
      const client = await QUICClient.createQUICClient({
        host: '::ffff:127.0.0.1' as Host,
        port: server.port,
        localHost: '::' as Host,
        crypto,
        logger: logger.getChild(QUICClient.name),
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
          tlsConfig
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
          tlsConfig
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
  test('times out when there is no server', async () => {
    // QUICClient repeatedly dials until the connection timesout
    await expect(QUICClient.createQUICClient({
      host: '127.0.0.1' as Host,
      port: 55555 as Port,
      localHost: '127.0.0.1' as Host,
      crypto,
      logger: logger.getChild(QUICClient.name),
      config: {
        maxIdleTimeout: 1000,
      }
    })).rejects.toThrow(errors.ErrorQUICConnectionTimeout);
  });
  describe('TLS rotation', () => {
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
    test.todo('existing connections still function');
    test('existing connections config is unchanged and still function', async () => {
      const server = new QUICServer({
        crypto,
        logger: logger.getChild(QUICServer.name),
        config: {
          tlsConfig: certFixtures.tlsConfigFileRSA1
        }
      });
      server.addEventListener('connection', handleConnectionEventP);
      await server.start({
        host: '127.0.0.1' as Host,
      });
      const client1 = await QUICClient.createQUICClient({
        host: '::ffff:127.0.0.1' as Host,
        port: server.port,
        localHost: '::' as Host,
        crypto,
        logger: logger.getChild(QUICClient.name),
      });
      const peerCertChainInitial = client1.connection.conn.peerCertChain()
      server.updateConfig({
        tlsConfig: certFixtures.tlsConfigFileRSA2
      })
      // The existing connection's certs should be unchanged
      const peerCertChainNew = client1.connection.conn.peerCertChain()
      expect(peerCertChainNew![0].toString()).toStrictEqual(peerCertChainInitial![0].toString());
      await client1.destroy();
      await server.stop();
    });
    test('new connections use new config', async () => {
      const server = new QUICServer({
        crypto,
        logger: logger.getChild(QUICServer.name),
        config: {
          tlsConfig: certFixtures.tlsConfigFileRSA1
        }
      });
      server.addEventListener('connection', handleConnectionEventP);
      await server.start({
        host: '127.0.0.1' as Host,
      });
      const client1 = await QUICClient.createQUICClient({
        host: '::ffff:127.0.0.1' as Host,
        port: server.port,
        localHost: '::' as Host,
        crypto,
        logger: logger.getChild(QUICClient.name),
      });
      const peerCertChainInitial = client1.connection.conn.peerCertChain()
      server.updateConfig({
        tlsConfig: certFixtures.tlsConfigFileRSA2
      })
      // Starting a new connection has a different peerCertChain
      const client2 = await QUICClient.createQUICClient({
        host: '::ffff:127.0.0.1' as Host,
        port: server.port,
        localHost: '::' as Host,
        crypto,
        logger: logger.getChild(QUICClient.name),
      });
      const peerCertChainNew = client2.connection.conn.peerCertChain()
      expect(peerCertChainNew![0].toString()).not.toStrictEqual(peerCertChainInitial![0].toString());
      await client1.destroy();
      await client2.destroy();
      await server.stop();
    });
  })

  // test('dual stack to dual stack', async () => {

  //   const {
  //     p: clientErrorEventP,
  //     rejectP: rejectClientErrorEventP
  //   } = utils.promise<events.QUICClientErrorEvent>();

  //   const {
  //     p: serverErrorEventP,
  //     rejectP: rejectServerErrorEventP
  //   } = utils.promise<events.QUICServerErrorEvent>();

  //   const {
  //     p: serverStopEventP,
  //     resolveP: resolveServerStopEventP
  //   } = utils.promise<events.QUICServerStopEvent>();

  //   const {
  //     p: clientDestroyEventP,
  //     resolveP: resolveClientDestroyEventP
  //   } = utils.promise<events.QUICClientDestroyEvent>();

  //   const {
  //     p: connectionEventP,
  //     resolveP: resolveConnectionEventP
  //   } = utils.promise<events.QUICServerConnectionEvent>();

  //   const {
  //     p: streamEventP,
  //     resolveP: resolveStreamEventP
  //   } = utils.promise<events.QUICConnectionStreamEvent>();

  //   const server = new QUICServer({
  //     crypto,
  //     logger: logger.getChild(QUICServer.name)
  //   });
  //   server.addEventListener('error', handleServerErrorEvent);
  //   server.addEventListener('stop', handleServerStopEvent);

  //   // Every time I have a promise
  //   // I can attempt to await 4 promises
  //   // Then the idea is that this will resolve 4 times
  //   // Once for each time?
  //   // If you add once
  //   // Do you also

  //   // Fundamentally there could be multiple of these
  //   // This is not something I can put outside

  //   server.addEventListener(
  //     'connection',
  //     (e: events.QUICServerConnectionEvent) => {
  //       resolveConnectionEventP(e);

  //       // const conn = e.detail;
  //       // conn.addEventListener('stream', (e: events.QUICConnectionStreamEvent) => {
  //       //   resolveStreamEventP(e);
  //       // }, { once: true });
  //     },
  //     { once: true }
  //   );

  //   // Dual stack server
  //   await server.start({
  //     host: '::' as Host,
  //     port: 0 as Port
  //   });
  //   // Dual stack client
  //   const client = await QUICClient.createQUICClient({
  //     // host: server.host,
  //     // host: '::ffff:127.0.0.1' as Host,
  //     host: '::1' as Host,
  //     port: server.port,
  //     localHost: '::' as Host,
  //     crypto,
  //     logger: logger.getChild(QUICClient.name)
  //   });
  //   client.addEventListener('error', handleClientErrorEvent);
  //   client.addEventListener('destroy', handleClientDestroyEvent);



  //   // await testsUtils.sleep(1000);

  //   await expect(connectionEventP).resolves.toBeInstanceOf(events.QUICServerConnectionEvent);
  //   await client.destroy();
  //   await expect(clientDestroyEventP).resolves.toBeInstanceOf(events.QUICClientDestroyEvent);
  //   await server.stop();
  //   await expect(serverStopEventP).resolves.toBeInstanceOf(events.QUICServerStopEvent);


  //   // No errors occurred
  //   await expect(Promise.race([clientErrorEventP, Promise.resolve()])).resolves.toBe(undefined);
  //   await expect(Promise.race([serverErrorEventP, Promise.resolve()])).resolves.toBe(undefined);
  // });
  // test.only('', async () => {

  //   // const p = Promise.reject(new Error('Not implemented'));
  //   const { p, rejectP } = utils.promise();
  //   rejectP(new Error('oh no'));

  //   await expect(Promise.race([p, Promise.resolve()])).resolves.toBe(undefined);


  // });
  // We need to test shared socket later
});
