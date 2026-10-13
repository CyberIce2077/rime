// Anthropic Messages API adapter (plain fetch, streaming).

import { postStream } from './http.ts';
import type { Block, Event, Request } from './types.ts';

export async function* stream(req: Request): AsyncGenerator<Event> {
  const { conn, model, controls } = req;
  const betas: string[] = [];
  // Effort changes after the first message go in as an effort-only system
  // message, so the cached prefix survives (beta, SPEC §6).
  if (req.messages.some((m) => m.role === 'system')) betas.push('mid-conversation-output-config-2026-07-01');
  const effort = controls.reasoning ? controls.effort : 'low'; // thinking can't be turned off on current models
  const body = {
    model: model.id,
    max_tokens: req.maxTokens ?? 64000,
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    // Thinking blocks from another provider have no signature and can't be replayed here.
    messages: req.messages.map((m) => (Array.isArray(m.content) ? { ...m, content: m.content.filter((b) => b.type !== 'thinking' || b.signature) } : m)),
    cache_control: { type: 'ephemeral' },
    ...(effort ? { output_config: { effort } } : {}),
  };
  const headers: Record<string, string> = { 'x-api-key': conn.key || '', 'anthropic-version': '2023-06-01' };
  if (betas.length) headers['anthropic-beta'] = betas.join(',');

  const blocks: Block[] = [];
  const usage: Record<string, number> = {};
  for await (const ev of await postStream(`${conn.base}/v1/messages`, headers, body, req.signal)) {
    if (ev.type === 'error') throw new Error(ev.error?.message || 'stream error');
    if (ev.type === 'message_start') {
      Object.assign(usage, ev.message?.usage);
      if (ev.message?.model) yield { type: 'model', id: ev.message.model };
    } else if (ev.type === 'content_block_start') blocks[ev.index] = { ...ev.content_block };
    else if (ev.type === 'content_block_delta') {
      const b = blocks[ev.index], d = ev.delta;
      if (!b || !d) continue;
      if (d.type === 'text_delta') {
        b.text = ((b.text as string) || '') + d.text;
        yield { type: 'text', text: d.text };
      } else if (d.type === 'thinking_delta') {
        b.thinking = ((b.thinking as string) || '') + d.thinking;
        yield { type: 'thinking', text: d.thinking };
      } else if (d.type === 'signature_delta') b.signature = ((b.signature as string) || '') + d.signature;
    } else if (ev.type === 'message_delta') {
      for (const [k, v] of Object.entries(ev.usage || {})) if (typeof v === 'number') usage[k] = v;
      if (ev.delta?.stop_reason) yield { type: 'stop', reason: ev.delta.stop_reason };
    }
  }
  yield { type: 'blocks', blocks: blocks.filter(Boolean) };
  yield {
    type: 'usage',
    usage: {
      input: usage.input_tokens || 0,
      cached: usage.cache_read_input_tokens || 0,
      written: usage.cache_creation_input_tokens || 0,
      output: usage.output_tokens || 0,
    },
  };
}

export async function listModels(base: string, key?: string) {
  const res = await fetch(`${base}/v1/models?limit=100`, {
    headers: { 'x-api-key': key || '', 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return { status: res.status, models: [] };
  const j = (await res.json()) as { data?: { id: string; display_name?: string; max_input_tokens?: number }[] };
  return { status: 200, models: (j.data || []).map((m) => ({ id: m.id, label: m.display_name, context: m.max_input_tokens })) };
}
