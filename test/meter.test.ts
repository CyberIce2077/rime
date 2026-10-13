import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMeter, fmt$, fmtT } from '../src/plugins/token-kit/meter.ts';

test('formats tokens and dollars like the design', () => {
  assert.equal(fmtT(716), '716');
  assert.equal(fmtT(17900), '17.9k');
  assert.equal(fmtT(1_250_000), '1.25M');
  assert.equal(fmt$(0.12), '$0.12');
  assert.equal(fmt$(0.006), '$0.006');
  assert.equal(fmt$(-0.02), '-$0.02');
});

test('charges a hosted turn and counts what caching saved', () => {
  const m = createMeter();
  const turn = m.charge({ input: 80, cached: 16600, written: 1200, output: 716 }, { in: 4, read: 0.2, write: 5, out: 20 });
  assert.equal(turn.in, 17880);
  assert.ok(Math.abs(turn.spent! - 0.02396) < 1e-9); // 80*4 + 16600*0.2 + 1200*5 + 716*20, per million
  assert.ok(Math.abs(turn.saved - 0.06188) < 1e-9); // 16600*(4-0.2) - 1200*(5-4), per million
  assert.equal(m.pct(), 72);
});

test('local turns cost nothing and count the time the cache saved', () => {
  const m = createMeter();
  const turn = m.charge({ input: 1000, cached: 40000, written: 0, output: 800, promptMs: 1470 }, { in: 0, read: 0, write: 0, out: 0 }, true);
  assert.equal(turn.spent, 0);
  assert.equal(Math.round(turn.savedMs!), 58800); // 40k cached tokens at 1.47 ms each
  assert.equal(m.spent(), 0);
});

test('an unknown price shows tokens only', () => {
  const m = createMeter();
  assert.equal(m.charge({ input: 10, cached: 0, written: 0, output: 5 }, undefined).spent, undefined);
  assert.equal(m.unpriced(), true);
});
