// OpenAI Chat Completions adapter, used by every preset except Anthropic.
// Converts Rime's content blocks on the way out (thinking -> reasoning_content,
// tool_use -> tool_calls, tool_result -> role "tool") and back on the way in.

import { bearer, call, postStream } from './http.ts';
import { extras } from './llamacpp.ts';
import type { Block, Event, Message, Request, Usage } from './types.ts';

type Wire = Record<string, unknown>;

export function toWire(system: string, messages: Message[]): Wire[] {
  const out: Wire[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'system') continue; // Anthropic-only effort messages
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (m.role === 'assistant') {
      const reasoning = m.content.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('');
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      out.push({ role: 'assistant', content: text, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content.filter((b) => b.type === 'tool_result')) {
        const c = b.content;
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: typeof c === 'string' ? c : JSON.stringify(c) });
      }
      // Attachments: images go as image_url parts (data URLs), in order with the text.
      if (m.content.some((b) => b.type === 'image')) {
        out.push({
          role: 'user',
          content: m.content.filter((b) => b.type === 'text' || b.type === 'image').map((b) => {
            const src = b.source as { media_type: string; data: string } | undefined;
            return b.type === 'text' ? { type: 'text', text: b.text } : { type: 'image_url', image_url: { url: `data:${src?.media_type};base64,${src?.data}` } };
          }),
        });
      } else {
        const t = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        if (t) out.push({ role: 'user', content: t });
      }
    }
  }
  return out;
}

const STOP: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'refusal' };

// Usage from the final chunk; llama.cpp's `timings` win when present (§2.1).
export function usageOf(u: any, t: any): Usage | null {
  if (t && typeof t.prompt_n === 'number') {
    return { input: t.prompt_n, cached: t.cache_n ?? 0, written: 0, output: t.predicted_n ?? 0, promptMs: t.prompt_ms, genMs: t.predicted_ms };
  }
  if (!u) return null;
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return { input: (u.prompt_tokens ?? 0) - cached, cached, written: 0, output: u.completion_tokens ?? 0 };
}

export function body(req: Request): Wire {
  const { conn, model, controls } = req;
  const b: Wire = {
    model: model.id,
    messages: toWire(req.system, req.messages),
    stream: true,
    stream_options: { include_usage: true },
    ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
  };
  if (req.tools?.length) b.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  if (conn.llamacpp) return { ...b, ...extras(model, controls, req.slot) };
  // ponytail: effort field names per host are from the design note; verify per preset.
  if (conn.effortField === 'reasoning.effort') {
    if (!controls.reasoning) b.reasoning = { enabled: false };
    else if (controls.effort) b.reasoning = { effort: controls.effort === 'max' ? 'high' : controls.effort };
  } else if (!controls.reasoning) b.reasoning_effort = 'none';
  else if (controls.effort) b.reasoning_effort = controls.effort === 'max' ? 'high' : controls.effort;
  return b;
}

export async function* stream(req: Request): AsyncGenerator<Event> {
  let text = '', reasoning = '', usage: Usage | null = null;
  const calls: { id?: string; name?: string; args: string }[] = [];
  let sentId = false;
  for await (const ch of await postStream(`${req.conn.base}/chat/completions`, bearer(req.conn.key), body(req), req.signal)) {
    if (ch.error) throw new Error(ch.error.message || String(ch.error));
    if (ch.id && !sentId) {
      sentId = true;
      yield { type: 'id', id: ch.id };
      if (ch.model) yield { type: 'model', id: ch.model };
    }
    const c = ch.choices?.[0];
    const d = c?.delta;
    if (d?.reasoning_content) {
      reasoning += d.reasoning_content;
      yield { type: 'thinking', text: d.reasoning_content };
    }
    if (d?.content) {
      text += d.content;
      yield { type: 'text', text: d.content };
    }
    for (const tc of d?.tool_calls ?? []) {
      const slot = (calls[tc.index ?? 0] ??= { args: '' });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name = tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
    if (c?.finish_reason) yield { type: 'stop', reason: STOP[c.finish_reason] ?? c.finish_reason };
    usage = usageOf(ch.usage, ch.timings) ?? usage;
  }
  // A server whose chat template doesn't handle tools leaves Qwen's own
  // <tool_call> XML in the text: read the calls from there instead.
  if (!calls.length && req.tools?.length && text.includes('<tool_call>')) {
    const x = textToolCalls(text, req.tools.map((t) => t.name));
    text = x.text;
    for (const c of x.calls) calls.push({ id: c.id, name: c.name, args: JSON.stringify(c.input) });
  }
  const blocks: Block[] = [];
  if (reasoning) blocks.push({ type: 'thinking', thinking: reasoning, signature: '' });
  if (text) blocks.push({ type: 'text', text });
  for (const tc of calls) {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.args || '{}');
    } catch {}
    blocks.push({ type: 'tool_use', id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`, name: tc.name, input });
  }
  if (calls.length) yield { type: 'stop', reason: 'tool_use' };
  yield { type: 'blocks', blocks };
  if (usage) yield { type: 'usage', usage };
}

// Qwen's tool-call text: <tool_call><function=bash><parameter=command>ls</parameter>
// </function></tool_call>, or the JSON form {"name": …, "arguments": {…}}.
export function textToolCalls(text: string, names: string[]) {
  const calls: { id: string; name: string; input: Record<string, unknown> }[] = [];
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  for (const [, body] of text.matchAll(/<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g)) {
    let name: string | undefined, input: Record<string, unknown> = {};
    const fn = /<function=([^>\s]+)>/.exec(body);
    if (fn) {
      name = fn[1];
      for (const [, k, v] of body.matchAll(/<parameter=([^>\s]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) {
        try {
          input[k] = /^\s*[[{0-9tfn-]/.test(v) && !/^\s*\d+[^\d.]/.test(v) ? JSON.parse(v) : v;
        } catch {
          input[k] = v;
        }
      }
    } else {
      try {
        const j = JSON.parse(body.trim());
        name = j.name;
        input = typeof j.arguments === 'string' ? JSON.parse(j.arguments) : (j.arguments ?? {});
      } catch {}
    }
    const known = name && lower.get(name.toLowerCase());
    if (known) calls.push({ id: `call_${Math.random().toString(36).slice(2, 10)}`, name: known, input });
  }
  return { text: calls.length ? text.slice(0, text.indexOf('<tool_call>')).trimEnd() : text, calls };
}

export async function listModels(base: string, key?: string) {
  const r = await call(`${base}/models`, { headers: bearer(key), timeout: 8000 });
  if (r.status !== 200) return { status: r.status, models: [] };
  const list: any[] = r.json?.data ?? r.json?.models ?? [];
  return {
    status: 200,
    models: list.map((m) => ({
      id: String(m.id ?? m.name),
      label: m.name && m.name !== m.id ? m.name : undefined,
      context: m.meta?.n_ctx_train ?? m.context_length ?? m.max_model_len,
      vision: Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities.includes('image') : undefined,
      price: m.pricing ? { in: +m.pricing.prompt * 1e6, out: +m.pricing.completion * 1e6, read: +(m.pricing.input_cache_read ?? m.pricing.prompt) * 1e6, write: +(m.pricing.input_cache_write ?? m.pricing.prompt) * 1e6 } : undefined,
    })),
  };
}
