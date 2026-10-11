import assert from 'node:assert/strict';
import test from 'node:test';
import { stopAndEnd } from '../client/src/session-end';

test('ends the room after microphone shutdown even if caption delivery failed', async () => {
  const calls: string[] = [];
  const result = await stopAndEnd(async () => { calls.push('stop'); }, async () => { calls.push('flush'); throw new Error('delivery failed'); }, async () => { calls.push('end'); return 'ended'; });
  assert.deepEqual(calls, ['stop', 'flush', 'end']);
  assert.equal(result, 'ended');
});
test('propagates room closure failure so the speaker can retry', async () => {
  await assert.rejects(stopAndEnd(async () => {}, async () => {}, async () => { throw new Error('offline'); }), /offline/);
});
