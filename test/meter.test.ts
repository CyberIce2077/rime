import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMeter, fmt$, fmtT } from '../src/plugins/token-kit/meter.ts';
import { MODELS } from '../src/core/models.ts';

test('formats tokens and dollars like the design', () => {
  assert.equal(fmtT(716), '716');
  assert.equal(fmtT(17900), '17.9k');
  assert.equal(fmtT(1_250_000), '1.25M');
  assert.equal(fmt$(0.12), '$0.12');
  assert.equal(fmt$(0.006), '$0.006');
  assert.equal(fmt$(-0.02), '-$0.02');
});

test('charges a turn and counts what caching saved', () => {
  const m = createMeter();
  const opus = MODELS.find((x) => x.id === 'claude-opus-5-5')!.price;
  const turn = m.charge({ input_tokens: 80, cache_read_input_tokens: 16600, cache_creation_input_tokens: 1200, output_tokens: 716 }, opus);
  assert.equal(turn.in, 17880);
  assert.equal(turn.cached, 16600);
  // 80*4 + 16600*0.2 + 1200*5 + 716*20, per million
  assert.ok(Math.abs(turn.spent - 0.02396) < 1e-9);
  // 16600*(4-0.2) - 1200*(5-4), per million
  assert.ok(Math.abs(turn.saved - 0.06188) < 1e-9);
  assert.equal(m.totalTokens(), 18596);
  assert.equal(m.pct(), 72);
});
