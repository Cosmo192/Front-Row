import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// This private key must be imported into Supabase and kept in server secrets.
// Do not print it to the console, commit it, or include it in a browser bundle.
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = { ...privateKey.export({ format: 'jwk' }), alg: 'ES256', kid: randomUUID(), use: 'sig' };
mkdirSync('.keys', { recursive: true, mode: 0o700 });
const destination = resolve('.keys/private-jwk.json');
try {
  writeFileSync(destination, JSON.stringify(jwk), { mode: 0o600, flag: 'wx' });
  console.log(`Saved a private signing key to ${destination}`);
  console.log('Import this key into your new Supabase project, activate it, and set SUPABASE_JWT_PRIVATE_KEY to the same JSON in your server environment. See README.md.');
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error('A signing key already exists. It was not overwritten. Use the existing key or follow the rotation instructions in the README.');
    process.exitCode = 1;
  } else throw error;
}
