import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createRequestHandler } from '../server/app.ts';
import { issueGuestToken, secretHash } from '../server/auth.ts';
import type { Room } from '../shared/protocol.ts';
import type { DatabaseArguments } from '../server/db.ts';

const room: Room = { id: '11111111-1111-4111-8111-111111111111', code: 'ABC234', title: '', language: 'en', status: 'ended', version: 2, createdAt: new Date().toISOString(), expiresAt: new Date().toISOString() };
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'fixture', SUPABASE_SECRET_KEY: 'fixture', ELEVENLABS_API_KEY: 'fixture', SUPABASE_JWT_SECRET: 'fixture-signing-secret-at-least-thirty-two-characters' };
const speakerToken = `frs_${'a'.repeat(43)}`;

test('title API authenticates the speaker and validates input before writing', async () => {
  const calls: Array<{action: string; args: DatabaseArguments}> = [];
  const handler = createRequestHandler({env, database: {
    async manage(action, args) { calls.push({action, args}); return { room: { ...room, title: (args.payload as {title:string}).title } }; },
    async broadcast() { assert.fail('An ended room must not broadcast a title change'); },
  }});
  const request = (title: unknown, token = speakerToken, method = 'POST') => handler(new Request('https://front-row.test/api/rooms/ABC234/title', {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(method === 'GET' ? {} : {body: JSON.stringify({title})}),
  }));
  assert.equal((await request('Meeting', '', 'POST')).status, 401);
  const guest = await issueGuestToken(env, room, 'audience', '22222222-2222-4222-8222-222222222222');
  assert.equal((await request('Meeting', guest.token)).status, 403);
  assert.equal((await request('Meeting', speakerToken, 'GET')).status, 405);
  for (const invalid of ['x'.repeat(121), 'two\nlines', null, {title:'Nested'}]) assert.equal((await request(invalid)).status, 400);
  assert.equal(calls.length, 0);
  const response = await request('  Neighborhood meeting  ');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).room.title, 'Neighborhood meeting');
  assert.equal(calls[0].action, 'title');
  assert.equal(calls[0].args.secretHash, secretHash(speakerToken));
});
