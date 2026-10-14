// Probing an endpoint (docs/providers.md §3.4), for /setup, /connect and
// `rime connect <url>`: what is it, does it need a key, which models does it serve.

import { bearer, call } from './http.ts';
import { authorize, props, routerModels, templateSafety } from './llamacpp.ts';
import type { ProviderConfig } from '../core/config.ts';
import type { ServerModel } from './llamacpp.ts';

export type Probe = {
  base: string; // the URL requests go to (ends in /v1 for OpenAI-style servers)
  kind: 'llamacpp' | 'ollama' | 'lmstudio' | 'openai';
  needKey: boolean;
  models: { id: string; context?: number }[];
  server?: ServerModel[]; // llama.cpp router mode: every model, loaded or not
  build?: string;
  slots?: number;
  ctx?: number;
  warnings: string[];
};

export const normalizeUrl = (u: string) => (/^https?:\/\//.test(u) ? u : `http://${u}`).replace(/\/+$/, '');

export async function probe(url: string, key?: string): Promise<Probe | null> {
  url = normalizeUrl(url);
  const root = url.replace(/\/v1$/, '');
  const get = (u: string, k?: string) => call(u, { headers: bearer(k), timeout: 3000 }).catch(() => null);

  let base = `${root}/v1`;
  let m = await get(`${base}/models`, key);
  if (!m || m.status === 404) {
    base = url;
    m = await get(`${base}/models`, key);
  }
  if (!m) return null;
  const out: Probe = { base, kind: 'openai', needKey: m.status === 401 || m.status === 403, models: [], warnings: [] };
  if (m.status === 200) {
    const list: any[] = m.json?.data ?? m.json?.models ?? [];
    out.models = list.map((x) => ({ id: String(x.id ?? x.name), context: x.meta?.n_ctx_train ?? x.context_length ?? x.max_model_len }));
  }

  if (key) authorize(root, key);
  const p = await props(root).catch(() => null);
  if (p?.status === 200 && (p.json?.build_info || p.json?.default_generation_settings)) {
    out.kind = 'llamacpp';
    out.build = String(p.json.build_info ?? '').match(/b\d+/)?.[0] ?? p.json.build_info;
    out.slots = p.json.total_slots;
    out.ctx = p.json.default_generation_settings?.n_ctx;
    out.server = (await routerModels(root)) ?? undefined;
    for (const x of out.server ?? out.models) {
      if (/\.gguf$|\//.test(x.id)) out.warnings.push(`${x.id} has no alias; add --alias so Rime can name it`);
    }
    const s = await get(`${root}/slots`, key);
    if (s?.status === 501) out.warnings.push('/slots is disabled; Rime can\'t check whether the server is busy');
  } else if ((await get(`${root}/api/tags`))?.status === 200) out.kind = 'ollama';
  else if ((await get(`${root}/api/v0/models`))?.status === 200) out.kind = 'lmstudio';
  return out;
}

// One request with one tool (SPEC §12 Phase 4): does the server's chat template
// turn the call into tool_calls (native), leave Qwen's <tool_call> text in the
// reply (text), or neither (none)? null when the request fails.
export async function toolSupport(base: string, model: string, key?: string): Promise<'native' | 'text' | 'none' | null> {
  const tool = { type: 'function', function: { name: 'get_time', description: 'Returns the current time.', parameters: { type: 'object', properties: {} } } };
  const r = await call(`${base.replace(/\/$/, '')}/chat/completions`, {
    headers: bearer(key),
    body: { model, messages: [{ role: 'user', content: 'What time is it? Use the get_time tool.' }], tools: [tool], max_tokens: 300, reasoning_effort: 'none' },
    timeout: 60000,
  }).catch(() => null);
  const msg = r?.status === 200 ? r.json?.choices?.[0]?.message : null;
  if (!msg) return null;
  if (msg.tool_calls?.length) return 'native';
  return /<tool_call>/.test(String(msg.content ?? '')) ? 'text' : 'none';
}

// What Rime knows about a llama.cpp server's template (cache safety, tool calls),
// measured again when its build changes; null when what's saved still holds.
// Until it's measured, effort and reasoning count as unsafe to change per message.
export async function recheck(root: string, m: { id: string; efforts?: Record<string, string> }, saved: ProviderConfig['probe']): Promise<NonNullable<ProviderConfig['probe']> | null> {
  const pr = await props(root).catch(() => null);
  if (pr?.status !== 200) return null;
  const build = String(pr.json?.build_info ?? '').match(/b\d+/)?.[0] ?? pr.json?.build_info;
  if (saved && saved.build === build && saved.effortSafe !== undefined && saved.tools) return null;
  const safety = await templateSafety(root, m as any).catch(() => null);
  const tools = (await toolSupport(`${root}/v1`, m.id).catch(() => null)) ?? saved?.tools;
  return {
    ...saved,
    build,
    slots: pr.json?.total_slots,
    ctx: pr.json?.default_generation_settings?.n_ctx,
    ...(safety ? { effortSafe: safety.effort !== 'unsafe', reasoningSafe: safety.reasoning !== 'unsafe' } : {}),
    ...(tools ? { tools } : {}),
  };
}

// Local servers Rime looks for on "This computer" (llama.cpp, Ollama, LM Studio, vLLM).
export const LOCAL_PORTS = [8080, 9931, 11434, 1234, 8000];

export async function findLocal(ports = LOCAL_PORTS) {
  const found = await Promise.all(ports.map((port) => probe(`http://127.0.0.1:${port}`).then((p) => (p && !p.needKey ? { port, probe: p } : null))));
  return found.filter((f) => f !== null);
}
