// llama.cpp hooks (docs/providers.md §4): effort/reasoning mapping, sampling, slot
// pinning, and the server endpoints setup and /server use.

import { call } from './http.ts';
import type { Controls, Effort, Message, Model } from './types.ts';

type Sampling = Record<string, number>;

// Defaults for models Rime knows. Qwen3.8's template takes none/low/medium/xhigh
// (no "high"); sampling per Unsloth's guide. Config `models[ref]` overrides these.
const KNOWN: { match: RegExp; efforts: Model['efforts']; sampling: { reasoning: Sampling; plain: Sampling } }[] = [
  {
    match: /qwen3\.8/i,
    efforts: { off: 'none', low: 'low', medium: 'medium', high: 'xhigh', max: 'xhigh' },
    sampling: {
      reasoning: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0 },
      plain: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5 },
    },
  },
];
const GENERIC: Model['efforts'] = { off: 'none', low: 'low', medium: 'medium', high: 'high', max: 'high' };

export const known = (id: string) => KNOWN.find((k) => k.match.test(id));
export const effortsFor = (m: Pick<Model, 'id' | 'efforts'>) => ({ ...(known(m.id)?.efforts ?? GENERIC), ...m.efforts });

// The extra request fields for one chat completion.
export function extras(m: Model, c: Controls, slot?: number) {
  const efforts = effortsFor(m);
  const value = !c.reasoning ? efforts.off : c.effort ? efforts[c.effort] : undefined;
  const sampling = known(m.id)?.sampling[c.reasoning ? 'reasoning' : 'plain'];
  const budget = c.reasoning && c.effort ? m.budgets?.[c.effort] : undefined;
  return {
    ...(value ? { reasoning_effort: value } : {}),
    ...(budget ? { thinking_budget_tokens: budget } : {}),
    reasoning_control: true, // lets esc end the thinking early (§4.3)
    ...(slot !== undefined ? { id_slot: slot } : {}),
    cache_prompt: true,
    ...sampling,
  };
}

// llama.cpp serves its own endpoints next to /v1.
export const rootOf = (base: string) => base.replace(/\/v1\/?$/, '');

export const health = (root: string, timeout = 1500) => call(`${root}/health`, { timeout });
export const props = (root: string) => call(`${root}/props`);

export type ServerModel = { id: string; status: string; path?: string };

// Router mode lists every model the preset defines, loaded or not. A single-model
// server has no /models route (or answers with the OpenAI shape), which we treat
// as "already loaded".
export async function routerModels(root: string): Promise<ServerModel[] | null> {
  const r = await call(`${root}/models`).catch(() => null);
  if (!r || r.status !== 200 || !r.json) return null;
  const list: any[] = r.json.data ?? r.json.models ?? (Array.isArray(r.json) ? r.json : []);
  return list.map((m) => ({
    id: m.id ?? m.name ?? m.model,
    status: String(m.status?.value ?? m.status ?? m.state ?? 'unknown'),
    path: m.path ?? m.status?.args?.find?.((a: string) => a.endsWith('.gguf')),
  }));
}

export const loadModel = (root: string, model: string) => call(`${root}/models/load`, { body: { model }, timeout: 15000 });
export const unloadModel = (root: string, model: string) => call(`${root}/models/unload`, { body: { model }, timeout: 15000 });

