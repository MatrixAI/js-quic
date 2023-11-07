"use strict";
const { default: QUICServer } = require('./dist/QUICServer');
const {
  default: Logger,
  formatting,
  LogLevel,
  StreamHandler,
} = require('@matrixai/logger');
const peculiarWebcrypto = require('@peculiar/webcrypto');
const { default: QUICClient } = require('./dist/QUICClient');
const webcrypto = new peculiarWebcrypto.Crypto();

async function signHMAC(key, data) {
  const cryptoKey = await webcrypto.subtle.importKey(
    'raw',
    key,
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  return webcrypto.subtle.sign('HMAC', cryptoKey, data);
}

async function verifyHMAC(
  key,
  data,
  sig,
) {
  const cryptoKey = await webcrypto.subtle.importKey(
    'raw',
    key,
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  return webcrypto.subtle.verify('HMAC', cryptoKey, sig, data);
}

const serverCrypto = {
  sign: signHMAC,
  verify: verifyHMAC,
};

async function randomBytes(data) {
  webcrypto.getRandomValues(new Uint8Array(data));
}

const clientCrypto = {
  randomBytes: randomBytes,
};

function sleep(delay) {
   return new Promise(resolve => {
     setTimeout(resolve, delay);
   });
}

const key = Buffer.from('fb8e18eaa611043e830a3d1d6df0488ab026c451de0576ef3610108e37540e90bc7376a74c90b7d47b8fb0d4357e903dfcfc386df6513ad5c11272df2a7aba2b', 'hex');
const privateKeyPem =
  `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDA2hjtJZfnYDO+
HZWhKfaT9uDX0OfTI23bRx+7dFTLkwukUqc9yhpmwqjzpzfIBjgNRbywU6tFZPsO
5RMRipeetQsMqeraOVqnKK1mQwLyZ61L9LNFrVh09pUPDXugUWtnOGQ2tBERySRX
XbXJuqMcT8lKInzdKQoZ5mIgIkMd6PQBwLgNHK/1eR/RZqkQfPKyI4nf72ogmuMc
BhJ+RHNYk/5h3WYgQHSwBL1fPyKYVXgcQpHKYFaBHlyLibpXhi9aO8twD6SiF2ay
ZM8czgCfu/YaFQU8yqd9hqPWlHtVz6MoanROtaIzLe41msGmn76vwwsD7ubuLp6z
Oh8HfhrTAgMBAAECggEAH8sU4ZZur5S66F8k5DfwexOanRnHTkCrWMN7UMJsmaR5
U919zYBRz+/MPgxVnuKflQM9M0M9Rih6rJ70ANKnYmEYcZMFsR+peUtfItpt/vE8
BFH9csGRhrQsKMTL78cx0geIRe3JA/Seys8b1tEFGPgdCDLIAQdGBLUS0kIJF0H0
nFWfmGQVQzUoylaQ1VH2xnzv1KN8xXR4y8xVFEuphbzzyiQhfHx3gI4dfAyc4JTk
1nb/VoPI29Wbi8/mPM64EU0e4/tQpx293pmfnvojOHc40MnsQnIOOIkbtuNhAHCC
xs6I5wl9EUi97cTAQ0EtwQpLFQ1EY+fMSNnvt2//cQKBgQDuzX3M3kqYSAjFj2g/
SFjY5BzQ4/tTzbEazap7CfCbRoG3OLTgCIs/72kUvk1mbWk5jnEl9pKodOwz/lNB
56Dnd7NYV3mN0wLTTRvjYBVRZe/q1URlgkGItftX/hPT7v8dsor9kxLPkKNiWIXb
tMC3TAX1wAvxCGWHHF/nTTWM2wKBgQDOvXgM9muZf78YqRQtHI9y9JFXhjOaBIDb
zM2CIWt0pe1//jfpAFKhbeKG8IXbamu5mOsyf7vIKuyVTlFcuMm0Jq5S/OwhooSe
OUPga7uD4/1ofUrUXlF4cKpehlQwvtGE7oAmIKailKEbJ20CH/5MDt9tyVLx03Uh
lrBwc1uPaQKBgG872tBV7ws16pgTr6xih7gnsWCAAW7MziU9DZ8YRzIcyolM6bu9
Xxed7iWSaz0905jSx9O2IiRDqk6htahqO2H2ONz6ig1M7/D65vWnqOZshC+vvZdG
8D28/uHC4PuERONRajqpikaTCffiYh+v92CqEdCh7y4MCjbAOc/k//+nAoGAYays
cltd/LiZHVqMmL+cmnAn1tUlvgeQpcf99BQ8A3F9YvJFkgTABVq4Io6yfzapTJeN
z17/5hM5kVTeJdN8IGwCAl1SZpW02Fgv1HCxuB9YEyzW1Lz2+tMn+t62Gg2dSZOw
4dKdR8S21PBslQtuhpqkPudWE8CW31alZ4to37kCgYB+bmy8qVWvXiB2RyV1FnBD
eC6UA9Z9x3siD09Uo74/lFEISWYR6whWqUHbbNR1pae+VfZnKJfqPRlSlO3hojgf
2kv9Mb0mdzNys00J3Xgr82TtszXBnw3dgCscf26rqkLw5GZgPQOuItYGnWrgDLIs
Ju/v2gL+5VLZGMo8HE9ijA==
-----END PRIVATE KEY-----`

const certPem =
  `-----BEGIN CERTIFICATE-----
MIIEGDCCAwCgAwIBAgIBATANBgkqhkiG9w0BAQsFADBLMUkwRwYDVQQDE0AzOGQy
ZDdkMWY2MjkzMGNkZTdmNWZkMWQ3NTJkM2Y2NTNkZWYwNWEzMDA0OWE2ZTM1YmRk
Y2QyZTE3ZDk4YzhlMB4XDTIzMTEwNzAyMTkzN1oXDTMzMTEwNDAyMTkzN1owSzFJ
MEcGA1UEAxNAZjk2NDgzNGYwZTkxNzdjNGQzOTcwNDc1YzdiZjJlYmQ4NDk0OTFh
MTM0OTc3ZGFkYTU1NTYzOTgyODdkZmFmZTCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBAMDaGO0ll+dgM74dlaEp9pP24NfQ59MjbdtHH7t0VMuTC6RSpz3K
GmbCqPOnN8gGOA1FvLBTq0Vk+w7lExGKl561Cwyp6to5WqcorWZDAvJnrUv0s0Wt
WHT2lQ8Ne6BRa2c4ZDa0ERHJJFddtcm6oxxPyUoifN0pChnmYiAiQx3o9AHAuA0c
r/V5H9FmqRB88rIjid/vaiCa4xwGEn5Ec1iT/mHdZiBAdLAEvV8/IphVeBxCkcpg
VoEeXIuJuleGL1o7y3APpKIXZrJkzxzOAJ+79hoVBTzKp32Go9aUe1XPoyhqdE61
ojMt7jWawaafvq/DCwPu5u4unrM6Hwd+GtMCAwEAAaOCAQUwggEBMAwGA1UdEwQF
MAMBAf8wCwYDVR0PBAQDAgH+MEUGA1UdJQQ+MDwGCCsGAQUFBwMBBggrBgEFBQcD
AgYIKwYBBQUHAwMGCCsGAQUFBwMEBggrBgEFBQcDCAYIKwYBBQUHAwkwfgYDVR0R
BHcwdYJAZjk2NDgzNGYwZTkxNzdjNGQzOTcwNDc1YzdiZjJlYmQ4NDk0OTFhMTM0
OTc3ZGFkYTU1NTYzOTgyODdkZmFmZYIJbG9jYWxob3N0ggkxMjcuMC4wLjGCAzo6
MYcEfwAAAYcQAAAAAAAAAAAAAAAAAAAAATAdBgNVHQ4EFgQU3uSr9eyVszazs056
J/1HXl85DtwwDQYJKoZIhvcNAQELBQADggEBAEFAZXXT4CpygCeMjo9Ok6A/to6r
9TTMus9hwanatQTYp449f2gMLT2XmAOhCthUoGgJ3DbVF4PHQ0hF+s9p0NGaSuSy
k61x0usYepdEVR0wlPQXc98WTpxr9sAf9mJdU8Iqf/ZIGGdkNDLd1Rj7g01392jM
MwuwBZYmEFzKgJjQ6eBPoOI0haIhy8H9SBRCSLt63495ZFeydurlCBWsXF6XNaKl
YIUD5a/f3CkZQSe86zoJlbgE6KMd05pn9+kyNuKOT2L/7CdVcqN7tfO8HWu3L6Fx
ZlGQNFSrHBt6AzqD8/S5P+tcRJ+GqTRxubRxmSu/OtEhgdthvBWOwEcC9Ww=
-----END CERTIFICATE-----`

async function main() {
  const logger = new Logger(`Test`, LogLevel.SILENT, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);

  console.log('starting!');
  await sleep(5000);

  // start by creating a server
  const server = new QUICServer({
    crypto: {
      key,
      ops: serverCrypto,
    },
    logger: logger.getChild('server'),
    config: {
      initialMaxStreamsBidi: 10000,
      key: privateKeyPem,
      cert: certPem,
      verifyPeer: false,
    },
  });
  await server.start({
    host: '127.0.0.2',
  });

  // now start a client
  const client = await QUICClient.createQUICClient({
    host: '127.0.0.2',
    port: server.port,
    localHost: '127.0.0.3',
    crypto: {
      ops: clientCrypto,
    },
    logger: logger.getChild('client'),
    config: {
      initialMaxStreamsBidi: 10000,
      verifyPeer: false,
    },
  });

  // Let's create and destroy a whole bunch of streams.
  const streams = [];
  const streamPs = [];
  for (let i = 0; i < 1000; i++) {
    // if (i % 100 === 0) console.log(i);
    const stream = client.connection.newStream();
    streams.push(stream);
    streamPs.push(stream.closedP);
  }

  console.log('started')
  await sleep(5000);
  for (const stream of streams) {
    stream.cancel();
  }
  await Promise.all(streamPs);
  console.log('cancelled');
  await sleep(5000);

  await client.destroy();
  await server.stop();

  console.log('destroyed!');
  await sleep(5000);
  console.log('done!');
}

main();
