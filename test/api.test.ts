import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccumulator, sse } from '../src/core/api.ts';

const stream = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });

test('sse parses frames split across chunks', async () => {
  const evs = [];
  for await (const e of sse(stream(['event: a\ndata: {"type":"a"', '}\n\nevent: b\r\ndata: {"type":"b"}\r\n\r\n']))) evs.push(e.type);
  assert.deepEqual(evs, ['a', 'b']);
});

test('accumulator rebuilds blocks, text and usage', () => {
  const acc = createAccumulator();
  const evs = [
    { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi ' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'there' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
  ];
  const text = evs.map((e) => acc.add(e)).join('');
  assert.equal(text, 'hi there');
  assert.deepEqual(acc.blocks, [{ type: 'thinking', thinking: '', signature: 'abc' }, { type: 'text', text: 'hi there' }]);
  assert.deepEqual(acc.usage, { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 });
  assert.equal(acc.stopReason(), 'end_turn');
});