// Waits until `model` is loaded, reporting 0..1 progress from /models/sse
// (download bytes, then loading stages) and polling /models as a fallback.
// Progress never moves backwards (the docs warn mmap can misreport).
export async function waitLoaded(root: string, model: string, onProgress: (p: number | null) => void, timeoutMs = 600000) {
  let best = 0;
  const report = (p: number | null) => {
    if (p === null) return onProgress(null);
    best = Math.max(best, Math.min(1, p));
    onProgress(best);
  };
  const ac = new AbortController();
  const done = new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const poll = setInterval(async () => {
      const list = await routerModels(root).catch(() => null);
      const st = list?.find((m) => m.id === model)?.status;
      if (st === 'loaded' || st === 'ready') finish();
      else if (st === 'failed' || st === 'error') fail(new Error(`${model} failed to load`));
      else if (Date.now() - t0 > timeoutMs) fail(new Error(`${model} didn't load in ${timeoutMs / 1000}s`));
    }, 1000);
    const finish = () => {
      clearInterval(poll);
      ac.abort();
      report(1);
      resolve();
    };
    const fail = (e: Error) => {
      clearInterval(poll);
      ac.abort();
      reject(e);
    };
    // ponytail: the /models/sse event shape is read leniently (verify on b11514).
    fetch(`${root}/models/sse`, { signal: ac.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) return;
        const dec = new TextDecoder();
        let buf = '';
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            let ev: any;
            try {
              ev = JSON.parse(line.slice(5));
            } catch {
              continue;
            }
            if (ev.model && ev.model !== model) continue;
            const dl = ev.download_progress;
            if (dl?.total) report(0.3 * (dl.downloaded ?? dl.bytes ?? 0) / dl.total);
            const v = ev.loading?.value ?? ev.value;
            if (typeof v === 'number') report(dl ? 0.3 + 0.7 * v : v);
            const st = ev.status?.value ?? ev.status;
            if (st === 'loaded') finish();
          }
        }
      })
      .catch(() => {});
  });
  return done;
}

// Ends the model's thinking early so it answers right away (esc, §4.3).
export const endReasoning = (root: string, id: string) =>
  call(`${root}/v1/chat/completions/control`, { body: { id, action: 'reasoning_end' }, timeout: 2000 }).catch(() => null);

// True when every slot is taken (someone else is using the server).
export async function busy(root: string) {
  const r = await call(`${root}/slots?fail_on_no_slot=1`, { timeout: 1500 }).catch(() => null);
  return r?.status === 503;
}

// The cache-safety test (§3.4 step 4): render the same conversation with each
// effort value and with reasoning off through the server's real chat template.
// A knob is safe to change per message when the prompts differ only after the
// last message; "ignored" when the template doesn't use it at all.
export type Safety = 'safe' | 'unsafe' | 'ignored';

export function compareRenders(a: string, b: string, marker: string): Safety {
  if (a === b) return 'ignored';
  let d = 0;
  while (d < a.length && a[d] === b[d]) d++;
  const end = a.lastIndexOf(marker) + marker.length;
  return d >= end ? 'safe' : 'unsafe';
}

export async function templateSafety(root: string, m: Pick<Model, 'id' | 'efforts'>) {
  const marker = 'RIME-PROBE-LAST-MESSAGE';
  const messages: Message[] = [
    { role: 'system', content: 'You are a test.' },
    { role: 'user', content: 'First question.' },
    { role: 'assistant', content: 'First answer.' },
    { role: 'user', content: marker },
  ];
  const render = async (reasoning_effort?: string) => {
    const r = await call(`${root}/apply-template`, { body: { model: m.id, messages, ...(reasoning_effort ? { reasoning_effort } : {}) }, timeout: 5000 });
    if (r.status !== 200 || typeof r.json?.prompt !== 'string') throw new Error(`apply-template: ${r.status}`);
    return r.json.prompt as string;
  };
  const efforts = effortsFor(m);
  const values = [...new Set((['low', 'medium', 'high', 'max'] as Effort[]).map((e) => efforts[e]).filter(Boolean))] as string[];
  const renders = await Promise.all(values.map((v) => render(v)));
  const off = await render(efforts.off);
  const pairs = renders.slice(1).map((r) => compareRenders(renders[0], r, marker));
  const effort: Safety = pairs.includes('unsafe') ? 'unsafe' : pairs.every((p) => p === 'ignored') ? 'ignored' : 'safe';
  return { effort, reasoning: compareRenders(renders[0] ?? off, off, marker) };
}
