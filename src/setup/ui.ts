// The setup box (docs/providers.md §3, reference/rime-setup.html): first run or
// /setup. Own server (llama.cpp over ssh), this computer, or a hosted provider.
// Rime writes ~/.rime/config itself at the end; nobody edits it by hand.

import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config, ProviderConfig, Step } from '../core/config.ts';
import { type Key, type Line, fit, lineWidth, wrap } from '../core/term.ts';
import type { BoxRow, Item, Styles } from '../core/view.ts';
import { listRow, settingRow } from '../core/view.ts';
import * as llama from '../providers/llamacpp.ts';
import { HOSTED, PRESETS } from '../providers/presets.ts';
import { type Probe, findLocal, probe, toolSupport } from '../providers/probe.ts';
import { connOf, keyOf, listModels, modelOf, prettyLabel } from '../providers/registry.ts';
import type { Effort, Model } from '../providers/types.ts';
import { bar, createLoader } from './loader.ts';
import * as sshx from './ssh.ts';
import { BUILTIN, Cancelled, NAMES, type Run, type RunState, STEPS, type Server, defaults, happened, runSteps } from './steps.ts';
import { broadcastFor, onLan, wake } from './wol.ts';

export type PanelView = { legend: Line; rows: BoxRow[]; foot: string[]; warn?: boolean };

// A box above the prompt that owns the keyboard while it's open.
export interface Panel {
  view(width: number): PanelView;
  placeholder?(): string | undefined;
  status?(): Line | undefined;
  masked?(): boolean;
  typing?(): boolean; // printable keys go to the prompt (filters, host names, edits)
  key(k: Key, buf: string): boolean; // true when the panel handled it
  submit?(buf: string): void;
  changed?(buf: string): void; // the prompt text changed while typing
  click?(id: string): void;
  // ctrl+c or ✕: cancel the whole flow (SPEC §5.2). Without it the box just closes.
  cancel?(): void;
}

export type Tunnel = { child: ChildProcess | null; port: number };

export type Host = {
  st: Styles;
  cfg: Config;
  system: string;
  redraw(): void;
  close(): void;
  setBuffer(s: string): void;
  say(item: Item): void;
  save(): void;
  activate(model: Model, base: string): void; // make it the current model
  tunnel(name: string): Tunnel;
  // Keep a run going from the header; `panel` is what /setup brings back.
  background(name: string, run: Run, done: Promise<unknown>, panel?: Panel): void;
  open(panel: Panel): void; // replace the open box
};

// Answers from a setup that was cancelled before it finished. Nothing is saved
// to the config; the next /setup offers to continue (SPEC §5.2). Kept for this
// Rime process only.
type Draft = { at: 'where' | 'model' | 'steps'; host: string; data: Record<string, any> };
let draft: Draft | null = null;

type Mark = 'ok' | 'warn' | 'run' | 'fail';
type Check = { mark: Mark; text: Line };

const EFF: Effort[] = ['low', 'medium', 'high'];
// What "this computer" starts when llama-server is installed but not running
// (router mode: models from its cache; edit it to name one).
const LOCAL_START = 'llama-server --port 8080';
const QUIT: [ProviderConfig['onQuit'] & string, string][] = [['keep', 'keep running'], ['stop', 'stop the server'], ['poweroff', 'power off {host}']];
// Own-server screens and their place in "setup · n of 4".
const ORDER = ['start', 'where', 'model', 'steps'] as const;
// Steps that change the machine are marked before they run.
const CHANGES: Step[] = ['wake', 'start', 'load'];

