import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeApiPath } from '../api/handler';

test('Vercel rewrite paths resolve to the API routes without double slashes', () => {
  for (const path of ['config', '/config', '/api/config']) {
    assert.equal(normalizeApiPath(path), '/api/config');
  }
  assert.equal(normalizeApiPath('rooms/ABC234/end'), '/api/rooms/ABC234/end');
});
