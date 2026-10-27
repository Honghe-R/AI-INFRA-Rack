import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import {
  createHmacVerifier,
  createJwtVerifier,
  extractBearerToken,
  localJwks,
  toIdentity,
} from '../index.js';

const SECRET = 'test-secret-value-not-for-production';
const ISSUER = 'https://issuer.test';
const AUDIENCE = 'ai-infra';

async function signHmac(claims = {}, { exp = '5m', issuer = ISSUER, audience = AUDIENCE } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub ?? 'user-1')
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(SECRET));
}

test('the shared-secret verifier accepts a token it issued', async () => {
  const verifier = createHmacVerifier({ secret: SECRET, issuer: ISSUER, audience: AUDIENCE });
  const token = await signHmac({ email: 'a@example.test', name: 'Ada', amr: ['pwd', 'mfa'], auth_time: 1_700_000_000 });
  const identity = await verifier.verify(token);
  assert.equal(identity.subject, 'user-1');
  assert.equal(identity.email, 'a@example.test');
  assert.equal(identity.displayName, 'Ada');
  assert.equal(identity.mfa, true);
  assert.equal(identity.authenticatedAt, 1_700_000_000);
});

test('the shared-secret verifier rejects a token signed elsewhere', async () => {
  const verifier = createHmacVerifier({ secret: SECRET, issuer: ISSUER, audience: AUDIENCE });
  const foreign = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode('a-different-secret'));

  await assert.rejects(() => verifier.verify(foreign));
});

test('the shared-secret verifier rejects an expired token', async () => {
  const verifier = createHmacVerifier({ secret: SECRET, issuer: ISSUER, audience: AUDIENCE });
  const expired = await signHmac({}, { exp: Math.floor(Date.now() / 1000) - 60 });
  await assert.rejects(() => verifier.verify(expired));
});

test('the shared-secret verifier enforces the issuer and audience', async () => {
  const verifier = createHmacVerifier({ secret: SECRET, issuer: ISSUER, audience: AUDIENCE });
  const wrongIssuer = await signHmac({}, { issuer: 'https://someone-else.test' });
  const wrongAudience = await signHmac({}, { audience: 'another-app' });
  await assert.rejects(() => verifier.verify(wrongIssuer));
  await assert.rejects(() => verifier.verify(wrongAudience));
});

test('the shared-secret verifier refuses to exist in production', () => {
  assert.throws(
    () => createHmacVerifier({ secret: SECRET, issuer: ISSUER, env: { NODE_ENV: 'production' } }),
    /not permitted in production/,
  );
  assert.doesNotThrow(() =>
    createHmacVerifier({ secret: SECRET, issuer: ISSUER, env: { NODE_ENV: 'production' }, allowInProduction: true }),
  );
});

test('the JWKS verifier accepts a token signed by the published key', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwks = localJwks({ keys: [{ ...(await exportJWK(publicKey)), kid: 'key-1', alg: 'RS256', use: 'sig' }] });
  const verifier = createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks });

  const token = await new SignJWT({ email: 'b@example.test' })
    .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
    .setSubject('user-2')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);

  const identity = await verifier.verify(token);
  assert.equal(identity.subject, 'user-2');
  assert.equal(identity.mfa, false, 'no amr claim means no second factor');
});

test('the JWKS verifier rejects a token signed by a different key', async () => {
  const trusted = await generateKeyPair('RS256');
  const attacker = await generateKeyPair('RS256');
  const jwks = localJwks({ keys: [{ ...(await exportJWK(trusted.publicKey)), kid: 'key-1', alg: 'RS256', use: 'sig' }] });
  const verifier = createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks });

  const forged = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
    .setSubject('user-2')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(attacker.privateKey);

  await assert.rejects(() => verifier.verify(forged));
});

test('the JWKS verifier requires a key source', () => {
  assert.throws(() => createJwtVerifier({ issuer: ISSUER }), /requires a JWKS/);
});

test('extractBearerToken handles the header shapes', () => {
  assert.equal(extractBearerToken('Bearer abc.def.ghi'), 'abc.def.ghi');
  assert.equal(extractBearerToken('bearer abc'), 'abc');
  assert.equal(extractBearerToken('  Bearer   abc  '), 'abc');
  assert.equal(extractBearerToken('Basic abc'), null);
  assert.equal(extractBearerToken('abc'), null);
  assert.equal(extractBearerToken(undefined), null);
});

test('toIdentity tolerates a sparse payload', () => {
  assert.deepEqual(toIdentity({ sub: 'u' }), {
    subject: 'u',
    email: null,
    displayName: null,
    mfa: false,
    authenticatedAt: null,
  });
});