// start: the first screen; 'steps' reopens a saved server's steps, 'connect'
// probes `url` (/connect) and goes straight to its key or models.
export function createSetup(h: Host, start: 'start' | 'steps' | 'connect' = 'start', serverName?: string, url?: string): Panel {
  const { st } = h;
  const dim = (t: string) => ({ t, s: st.dim });
  const title = (t: string) => ({ t, s: st.title });
  const plain = (t: string) => ({ t, s: st.fg });
  const accent = (t: string) => ({ t, s: st.accent });

  let screen: 'start' | 'resume' | 'where' | 'model' | 'steps' | 'running' | 'local' | 'providers' | 'key' | 'models' = 'start';
  let pick = 0;
  let filter = '';

  // ---- own server state ----
  let host = sshx.sshHosts()[0] ?? '';
  let typed = host; // what's typed in the prompt on the "where" screen
  let checks: Check[] = [];
  let checking = false, checked = false, needMac = false, needWake = false, wakePort = 22;
  let hostname = '', user: string | undefined;
  let unit: sshx.Unit | null = null, build: string | undefined, gpu: sshx.Gpu | null = null;
  let presets: Record<string, Record<string, string>> = {};
  let mac: string | undefined;
  let models: { id: string; help: string }[] = [];
  let modelPick = 0;
  const settings = { effort: EFF.indexOf(h.cfg.effort as Effort) >= 0 ? EFF.indexOf(h.cfg.effort as Effort) : 1, reasoning: h.cfg.reasoning === false ? 1 : 0, wake: 0, quit: 0, save: 0 };
  let edits: Partial<Record<Step, string>> = {};
  let skip = new Set<Step>();
  let stepSel = 0;
  let editing: Step | null = null;
  let run: Run | null = null;
  let runError = '';
  const loader = createLoader();
  let anim: NodeJS.Timeout | null = null;
  let blinkAt = 0;
  let inBg = false; // the run went to the background; finishing mustn't close another box
  let stopping = false; // ctrl+c was pressed while steps run
  let woke = false; // the user said yes to waking the machine

  // ---- local / provider state ----
  let local: { port: number; probe: Probe }[] = [];
  let looking = false;
  let preset = '';
  let key = '';
  let keyError = '';
  let provModels: { id: string; label?: string; context?: number; price?: Model['price'] }[] = [];
  let provBase = '';
  let provWarnings: string[] = []; // what the probe found wrong with a /connect server
  let provName = '';
  let fromLocal = false;

  const name = () => serverName ?? (/^[\d.]+$/.test(host) ? 'server' : host);
  const server = (): Server => {
    const remote = unit ? `${unit.host === '0.0.0.0' ? '127.0.0.1' : unit.host}:${unit.port}` : '127.0.0.1:8080';
    return { name: name(), host, remote, mac, broadcast: hostname ? broadcastFor(hostname) : undefined, model: models[modelPick]?.id, router: unit?.router ?? true };
  };

  let connectUrl = '';
  if (start === 'connect' && url) {
    connectUrl = url;
    screen = 'models';
    provModels = [];
    connectProbe();
  }

  // An earlier setup was cancelled: offer to continue it.
  if (start === 'start' && draft) screen = 'resume';

  // Reopening /setup for a saved server goes straight to its steps.
  if (start === 'steps' && serverName && h.cfg.providers[serverName]) {
    const p = h.cfg.providers[serverName];
    host = p.ssh ?? serverName;
    mac = p.wake?.mac;
    edits = { ...p.steps };
    skip = new Set(p.skip);
    models = p.model ? [{ id: p.model, help: '' }] : [];
    const [rh, rp] = (p.tunnel?.remote ?? '127.0.0.1:8080').split(':');
    unit = { router: p.router ?? !!p.model, host: rh, port: +rp, args: [] };
    // Its saved settings, so finishing again keeps them.
    settings.quit = Math.max(0, QUIT.findIndex(([q]) => q === p.onQuit));
    settings.save = p.saveCache === false ? 1 : 0;
    settings.wake = skip.has('wake') ? 1 : 0;
    screen = 'steps';
  }

  const add = (mark: Mark, ...text: Line) => {
    const c = { mark, text };
    checks.push(c);
    h.redraw();
    return c;
  };

  // The where screen's own checks (survey, wake wait): esc or ctrl+c stop them at once.
  let whereAc = new AbortController();
  const stopWhere = () => (whereAc.abort(), (whereAc = new AbortController()), (checking = false));

  // Where does it run? Each check appears as it finishes.
  async function survey(woken = false) {
    const signal = whereAc.signal;
    checking = true;
    checked = needMac = needWake = false;
    if (!woken) checks = [];
    try {
      const r = await sshx.resolveHost(host);
      hostname = r.hostname;
      user = r.user;
      const inConfig = sshx.sshHosts().includes(host);
      const hostLine = inConfig
        ? add('ok', plain(`${host} in ~/.ssh/config `), dim(`· ${hostname}${user ? ` · user ${user}` : ''}`))
        : add('warn', plain(`${host} isn't in ~/.ssh/config `), dim('· using it as an address'));
      mac = mac ?? h.cfg.providers[name()]?.wake?.mac;
      if (!woken && !(await sshx.tcpOpen(hostname, r.port, 2000))) {
        // Waking changes the machine, so Rime asks first (the MAC counts as a yes).
        wakePort = r.port;
        if (!mac) {
          needMac = true;
          add('warn', plain(`${host} is off `), dim('· type its MAC address below and Rime will wake it, or turn it on and press enter'));
        } else {
          needWake = true;
          add('warn', plain(`${host} is off `), dim(`· enter wakes it (Wake-on-LAN ${mac})`));
        }
        return;
      }
      const c = add('run', plain(`connecting to ${host}…`));
      const t = await sshx.ssh(host, 'true', 20000, undefined, signal);
      if (signal.aborted) return;
      if (t.code !== 0) {
        Object.assign(c, { mark: 'fail', text: [plain(`ssh ${host} failed `), dim(`· ${t.err.trim().split('\n').at(-1) ?? `exit ${t.code}`}`)] });
        return;
      }
      checks.splice(checks.indexOf(c), 1);
      if (inConfig) hostLine.text.push(dim(' · key login'));
      const sv = sshx.sections((await sshx.ssh(host, sshx.SURVEY, 20000, undefined, signal)).out);
      if (signal.aborted) return;
      mac = sv.MAC?.trim() || mac;
      unit = sshx.parseUnit(sv.UNIT ?? '');
      gpu = sshx.parseGpu(sv.GPU ?? '');
      if (unit) {
        const more = sshx.sections((await sshx.ssh(host, sshx.detailsScript(unit), 20000, undefined, signal)).out);
        if (signal.aborted) return;
        build = sshx.buildOf(more.VERSION ?? '');
        presets = sshx.parseIni(more.PRESETS ?? '');
        add('ok', plain('llama-server.service '), dim(`· ${unit.router ? 'router mode' : 'single model'} · ${unit.host}:${unit.port}${build ? ` · llama.cpp ${build}` : ''}`));
        for (const w of sshx.unitWarnings(unit)) add('warn', plain(w));
      } else add('warn', plain('no llama-server.service '), dim('· edit the start step to run your server'));
      models = Object.entries(presets)
        .filter(([k, v]) => k !== '*' && (v.model || v.m))
        .map(([k, v]) => {
          const ctx = Number(v['ctx-size'] ?? v.c ?? 0);
          const kv = v['cache-type-k'] ?? v.ctk;
          return { id: k, help: [String(v.model ?? v.m).split('/').pop(), ctx ? `${Math.round(ctx / 1000)}k context` : '', kv ? `${kv} KV` : ''].filter(Boolean).join(' · ') };
        });
      if (!models.length && unit && (unit.alias || unit.model)) models = [{ id: unit.alias ?? String(unit.model).split('/').pop()!, help: String(unit.model ?? '').split('/').pop() ?? '' }];
      const gpuName = gpu ? `${gpu.name.replace(/^NVIDIA\s+/, '').replace(/-(PCIE|SXM\d?).*$/i, '')} ${Math.round(gpu.memTotal / 1024)} GB` : '';
      const presetNote = unit?.preset && models.length ? `${unit.preset.replace(/^\/home\/[^/]+/, '~')} has ${models.map((m) => m.id).join(', ')}` : '';
      if (gpu) add('ok', plain(`${gpuName} `), dim([`· ${gpu.temp}°C`, presetNote].filter(Boolean).join(' · ')));
      else if (presetNote) add('ok', plain(presetNote));
      checked = true;
    } catch (e) {
      if (!signal.aborted) add('fail', plain((e as Error).message));
    } finally {
      if (!signal.aborted) checking = false;
      h.redraw();
    }
  }

  async function wakeUp(port: number) {
    const signal = whereAc.signal;
    checks = [add('ok', plain(`${host} was off `), dim(`· woken after you said yes (Wake-on-LAN ${mac})`))];
    if (!onLan(hostname)) throw new Error(`Wake-on-LAN only works on the same network, and ${hostname} isn't on this computer's network. Turn ${host} on and press enter.`);
    const c = add('run', plain(`waking ${host}`));
    const t0 = Date.now();
    await wake(mac!, broadcastFor(hostname));
    while (!(await sshx.tcpOpen(hostname, port, 1500))) {
      if (signal.aborted) throw new Error('stopped');
      const s = Math.round((Date.now() - t0) / 1000);
      if (s > 120) throw new Error(`${host} didn't answer within 120 s; Wake-on-LAN only works on the same network`);
      c.text = [plain(`waking ${host} `), dim(`· ${s} s, usually ~30 s`)];
      h.redraw();
      await new Promise((r) => setTimeout(r, 1000));
    }
    Object.assign(c, { mark: 'ok', text: [plain('woke in '), title(`${Math.round((Date.now() - t0) / 1000)} s`), dim(' · ssh works')] });
  }

  // ---- the run ----

  const controls = () => ({ reasoning: settings.reasoning === 0, effort: EFF[settings.effort] });

  function begin() {
    const s = server();
    const t = h.tunnel(s.name);
    const conn = connOf(s.name, { preset: 'llamacpp' }, `http://127.0.0.1:${t.port || 0}/v1`);
    run = runSteps(s, {
      edited: edits,
      skip: [...skip],
      system: h.system,
      model: modelOf(h.cfg, conn, s.model ?? 'default'),
      controls: controls(),
      tunnel: t,
      onUpdate: () => h.redraw(),
    });
    runError = '';
    stopping = false;
    screen = 'running';
    blinkAt = 0;
    inBg = false;
    anim = setInterval(() => {
      loader.tick(Date.now(), !run?.state.done);
      h.redraw();
    }, 120);
    const mine = run;
    const done = run.promise.then(
      (r) => finish(s, r),
      (e) => {
        stopAnim();
        if (e instanceof Cancelled) return stopped(s, mine);
        runError = (e as Error).message;
        h.redraw();
      },
    );
    return done;
  }

  // A cancelled run: say what already happened and ask what to do about it.
  function stopped(s: Server, r: Run) {
    keepDraft('steps');
    h.open(createStopped(h, { name: s.name, host: s.host, model: s.model, state: r.state, after: 'Nothing was saved. /setup picks up at the steps.' }, () => {
      h.open(self);
      begin();
    }));
  }

  // Keeps the answers so far, so the next /setup can pick up here.
  function keepDraft(at: Draft['at']) {
    draft = { at, host, data: { host, typed, checks, checked, hostname, user, unit, build, gpu, presets, mac, models, modelPick, woke, settings: { ...settings }, edits: { ...edits }, skip: new Set(skip) } };
  }
  function resumeDraft(d: Draft) {
    ({ host, typed, checks, checked, hostname, user, unit, build, gpu, presets, mac, models, modelPick, woke, edits, skip } = d.data as any);
    Object.assign(settings, d.data.settings);
    screen = d.at;
    pick = 0;
    stepSel = 0;
    if (d.at === 'where') h.setBuffer(host);
  }

  const stopAnim = () => {
    if (anim) clearInterval(anim);
    anim = null;
  };

  // Saves everything and says it's ready (also when setup ran in the background).
  async function finish(s: Server, r: { base: string; tps?: number; warm?: number }) {
    const root = llama.rootOf(r.base);
    const pr = await llama.props(root).catch(() => null);
    const safety = s.model ? await llama.templateSafety(root, { id: s.model }).catch(() => null) : null;
    const tools = s.model ? await toolSupport(r.base, s.model).catch(() => null) : null;
    const quit = QUIT[settings.quit][0];
    // Merged into what was saved, so keys Rime doesn't set here (a key, a URL) stay.
    h.cfg.providers[s.name] = {
      ...h.cfg.providers[s.name],
      steps: undefined,
      skip: undefined,
      preset: 'llamacpp',
      ssh: s.host,
      tunnel: { remote: s.remote },
      ...(s.mac ? { wake: { mac: s.mac, broadcast: s.broadcast } } : {}),
      ...(s.model ? { model: s.model } : {}),
      router: s.router,
      ...(Object.keys(edits).length ? { steps: edits } : {}),
      ...(skip.size ? { skip: [...skip] } : {}),
      onQuit: quit,
      saveCache: settings.save === 0,
      probe: {
        build: build ?? String(pr?.json?.build_info ?? '').match(/b\d+/)?.[0],
        slots: pr?.json?.total_slots,
        ctx: pr?.json?.default_generation_settings?.n_ctx,
        ...(safety ? { effortSafe: safety.effort !== 'unsafe', reasoningSafe: safety.reasoning !== 'unsafe' } : {}),
        ...(tools ? { tools } : {}),
      },
    };
    const ref = `${s.name}/${s.model ?? 'default'}`;
    h.cfg.model = ref;
    h.cfg.effort = EFF[settings.effort];
    h.cfg.reasoning = settings.reasoning === 0;
    h.save();
    const conn = connOf(s.name, h.cfg.providers[s.name], r.base);
    const m = modelOf(h.cfg, conn, s.model ?? 'default', { context: pr?.json?.default_generation_settings?.n_ctx });
    h.activate(m, r.base);
    // He blinks once, then the box gives way to the ready line.
    blinkAt = Date.now();
    await new Promise((res) => setTimeout(res, screen === 'running' && !inBg ? 1600 : 0));
    stopAnim();
    draft = null;
    const warm = r.warm ? ` · cache warm (${r.warm >= 1000 ? (r.warm / 1000).toFixed(1) + 'k' : r.warm} tokens in slot 0)` : '';
    h.say({
      kind: 'lines',
      lines: [
        [{ t: '● ', s: st.ok }, plain(`${s.host} is ready · `), { t: m.label, s: st.titleB }, plain(r.tps ? ` · ${Math.round(r.tps)} tok/s` : ''), plain(warm)],
        [dim('  Saved. Change anything with /setup, manage the server with /server.')],
      ],
    });
    if (screen === 'running' && !inBg) h.close();
  }

  // ---- provider / local finishing ----

  function connectProvider(provider: string, cfgEntry: ProviderConfig, base: string, id: string, info: (typeof provModels)[number], ready: string) {
    h.cfg.providers[provider] = cfgEntry;
    h.cfg.model = `${provider}/${id}`;
    h.save();
    const conn = connOf(provider, cfgEntry, base);
    const m = modelOf(h.cfg, conn, id, info);
    h.activate(m, base);
    h.say({
      kind: 'lines',
      lines: [
        [{ t: '● ', s: st.ok }, plain(`${ready} · `), { t: m.label, s: st.titleB }],
        [dim('  Saved. Change anything with /setup or /model.')],
      ],
    });
    h.close();
  }

  async function lookLocal() {
    looking = true;
    h.redraw();
    local = await findLocal();
    looking = false;
    pick = 0;
    if (!local.length && hasLlama()) h.setBuffer(LOCAL_START);
    h.redraw();
  }
  // Nothing running here but llama-server is installed: Rime starts it with the
  // command on the prompt line (editable, like a step), waits for /health, then
  // looks again. ponytail: only the start step runs locally, not the full list;
  // the server keeps running after Rime quits, like one you started yourself.
  const hasLlama = () => (process.env.PATH ?? '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server')));
  let starting = '';
  async function startLocal(cmd: string) {
    const signal = whereAc.signal;
    starting = cmd;
    h.setBuffer('');
    h.redraw();
    fs.mkdirSync(path.join(os.homedir(), '.rime'), { recursive: true });
    const log = fs.openSync(path.join(os.homedir(), '.rime', 'llama-server.log'), 'a');
    const p = spawn(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', cmd] : ['-c', cmd], { detached: true, stdio: ['ignore', log, log] });
    p.on('error', () => {});
    p.unref();
    fs.closeSync(log);
    const port = Number(/--port[ =](\d+)/.exec(cmd)?.[1] ?? 8080);
    for (let i = 0; i < 120 && !signal.aborted && p.exitCode === null; i++) {
      const r = await llama.health(`http://127.0.0.1:${port}`, 1000).catch(() => null);
      if (r?.status === 200) break;
      await new Promise((res) => setTimeout(res, 1000));
    }
    starting = '';
    if (signal.aborted) return;
    await lookLocal();
    if (!local.length) h.setBuffer(cmd);
  }

  // /connect <url>: what is it, does it need a key, which models.
  async function connectProbe() {
    const p = await probe(connectUrl, key || undefined);
    if (!p) {
      h.say({ kind: 'note', tone: 'warn', text: `Nothing answered at ${connectUrl}.` });
      return h.close();
    }
    preset = p.kind === 'openai' ? 'generic' : p.kind;
    const hostOf = new URL(p.base).hostname;
    provName = serverName ?? (/^[\d.]+$|^localhost$/.test(hostOf) ? (hostOf === 'localhost' || hostOf === '127.0.0.1' ? 'local' : 'server') : hostOf.split('.')[0]);
    provBase = p.base;
    provWarnings = p.warnings;
    fromLocal = true; // saved with its URL
    if (p.needKey) {
      keyError = key ? 'That key was refused. Paste it again.' : '';
      screen = 'key';
    } else {
      provModels = (p.server ?? p.models).map((m) => ({ id: m.id, context: ('context' in m ? m.context : undefined) ?? p.ctx }));
      screen = 'models';
      pick = 0;
    }
    h.redraw();
  }

  async function testKey() {
    keyError = '';
    if (connectUrl) return connectProbe();
    const pre = PRESETS[preset];
    const k = key || keyOf({ preset });
    const conn = connOf(preset, { preset, key: k }, pre.url);
    const r = await listModels(conn).catch((e) => ({ status: 0, models: [], error: (e as Error).message }));
    if (r.status !== 200) {
      keyError = r.status === 401 || r.status === 403 ? 'That key was refused. Paste it again.' : `Couldn't list models (${r.status || 'no answer'}).`;
      screen = 'key';
      h.setBuffer('');
    } else {
      provModels = r.models;
      provBase = pre.url;
      provName = preset;
      screen = 'models';
      pick = 0;
      h.setBuffer('');
    }
    h.redraw();
  }

  // ---- views ----

  const MARK: Record<Mark, Line[number]> = { ok: { t: '✓', s: st.ok }, warn: { t: '○', s: st.warn }, run: { t: '●', s: st.accent }, fail: { t: '✗', s: st.del } };
  const blank: BoxRow = { line: [] };
  const filtered = <T>(list: T[], text: (x: T) => string) => (filter ? list.filter((x) => text(x).toLowerCase().includes(filter.toLowerCase())) : list);

  const START: [string, string][] = [
    ['My own server', 'llama.cpp on another computer, over ssh'],
    ['This computer', 'llama.cpp on this machine'],
    ['A provider', 'OpenRouter, OpenAI, Anthropic, DeepSeek, Groq, …'],
  ];
  const RESUME: [string, string][] = [
    ['Continue', 'pick up where you stopped, with your answers'],
    ['Start over', 'forget the answers and begin at screen 1'],
    ['Not now', 'close; /setup asks again next time'],
  ];
  const AT: Record<Draft['at'], string> = { where: 'where it runs', model: 'the model', steps: 'the steps' };

  // marker (3) · name (14) · command, wrapped · result, right-aligned
  function stepRows(width: number): BoxRow[] {
    const s = server();
    const t = h.tunnel(s.name);
    const cmds = { ...defaults(s, t.port || 18080, EFF[settings.effort]), ...edits };
    const tag = `changes ${host}`.slice(0, 22);
    const inner = width - 4, resW = run ? 9 : Math.max(9, tag.length + 1), cmdW = Math.max(10, inner - 17 - resW);
    const rows: BoxRow[] = [];
    STEPS.forEach((id, i) => {
      const v = run?.state.steps[i];
      const status = v?.status ?? (skip.has(id) ? 'off' : 'todo');
      const mk = { todo: { t: '○', s: st.dim }, run: { t: '●', s: st.accent }, done: { t: '✓', s: st.ok }, off: { t: '–', s: st.dim }, fail: { t: '✗', s: st.del }, stopped: { t: '■', s: st.warn } }[status];
      const off = status === 'off';
      const strike = st.mode === 'none' ? '' : '\x1b[9m';
      const cmd = v?.cmd ?? cmds[id];
      const note = edits[id] ? '' : id === 'wake' ? `(skipped if ${s.host} already answers)` : id === 'tunnel' ? '(Rime keeps it open)' : '';
      const chunks: Line[] = [];
      for (let k = 0; k < cmd.length; k += cmdW) chunks.push([{ t: cmd.slice(k, k + cmdW), s: off ? st.dim + strike : editing === id ? st.accent : st.fg }]);
      if (note) {
        const last = chunks.at(-1)!;
        if (lineWidth(last) + 2 + note.length <= cmdW) last.push({ t: '  ' + note, s: st.dim });
        else chunks.push([{ t: note, s: st.dim }]);
      }
      const selected = screen === 'steps' && i === stepSel;
      chunks.forEach((c, j) => {
        const left: Line = j === 0 ? [{ t: mk.t.padEnd(3), s: mk.s }, { t: NAMES[id].padEnd(14), s: off ? st.dim + strike : st.title }] : [{ t: ' '.repeat(17), s: '' }];
        // Before anything runs, steps that change the machine say so.
        const marked = j === 0 && !run && !off && CHANGES.includes(id);
        const result = j === 0 ? (v?.result ?? (off ? 'skip' : marked ? tag : '')) : '';
        rows.push({ line: [...fit([...left, ...c], inner - resW, false), { t: result.padStart(resW), s: marked ? st.warn : st.dim }], bg: selected ? st.panelBg : undefined, hit: `step:${i}` });
      });
    });
    return rows;
  }

  function loaderRows(): BoxRow[] {
    const state = run!.state;
    const now = Date.now();
    const blink = blinkAt > 0 && now - blinkAt > 500 && now - blinkAt < 700;
    const cube = loader.cells(state.done ? 1 : state.overall, now, st.mode, blink);
    const cur = state.steps.find((v) => v.status === 'run' || v.status === 'fail');
    const s = server();
    const label = prettyLabel(s.model ?? 'model');
    let what: Line;
    if (state.done) what = [{ t: '✓ ', s: st.ok }, { t: 'ready', s: st.titleB }];
    else if (runError) what = [{ t: '✗ ', s: st.del }, plain(runError)];
    else if (stopping) what = [{ t: '■ ', s: st.warn }, plain(cur?.id === 'load' ? 'stopping, unloading the model again' : 'stopping'), dim('.'.repeat(1 + (Math.floor(now / 350) % 3)))];
    else if (cur?.id === 'load') what = [accent('● '), plain('loading '), { t: label, s: st.titleB }, dim(cur.progress === null ? ' · waiting for the server' : ` · ${Math.round((cur.progress ?? 0) * 100)}%${gpu ? ` into the ${gpu.name.replace(/^NVIDIA\s+|Tesla\s+/g, '').replace(/-(PCIE|SXM\d?).*$/i, '')}` : ''}`)];
    else if (cur?.id === 'wake') what = [accent('● '), plain(`waking ${s.host}`), dim(cur.detail ? ` · ${cur.detail}` : '')];
    else {
      const verb = { connect: `connecting to ${s.host}`, tunnel: 'opening the tunnel', start: 'starting llama-server', warm: 'warming the cache', test: 'testing a reply', wake: '', load: '' }[cur?.id ?? 'connect'];
      what = [accent('● '), plain(verb), dim('.'.repeat(1 + (Math.floor(now / 350) % 3)))];
    }
    const b = bar(state.done ? 1 : state.overall);
    const txt: Line[] = [[{ t: `Setting up ${s.host}`, s: st.titleB }], what, [accent(b.fill), { t: b.empty, s: st.line }, plain(' ' + b.pct)]];
    return cube.map((c, i) => ({ line: [...c, { t: '  ', s: '' }, ...txt[i]] }));
  }

  const say = (text: string) => h.say({ kind: 'note', tone: 'dim', text });

  // Moves the run to the header's compact loader; /setup brings this box back.
  function background() {
    if (!run) return;
    inBg = true;
    stopAnim();
    h.background(name(), run, run.promise.catch(() => {}), self);
    say('Setup continues in the background · /setup to watch it, ctrl+c stops it');
    h.close();
  }

  const self: Panel = {
    view(width) {
      // Back from the background: the loader animates again.
      if (inBg && screen === 'running') {
        inBg = false;
        if (run && !run.state.done && !runError && !anim) {
          anim = setInterval(() => {
            loader.tick(Date.now(), !run?.state.done);
            h.redraw();
          }, 120);
        }
      }
      const legend = (more?: string, n?: number): Line => [accent('setup'), ...(more ? [dim(` · ${more}`)] : []), ...(n ? [dim(` · ${n} of 4`)] : [])];
      const why = (t: string): BoxRow[] => wrap([dim(t)], width - 4).map((line) => ({ line }));
      const BACK = ['esc', ' back · '], CANCEL = ['ctrl+c', ' cancel'];
      if (screen === 'resume') {
        return {
          legend: legend(),
          rows: [
            { line: [plain('You were setting up '), title(draft?.host ?? host), plain(' and stopped at '), title(AT[draft?.at ?? 'where']), plain('.')] },
            ...why('Your answers are kept. Nothing was saved to Rime\'s config.'),
            blank,
            ...RESUME.map(([n, d], i) => listRow(n, d, i === pick, st, `pick:${i}`, 22)),
          ],
          foot: ['↑ ↓', ' choose · ', 'enter', ' go · ', ...CANCEL],
        };
      }
      if (screen === 'start') {
        const any = Object.keys(h.cfg.providers).length > 0;
        return {
          legend: legend(undefined, 1),
          rows: [
            { line: [plain(any ? 'How do you want to run Rime?' : 'No model is connected yet. How do you want to run Rime?')] },
            ...why('Nothing is installed, changed or saved until you confirm at the end.'),
            blank,
            ...START.map(([n, d], i) => listRow(n, d, i === pick, st, `pick:${i}`, 22)),
          ],
          foot: ['↑ ↓', ' choose · ', 'enter', ' next · ', 'esc', ' later · ', ...CANCEL],
        };
      }
      if (screen === 'where') {
        const known = sshx.sshHosts();
        const rows: BoxRow[] = [
          { line: [plain('Where does it run? '), accent('› '), title(typed || '…')] },
          ...why('Rime only checks over ssh here and changes nothing. If the machine is off, it asks before waking it. No ssh? Type its URL (http://host:8080) and Rime talks to it directly.'),
          blank,
          ...checks.map((c) => ({ line: [MARK[c.mark], plain(' '), ...c.text] })),
        ];
        if (!checks.length && known.length) rows.push({ line: [dim(`Hosts in ~/.ssh/config: ${known.join(' · ')}`)] });
        return {
          legend: legend('my own server', 2),
          rows,
          foot: needWake ? ['enter', ` wake ${host} · `, ...BACK, ...CANCEL] : ['enter', checked ? ' next · ' : ' check · ', ...BACK, ...CANCEL],
        };
      }
      if (screen === 'model') {
        const rows: BoxRow[] = [{ line: [dim(`Models in ${host}'s ${unit?.router ? 'presets.ini' : 'server'}`)] }];
        if (!models.length) rows.push({ line: [dim('  none found; the server will use what it has loaded')] });
        models.forEach((m, i) => rows.push(listRow(m.id, m.help, pick === i, st, `pick:${i}`, 22)));
        rows.push(blank, { line: [dim('Settings (saved when setup finishes)')] });
        const vals = [EFF[settings.effort], ['on', 'off'][settings.reasoning], ['yes', 'no'][settings.wake], QUIT[settings.quit][1].replace('{host}', host), ['yes', 'no'][settings.save]];
        const labels = ['Default effort', 'Reasoning', `Wake ${host} when needed`, 'When Rime quits', 'Save the cache first'];
        labels.forEach((l, i) => rows.push(settingRow(l, vals[i], pick === models.length + i, st, `pick:${models.length + i}`)));
        return { legend: legend('model and settings', 3), rows, foot: ['↑ ↓', ' choose · ', '← →', ' change · ', 'enter', ' next · ', ...BACK, ...CANCEL] };
      }
      if (screen === 'steps') {
        return {
          legend: legend('steps', 4),
          rows: [
            { line: [dim(`Rime will run these on ${host}. Nothing has run yet.`)] },
            ...why('Select a command and press e to edit it. You can cancel while they run.'),
            blank,
            ...stepRows(width),
          ],
          foot: editing
            ? ['enter', ' save this command · ', 'esc', ' undo the edit']
            : ['enter', ' run all · ', 'e', ' edit · ', 'space', ' skip · ', 'r', ' reset · ', ...BACK, ...CANCEL],
        };
      }
      if (screen === 'running') {
        return {
          legend: legend('running'),
          rows: [...loaderRows(), blank, ...stepRows(width)],
          foot: runError
            ? ['enter', ' retry · ', 'e', ' edit steps · ', 'l', ' server log · ', 'esc', ' close']
            : run?.state.done || stopping ? ['', ''] : ['ctrl+c', ' cancel · ', 'b', ' run in background · ', 'l', ' server log'],
        };
      }
      if (screen === 'local') {
        const rows: BoxRow[] = [];
        if (starting) rows.push({ line: [accent('● '), plain('starting '), dim(starting)] }, { line: [dim('its output goes to ~/.rime/llama-server.log')] });
        else if (looking) rows.push({ line: [accent('● '), plain('looking for llama.cpp, Ollama, LM Studio and vLLM on this computer…')] });
        else if (!local.length && hasLlama()) rows.push({ line: [plain('No local server answered on ports 8080, 9931, 11434, 1234 or 8000.')] }, { line: [dim('Enter starts llama-server with the command below (edit it to add a model, e.g. -m model.gguf), or clear the line to look again.')] });
        else if (!local.length) rows.push({ line: [plain('No local server answered on ports 8080, 9931, 11434, 1234 or 8000.')] }, { line: [dim('Start llama-server (or Ollama, LM Studio) and press enter to look again.')] });
        else {
          rows.push({ line: [dim('Servers on this computer')] });
          local.forEach((l, i) => rows.push(listRow(`${PRESETS[l.probe.kind === 'openai' ? 'generic' : l.probe.kind === 'llamacpp' ? 'llamacpp' : l.probe.kind].label} :${l.port}`, [l.probe.build, l.probe.models.map((m) => m.id).join(', ')].filter(Boolean).join(' · '), i === pick, st, `pick:${i}`, 22)));
        }
        return { legend: legend('this computer'), rows, foot: ['↑ ↓', ' choose · ', 'enter', local.length ? ' next · ' : hasLlama() ? ' start / look again · ' : ' look again · ', ...BACK, ...CANCEL] };
      }
      if (screen === 'providers') {
        const list = filtered(HOSTED, (p) => PRESETS[p].label);
        const rows = list.map((p, i) => {
          const env = PRESETS[p].keyEnv;
          return listRow(PRESETS[p].label, env && process.env[env] ? [{ t: `✓ ${env} found`, s: st.ok }] : `needs a key${env ? ` · or set ${env}` : ''}`, i === pick, st, `pick:${i}`, 22);
        });
        return { legend: legend('a provider'), rows: rows.length ? rows : [{ line: [dim(`no provider matches ${filter}`)] }], foot: ['↑ ↓', ' choose · ', 'enter', ' next · type to filter · ', ...BACK, ...CANCEL] };
      }
      if (screen === 'key') {
        const pre = PRESETS[preset];
        return {
          legend: legend(pre.label),
          rows: [
            { line: [plain(`Paste your ${pre.label} API key into the prompt below and press enter.`)] },
            { line: [dim(`Rime keeps it in ~/.rime/config (mode 0600)${pre.keyEnv ? `, or set ${pre.keyEnv} instead` : ''}.`)] },
            ...(keyError ? [blank, { line: [{ t: '✗ ', s: st.del }, plain(keyError)] }] : []),
          ],
          foot: ['enter', ' test the key · ', ...BACK, ...CANCEL],
        };
      }
      // models
      const list = filtered(provModels, (m) => `${m.id} ${m.label ?? ''}`);
      const shown = list.slice(Math.max(0, pick - 8), Math.max(0, pick - 8) + 10);
      const offset = Math.max(0, pick - 8);
      return {
        legend: legend(`${provName} · model`),
        rows: [...provWarnings.map((w): BoxRow => ({ line: [{ t: '! ', s: st.warn }, dim(w)] })), ...(provWarnings.length ? [blank] : [])].concat(shown.length
          ? shown.map((m, i) => listRow(m.label ?? prettyLabel(m.id), [m.id, m.context ? `${Math.round(m.context / 1000)}k context` : ''].filter(Boolean).join(' · '), offset + i === pick, st, `pick:${offset + i}`, 22))
          : [{ line: [dim(filter ? `no model matches ${filter}` : 'no models listed')] }]),
        foot: ['↑ ↓', ' choose · ', 'enter', ' use it · type to filter · ', ...BACK, ...CANCEL],
      };
    },

    placeholder() {
      if (screen === 'where') return needMac ? 'MAC address to wake it, e.g. 00:11:22:33:44:55' : needWake ? `Enter wakes ${host}` : 'gpubox, a host name, an IP address, or a URL like http://host:8080';
      if (screen === 'steps') return editing ? 'Edit the command, enter saves' : 'Enter runs every step';
      if (screen === 'running') return 'You can type; it sends once the model is ready';
      if (screen === 'key') return `${PRESETS[preset]?.label ?? 'API'} key`;
      if (screen === 'models' || screen === 'providers') return 'Type to filter';
      if (screen === 'model') return 'Type to filter models';
      if (screen === 'resume') return 'Pick an option';
      return 'Pick an option, or type to filter';
    },

    status() {
      if (screen === 'where' && checking) return [dim(`checking ${host}…`)];
      if (screen === 'running' && !run?.state.done) return [dim(`setting up ${host}`)];
      return undefined;
    },

    masked: () => screen === 'key',
    typing: () => ['where', 'key', 'models', 'providers'].includes(screen) || editing !== null,

    // ctrl+c or ✕ (SPEC §5.2): before anything runs, close and keep the answers;
    // while steps run, stop the current one now and ask what to do.
    cancel() {
      if (screen === 'running') {
        if (run && !run.state.done && !runError) {
          if (!stopping) {
            stopping = true;
            run.cancel();
          }
          return;
        }
        if (run?.state.done) return; // it's finishing
        stopAnim();
        return h.close();
      }
      editing = null;
      stopWhere();
      if (screen === 'where' || screen === 'model' || screen === 'steps') {
        keepDraft(screen);
        say(`Setup cancelled. ${woke ? `Rime woke ${host}; nothing else was` : 'Nothing was'} changed or saved. /setup picks up where you left off.`);
      } else say('Setup cancelled. Nothing was changed or saved.');
      h.close();
    },

    key(k, buf) {
      const nav = (n: number) => {
        if (k.name === 'up') pick = (pick - 1 + n) % Math.max(1, n);
        else if (k.name === 'down') pick = (pick + 1) % Math.max(1, n);
        else return false;
        return true;
      };
      if (screen === 'resume') {
        if (k.name === 'escape') return h.close(), true;
        if (nav(RESUME.length)) return true;
        if (k.name === 'enter') {
          if (pick === 0 && draft) resumeDraft(draft);
          else if (pick === 1) {
            draft = null;
            screen = 'start';
            pick = 0;
          } else h.close();
          return true;
        }
        return true;
      }
      if (screen === 'start') {
        if (k.name === 'escape') return say('Setup closed. Run /setup when you\'re ready.'), h.close(), true;
        if (nav(START.length)) return true;
        if (k.name === 'enter') {
          filter = '';
          if (pick === 0) {
            screen = 'where';
            typed = host;
            h.setBuffer(host);
          } else if (pick === 1) {
            screen = 'local';
            lookLocal();
          } else screen = 'providers';
          pick = 0;
          return true;
        }
        return false;
      }
      if (screen === 'where') {
        if (k.name === 'escape') return (stopWhere(), (screen = 'start'), (pick = 0), h.setBuffer(''), true);
        return false; // typing and enter go to submit()
      }
      if (screen === 'model') {
        const n = models.length + 5;
        if (k.name === 'escape') return (screen = 'where', h.setBuffer(host), true);
        if (nav(n)) return true;
        if (k.name === 'left' || k.name === 'right') {
          const i = pick - models.length;
          if (i < 0) return true;
          const d = k.name === 'right' ? 1 : -1;
          const key = (['effort', 'reasoning', 'wake', 'quit', 'save'] as const)[i];
          const size = [EFF.length, 2, 2, QUIT.length, 2][i];
          settings[key] = (settings[key] + d + size) % size;
          if (key === 'wake') settings.wake ? skip.add('wake') : skip.delete('wake');
          return true;
        }
        if (k.name === 'enter') {
          if (pick < models.length) modelPick = pick;
          screen = 'steps';
          stepSel = 0;
          return true;
        }
        return true;
      }
      if (screen === 'steps') {
        if (editing) {
          if (k.name === 'escape') return (editing = null, h.setBuffer(''), true);
          return false; // enter goes to submit()
        }
        if (k.name === 'escape') return (screen = 'model', pick = 0, true);
        if (k.name === 'up') return (stepSel = (stepSel + STEPS.length - 1) % STEPS.length, true);
        if (k.name === 'down') return (stepSel = (stepSel + 1) % STEPS.length, true);
        const id = STEPS[stepSel];
        if (k.name === 'space' || (k.name === 'char' && k.ch === ' ')) {
          skip.has(id) ? skip.delete(id) : skip.add(id);
          return true;
        }
        if (k.name === 'char' && k.ch === 'e') {
          if (BUILTIN.includes(id)) return true;
          editing = id;
          const s = server();
          h.setBuffer(edits[id] ?? defaults(s, '{port}', EFF[settings.effort])[id]);
          return true;
        }
        if (k.name === 'char' && k.ch === 'r') {
          delete edits[id];
          skip.delete(id);
          return true;
        }
        if (k.name === 'enter') {
          begin();
          return true;
        }
        return true;
      }
      if (screen === 'running') {
        if (k.name === 'char' && k.ch === 'l') {
          sshx.ssh(host, 'journalctl -u llama-server -n 200 --no-pager', 15000).then((r) =>
            h.say({ kind: 'lines', lines: (r.out || r.err || 'no log').trim().split('\n').slice(-200).map((l) => [dim(l)]) }),
          );
          return true;
        }
        if (runError) {
          if (k.name === 'enter') return (begin(), true);
          if (k.name === 'char' && k.ch === 'e') return (screen = 'steps', run = null, runError = '', true);
          if (k.name === 'escape') return (stopAnim(), h.close(), true);
          return true;
        }
        // esc does nothing while steps run, so it can't cancel by accident.
        if (k.name === 'char' && k.ch === 'b' && run && !run.state.done && !stopping) return background(), true;
        return true;
      }
      if (screen === 'local') {
        if (k.name === 'escape') return (stopWhere(), (starting = ''), h.setBuffer(''), (screen = 'start'), (pick = 1), true);
        if (starting || looking) return true;
        if (nav(local.length)) return true;
        if (k.name === 'enter') {
          if (!local.length) return (buf.trim() ? void startLocal(buf.trim()) : void lookLocal()), true;
          const l = local[pick];
          const kind = l.probe.kind === 'openai' ? 'generic' : l.probe.kind;
          provName = kind === 'llamacpp' ? 'local' : kind;
          provBase = l.probe.base;
          provModels = (l.probe.server ?? l.probe.models).map((m) => ({ id: m.id, context: ('context' in m ? m.context : undefined) ?? l.probe.ctx }));
          preset = kind;
          fromLocal = true;
          screen = 'models';
          pick = 0;
          return true;
        }
        return !!local.length || !hasLlama(); // with nothing found, typing edits the start command
      }
      if (screen === 'providers') {
        const list = filtered(HOSTED, (p) => PRESETS[p].label);
        if (k.name === 'escape') return (screen = 'start', pick = 2, filter = '', h.setBuffer(''), true);
        if (nav(list.length)) return true;
        if (k.name === 'enter' && list[pick]) {
          preset = list[pick];
          fromLocal = false;
          filter = '';
          h.setBuffer('');
          key = '';
          if (keyOf({ preset })) testKey();
          else screen = 'key';
          return true;
        }
        return false;
      }
      if (screen === 'key') {
        if (k.name === 'escape') return connectUrl ? (h.close(), true) : (screen = 'providers', h.setBuffer(''), true);
        return false;
      }
      // models
      const list = filtered(provModels, (m) => `${m.id} ${m.label ?? ''}`);
      if (k.name === 'escape') return connectUrl ? (h.close(), true) : (screen = fromLocal ? 'local' : 'providers', pick = 0, filter = '', h.setBuffer(''), true);
      if (nav(list.length)) return true;
      if (k.name === 'enter' && list[pick]) {
        const m = list[pick];
        const entry: ProviderConfig = fromLocal ? { preset, url: provBase, ...(key ? { key } : {}) } : { preset, ...(key ? { key } : {}) };
        const ready = connectUrl ? `${provName} is connected` : fromLocal ? `${PRESETS[preset].label} on this computer is ready` : `${PRESETS[preset].label} is connected`;
        connectProvider(provName, entry, provBase, m.id, m, ready);
        return true;
      }
      return false;
    },

    submit(buf) {
      if (screen === 'where') {
        const v = buf.trim();
        if (needMac || needWake) {
          if (needMac) {
            if (!/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(v)) {
              add('fail', plain(`${v || 'that'} isn't a MAC address `), dim('· six pairs like 00:11:22:33:44:55'));
              return;
            }
            mac = v.toLowerCase().replace(/-/g, ':');
            h.setBuffer(host);
          }
          // A yes: wake it, then carry on reading the server.
          needMac = needWake = false;
          checking = true;
          woke = true;
          const signal = whereAc.signal;
          wakeUp(wakePort).then(() => void (signal.aborted || survey(true)), (e) => {
            if (signal.aborted) return;
            add('fail', plain((e as Error).message));
            checking = false;
          });
          return;
        }
        if (checked && v === host) {
          screen = 'model';
          pick = 0;
          h.setBuffer('');
          return;
        }
        if (!v || checking) return;
        // A URL (or host:port) is a server Rime talks to directly, with no ssh:
        // the /connect flow (probe, key if it asks for one, pick a model).
        if (/^https?:\/\//i.test(v) || /^[\w.-]+:\d+(\/.*)?$/.test(v)) {
          connectUrl = v;
          screen = 'models';
          provModels = [];
          h.setBuffer('');
          connectProbe();
          return;
        }
        host = v;
        survey();
        return;
      }
      if (screen === 'steps' && editing) {
        const s = server();
        const def = defaults(s, '{port}', EFF[settings.effort])[editing];
        if (buf.trim() && buf.trim() !== def) edits[editing] = buf.trim();
        else delete edits[editing];
        editing = null;
        h.setBuffer('');
        return;
      }
      if (screen === 'key') {
        key = buf.trim();
        if (!key) return;
        h.setBuffer('');
        testKey();
      }
    },

    click(id) {
      const i = Number(id.split(':')[1]);
      if (id.startsWith('pick:')) pick = i;
      else if (id.startsWith('step:') && screen === 'steps') stepSel = i;
    },

    changed(buf) {
      if (screen === 'where') typed = buf;
      else if (screen === 'models' || screen === 'providers') {
        filter = buf;
        pick = 0;
      }
    },
  };
  return self;
}

