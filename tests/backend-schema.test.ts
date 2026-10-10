import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Caption, Room } from '../shared/protocol.ts';
import type { DatabaseArguments, DatabaseResult } from '../server/db.ts';

describe('Postgres room invariants (the deployable migration)', { concurrency: false }, () => {
  let pg: PGlite;
  const hash = 'a'.repeat(64);
  const otherHash = 'b'.repeat(64);
  const code = 'ABC234';

  before(async () => {
    pg = new PGlite();
    await pg.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create schema realtime;
      create function auth.jwt() returns jsonb language sql stable as
        $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
      create function realtime.topic() returns text language sql stable as
        $$ select current_setting('realtime.topic', true) $$;
      create table realtime.messages (topic text, extension text);
      alter table realtime.messages enable row level security;
      grant usage on schema public, auth, realtime to service_role, authenticated, anon;
      grant select, insert on realtime.messages to authenticated;
    `);
    await pg.exec(await readFile(new URL('../supabase/migrations/20261010221106_front_row.sql', import.meta.url), 'utf8'));
    await pg.exec(await readFile(new URL('../supabase/migrations/20261011000100_session_title.sql', import.meta.url), 'utf8'));
  });
  after(async () => { await pg?.close(); });
  beforeEach(async () => {
    await pg.exec('reset role; truncate public.front_row_rooms, public.front_row_guests, public.front_row_captions, public.front_row_rate_limits, realtime.messages cascade; set role service_role;');
  });

  async function rpc(action: string, args: DatabaseArguments = { code, secretHash: hash }): Promise<DatabaseResult> {
    const data = await pg.query<{ result: DatabaseResult }>(
      'select public.front_row_manage($1,$2,$3,$4,$5,$6::jsonb,$7) as result',
      [action, args.code, args.secretHash ?? null, args.guestId ?? null, args.claimRoom ?? null,
        JSON.stringify(args.payload ?? {}), args.rateKey ?? null]);
    return data.rows[0].result;
  }
  async function create(roomCode = code, rate = randomUUID()): Promise<Room> {
    const result = await rpc('create', { code: roomCode, secretHash: hash, rateKey: rate, payload: { title: 'Lecture', language: 'en' } });
    assert.ok(result.room, JSON.stringify(result));
    return result.room;
  }
  function caption(room: Room, changes: Partial<Caption> = {}): Caption {
    return { v: 1, type: 'caption', roomId: room.id, segmentId: 'stream-1', revision: 2,
      final: true, text: 'Hello room.', startMs: 0, endMs: 1200, ...changes };
  }

  it('enforces owner authorization and denies browser table/RPC access', async () => {
    await create();
    assert.equal((await rpc('end', { code, secretHash: otherHash })).error, 'UNAUTHORIZED');
    await pg.exec('set role authenticated');
    await assert.rejects(pg.query('select * from public.front_row_rooms'), /permission denied/);
    await assert.rejects(rpc('end'), /permission denied/);
    await pg.exec('set role service_role');
    assert.equal((await rpc('snapshot')).room?.status, 'starting');
  });

  it('only the owner can title an ended session before retention expires', async () => {
    await create();
    const title = async (secret = hash, value = 'Neighborhood meeting') => {
      const result = await pg.query<{ result: DatabaseResult }>('select public.front_row_title($1,$2,$3) as result', [code, secret, value]);
      return result.rows[0].result;
    };
    assert.equal((await title()).error, 'INVALID_REQUEST');
    await rpc('end');
    assert.equal((await title(otherHash)).error, 'UNAUTHORIZED');
    assert.equal((await title(hash, 'x'.repeat(121))).error, 'INVALID_REQUEST');
    assert.equal((await title(hash, 'two\nlines')).error, 'INVALID_REQUEST');
    const result = await title(hash, '  Neighborhood meeting  ');
    assert.equal(result.room?.title, 'Neighborhood meeting');
    assert.equal(result.room?.status, 'ended');
    assert.equal((await title()).room?.version, result.room?.version);
    assert.equal((await rpc('join', { code, guestId: randomUUID(), rateKey: 'wifi' })).error, 'ROOM_UNAVAILABLE');
    await pg.exec('set role authenticated');
    await assert.rejects(title(), /permission denied/);
    await pg.exec('set role anon');
    await assert.rejects(title(), /permission denied/);
    await pg.exec('reset role');
    await pg.exec("update public.front_row_rooms set purge_at = now() - interval '1 second'");
    await pg.exec('set role service_role');
    assert.equal((await title()).error, 'ROOM_UNAVAILABLE');
  });

  it('private Realtime grants allow only this room and presence writes', async () => {
    const room = await create();
    const topic = `room:${room.id}`;
    await pg.exec('reset role');
    await pg.query('insert into realtime.messages values ($1, $2), ($3, $2)', [topic, 'broadcast', `room:${randomUUID()}`]);
    await pg.exec('set role authenticated');
    await pg.query("select set_config('request.jwt.claims', $1, false), set_config('realtime.topic', $2, false)",
      [JSON.stringify({ front_row_room: room.id, front_row_role: 'audience' }), topic]);
    // Realtime evaluates access for the requested topic in a transaction; its payload is never queried as app history.
    const own = await pg.query('select * from realtime.messages where topic = $1', [topic]);
    assert.equal(own.rows.length, 1);
    await pg.query('insert into realtime.messages values ($1, $2)', [topic, 'presence']);
    await assert.rejects(pg.query('insert into realtime.messages values ($1, $2)', [topic, 'broadcast']), /row-level security/);
    await pg.query("select set_config('realtime.topic', $1, false)", [`room:${randomUUID()}`]);
    assert.equal((await pg.query('select * from realtime.messages')).rows.length, 0);
  });

  it('persists only immutable finals and accepts exact final retries', async () => {
    const room = await create();
    assert.equal((await rpc('caption', { code, secretHash: hash, payload: caption(room, { final: false }) })).accepted, true);
    assert.equal((await rpc('snapshot')).captions?.length, 0);
    assert.equal((await rpc('caption', { code, secretHash: hash, payload: caption(room) })).accepted, true);
    assert.equal((await rpc('caption', { code, secretHash: hash, payload: caption(room) })).accepted, true);
    assert.equal((await rpc('snapshot')).captions?.length, 1);
    assert.equal((await rpc('caption', { code, secretHash: hash, payload: caption(room, { text: 'Changed' }) })).error, 'CAPTION_CONFLICT');
    assert.equal((await rpc('caption', { code, secretHash: hash, payload: caption(room, { final: false, revision: 1 }) })).accepted, false);
    assert.equal((await rpc('caption', { code, secretHash: hash, payload: caption(room, { roomId: randomUUID() }) })).error, 'UNAUTHORIZED');
  });

  it('End invalidates joins and writes while authorized viewers can observe ended state', async () => {
    const room = await create();
    const guest = randomUUID();
    await rpc('join', { code, guestId: guest, rateKey: 'shared-wifi' });
    await rpc('caption', { code, secretHash: hash, payload: caption(room) });
    const ended = await rpc('end');
    assert.equal(ended.room?.status, 'ended');
    assert.equal((await rpc('end')).room?.version, ended.room?.version);
    assert.equal((await rpc('join', { code, guestId: randomUUID(), rateKey: 'wifi' })).error, 'ROOM_UNAVAILABLE');
    for (const action of ['heartbeat','state','caption','transcription-token','authorize','refresh']) {
      assert.equal((await rpc(action, { code, secretHash: hash, payload: caption(room) })).error, 'ROOM_ENDED', action);
    }
    const snapshot = await rpc('snapshot', { code, guestId: guest, claimRoom: room.id });
    assert.equal(snapshot.room?.status, 'ended');
    assert.equal(snapshot.captions?.length, 1);
  });

  it('every operation detects stale heartbeats before updating or authorizing', async () => {
    for (const action of ['heartbeat','state','caption','transcription-token','authorize','refresh','snapshot']) {
      await pg.exec('reset role; truncate public.front_row_rooms cascade; set role service_role');
      const room = await create();
      await pg.query("update public.front_row_rooms set heartbeat_deadline = now() - interval '1 second' where code=$1", [code]);
      const result = await rpc(action, { code, secretHash: hash, payload: caption(room) });
      if (action === 'snapshot') assert.equal(result.room?.status, 'ended');
      else assert.equal(result.error, 'ROOM_ENDED', action);
      const rows = await pg.query<{ status: string }>('select status from public.front_row_rooms');
      assert.equal(rows.rows[0].status, 'ended', 'expiry must commit even when operation fails');
    }
  });

  it('hard six-hour expiry overrides a recent heartbeat', async () => {
    await create();
    await pg.query("update public.front_row_rooms set expires_at = now() - interval '1 second', heartbeat_deadline=now()+interval '2 minutes'");
    assert.equal((await rpc('heartbeat')).error, 'ROOM_ENDED');
  });

  it('state versions advance only on changes and reject stale conditional transitions', async () => {
    const room = await create();
    const first = await rpc('state', { code, secretHash: hash, payload: { status: 'listening', expectedVersion: room.version } });
    assert.equal(first.room?.version, room.version + 1);
    assert.equal((await rpc('heartbeat')).room?.version, first.room?.version);
    assert.equal((await rpc('state', { code, secretHash: hash, payload: { status: 'reconnecting', expectedVersion: room.version } })).error, 'STALE_STATE');
    assert.equal((await rpc('snapshot')).room?.status, 'listening');
  });

  it('caps active rooms at five and reclaims expired rooms', async () => {
    for (const value of ['ABC234','ABC235','ABC236','ABC237','ABC238']) await create(value);
    const args = { code: 'ABC239', secretHash: hash, rateKey: randomUUID(), payload: { title: '', language: 'en' } };
    assert.equal((await rpc('create', args)).error, 'ROOM_LIMIT');
    await pg.query("update public.front_row_rooms set heartbeat_deadline=now()-interval '1 second' where code=$1", [code]);
    assert.ok((await rpc('create', args)).room);
  });

  it('caps audience grants at 100, reuses refresh leases, and rejects cross-room grants', async () => {
    const room = await create();
    const firstGuest = randomUUID();
    assert.ok((await rpc('join', { code, guestId: firstGuest, rateKey: 'wifi' })).room);
    for (let i = 1; i < 100; i++) assert.ok((await rpc('join', { code, guestId: randomUUID(), rateKey: 'wifi' })).room);
    assert.equal((await rpc('join', { code, guestId: randomUUID(), rateKey: 'wifi' })).error, 'ROOM_FULL');
    assert.ok((await rpc('refresh', { code, guestId: firstGuest, claimRoom: room.id })).room);
    assert.equal((await rpc('snapshot', { code, guestId: firstGuest, claimRoom: randomUUID() })).error, 'UNAUTHORIZED');
    await pg.query("update public.front_row_guests set expires_at=now()-interval '1 second' where id=$1", [firstGuest]);
    assert.ok((await rpc('join', { code, guestId: randomUUID(), rateKey: 'wifi' })).room);
  });

  it('rate limits expire and cleanup removes transcript rows by cascade', async () => {
    const room = await create();
    await rpc('caption', { code, secretHash: hash, payload: caption(room) });
    for (let i = 0; i < 12; i++) assert.ok((await rpc('transcription-token')).room);
    assert.equal((await rpc('transcription-token')).error, 'RATE_LIMIT');
    await pg.query("update public.front_row_rate_limits set expires_at=now()-interval '1 second'");
    assert.ok((await rpc('transcription-token')).room);
    await rpc('end');
    await pg.query('select public.front_row_cleanup()');
    assert.equal((await pg.query('select * from public.front_row_captions')).rows.length, 1);
    await pg.query("update public.front_row_rooms set purge_at=now()-interval '1 second'");
    await pg.query('select public.front_row_cleanup()');
    assert.equal((await pg.query('select * from public.front_row_captions')).rows.length, 0);
  });
});
