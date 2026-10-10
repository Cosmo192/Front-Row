import assert from 'node:assert/strict';
import test from 'node:test';
import { CaptionAssembler, mergeCaption, mergeCaptions } from '../client/src/captions.ts';
import type { Caption } from '../shared/protocol.ts';

const caption = (overrides: Partial<Caption> = {}): Caption => ({
  v: 1, type: 'caption', roomId: 'room-one', segmentId: 'stream_000000', revision: 1,
  final: false, text: 'A first draft', startMs: 0, endMs: 1000, ...overrides,
});

test('late drafts and duplicated finals cannot rewrite a committed caption', () => {
  let state = mergeCaption([], caption());
  state = mergeCaption(state, caption({ revision: 3, final: true, text: 'The correct sentence.' }));
  const committed = state;
  for (const incoming of [caption({ revision: 2 }), caption({ revision: 4 }), caption({ revision: 5, final: true, text: 'A changed final' })]) {
    assert.equal(mergeCaption(state, incoming), committed);
  }
  assert.equal(state.length, 1);
  assert.equal(state[0].text, 'The correct sentence.');
});

test('snapshot and realtime overlap produce one ordered transcript', () => {
  const early = caption({ final: true, revision: 3 });
  const later = caption({ segmentId: 'stream_000001', final: true, startMs: 1200, endMs: 2200, text: 'Next sentence' });
  const state = mergeCaptions([later], [early, later, caption({ revision: 2 })]);
  assert.deepEqual(state, [early, later]);
});

test('assembler replaces drafts under one id, then allocates a new id even for repeated words', () => {
  const assembler = new CaptionAssembler('room-one', 'stream');
  const draft = assembler.accept(' hello ', false, 250)!;
  assert.equal(assembler.accept('hello', false, 400), null);
  const final = assembler.accept('hello', true, 500)!;
  const repeated = assembler.accept('hello', true, 1000)!;
  assert.equal(draft.segmentId, final.segmentId);
  assert.ok(final.revision > draft.revision);
  assert.notEqual(final.segmentId, repeated.segmentId);
  assert.equal(repeated.startMs, final.endMs);
  assert.equal(repeated.text, 'hello');
});
