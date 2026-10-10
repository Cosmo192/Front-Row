import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { defaultSessionTitle } from '../shared/session-title.ts';
import { createRoomInput } from '../server/validation.ts';

test('session date follows the speaker timezone across midnight', () => {
  const date = new Date('2026-10-11T02:00:00Z');
  assert.equal(defaultSessionTitle(date, 'America/New_York'), 'Session — Oct 10, 2026');
  assert.equal(defaultSessionTitle(date, 'UTC'), 'Session — Oct 11, 2026');
});
test('API room creation fills blank names and preserves custom names', () => {
  assert.match(createRoomInput({title: '  ', language:'en'}).title, /^Session — [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  assert.equal(createRoomInput({title:'  Community meeting  ', language:'en'}).title, 'Community meeting');
});
