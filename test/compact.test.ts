import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLEARED, SUMMARY_HEAD, clearOld, compacted, cutPoint, tokensOf, transcript } from '../src/plugins/token-kit/compact.ts';
import * as llama from '../src/providers/llamacpp.ts';
import type { Block, Message } from '../src/providers/types.ts';
import { startMock } from './fixtures/mock-llama.ts';

// A long tool-using conversation: each round is a call and its (big) result.
const convo = (rounds: number, big = 4000): Message[] => {
  const m: Message[] = [{ role: 'user', content: 'fix the build' }];
  for (let i = 0; i < rounds; i++) {
    m.push({ role: 'assistant', content: [{ type: 'text', text: `step ${i}` }, { type: 'tool_use', id: `c${i}`, name: 'bash', input: { command: `make ${i}` } }] });
    m.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `c${i}`, content: `out ${i} `.repeat(big / 6) }] });
  }
  return m;
};

// Every tool_result answers the tool_use just before it, and roles alternate.
function valid(m: Message[]) {
  assert.equal(m[0].role, 'user');
  for (let i = 1; i < m.length; i++) {
    assert.notEqual(m[i].role, m[i - 1].role, `roles alternate at ${i}`);
    for (const b of Array.isArray(m[i].content) ? (m[i].content as Block[]) : []) {
      if (b.type !== 'tool_result') continue;
      const prev = m[i - 1].content as Block[];
      assert.ok(prev.some((u) => u.type === 'tool_use' && u.id === b.tool_use_id), `result ${b.tool_use_id} follows its call`);
    }
  }
}

test('compaction keeps a valid tail of about the asked size, after a summary', () => {
  const m = convo(30);
  const cut = cutPoint(m, 8000);
  assert.ok(cut > 0 && m[cut].role === 'assistant');
  const next = compacted(m, cut, 'They were fixing the build.');
  valid(next);
  assert.ok(String((next[0].content as Block[])[0].text).startsWith(SUMMARY_HEAD));
  const tail = tokensOf(next.slice(1));
  assert.ok(tail >= 8000 && tail < 8000 + 2000, `kept ~8k tokens, got ${tail}`);
  assert.equal(cutPoint(convo(1), 8000), 0, 'nothing to cut in a short conversation');
});

test('the summarised part goes as a short transcript, tool output cut', () => {
  const t = transcript(convo(3, 3000));
  assert.match(t, /^User: fix the build/);
  assert.match(t, /\[tool bash\] \{"command":"make 0"\}/);
  assert.ok(t.length < 3 * 600 + 300, 'results are cut to a few hundred characters');
});

test('clearing old tool output keeps the last rounds and frees the rest once', () => {
  const m = convo(8, 3000);
  const freed = clearOld(m, 4);
  assert.ok(freed > 4 * 2500);
  const results = m.filter((x) => x.role === 'user' && Array.isArray(x.content)).map((x) => (x.content as Block[])[0].content);
  assert.deepEqual(results.map((r) => r === CLEARED), [true, true, true, true, false, false, false, false]);
  assert.equal(clearOld(m, 4), 0, 'already cleared');
  valid(m);
});

test("saved slots: a slot's cache goes to a file on the server and comes back", async () => {
  const mock = await startMock();
  const off = await startMock({ noSave: true });
  try {
    const save = await llama.slotAction(mock.url, 0, 'save', 'rime-1-abc.bin');
    assert.equal(save.json.n_saved, 41000);
    assert.equal((await llama.slotAction(mock.url, 1, 'restore', 'rime-1-abc.bin')).json.n_restored, 41000);
    assert.equal((await llama.slotAction(mock.url, 0, 'restore', 'rime-2-zzz.bin')).status, 400, 'nothing saved under that name');
    assert.equal((await llama.slotAction(off.url, 0, 'save', 'x.bin')).status, 501, 'no --slot-save-path');
  } finally {
    await mock.close();
    await off.close();
  }
});
