import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as openai from '../src/providers/openai.ts';
import * as llama from '../src/providers/llamacpp.ts';
import { findLocal, probe } from '../src/providers/probe.ts';
import { connOf, modelOf, prettyLabel } from '../src/providers/registry.ts';
import type { Event, Message } from '../src/providers/types.ts';
import { startMock } from './fixtures/mock-llama.ts';

const cfg = { providers: {}, models: {} };

test('OpenAI wire: thinking, tool calls and tool results convert both ways', () => {
  const msgs: Message[] = [
    { role: 'user', content: 'fix it' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: '' }, { type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] },
    { role: 'system', content: [], output_config: { effort: 'low' } },
  ];
  assert.deepEqual(openai.toWire('SYS', msgs), [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'fix it' },
    { role: 'assistant', content: 'Reading.', reasoning_content: 'hmm', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'file body' },
  ]);
});

test('llama.cpp request: Qwen3.8 effort map, sampling per mode, slot and cache', () => {
  const conn = connOf('gpubox', { preset: 'llamacpp' }, 'http://127.0.0.1:18080/v1');
  const model = modelOf(cfg, conn, 'qwen3.8-27b');
  assert.equal(model.label, 'Qwen3.8 27B');
  assert.deepEqual(model.price, { in: 0, read: 0, write: 0, out: 0 }, 'local is free');
  const high = openai.body({ conn, model, system: 's', messages: [], controls: { reasoning: true, effort: 'high' }, slot: 0 });
  assert.equal(high.reasoning_effort, 'xhigh', 'Qwen3.8 has no "high"');
  assert.equal(high.id_slot, 0);
  assert.equal(high.cache_prompt, true);
  assert.equal(high.temperature, 1.0);
  const off = openai.body({ conn, model, system: 's', messages: [], controls: { reasoning: false } });
  assert.equal(off.reasoning_effort, 'none');
  assert.equal(off.presence_penalty, 1.5);
  const def = openai.body({ conn, model, system: 's', messages: [], controls: { reasoning: true } });
  assert.equal(def.reasoning_effort, undefined, 'no effort: the template default');
});

test('other hosts: effort goes where the preset says', () => {
  const or = connOf('openrouter', { preset: 'openrouter' }, 'https://openrouter.ai/api/v1');
  const m = modelOf(cfg, or, 'some/model');
  assert.deepEqual(openai.body({ conn: or, model: m, system: 's', messages: [], controls: { reasoning: false } }).reasoning, { enabled: false });
  assert.deepEqual(openai.body({ conn: or, model: m, system: 's', messages: [], controls: { reasoning: true, effort: 'max' } }).reasoning, { effort: 'high' });
  const oa = connOf('openai', { preset: 'openai' }, 'https://api.openai.com/v1');
  assert.equal(openai.body({ conn: oa, model: m, system: 's', messages: [], controls: { reasoning: true, effort: 'low' } }).reasoning_effort, 'low');
});

test('streaming from llama.cpp: thinking, text, blocks and usage from timings', async () => {
  const mock = await startMock();
  try {
    const conn = connOf('gpubox', { preset: 'llamacpp' }, `${mock.url}/v1`);
    const evs: Event[] = [];
    for await (const ev of openai.stream({ conn, model: modelOf(cfg, conn, 'qwen3.8-27b'), system: 's', messages: [{ role: 'user', content: 'hi' }], controls: { reasoning: true, effort: 'medium' }, slot: 0 })) evs.push(ev);
    assert.equal(evs.filter((e) => e.type === 'text').map((e) => (e as any).text).join(''), 'Hello there.');
    assert.deepEqual(evs.find((e) => e.type === 'id'), { type: 'id', id: 'cmpl-1' });
    assert.deepEqual((evs.find((e) => e.type === 'blocks') as any).blocks, [{ type: 'thinking', thinking: 'Let me think.', signature: '' }, { type: 'text', text: 'Hello there.' }]);
    assert.deepEqual((evs.find((e) => e.type === 'usage') as any).usage, { input: 120, cached: 3000, written: 0, output: 12, promptMs: 180, genMs: 480 });
    const sent = mock.state.requests.find((r) => r.path === '/v1/chat/completions')!.body;
    assert.equal(sent.reasoning_effort, 'medium');
    assert.equal(sent.stream_options.include_usage, true);
  } finally {
    await mock.close();
  }
});

