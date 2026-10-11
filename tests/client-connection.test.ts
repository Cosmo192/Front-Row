import assert from 'node:assert/strict';
import test from 'node:test';
import { CaptionPublisher, RequestError, getConfig } from '../client/src/connection.ts';
import type { Caption, RoomSession } from '../shared/protocol.ts';

const session = { room: { code: 'ABCDEF' } } as RoomSession;
const makeCaption = (segmentId: string, revision: number, final = false): Caption => ({
  v: 1, type: 'caption', roomId: 'room', segmentId, revision, final,
  text: `${segmentId}:${revision}`, startMs: 0, endMs: 1000,
});

test('publisher serializes HTTP calls, coalesces queued drafts, and never drops a final', async () => {
  const delivered: Caption[] = [];
  let release!: () => void;
  let active = 0;
  let peak = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const publisher = new CaptionPublisher(session, error => { throw error; }, async (_session, caption) => {
    peak = Math.max(peak, ++active);
    if (!delivered.length) await held;
    delivered.push(caption);
    active--;
  });
  publisher.publish(makeCaption('one', 1));
  publisher.publish(makeCaption('one', 2));
  publisher.publish(makeCaption('one', 3));
  publisher.publish(makeCaption('one', 4, true));
  publisher.publish(makeCaption('one', 5)); // A late draft after commit must never be sent.
  publisher.publish(makeCaption('two', 1));
  publisher.publish(makeCaption('two', 2, true));
  release();
  await publisher.flush();
  assert.equal(peak, 1);
  assert.deepEqual(delivered.map(item => [item.segmentId, item.revision]), [['one', 1], ['one', 4], ['two', 2]]);
});

test('transient final publication retries use an identical idempotent payload', async () => {
  const requests: Caption[] = [];
  const errors: Error[] = [];
  const publisher = new CaptionPublisher(session, error => errors.push(error), async (_session, caption) => {
    requests.push(caption);
    if (requests.length === 1) throw new RequestError('Network unavailable', 'network_error', true);
  });
  const final = makeCaption('one', 3, true);
  publisher.publish(final);
  await publisher.flush();
  assert.deepEqual(requests, [final, final]);
  assert.equal(errors.length, 0);
});

test('a rejected final surfaces to the speaker and flush fails instead of pretending success', async () => {
  const errors: Error[] = [];
  let calls = 0;
  const denied = new RequestError('Session ended', 'room_ended', false, 410);
  const publisher = new CaptionPublisher(session, error => errors.push(error), async () => { calls++; throw denied; });
  publisher.publish(makeCaption('one', 1, true));
  publisher.publish(makeCaption('two', 1, true));
  await assert.rejects(publisher.flush(), /Session ended/);
  assert.equal(calls, 1);
  assert.deepEqual(errors, [denied]);
});

test('backlog is bounded and reports failure when too many finals wait', async () => {
  let release!: () => void;
  const errors: Error[] = [];
  const publisher = new CaptionPublisher(session, error => errors.push(error), () => new Promise<void>(resolve => { release = resolve; }));
  for (let i = 0; i < 35; i++) publisher.publish(makeCaption(String(i), 1, true));
  await assert.rejects(publisher.flush(), /could not be delivered/);
  assert.equal(errors.length, 1);
  release();
});


test('configuration requests preserve same-origin deployment authentication', async () => {
  const originalFetch = globalThis.fetch;
  let credentials: RequestCredentials | undefined;
  globalThis.fetch = async (_input, init) => {
    credentials = init?.credentials;
    return Response.json({ ready: true, missing: [], tier: 1 });
  };
  try {
    assert.equal((await getConfig()).ready, true);
    assert.equal(credentials, 'same-origin');
  } finally { globalThis.fetch = originalFetch; }
});