// A run that was cancelled part-way (SPEC §5.2, docs/providers.md §3.6): what
// already happened, and what should happen to the machine now.
// `startup`: the run that brings a saved server up (at startup or for a message),
// rather than /setup.
export function createStopped(h: Host, r: { name: string; host: string; model?: string; state: RunState; startup?: boolean; after: string }, resume: () => void): Panel {
  const { st } = h;
  const head = r.startup ? `Rime stopped bringing ${r.name} up.` : 'Setup stopped.';
  const done0 = r.startup ? `Stopped bringing ${r.name} up.` : 'Setup cancelled.';
  const dim = (t: string) => ({ t, s: st.dim });
  const plain = (t: string) => ({ t, s: st.fg });
  const started = !!r.state.startSent || r.state.steps.some((v) => v.id === 'start' && v.status === 'done' && v.result !== 'running');
  const cut = r.state.steps.find((v) => v.status === 'stopped');
  const opts: ['leave' | 'stop' | 'off' | 'continue', string, string][] = [
    ['leave', 'Leave it as it is', started ? 'llama-server keeps running' : `${r.host} stays as it is`],
    ...(started ? [['stop', 'Stop llama-server', 'sudo systemctl stop llama-server'] as ['stop', string, string]] : []),
    ['off', `Power off ${r.host}`, 'sudo poweroff'],
    ['continue', r.startup ? 'Continue' : 'Continue setup', `resume from ${cut ? NAMES[cut.id] : 'the next step'}`],
  ];
  const did = happened(r, r.state);
  let pick = 0;
  let working = '';

  async function choose(i: number) {
    const c = opts[i][0];
    if (c === 'continue') return resume();
    let done = started ? `llama-server is still running on ${r.host}.` : `${r.host} is as it was left.`;
    if (c !== 'leave') {
      working = c === 'stop' ? 'stopping llama-server…' : `powering off ${r.host}…`;
      h.redraw();
      const x = await sshx.ssh(r.host, c === 'stop' ? 'sudo systemctl stop llama-server' : 'sudo poweroff', 30000);
      done = c === 'off' ? `${r.host} is powering off.` : x.code === 0 ? `llama-server was stopped; ${r.host} is still on.` : `Stopping llama-server failed: ${x.err.trim().split('\n').at(-1) || `exit ${x.code}`}.`;
    }
    h.say({ kind: 'note', tone: 'dim', text: `${done0} ${done} ${r.after}` });
    h.close();
  }

  return {
    view: () => ({
      legend: [{ t: r.startup ? 'server' : 'setup', s: st.warn }, dim(' · stopped')],
      warn: true,
      rows: [
        { line: [plain(`${head} So far Rime:`)] },
        ...(did.length ? did : ['did nothing yet']).map((l) => ({ line: [dim(`  · ${l}`)] })),
        { line: [dim(`Nothing was saved to Rime's config. What should happen to ${r.host}?`)] },
        { line: [] },
        ...opts.map(([, n, d], i) => listRow(n, d, i === pick, st, `pick:${i}`, 22)),
        ...(working ? [{ line: [] }, { line: [{ t: '● ', s: st.accent }, plain(working)] }] : []),
      ],
      foot: ['↑ ↓', ' choose · ', 'enter', ' do it · ', 'esc', ` ${opts.at(-1)![1].toLowerCase()}`],
    }),
    placeholder: () => `Pick what happens to ${r.host}`,
    key(k) {
      if (working) return true;
      if (k.name === 'up') return (pick = (pick + opts.length - 1) % opts.length, true);
      if (k.name === 'down') return (pick = (pick + 1) % opts.length, true);
      if (k.name === 'enter') return choose(pick), true;
      if (k.name === 'escape') return resume(), true;
      return true;
    },
    cancel: () => void (working || choose(0)), // the default: leave it as it is
    click(id) {
      pick = Number(id.split(':')[1]);
    },
  };
}
