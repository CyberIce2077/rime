// Plain fetch helpers shared by the adapters: SSE parsing, JSON calls with a
// timeout, and readable API errors.

import { ApiError } from './types.ts';

export type Json = Record<string, any>;

// Turns an SSE byte stream into parsed `data:` payloads ("[DONE]" ends it).
export async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<Json> {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let end;
    while ((end = buf.search(/\r?\n\r?\n/)) >= 0) {
      const frame = buf.slice(0, end);
      buf = buf.slice(end).replace(/^\r?\n\r?\n/, '');
      const data = frame.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data === '[DONE]') return;
      if (data) yield JSON.parse(data);
    }
  }
}

async function errorOf(res: Response): Promise<ApiError> {
  let msg = `${res.status} ${res.statusText}`;
  try {
    const j = await res.json();
    msg = j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : msg);
  } catch {}
  return new ApiError(res.status, msg);
}

// POST that streams SSE back; throws ApiError on a non-2xx answer.
export async function postStream(url: string, headers: Record<string, string>, body: Json, signal?: AbortSignal) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) throw await errorOf(res);
  return sse(res.body);
}

// A JSON request with a timeout. Resolves to { status, json } and never throws
// on HTTP errors; network errors, timeouts and aborts reject.
export async function call(url: string, opts: { method?: string; headers?: Record<string, string>; body?: Json; timeout?: number; signal?: AbortSignal } = {}) {
  const timeout = AbortSignal.timeout(opts.timeout ?? 5000);
  const res = await fetch(url, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

export const bearer = (key?: string): Record<string, string> => (key ? { authorization: `Bearer ${key}` } : {});
