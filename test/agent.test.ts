import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type AgentEvent, type Approval, type TurnHost, runTurn } from '../src/core/agent.ts';
import { decide } from '../src/core/permissions.ts';
import { TOOLS, bash, optionsOf, read, write } from '../src/core/tools.ts';
import * as openai from '../src/providers/openai.ts';
import { connOf, modelOf } from '../src/providers/registry.ts';
import type { Block, Message } from '../src/providers/types.ts';
import { startMock } from './fixtures/mock-llama.ts';

// A host with no screen: an in-memory store, the real permissions and tools in a
// temp project, and scripted answers to approvals and questions.
async function harness(o: { approve?: Approval; answer?: string | null; mode?: string; full?: boolean } = {}) {
  const mock = await startMock();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'rime-agent-'));
  const conn = connOf('gpubox', { preset: 'llamacpp' }, `${mock.url}/v1`);
  const model = modelOf({ providers: {}, models: {} }, conn, 'qwen3.8-27b');
  const events: AgentEvent[] = [];
  const rows = new Map<number, { role: string; content: Block[]; interrupted: boolean }>();
  let seq = 0, lastUser = 0, asked = 0;
  const messages: Message[] = [];
  const h: TurnHost = {
    messages,
    stream: (signal) => openai.stream({ conn, model, system: 's', tools: TOOLS, messages, controls: { reasoning: true }, signal, slot: 0 }),
    store: {
      append: (role, content, interrupted) => (rows.set(++seq, { role, content, interrupted }), seq),
      update: (s, content, interrupted) => void rows.set(s, { ...rows.get(s)!, content, interrupted }),
      remove: (s) => void rows.delete(s),
    },
    emit: (e) => events.push(e),
    decide: (u) => decide(String(u.name), (u.input ?? {}) as Record<string, any>, { mode: (o.mode ?? 'ask') as any, project, rules: [] }),
    approve: async () => (asked++, o.approve ?? 'yes'),
    question: async () => (o.answer === undefined ? 'the first one' : o.answer),
    run: async (u) => {
      const i = (u.input ?? {}) as Record<string, any>;
      return u.name === 'write' ? write(project, i as any) : u.name === 'read' ? read(project, i as any) : bash(project, i as any);
    },
    optionsOf,
    afterRound: async () => !o.full,
    setLastUser: (s) => void (lastUser = s),
  };
  const say = async (text: string, signal = new AbortController().signal) => {
    messages.push({ role: 'user', content: text });
    const userSeq = h.store.append('user', [{ type: 'text', text }], false);
    return runTurn(h, signal, userSeq);
  };
  return { h, say, events, rows, messages, project, mock, asked: () => asked, lastUser: () => lastUser, close: () => mock.close() };
}

const roles = (m: Message[]) => m.map((x) => x.role).join(' ');

test('agent: a plain reply streams, is stored and ends the turn', async () => {
  const t = await harness();
  try {
    const r = await t.say('hi');
    assert.equal(r.said, 'Hello there.');
    assert.equal(roles(t.messages), 'user assistant');
    assert.deepEqual(t.events.map((e) => e.type).filter((x) => x !== 'thinking' && x !== 'text' && x !== 'id'), ['start', 'reply', 'end']);
    const stored = [...t.rows.values()].at(-1)!;
    assert.equal(stored.role, 'assistant');
    assert.equal(stored.interrupted, false, 'the live row is finished');
  } finally {
    await t.close();
  }
});

test('agent: a write is asked about, runs, and its result goes back to the model', async () => {
  const t = await harness();
  try {
    const r = await t.say('make a page');
    assert.equal(t.asked(), 1, 'asked once in ask mode');
    assert.ok(fs.existsSync(path.join(t.project, 'index.html')));
    assert.equal(r.said, 'Created index.html.');
    assert.equal(roles(t.messages), 'user assistant user assistant');
    assert.ok(t.events.some((e) => e.type === 'ran'));
  } finally {
    await t.close();
  }
});

test('agent: a declined call is not run and the reason goes back', async () => {
  const t = await harness({ approve: { declined: 'not now' } });
  try {
    const r = await t.say('make a page');
    assert.equal(fs.existsSync(path.join(t.project, 'index.html')), false);
    const results = t.messages[2].content as Block[];
    assert.equal(results[0].content, 'The user declined this and said: not now');
    assert.equal(r.said, 'Okay, I left it.');
  } finally {
    await t.close();
  }
});

test('agent: plan mode refuses the write without asking', async () => {
  const t = await harness({ mode: 'plan' });
  try {
    await t.say('make a page');
    assert.equal(t.asked(), 0);
    assert.ok(t.events.some((e) => e.type === 'denied'));
    assert.equal(fs.existsSync(path.join(t.project, 'index.html')), false);
  } finally {
    await t.close();
  }
});

test('agent: the ask tool waits for the answer', async () => {
  const t = await harness({ answer: 'Same file, your own CUDA kernel' });
  try {
    const r = await t.say('which stack');
    assert.equal(r.said, 'Going with that: Same file, your own CUDA kernel.');
  } finally {
    await t.close();
  }
});

test('agent: a question in text followed by a tool call holds the call', async () => {
  const t = await harness({ mode: 'god' });
  try {
    await t.say('write slowly');
    assert.ok(t.events.some((e) => e.type === 'held'));
    assert.equal(fs.existsSync(path.join(t.project, 'site')), false, 'not written');
    assert.equal(t.messages.at(-1)!.role, 'user', 'the not-run results wait for the next message');
    assert.ok(t.lastUser() > 0, 'your next words join them');
    assert.ok(t.events.some((e) => e.type === 'draft'), 'the tool call was shown while it streamed');
  } finally {
    await t.close();
  }
});

test('agent: stopping mid-reply keeps the text and ends the turn', async () => {
  const t = await harness();
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    await t.say('slow', ac.signal);
    assert.ok(t.events.some((e) => e.type === 'stopped'));
    assert.equal(roles(t.messages), '', 'nothing came, so the message is taken back');
  } finally {
    await t.close();
  }
});

test('agent: a failed request takes the message back', async () => {
  const t = await harness();
  await t.close(); // nothing answers now
  await t.say('hi');
  assert.ok(t.events.some((e) => e.type === 'failed'));
  assert.equal(t.messages.length, 0);
  assert.equal([...t.rows.values()].length, 0);
});

test("agent: when the host can't make room, the turn stops before the next step", async () => {
  const t = await harness({ full: true });
  try {
    const r = await t.say('make a page');
    assert.equal(r.said, '', 'stopped after the tool results, before the next reply');
    assert.equal(t.messages.at(-1)!.role, 'user');
  } finally {
    await t.close();
  }
});
