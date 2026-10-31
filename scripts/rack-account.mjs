#!/usr/bin/env node
// Provision a password login for an existing identity without changing its roles.
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { SignJWT } from 'jose';
import { createPool } from '@ai-infra/db';
import { createAccountStore, normalizeLogin } from './lib/rack-auth.mjs';
import { DEV_IDENTITIES } from './lib/dev-identities.mjs';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--subject', '--login'].includes(args[i]) || !args[i + 1]) throw new Error('Use npm run rack:account -- --subject dev-user --login admin');
  options[args[i].slice(2)] = args[i + 1];
}
const login = normalizeLogin(options.login), identity = DEV_IDENTITIES.find(a => a.subject === options.subject);
if (!identity) throw new Error('Choose an existing seeded backend subject. No roles are created or changed by this command.');
const api = new URL(process.env.API_URL ?? 'http://127.0.0.1:8797');
if (!['localhost', '127.0.0.1', '[::1]'].includes(api.hostname)) throw new Error('Account provisioning requires the isolated local API.');
if (!process.env.AUTH_DEV_SECRET || process.env.AI_INFRA_COMPOSE_FILE !== 'compose.rack.yaml') throw new Error('Load the isolated Rack .env before provisioning.');
let jwt = new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(identity.subject)
  .setIssuer(process.env.AUTH_ISSUER ?? 'https://identity.local').setIssuedAt().setExpirationTime('1m');
if (process.env.AUTH_AUDIENCE) jwt = jwt.setAudience(process.env.AUTH_AUDIENCE);
const bearer = await jwt.sign(new TextEncoder().encode(process.env.AUTH_DEV_SECRET));
const profile = await fetch(new URL('/api/v1/me/permissions', api), { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(5000) });
if (!profile.ok) throw new Error('The backend identity is unavailable, unknown or suspended. No account was provisioned.');
const userId = (await profile.json()).data?.user_id;
const database = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== (process.env.AI_INFRA_DB_PORT ?? '55532') || database.pathname !== '/rack_facility')
  throw new Error('Provisioning requires the isolated Rack database.');
const pool = createPool({ connectionString: process.env.DATABASE_URL, max: 1 });
let organisations;
try { organisations = (await pool.query("SELECT organization_id FROM organization_memberships WHERE user_id=$1 AND status='ACTIVE' ORDER BY organization_id", [userId])).rows; }
finally { await pool.end(); }
const organisationId = identity.organisationId ?? organisations[0]?.organization_id;
if (!organisationId || !organisations.some(o => o.organization_id === organisationId)) throw new Error('The account needs an active organisation membership.');
const store = createAccountStore({ file: fileURLToPath(new URL('../.local-runtime/auth/accounts.json', import.meta.url)) });
const activation = await store.provision({ login, subject: identity.subject, name: identity.name, organisationId });
const link = new URL(`http://localhost:${process.env.WEB_PORT ?? 5193}/`);
link.hash = `activate=${activation}`;
const directory = new URL('../.local-runtime/auth/', import.meta.url);
await mkdir(directory, { recursive: true });
const path = new URL(`activate-${login}.txt`, directory);
await writeFile(path, `Private one-use activation link for ${login}\nExpires in 24 hours. Choose your own password; never commit or share this file publicly.\n\n${link.href}\n`, { mode: 0o600 });
console.log(`Provisioned ${login}. Open ${fileURLToPath(path)} privately to set your password. The activation token is not printed.`);
