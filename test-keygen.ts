import type { JsonWebKey } from 'crypto';
import crypto from 'crypto';

async function generateKeyPairRSA(): Promise<{
  publicKey: JsonWebKey,
  privateKey: JsonWebKey
}> {
  return new Promise((resolve, reject) => {
    crypto.generateKeyPair('rsa', {
      modulusLength: 2048,
    }, (err, publicKey, privateKey) => {
      if (err) {
        reject(err);
      } else {
        resolve({
          publicKey: publicKey.export({ format: 'jwk' }),
          privateKey: privateKey.export({ format: 'jwk' }),
        });
      }
    });
  });
}

async function generateKeyPairECDSA(): Promise<{
  publicKey: JsonWebKey,
  privateKey: JsonWebKey,
}> {
  return new Promise((resolve, reject) => {
    crypto.generateKeyPair('ec', {
      namedCurve: 'P-256',
    }, (err, publicKey, privateKey) => {
      if (err) {
        reject(err);
      } else {
        resolve({
          publicKey: publicKey.export({
            format: 'jwk'
          }),
          privateKey: privateKey.export({
            format: 'jwk'
          })
        });
      }
    });
  });
}

async function generateKeyPairEd25519(): Promise<{
  publicKey: JsonWebKey,
  privateKey: JsonWebKey
}> {
  return new Promise((resolve, reject) => {
    crypto.generateKeyPair(
      'ed25519',
      undefined,
      (e, publicKey, privateKey) => {
        if (e) {
          reject(e);
        } else {
          resolve({
            publicKey: publicKey.export({
              format: 'jwk'
            }),
            privateKey: privateKey.export({
              format: 'jwk'
            })
          });
        }
      }
    );
  });
}

async function main() {
  console.log(await generateKeyPairRSA());
  console.log(await generateKeyPairECDSA());
  console.log(await generateKeyPairEd25519());
}

void main();
