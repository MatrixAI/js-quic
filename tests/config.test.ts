import type { X509Certificate } from '@peculiar/x509';
import { clientDefault, serverDefault, buildQuicheConfig } from '@/config';
import * as errors from '@/errors';
import * as testsUtils from './utils';

describe('config', () => {
  let keyPairRSA: {
    publicKey: JsonWebKey;
    privateKey: JsonWebKey;
  };
  let certRSA: X509Certificate;
  let keyPairRSAPEM: {
    publicKey: string;
    privateKey: string;
  };
  let certRSAPEM: string;
  let keyPairECDSA: {
    publicKey: JsonWebKey;
    privateKey: JsonWebKey;
  };
  let certECDSA: X509Certificate;
  let keyPairECDSAPEM: {
    publicKey: string;
    privateKey: string;
  };
  let certECDSAPEM: string;
  let keyPairEd25519: {
    publicKey: JsonWebKey;
    privateKey: JsonWebKey;
  };
  let certEd25519: X509Certificate;
  let keyPairEd25519PEM: {
    publicKey: string;
    privateKey: string;
  };
  let certEd25519PEM: string;
  beforeAll(async () => {
    keyPairRSA = await testsUtils.generateKeyPairRSA();
    certRSA = await testsUtils.generateCertificate({
      certId: '0',
      subjectKeyPair: keyPairRSA,
      issuerPrivateKey: keyPairRSA.privateKey,
      duration: 60 * 60 * 24 * 365 * 10,
    });
    keyPairRSAPEM = await testsUtils.keyPairRSAToPEM(keyPairRSA);
    certRSAPEM = testsUtils.certToPEM(certRSA);
    keyPairECDSA = await testsUtils.generateKeyPairECDSA();
    certECDSA = await testsUtils.generateCertificate({
      certId: '0',
      subjectKeyPair: keyPairECDSA,
      issuerPrivateKey: keyPairECDSA.privateKey,
      duration: 60 * 60 * 24 * 365 * 10,
    });
    keyPairECDSAPEM = await testsUtils.keyPairECDSAToPEM(keyPairECDSA);
    certECDSAPEM = testsUtils.certToPEM(certECDSA);
    keyPairEd25519 = await testsUtils.generateKeyPairEd25519();
    certEd25519 = await testsUtils.generateCertificate({
      certId: '0',
      subjectKeyPair: keyPairEd25519,
      issuerPrivateKey: keyPairEd25519.privateKey,
      duration: 60 * 60 * 24 * 365 * 10,
    });
    keyPairEd25519PEM = await testsUtils.keyPairEd25519ToPEM(keyPairEd25519);
    certEd25519PEM = testsUtils.certToPEM(certEd25519);
  });
  test('build default client config', () => {
    const config = buildQuicheConfig(clientDefault);
    expect(config).toBeDefined();
  });
  test('build default server config', () => {
    const config = buildQuicheConfig(serverDefault);
    expect(config).toBeDefined();
  });
  test('build with incorrect configuration', () => {
    expect(() =>
      buildQuicheConfig({
        ...serverDefault,
        sigalgs: 'ed448',
      }),
    ).toThrow(errors.ErrorQUICConfig);
    expect(() =>
      buildQuicheConfig({
        ...serverDefault,
        key: [keyPairRSAPEM.privateKey, keyPairECDSAPEM.privateKey],
        cert: [certRSAPEM],
      }),
    ).toThrow(errors.ErrorQUICConfig);
  });
  test('build with self-signed certificates', () => {
    buildQuicheConfig({
      ...clientDefault,
      key: keyPairRSAPEM.privateKey,
      cert: certRSAPEM,
    });
    buildQuicheConfig({
      ...clientDefault,
      key: keyPairECDSAPEM.privateKey,
      cert: certECDSAPEM,
    });
    buildQuicheConfig({
      ...clientDefault,
      key: keyPairEd25519PEM.privateKey,
      cert: certEd25519PEM,
    });
    buildQuicheConfig({
      ...serverDefault,
      key: keyPairRSAPEM.privateKey,
      cert: certRSAPEM,
    });
    buildQuicheConfig({
      ...serverDefault,
      key: keyPairECDSAPEM.privateKey,
      cert: certECDSAPEM,
    });
    buildQuicheConfig({
      ...serverDefault,
      key: keyPairEd25519PEM.privateKey,
      cert: certEd25519PEM,
    });
  });
  test('build with issued certificates', async () => {
    const keyPairParent = await testsUtils.generateKeyPairEd25519();
    const certParent = await testsUtils.generateCertificate({
      certId: '0',
      subjectKeyPair: keyPairParent,
      issuerPrivateKey: keyPairParent.privateKey,
      duration: 60 * 60 * 24 * 365 * 10,
    });
    const certParentPEM = testsUtils.certToPEM(certParent);
    const keyPairChild = await testsUtils.generateKeyPairECDSA();
    const certChild = await testsUtils.generateCertificate({
      certId: '0',
      subjectKeyPair: keyPairChild,
      issuerPrivateKey: keyPairParent.privateKey,
      duration: 60 * 60 * 24 * 365 * 10,
    });
    const keyPairChildPEM = await testsUtils.keyPairECDSAToPEM(keyPairChild);
    const certChildPEM = testsUtils.certToPEM(certChild);
    buildQuicheConfig({
      ...serverDefault,
      ca: certParentPEM,
      key: keyPairChildPEM.privateKey,
      cert: certChildPEM,
    });
    buildQuicheConfig({
      ...clientDefault,
      ca: certParentPEM,
      key: keyPairChildPEM.privateKey,
      cert: certChildPEM,
    });
  });
  test('build with multiple certificate authorities', async () => {
    const keyPairCA1 = await testsUtils.generateKeyPairRSA();
    const keyPairCA2 = await testsUtils.generateKeyPairECDSA();
    const keyPairCA3 = await testsUtils.generateKeyPairEd25519();
    const caCert1 = await testsUtils.generateCertificate({
      certId: '0',
      subjectKeyPair: keyPairCA1,
      issuerPrivateKey: keyPairCA1.privateKey,
      duration: 60 * 60 * 24 * 365 * 10,
    });
    const caCert2 = await testsUtils.generateCertificate({
      certId: '0',
      subjectKeyPair: keyPairCA2,
      issuerPrivateKey: keyPairCA2.privateKey,
      duration: 60 * 60 * 24 * 365 * 10,
    });
    const caCert3 = await testsUtils.generateCertificate({
      certId: '0',
      subjectKeyPair: keyPairCA3,
      issuerPrivateKey: keyPairCA3.privateKey,
      duration: 60 * 60 * 24 * 365 * 10,
    });
    const caCert1PEM = testsUtils.certToPEM(caCert1);
    const caCert2PEM = testsUtils.certToPEM(caCert2);
    const caCert3PEM = testsUtils.certToPEM(caCert3);
    buildQuicheConfig({
      ...clientDefault,
      ca: [caCert1PEM, caCert2PEM, caCert3PEM],
      verifyPeer: true,
    });
    buildQuicheConfig({
      ...serverDefault,
      ca: [caCert1PEM, caCert2PEM, caCert3PEM],
      verifyPeer: true,
    });
  });
  test('build with certificate chain', async () => {
    const keyPairRoot = await testsUtils.generateKeyPairEd25519();
    const certRoot = await testsUtils.generateCertificate({
      certId: '0',
      subjectKeyPair: keyPairRoot,
      issuerPrivateKey: keyPairRoot.privateKey,
      duration: 60 * 60 * 24 * 365 * 10,
    });
    const keyPairIntermediate = await testsUtils.generateKeyPairEd25519();
    const certIntermediate = await testsUtils.generateCertificate({
      certId: '0',
      subjectKeyPair: keyPairIntermediate,
      issuerPrivateKey: keyPairRoot.privateKey,
      duration: 60 * 60 * 24 * 365 * 10,
    });

    const keyPairLeaf = await testsUtils.generateKeyPairEd25519();
    const certLeaf = await testsUtils.generateCertificate({
      certId: '0',
      subjectKeyPair: keyPairLeaf,
      issuerPrivateKey: keyPairIntermediate.privateKey,
      duration: 60 * 60 * 24 * 365 * 10,
    });
    const certRootPEM = testsUtils.certToPEM(certRoot);
    const certIntermediatePEM = testsUtils.certToPEM(certIntermediate);
    const certLeafPEM = testsUtils.certToPEM(certLeaf);
    // These PEMs already have `\n` at the end
    const certChainPEM = [certLeafPEM, certIntermediatePEM].join('');
    const keyPairLeafPEM = await testsUtils.keyPairEd25519ToPEM(keyPairLeaf);
    buildQuicheConfig({
      ...clientDefault,
      ca: certRootPEM,
      key: keyPairLeafPEM.privateKey,
      cert: certChainPEM,
    });
    buildQuicheConfig({
      ...serverDefault,
      ca: certRootPEM,
      key: keyPairLeafPEM.privateKey,
      cert: certChainPEM,
    });
  });
  /**
   * This currently is not supported.
   * But the test will pass.
   */
  test('build with multiple certificate chains', async () => {
    const keyPairParent = await testsUtils.generateKeyPairEd25519();
    const certParent = await testsUtils.generateCertificate({
      certId: '0',
      subjectKeyPair: keyPairParent,
      issuerPrivateKey: keyPairParent.privateKey,
      duration: 60 * 60 * 24 * 365 * 10,
    });
    const certParentPEM = testsUtils.certToPEM(certParent);
    const keyPair1 = await testsUtils.generateKeyPairRSA();
    const keyPairPEM1 = await testsUtils.keyPairRSAToPEM(keyPair1);
    const keyPair2 = await testsUtils.generateKeyPairECDSA();
    const keyPairPEM2 = await testsUtils.keyPairECDSAToPEM(keyPair2);
    const keyPair3 = await testsUtils.generateKeyPairEd25519();
    const keyPairPEM3 = await testsUtils.keyPairEd25519ToPEM(keyPair3);
    const cert1 = await testsUtils.generateCertificate({
      certId: '0',
      subjectKeyPair: keyPair1,
      issuerPrivateKey: keyPairParent.privateKey,
      duration: 60 * 60 * 24 * 365 * 10,
    });
    const cert2 = await testsUtils.generateCertificate({
      certId: '0',
      subjectKeyPair: keyPair2,
      issuerPrivateKey: keyPairParent.privateKey,
      duration: 60 * 60 * 24 * 365 * 10,
    });
    const cert3 = await testsUtils.generateCertificate({
      certId: '0',
      subjectKeyPair: keyPair3,
      issuerPrivateKey: keyPairParent.privateKey,
      duration: 60 * 60 * 24 * 365 * 10,
    });
    const certPEM1 = testsUtils.certToPEM(cert1);
    const certPEM2 = testsUtils.certToPEM(cert2);
    const certPEM3 = testsUtils.certToPEM(cert3);
    buildQuicheConfig({
      ...clientDefault,
      ca: certParentPEM,
      key: [
        keyPairPEM1.privateKey,
        keyPairPEM2.privateKey,
        keyPairPEM3.privateKey,
      ],
      cert: [certPEM1, certPEM2, certPEM3],
      verifyPeer: true,
    });
    buildQuicheConfig({
      ...serverDefault,
      ca: certParentPEM,
      key: [
        keyPairPEM1.privateKey,
        keyPairPEM2.privateKey,
        keyPairPEM3.privateKey,
      ],
      cert: [certPEM1, certPEM2, certPEM3],
      verifyPeer: true,
    });
  });
});
