// The setup steps for an own server (docs/providers.md §3.2): wake, connect,
// tunnel, start, load, warm cache, test. Each one is a visible command the user can
// edit or skip; each finishes instantly when it's already satisfied, so a normal
// start with the server on takes well under a second.

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import type { Step } from '../core/config.ts';
import { call } from '../providers/http.ts';
import * as llama from '../providers/llamacpp.ts';
import type { Controls, Model } from '../providers/types.ts';
import { freePort, resolveHost, shell, ssh, tcpOpen } from './ssh.ts';
import { wake } from './wol.ts';

export const STEPS: Step[] = ['wake', 'connect', 'tunnel', 'start', 'load', 'warm', 'test'];
export const NAMES: Record<Step, string> = { wake: 'wake', connect: 'connect', tunnel: 'tunnel', start: 'start', load: 'load', warm: 'warm cache', test: 'test' };
// Share of the loader bar per step; skipped steps drop out.
const WEIGHT: Record<Step, number> = { wake: 0.2, connect: 0.04, tunnel: 0.03, start: 0.08, load: 0.5, warm: 0.1, test: 0.05 };
// Built in: shown so you can see what happens, not editable.
export const BUILTIN: Step[] = ['warm', 'test'];

export type Server = {
  name: string; // provider name, e.g. "gpubox"
  host: string; // ssh host
  remote: string; // where llama-server listens on the server, e.g. 127.0.0.1:8080
  mac?: string;
  broadcast?: string;
  model?: string; // model to load (router mode)
  router: boolean;
};

export type StepView = { id: Step; cmd: string; note?: string; status: 'todo' | 'run' | 'done' | 'off' | 'fail'; result: string; progress: number | null; detail?: string };
export type RunState = { steps: StepView[]; overall: number; done: boolean; error?: string };

export function defaults(s: Server, port: number | string, effort = 'medium'): Record<Step, string> {
  return {
    wake: `wake-on-lan ${s.mac ?? '{mac}'}`,
    connect: `ssh -o BatchMode=yes ${s.host} true`,
    tunnel: `ssh -N -o ExitOnForwardFailure=yes -L ${port}:${s.remote} ${s.host}`,
    start: 'sudo systemctl start llama-server',
    load: `POST /models/load {"model":"${s.model ?? '{model}'}"}`,
    warm: 'tools + system prompt → slot 0',
    test: `one short reply at ${effort} effort`,
  };
}

export const NOTES: Partial<Record<Step, (s: Server) => string>> = {
  wake: (s) => `(skipped if ${s.host} already answers)`,
  tunnel: () => '(Rime keeps it open)',
};

export type Run = {
  state: RunState;
  promise: Promise<{ base: string; tps?: number; warm?: number }>;
};

type Opts = {
  edited?: Partial<Record<Step, string>>;
  skip?: Step[];
  system: string; // the frozen system prompt, to warm the cache with
  model?: Model;
  controls: Controls;
  tunnel: { child: ChildProcess | null; port: number };
  onUpdate: (s: RunState) => void;
  usualWakeSeconds?: number;
};

const secs = (ms: number) => (ms < 10000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000))) + 's';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastLine = (s: string) => s.trim().split('\n').at(-1) ?? '';

