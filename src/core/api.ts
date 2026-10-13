// Streaming Messages API over plain fetch (no SDK, per CLAUDE.md).

export type Block = { type: string; [k: string]: unknown };
export type Message = { role: 'user' | 'assistant' | 'system'; content: string | Block[]; [k: string]: unknown };
export type StreamEvent = { type: string; [k: string]: any };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Turns an SSE byte stream into parsed `data:` payloads.
export async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let end;
    while ((end = buf.search(/\r?\n\r?\n/)) >= 0) {
      const frame = buf.slice(0, end);
      buf = buf.slice(end).replace(/^\r?\n\r?\n/, '');
      const data = frame.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data) yield JSON.parse(data);
    }
  }
}

export type Request = {
  apiKey: string;
  baseUrl: string;
  body: Record<string, unknown>;
  betas: string[];
  signal?: AbortSignal;
};

export async function* streamMessages(req: Request): AsyncGenerator<StreamEvent> {
  const res = await fetch(`${req.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': req.apiKey,
      'anthropic-version': '2023-06-01',
      ...(req.betas.length ? { 'anthropic-beta': req.betas.join(',') } : {}),
    },
    body: JSON.stringify({ ...req.body, stream: true }),
    signal: req.signal,
  });
  if (!res.ok || !res.body) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.error?.message) msg = j.error.message;
    } catch {}
    throw new ApiError(res.status, msg);
  }
  for await (const ev of sse(res.body)) {
    if (ev.type === 'error') throw new ApiError(0, ev.error?.message || 'stream error');
    yield ev;
  }
}

// Folds stream events into full content blocks, so the assistant turn can be sent
// back unchanged (thinking blocks included) on the next request.
export function createAccumulator() {
  const blocks: Block[] = [];
  const usage: Record<string, number> = {};
  let stopReason = '';
  return {
    blocks,
    usage,
    stopReason: () => stopReason,
    // Returns any new visible text from this event.
    add(ev: StreamEvent): string {
      if (ev.type === 'message_start') Object.assign(usage, ev.message?.usage);
      else if (ev.type === 'message_delta') {
        for (const [k, v] of Object.entries(ev.usage || {})) if (typeof v === 'number') usage[k] = v;
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
      } else if (ev.type === 'content_block_start') blocks[ev.index] = { ...ev.content_block };
      else if (ev.type === 'content_block_delta') {
        const b = blocks[ev.index], d = ev.delta;
        if (!b || !d) return '';
        if (d.type === 'text_delta') { b.text = (b.text || '') + d.text; return d.text; }
        if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + d.thinking;
        else if (d.type === 'signature_delta') b.signature = (b.signature || '') + d.signature;
        else if (d.type === 'input_json_delta') b._json = ((b._json as string) || '') + d.partial_json;
      }
      return '';
    },
  };
}