test('usage without timings comes from the OpenAI block', () => {
  assert.deepEqual(openai.usageOf({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } }, null), { input: 200, cached: 800, written: 0, output: 50 });
});

test('probe recognises llama.cpp router mode and a key-protected server', async () => {
  const mock = await startMock();
  const locked = await startMock({ key: 'sekrit' });
  try {
    const p = (await probe(mock.url))!;
    assert.equal(p.kind, 'llamacpp');
    assert.equal(p.base, `${mock.url}/v1`);
    assert.equal(p.build, 'b11514');
    assert.equal(p.slots, 1);
    assert.equal(p.ctx, 262144);
    assert.deepEqual(p.server, [{ id: 'qwen3.8-27b', status: 'loaded', path: undefined }]);
    assert.equal((await probe(locked.url))!.needKey, true);
    assert.equal((await probe(locked.url, 'sekrit'))!.needKey, false);
    assert.equal(await probe('http://127.0.0.1:1'), null);
  } finally {
    await mock.close();
    await locked.close();
  }
});

test('the template cache-safety test tells safe from unsafe', async () => {
  assert.equal(llama.compareRenders('abcMARKERx', 'abcMARKERy', 'MARKER'), 'safe');
  assert.equal(llama.compareRenders('a1MARKER', 'a2MARKER', 'MARKER'), 'unsafe');
  assert.equal(llama.compareRenders('same', 'same', 'MARKER'), 'ignored');
  const safe = await startMock();
  const unsafe = await startMock({ unsafeTemplate: true });
  try {
    assert.deepEqual(await llama.templateSafety(safe.url, { id: 'qwen3.8-27b' }), { effort: 'safe', reasoning: 'safe' });
    assert.deepEqual(await llama.templateSafety(unsafe.url, { id: 'qwen3.8-27b' }), { effort: 'unsafe', reasoning: 'unsafe' });
  } finally {
    await safe.close();
    await unsafe.close();
  }
});

test('model loading reports progress that never goes backwards', async () => {
  const mock = await startMock({ loaded: false });
  try {
    await llama.loadModel(mock.url, 'qwen3.8-27b');
    const seen: number[] = [];
    await llama.waitLoaded(mock.url, 'qwen3.8-27b', (p) => p !== null && seen.push(p));
    assert.equal(seen.at(-1), 1);
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'monotonic even when the server reports 0.5 then 0.4');
  } finally {
    await mock.close();
  }
});

test('busy and reasoning_end', async () => {
  const mock = await startMock({ busy: true });
  try {
    assert.equal(await llama.busy(mock.url), true);
    mock.state.busy = false;
    assert.equal(await llama.busy(mock.url), false);
    await llama.endReasoning(mock.url, 'cmpl-9');
    assert.deepEqual(mock.state.controls, [{ id: 'cmpl-9', action: 'reasoning_end' }]);
  } finally {
    await mock.close();
  }
});

test('labels', () => {
  assert.equal(prettyLabel('qwen3.8-27b'), 'Qwen3.8 27B');
  assert.equal(prettyLabel('/home/me/models/Llama-3.3-70b.gguf'), 'Llama 3.3 70B');
});

test('"This computer" finds servers on the given local ports', async () => {
  const mock = await startMock();
  try {
    const found = await findLocal([mock.port, 1]);
    assert.equal(found.length, 1);
    assert.equal(found[0].port, mock.port);
    assert.equal(found[0].probe.kind, 'llamacpp');
  } finally {
    await mock.close();
  }
});
