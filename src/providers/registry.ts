// Turns config + presets into live connections and model lists.

import type { Config, ProviderConfig } from '../core/config.ts';
import * as anthropic from './anthropic.ts';
import { call } from './http.ts';
import * as llama from './llamacpp.ts';
import * as openai from './openai.ts';
import { PRESETS } from './presets.ts';
import type { Conn, Model } from './types.ts';

export const presetOf = (p: ProviderConfig) => PRESETS[p.preset] ?? PRESETS.generic;

// Environment variable first, then the key saved in the config.
export function keyOf(p: ProviderConfig, env = process.env) {
  const v = p.keyEnv ?? presetOf(p).keyEnv;
  return (v && env[v]) || p.key;
}

export function connOf(name: string, p: ProviderConfig, base: string, env = process.env): Conn {
  const pre = presetOf(p);
  if (pre.llamacpp && base) llama.authorize(base, keyOf(p, env));
  return { name, wire: pre.wire, base: base.replace(/\/$/, ''), key: keyOf(p, env), local: pre.local || !!p.ssh, cache: pre.cache, llamacpp: pre.llamacpp, effortField: pre.effortField, ...(p.probe?.tools ? { tools: p.probe.tools } : {}) };
}

// The first address that answers ("alias or IP", §2.4): a quick /health, then
// /models, 500 ms each.
export async function pickUrl(urls: string[]) {
  for (const u of urls) {
    const root = u.replace(/\/v1\/?$/, '');
    for (const probe of [`${root}/health`, `${u.replace(/\/$/, '')}/models`]) {
      const r = await call(probe, { timeout: 500 }).catch(() => null);
      if (r && r.status < 500) return u;
    }
  }
  return null;
}

// "qwen3.8-27b" -> "Qwen3.8 27B"
export function prettyLabel(id: string) {
  const base = id.split('/').pop()!.replace(/\.gguf$/i, '');
  return base
    .split(/[-_\s]+/)
    .map((w) => (/^\d+(\.\d+)?b$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

export async function listModels(conn: Conn) {
  return conn.wire === 'anthropic' ? anthropic.listModels(conn.base, conn.key) : openai.listModels(conn.base, conn.key);
}

export function modelOf(cfg: Config, conn: Conn, id: string, info: { label?: string; context?: number; price?: Model['price']; vision?: boolean } = {}): Model {
  const ref = `${conn.name}/${id}`;
  const o = cfg.models[ref] ?? {};
  return {
    ref,
    provider: conn.name,
    id,
    label: o.label ?? info.label ?? prettyLabel(id),
    context: o.context ?? info.context,
    price: o.price ?? (conn.local ? { in: 0, read: 0, write: 0, out: 0 } : info.price),
    efforts: o.efforts,
    budgets: o.budgets,
    // Every current Claude model sees images; elsewhere the listing or the server says.
    vision: o.vision ?? info.vision ?? (conn.wire === 'anthropic' ? true : undefined),
  };
}

export const streamFor = (conn: Conn) => (conn.wire === 'anthropic' ? anthropic.stream : openai.stream);