export function runSteps(s: Server, o: Opts): Run {
  const usual = o.usualWakeSeconds ?? 30;
  const base = () => `http://127.0.0.1:${o.tunnel.port}`;
  const cmds = { ...defaults(s, o.tunnel.port || '{port}', o.controls.effort ?? 'default'), ...o.edited };
  const state: RunState = {
    steps: STEPS.map((id) => ({ id, cmd: cmds[id], note: NOTES[id]?.(s), status: o.skip?.includes(id) ? 'off' : 'todo', result: o.skip?.includes(id) ? 'skip' : '', progress: 0 })),
    overall: 0,
    done: false,
  };
  const total = state.steps.reduce((a, v) => a + (v.status === 'off' ? 0 : WEIGHT[v.id]), 0) || 1;
  const update = () => {
    state.overall = Math.min(1, state.steps.reduce((a, v) => a + (v.status === 'done' ? WEIGHT[v.id] : v.status === 'run' ? WEIGHT[v.id] * (v.progress ?? 0) : 0), 0) / total);
    o.onUpdate(state);
  };
  const edited = (id: Step) => o.edited?.[id] !== undefined;
  const answers = async () => {
    const r = await llama.health(base(), 1500).catch(() => null);
    return r !== null && (r.status === 200 || r.status === 503);
  };
  const reachable = async () => {
    const h = await resolveHost(s.host);
    return tcpOpen(h.hostname, h.port, 1500);
  };

  const impl: Record<Step, (v: StepView) => Promise<string>> = {
    async wake(v) {
      if (await reachable()) return 'on';
      if (!s.mac && !edited('wake')) throw new Error(`${s.host} is off and Rime has no MAC address to wake it`);
      const t0 = Date.now();
      if (edited('wake')) await shell(v.cmd, 10000);
      else {
        const h = await resolveHost(s.host);
        await wake(s.mac!, s.broadcast);
        if (!s.broadcast) await wake(s.mac!, h.hostname.replace(/\.\d+$/, '.255')).catch(() => {});
      }
      while (!(await reachable())) {
        const el = Date.now() - t0;
        if (el > 120000) throw new Error(`${s.host} didn't answer within 120 s; Wake-on-LAN only works on the same network`);
        v.progress = Math.min(0.95, el / 1000 / usual);
        v.detail = `${Math.round(el / 1000)} s, usually ~${usual} s`;
        update();
        await sleep(1000);
      }
      return secs(Date.now() - t0);
    },
    async connect(v) {
      const t0 = Date.now();
      const r = await shell(v.cmd, 20000);
      if (r.code !== 0) throw new Error(`ssh failed: ${lastLine(r.err) || `exit ${r.code}`}`);
      return secs(Date.now() - t0);
    },
    async tunnel(v) {
      if (o.tunnel.child && o.tunnel.child.exitCode === null && (await tcpOpen('127.0.0.1', o.tunnel.port, 500))) return 'open';
      // Reuse a forward that's already there (e.g. `ssh -fN gpubox-llm` on 8080).
      const rport = Number(s.remote.split(':').pop());
      if (!edited('tunnel') && (await llama.props(`http://127.0.0.1:${rport}`).catch(() => null))?.status === 200) {
        o.tunnel.port = rport;
        return `reused :${rport}`;
      }
      const t0 = Date.now();
      if (!o.tunnel.port || o.tunnel.port === rport) o.tunnel.port = await freePort();
      const cmd = edited('tunnel') ? v.cmd.replaceAll('{port}', String(o.tunnel.port)) : defaults(s, o.tunnel.port).tunnel;
      v.cmd = cmd;
      const child = spawn('sh', ['-c', `exec ${cmd}`], { stdio: 'ignore' });
      o.tunnel.child = child;
      while (!(await tcpOpen('127.0.0.1', o.tunnel.port, 300))) {
        if (child.exitCode !== null) throw new Error(`the tunnel closed (exit ${child.exitCode})`);
        if (Date.now() - t0 > 15000) throw new Error('the tunnel didn\'t open within 15 s');
        await sleep(200);
      }
      return secs(Date.now() - t0);
    },
    async start(v) {
      if (await answers()) return 'running';
      const t0 = Date.now();
      const r = await ssh(s.host, v.cmd, 30000);
      if (r.code !== 0) throw new Error(`${v.cmd}: ${lastLine(r.err) || `exit ${r.code}`}`);
      while (!(await answers())) {
        if (Date.now() - t0 > 60000) throw new Error('llama-server didn\'t answer on /health within 60 s');
        v.progress = Math.min(0.9, (Date.now() - t0) / 10000);
        update();
        await sleep(500);
      }
      return secs(Date.now() - t0);
    },
    async load(v) {
      const t0 = Date.now();
      if (!s.router || !s.model) {
        // A single-model server only says 503 while it loads: shimmer, no percentage.
        v.progress = null;
        update();
        while ((await llama.health(base()).catch(() => null))?.status !== 200) {
          if (Date.now() - t0 > 600000) throw new Error('the model didn\'t load within 10 minutes');
          await sleep(500);
        }
        return 'loaded';
      }
      const list = await llama.routerModels(base());
      if (list?.find((m) => m.id === s.model)?.status === 'loaded') return 'loaded';
      const http = /^(GET|POST)\s+(\/\S*)\s*(.*)$/.exec(v.cmd);
      if (http) {
        const r = await call(`${base()}${http[2]}`, { method: http[1], body: http[3] ? JSON.parse(http[3]) : undefined, timeout: 15000 });
        if (r.status >= 400) throw new Error(`${http[1]} ${http[2]}: ${r.json?.error?.message ?? r.status}`);
      } else {
        const r = await ssh(s.host, v.cmd, 60000);
        if (r.code !== 0) throw new Error(`${v.cmd}: ${lastLine(r.err) || `exit ${r.code}`}`);
      }
      await llama.waitLoaded(base(), s.model, (p) => {
        v.progress = p;
        v.result = p === null ? '' : `${Math.round(p * 100)}%`;
        update();
      });
      return secs(Date.now() - t0);
    },
    async warm() {
      // ponytail: restoring a saved slot arrives with token-kit; until then this
      // sends the frozen system prompt so the next real request reuses it.
      const r = await call(`${base()}/v1/chat/completions`, {
        body: { model: s.model, messages: [{ role: 'system', content: o.system }, { role: 'user', content: 'hi' }], max_tokens: 1, id_slot: 0, cache_prompt: true },
        timeout: 300000,
      });
      if (r.status >= 400) throw new Error(`warming the cache: ${r.json?.error?.message ?? r.status}`);
      const t = r.json?.timings;
      return t ? `${((t.prompt_n ?? 0) + (t.cache_n ?? 0)).toLocaleString('en')} tokens` : 'done';
    },
    async test() {
      const extras = o.model ? llama.extras(o.model, o.controls, 0) : {};
      const r = await call(`${base()}/v1/chat/completions`, {
        body: { model: s.model, messages: [{ role: 'system', content: o.system }, { role: 'user', content: 'Reply with one word: ready' }], max_tokens: 16, ...extras },
        timeout: 300000,
      });
      if (r.status >= 400) throw new Error(`test reply: ${r.json?.error?.message ?? r.status}`);
      const tps = r.json?.timings?.predicted_per_second;
      return tps ? `${Math.round(tps)} t/s` : 'ok';
    },
  };

  const promise = (async () => {
    update();
    for (const v of state.steps) {
      if (v.status === 'off') continue;
      v.status = 'run';
      update();
      try {
        v.result = await impl[v.id](v);
        v.status = 'done';
        v.progress = 1;
        v.detail = undefined;
        update();
      } catch (e) {
        v.status = 'fail';
        state.error = (e as Error).message;
        update();
        throw e;
      }
    }
    state.done = true;
    update();
    const num = (id: Step) => parseFloat(state.steps.find((x) => x.id === id)?.result.replace(/,/g, '') ?? '');
    return { base: `${base()}/v1`, tps: num('test') || undefined, warm: num('warm') || undefined };
  })();
  return { state, promise };
}
