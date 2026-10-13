import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { sse } from '../src/providers/http.ts';
import * as anthropic from '../src/providers/anthropic.ts';
import { connOf, modelOf } from '../src/providers/registry.ts';
import type { Event } from '../src/providers/types.ts';

const stream = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });

test('sse parses frames split across chunks and stops at [DONE]', async () => {
  const evs = [];
  for await (const e of sse(stream(['event: a\ndata: {"type":"a"', '}\n\nevent: b\r\ndata: {"type":"b"}\r\n\r\ndata: [DONE]\n\ndata: {"type":"c"}\n\n']))) evs.push(e.type);
  assert.deepEqual(evs, ['a', 'b']);
});

test('Anthropic adapter: blocks with signatures, normalized usage, cache markers', async () => {
  let sent: any, headers: any;
  const srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    sent = JSON.parse(raw);
    headers = req.headers;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (o: unknown) => res.write(`event: x\ndata: ${JSON.stringify(o)}\n\n`);
    ev({ type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 1 } } });
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } });
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi ' } });
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'there' } });
    ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } });
    res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const conn = connOf('anthropic', { preset: 'anthropic', key: 'k' }, `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, {});
    const evs: Event[] = [];
    const messages = [
      { role: 'user' as const, content: 'q' },
      { role: 'assistant' as const, content: [{ type: 'thinking', thinking: 'from a local model', signature: '' }, { type: 'text', text: 'a' }] },
      { role: 'user' as const, content: 'q2' },
    ];
    for await (const e of anthropic.stream({ conn, model: modelOf({ providers: {}, models: {} }, conn, 'claude-x'), system: 'SYS', messages, controls: { reasoning: true, effort: 'medium' } })) evs.push(e);
    assert.equal(evs.filter((e) => e.type === 'text').map((e) => (e as any).text).join(''), 'hi there');
    assert.deepEqual((evs.find((e) => e.type === 'blocks') as any).blocks, [{ type: 'thinking', thinking: '', signature: 'abc' }, { type: 'text', text: 'hi there' }]);
    assert.deepEqual((evs.find((e) => e.type === 'usage') as any).usage, { input: 10, cached: 5, written: 2, output: 7 });
    assert.equal(headers['x-api-key'], 'k');
    assert.deepEqual(sent.system[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(sent.output_config, { effort: 'medium' });
    assert.deepEqual(sent.messages[1].content, [{ type: 'text', text: 'a' }], 'unsigned thinking from another provider is dropped');
  } finally {
    srv.close();
  }
});

test('Anthropic adapter: tools go first in the cached prefix, tool_use input streams in', async () => {
  let sent: any;
  const srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    sent = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (o: unknown) => res.write(`event: x\ndata: ${JSON.stringify(o)}\n\n`);
    ev({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } });
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'write', input: {} } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"index.html",' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"content":"<h1>hi</h1>"}' } });
    ev({ type: 'content_block_stop', index: 0 });
    ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } });
    res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const conn = connOf('anthropic', { preset: 'anthropic', key: 'k' }, `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, {});
    const tools = [{ name: 'write', description: 'w', input_schema: { type: 'object' } }];
    const evs: Event[] = [];
    for await (const e of anthropic.stream({ conn, model: modelOf({ providers: {}, models: {} }, conn, 'claude-x'), system: 'S', tools, messages: [{ role: 'user', content: 'make a page' }], controls: { reasoning: true } })) evs.push(e);
    assert.deepEqual(sent.tools, tools);
    assert.deepEqual(evs.find((e) => e.type === 'blocks'), { type: 'blocks', blocks: [{ type: 'tool_use', id: 'tu_1', name: 'write', input: { path: 'index.html', content: '<h1>hi</h1>' } }] });
    assert.deepEqual(evs.find((e) => e.type === 'stop'), { type: 'stop', reason: 'tool_use' });
  } finally {
    srv.close();
  }
});
