import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Conv, parse, rank, suggestions } from '../src/core/rank.ts';

const NOW = new Date('2026-10-14T12:00:00').getTime(), D = 86400000;
const convs: Conv[] = [
  { id: 1, title: 'Add rate limiting to the login route', updated: NOW - 3600e3, model: 'gpubox/qwen3.8-27b', timeline: [{ kind: 'edit', text: 'src/auth.ts +31 −4' }, { kind: 'test', text: 'npm test ✓' }] },
  { id: 2, title: 'Fix signup crash when name is missing', updated: NOW - 9 * D, model: 'anthropic/claude-opus-5-5', timeline: [{ kind: 'error', text: "TypeError: Cannot read properties of undefined (reading 'trim') · signup.ts:41" }, { kind: 'edit', text: 'src/signup.ts +2 −1' }, { kind: 'commit', text: 'Handle a missing name in validate' }] },
  { id: 3, title: 'Dark mode for the pricing page', updated: NOW - 2 * D, model: 'anthropic/claude-opus-5-5', timeline: [{ kind: 'edit', text: 'src/pages/Pricing.tsx +88 −12' }] },
];
const none = () => new Set<number>();

test('C-3: describe it: time phrases, outcome words and files, with the reason', () => {
  const r = rank(parse('the one last week where the signup page crashed and we fixed validate', NOW), convs, none, NOW);
  assert.deepEqual(r.map((x) => x.id), [2]);
  assert.match(r[0].reason, /^timeline: TypeError.*· last week$/);
  assert.deepEqual(rank(parse('pricing', NOW), convs, none, NOW).map((x) => [x.id, x.reason]), [[3, 'timeline: src/pages/Pricing.tsx +88 −12']]);
  assert.deepEqual(rank(parse('file:auth.ts', NOW), convs, none, NOW).map((x) => x.id), [1]);
  assert.deepEqual(rank(parse('model:opus today', NOW), convs, none, NOW).map((x) => x.id), [], 'opus, but not today');
  assert.deepEqual(rank(parse('this week', NOW), convs, none, NOW).map((x) => x.id), [1, 3], 'a date alone lists that range, newest first');
  assert.deepEqual(rank(parse('kubernetes', NOW), convs, (w) => new Set(w === 'kubernetes' ? [3] : []), NOW).map((x) => [x.id, x.reason]), [[3, 'messages']], 'message text comes from FTS5');
});

test('C-3: suggestions come from the timeline and the filters', () => {
  assert.deepEqual(suggestions('sig', convs), ['file:signup.ts']);
  assert.deepEqual(suggestions('crash in t', convs), ['today', 'this week']);
  assert.deepEqual(suggestions('npm', convs), [], 'nothing longer than what was typed');
});
