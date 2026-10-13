// A mock llama.cpp server in router mode, enough for setup, probe and chat tests.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

// xmlTools: answer tool calls as Qwen's text form, like a server without a tool template.
export type MockOpts = { started?: boolean; loaded?: boolean; busy?: boolean; unsafeTemplate?: boolean; key?: string; xmlTools?: boolean };

export async function startMock(o: MockOpts = {}) {
  const state = { started: o.started ?? true, loaded: o.loaded ?? true, busy: !!o.busy, requests: [] as { path: string; body: any }[], controls: [] as any[] };
  const MODEL = 'qwen3.8-27b';
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    const path = (req.url ?? '').split('?')[0];
    state.requests.push({ path: req.url ?? '', body });
    if (path === '/__start') return (state.started = true), send(res, 200, {});
    if (path === '/__stop') return (state.started = false), send(res, 200, {});
    if (!state.started) return void req.socket.destroy(); // the service isn't running
    if (o.key && req.headers.authorization !== `Bearer ${o.key}` && path.startsWith('/v1/')) return send(res, 401, { error: { message: 'Invalid API Key' } });
    if (path === '/health') return send(res, 200, { status: 'ok' });
    if (path === '/props') return send(res, 200, { build_info: 'b11514-1a2b3c', total_slots: 1, default_generation_settings: { n_ctx: 262144 } });
    if (path === '/models') return send(res, 200, { data: [{ id: MODEL, status: { value: state.loaded ? 'loaded' : 'unloaded' } }] });
    if (path === '/models/load') {
      setTimeout(() => (state.loaded = true), 300);
      return send(res, 200, { success: true });
    }
    if (path === '/models/unload') return (state.loaded = false), send(res, 200, { success: true });
    if (path === '/models/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const v of [0.2, 0.5, 0.4, 0.9]) {
        res.write(`data: ${JSON.stringify({ model: MODEL, loading: { value: v } })}\n\n`);
        await new Promise((r) => setTimeout(r, 40));
      }
      return res.end();
    }
    if (path === '/slots') return state.busy ? send(res, 503, { error: 'no slot' }) : send(res, 200, [{ id: 0, n_past: 3100 }]);
    if (path === '/v1/models') return send(res, 200, { data: [{ id: MODEL, meta: { n_ctx_train: 262144 } }] });
    if (path === '/apply-template') {
      const msgs = body.messages.map((m: any) => `<${m.role}>${m.content}`).join('');
      const eff = body.reasoning_effort ?? 'xhigh';
      // A safe template puts the effort in the generation prompt; an unsafe one in the system block.
      return send(res, 200, { prompt: o.unsafeTemplate ? `[effort=${eff}]${msgs}<assistant>` : `${msgs}<assistant><think effort=${eff}>` });
    }
    if (path === '/v1/chat/completions/control') return state.controls.push(body), send(res, 200, { success: true });
    if (path === '/v1/chat/completions') {
      const timings = { prompt_n: 120, prompt_ms: 180, cache_n: 3000, predicted_n: 12, predicted_ms: 480, predicted_per_second: 25.1, prompt_per_second: 680 };
      if (!body.stream) return send(res, 200, { id: 'cmpl-1', choices: [{ message: { content: 'ready' }, finish_reason: 'stop' }], timings });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: any, extra: any = {}) => res.write(`data: ${JSON.stringify({ id: 'cmpl-1', model: MODEL, choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`);
      const end = (reason: string) => {
        res.write(`data: ${JSON.stringify({ id: 'cmpl-1', choices: [{ index: 0, delta: {}, finish_reason: reason }], timings })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      };
      // With tools: "make a page" writes index.html, then a short answer.
      const last = body.messages.at(-1);
      if (body.tools && last.role === 'user' && /make a page/.test(JSON.stringify(last.content))) {
        const args = { path: 'index.html', content: '<!doctype html>\n<h1>I love beb &lt;3</h1>' };
        if (o.xmlTools) chunk({ content: `Writing it.\n<tool_call>\n<function=write>\n<parameter=path>\n${args.path}\n</parameter>\n<parameter=content>\n${args.content}\n</parameter>\n</function>\n</tool_call>` });
        else chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write', arguments: JSON.stringify(args) } }] });
        return end(o.xmlTools ? 'stop' : 'tool_calls');
      }
      if (body.tools && last.role === 'tool') {
        chunk({ content: /declined/.test(last.content) ? 'Okay, I left it.' : 'Created index.html.' });
        return end('stop');
      }
      // "slow": a reply that takes about three seconds (for switching away while it works).
      if (/slow/.test(JSON.stringify(last.content))) {
        for (let k = 0; k < 15; k++) {
          chunk({ reasoning_content: 'hmm ' });
          await new Promise((r) => setTimeout(r, 200));
        }
        chunk({ content: 'Finished the slow job.' });
        return end('stop');
      }
      // "ponder": several lines of thinking over about two seconds, then a short answer.
      if (/ponder/.test(JSON.stringify(last.content))) {
        const lines = ['The user wants a review of the kernel sketch.', 'Register widths are mixed: xmm0 is loaded, then ymm0 appears.', 'psrldq takes an immediate, not a register.', 'After the shift the high nibble needs a mask with 0x0F.', 'So there are three real bugs; list them first.', 'Then the design questions.'];
        for (const l of lines) {
          chunk({ reasoning_content: l + '\n' });
          await new Promise((r) => setTimeout(r, 350));
        }
        chunk({ content: 'Three bugs in the kernel sketch, then two design questions.' });
        return end('stop');
      }
      if (/ascii cat/.test(JSON.stringify(last.content))) {
        chunk({ content: "```\n     /\\_/\\\n    ( o.o )\n     > ^ <\n    /|   |\\\n   (_|   |_)\n      ~~~\n```\n\nAnd a bigger one for good measure:\n\n```\n   |\\      _,,,---,,_\n   /  \\. '___\\_ /'_/\\_  _\n  \\     \\  '---\\_ /\\  \\/_,\n   \\    \\_      \\ /_\n```\n\nWant me to save it to a file, or make an animated one (multiple frames cycling in the terminal)?" });
        return end('stop');
      }
      chunk({ reasoning_content: 'Let me ' });
      chunk({ reasoning_content: 'think.' });
      chunk({ content: 'Hello ' });
      chunk({ content: 'there.' });
      res.write(`data: ${JSON.stringify({ id: 'cmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3120, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 3000 } }, timings })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    send(res, 404, { error: { message: 'not found' } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}
