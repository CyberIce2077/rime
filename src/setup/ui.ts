// The setup box (docs/providers.md §3, reference/rime-setup.html): first run or
// /setup. Own server (llama.cpp over ssh), this computer, or a hosted provider.
// Rime writes ~/.rime/config itself at the end; nobody edits it by hand.

import type { ChildProcess } from 'node:child_process';
import type { Config, ProviderConfig, Step } from '../core/config.ts';
import { type Key, type Line, fit, lineWidth } from '../core/term.ts';
import type { BoxRow, Item, Styles } from '../core/view.ts';
import { listRow, settingRow } from '../core/view.ts';
import * as llama from '../providers/llamacpp.ts';
import { HOSTED, PRESETS } from '../providers/presets.ts';
import { type Probe, findLocal, probe } from '../providers/probe.ts';
import { connOf, keyOf, listModels, modelOf, prettyLabel } from '../providers/registry.ts';
import type { Effort, Model } from '../providers/types.ts';
import { bar, createLoader } from './loader.ts';
import * as sshx from './ssh.ts';
import { BUILTIN, NAMES, type Run, STEPS, type Server, defaults, runSteps } from './steps.ts';
import { broadcastFor, wake } from './wol.ts';

export type PanelView = { legend: Line; rows: BoxRow[]; foot: string[] };

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
  background(name: string, run: Run, done: Promise<unknown>): void; // keep going from the header
};

type Mark = 'ok' | 'warn' | 'run' | 'fail';
type Check = { mark: Mark; text: Line };

const EFF: Effort[] = ['low', 'medium', 'high'];
const QUIT: [ProviderConfig['onQuit'] & string, string][] = [['keep', 'keep running'], ['stop', 'stop the server'], ['poweroff', 'power off {host}']];

// start: the first screen; 'steps' reopens a saved server's steps, 'connect'
// probes `url` (/connect) and goes straight to its key or models.
export function createSetup(h: Host, start: 'start' | 'steps' | 'connect' = 'start', serverName?: string, url?: string): Panel {
  const { st } = h;
  const dim = (t: string) => ({ t, s: st.dim });
  const title = (t: string) => ({ t, s: st.title });
  const plain = (t: string) => ({ t, s: st.fg });
  const accent = (t: string) => ({ t, s: st.accent });

  let screen: 'start' | 'where' | 'model' | 'steps' | 'running' | 'local' | 'providers' | 'key' | 'models' = 'start';
  let pick = 0;
  let filter = '';

  // ---- own server state ----
  let host = sshx.sshHosts()[0] ?? '';
  let draft = host; // what's typed in the prompt on the "where" screen
  let checks: Check[] = [];
  let checking = false, checked = false, needMac = false;
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

  // ---- local / provider state ----
  let local: { port: number; probe: Probe }[] = [];
  let looking = false;
  let preset = '';
  let key = '';
  let keyError = '';
  let provModels: { id: string; label?: string; context?: number; price?: Model['price'] }[] = [];
  let provBase = '';
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

  // Reopening /setup for a saved server goes straight to its steps.
  if (start === 'steps' && serverName && h.cfg.providers[serverName]) {
    const p = h.cfg.providers[serverName];
    host = p.ssh ?? serverName;
    mac = p.wake?.mac;
    edits = { ...p.steps };
    skip = new Set(p.skip);
    models = p.model ? [{ id: p.model, help: '' }] : [];
    const [rh, rp] = (p.tunnel?.remote ?? '127.0.0.1:8080').split(':');
    unit = { router: !!p.model, host: rh, port: +rp, args: [] };
    screen = 'steps';
  }

  const add = (mark: Mark, ...text: Line) => {
    const c = { mark, text };
    checks.push(c);
    h.redraw();
    return c;
  };

  // Where does it run? Each check appears as it finishes.
  async function survey() {
    checking = true;
    checked = needMac = false;
    checks = [];
    try {
      const r = await sshx.resolveHost(host);
      hostname = r.hostname;
      user = r.user;
      const inConfig = sshx.sshHosts().includes(host);
      const hostLine = inConfig
        ? add('ok', plain(`${host} in ~/.ssh/config `), dim(`· ${hostname}${user ? ` · user ${user}` : ''}`))
        : add('warn', plain(`${host} isn't in ~/.ssh/config `), dim('· using it as an address'));
      mac = mac ?? h.cfg.providers[name()]?.wake?.mac;
      if (!(await sshx.tcpOpen(hostname, r.port, 2000))) {
        if (!mac) {
          needMac = true;
          add('warn', plain(`${host} is off `), dim('· type its MAC address below and Rime will wake it, or turn it on and press enter'));
          return;
        }
        await wakeUp(r.port);
      }
      const c = add('run', plain(`connecting to ${host}…`));
      const t = await sshx.ssh(host, 'true', 20000);
      if (t.code !== 0) {
        Object.assign(c, { mark: 'fail', text: [plain(`ssh ${host} failed `), dim(`· ${t.err.trim().split('\n').at(-1) ?? `exit ${t.code}`}`)] });
        return;
      }
      checks.splice(checks.indexOf(c), 1);
      if (inConfig) hostLine.text.push(dim(' · key login'));
      const sv = sshx.sections((await sshx.ssh(host, sshx.SURVEY, 20000)).out);
      mac = sv.MAC?.trim() || mac;
      unit = sshx.parseUnit(sv.UNIT ?? '');
      gpu = sshx.parseGpu(sv.GPU ?? '');
      if (unit) {
        const more = sshx.sections((await sshx.ssh(host, sshx.detailsScript(unit), 20000)).out);
        build = sshx.buildOf(more.VERSION ?? '');
        presets = sshx.parseIni(more.PRESETS ?? '');
        add('ok', plain('llama-server.service '), dim(`· ${unit.router ? 'router mode' : 'single model'} · ${unit.host}:${unit.port}${build ? ` · llama.cpp ${build}` : ''}`));
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
      add('fail', plain((e as Error).message));
    } finally {
      checking = false;
      h.redraw();
    }
  }

  async function wakeUp(port: number) {
    add('warn', plain(`${host} is off `), dim(`· Rime can wake it: Wake-on-LAN ${mac}`));
    const c = add('run', plain(`waking ${host}`));
    const t0 = Date.now();
    await wake(mac!, broadcastFor(hostname));
    while (!(await sshx.tcpOpen(hostname, port, 1500))) {
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
    screen = 'running';
    blinkAt = 0;
    anim = setInterval(() => {
      loader.tick(Date.now(), !run?.state.done);
      h.redraw();
    }, 120);
    const done = run.promise.then(
      (r) => finish(s, r),
      (e) => {
        runError = (e as Error).message;
        stopAnim();
        h.redraw();
      },
    );
    return done;
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
    const quit = QUIT[settings.quit][0];
    h.cfg.providers[s.name] = {
      preset: 'llamacpp',
      ssh: s.host,
      tunnel: { remote: s.remote },
      ...(s.mac ? { wake: { mac: s.mac, broadcast: s.broadcast } } : {}),
      ...(s.model ? { model: s.model } : {}),
      ...(Object.keys(edits).length ? { steps: edits } : {}),
      ...(skip.size ? { skip: [...skip] } : {}),
      onQuit: quit,
      saveCache: settings.save === 0,
      probe: {
        build: build ?? String(pr?.json?.build_info ?? '').match(/b\d+/)?.[0],
        slots: pr?.json?.total_slots,
        ctx: pr?.json?.default_generation_settings?.n_ctx,
        ...(safety ? { effortSafe: safety.effort !== 'unsafe', reasoningSafe: safety.reasoning !== 'unsafe' } : {}),
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
    await new Promise((res) => setTimeout(res, screen === 'running' ? 1600 : 0));
    stopAnim();
    const warm = r.warm ? ` · cache warm (${r.warm >= 1000 ? (r.warm / 1000).toFixed(1) + 'k' : r.warm} tokens in slot 0)` : '';
    h.say({
      kind: 'lines',
      lines: [
        [{ t: '● ', s: st.ok }, plain(`${s.host} is ready · `), { t: m.label, s: st.titleB }, plain(r.tps ? ` · ${Math.round(r.tps)} tok/s` : ''), plain(warm)],
        [dim('  Saved. Change anything with /setup, manage the server with /server.')],
      ],
    });
    if (screen === 'running') h.close();
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
    h.redraw();
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

  // marker (3) · name (14) · command, wrapped · result, right-aligned (9)
  function stepRows(width: number): BoxRow[] {
    const s = server();
    const t = h.tunnel(s.name);
    const cmds = { ...defaults(s, t.port || 18080, EFF[settings.effort]), ...edits };
    const inner = width - 4, resW = 9, cmdW = Math.max(10, inner - 17 - resW);
    const rows: BoxRow[] = [];
    STEPS.forEach((id, i) => {
      const v = run?.state.steps[i];
      const status = v?.status ?? (skip.has(id) ? 'off' : 'todo');
      const mk = { todo: { t: '○', s: st.dim }, run: { t: '●', s: st.accent }, done: { t: '✓', s: st.ok }, off: { t: '–', s: st.dim }, fail: { t: '✗', s: st.del } }[status];
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
        const result = j === 0 ? (v?.result ?? (skip.has(id) ? 'skip' : '')) : '';
        rows.push({ line: [...fit([...left, ...c], inner - resW, false), { t: result.padStart(resW), s: st.dim }], bg: selected ? st.panelBg : undefined, hit: `step:${i}` });
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

  return {
    view(width) {
      const legend = (more?: string): Line => [accent('setup'), ...(more ? [dim(` · ${more}`)] : [])];
      if (screen === 'start') {
        const any = Object.keys(h.cfg.providers).length > 0;
        return {
          legend: legend(),
          rows: [
            { line: [plain(any ? 'How do you want to run Rime?' : 'No model is connected yet. How do you want to run Rime?')] },
            blank,
            ...START.map(([n, d], i) => listRow(n, d, i === pick, st, `pick:${i}`, 22)),
          ],
          foot: ['↑ ↓', ' choose · ', 'enter', ' next · ', 'esc', ' later (/setup any time)'],
        };
      }
      if (screen === 'where') {
        const known = sshx.sshHosts();
        const rows: BoxRow[] = [
          { line: [plain('Where does it run? '), accent('› '), title(draft || '…')] },
          blank,
          ...checks.map((c) => ({ line: [MARK[c.mark], plain(' '), ...c.text] })),
        ];
        if (!checks.length && known.length) rows.push({ line: [dim(`Hosts in ~/.ssh/config: ${known.join(' · ')}`)] });
        return {
          legend: legend('my own server'),
          rows,
          foot: checked ? ['enter', ' next · Rime reaches the server through an ssh tunnel, so it stays on 127.0.0.1'] : ['enter', ' check · type a host from ~/.ssh/config, a name, or an IP · ', 'esc', ' back'],
        };
      }
      if (screen === 'model') {
        const rows: BoxRow[] = [{ line: [dim(`Models in ${host}'s ${unit?.router ? 'presets.ini' : 'server'}`)] }];
        if (!models.length) rows.push({ line: [dim('  none found; the server will use what it has loaded')] });
        models.forEach((m, i) => rows.push(listRow(m.id, m.help, pick === i, st, `pick:${i}`, 22)));
        rows.push(blank, { line: [dim('Settings')] });
        const vals = [EFF[settings.effort], ['on', 'off'][settings.reasoning], ['yes', 'no'][settings.wake], QUIT[settings.quit][1].replace('{host}', host), ['yes', 'no'][settings.save]];
        const labels = ['Default effort', 'Reasoning', `Wake ${host} when needed`, 'When Rime quits', 'Save the cache first'];
        labels.forEach((l, i) => rows.push(settingRow(l, vals[i], pick === models.length + i, st, `pick:${models.length + i}`)));
        return { legend: legend('model and settings'), rows, foot: ['↑ ↓', ' choose · ', '← →', ' change a setting · ', 'enter', ' next'] };
      }
      if (screen === 'steps') {
        return {
          legend: legend('steps'),
          rows: [{ line: [dim(`Rime will run these on ${host}. Select a command and press e to edit it.`)] }, blank, ...stepRows(width)],
          foot: editing
            ? ['enter', ' save this command · ', 'esc', ' cancel']
            : ['enter', ' run all · ', 'e', ' edit · ', 'space', ' skip a step · ', 'r', ' reset to default'],
        };
      }
      if (screen === 'running') {
        return {
          legend: legend('running'),
          rows: [...loaderRows(), blank, ...stepRows(width)],
          foot: runError ? ['enter', ' retry · ', 'e', ' edit steps · ', 'l', ' show server log · ', 'esc', ' close'] : ['esc', ' run in background · ', 'l', ' show server log'],
        };
      }
      if (screen === 'local') {
        const rows: BoxRow[] = [];
        if (looking) rows.push({ line: [accent('● '), plain('looking for llama.cpp, Ollama, LM Studio and vLLM on this computer…')] });
        else if (!local.length) rows.push({ line: [plain('No local server answered on ports 8080, 9931, 11434, 1234 or 8000.')] }, { line: [dim('Start llama-server (or Ollama, LM Studio) and press enter to look again.')] });
        else {
          rows.push({ line: [dim('Servers on this computer')] });
          local.forEach((l, i) => rows.push(listRow(`${PRESETS[l.probe.kind === 'openai' ? 'generic' : l.probe.kind === 'llamacpp' ? 'llamacpp' : l.probe.kind].label} :${l.port}`, [l.probe.build, l.probe.models.map((m) => m.id).join(', ')].filter(Boolean).join(' · '), i === pick, st, `pick:${i}`, 22)));
        }
        return { legend: legend('this computer'), rows, foot: ['↑ ↓', ' choose · ', 'enter', local.length ? ' next · ' : ' look again · ', 'esc', ' back'] };
      }
      if (screen === 'providers') {
        const list = filtered(HOSTED, (p) => PRESETS[p].label);
        const rows = list.map((p, i) => {
          const env = PRESETS[p].keyEnv;
          return listRow(PRESETS[p].label, env && process.env[env] ? [{ t: `✓ ${env} found`, s: st.ok }] : `needs a key${env ? ` · or set ${env}` : ''}`, i === pick, st, `pick:${i}`, 22);
        });
        return { legend: legend('a provider'), rows: rows.length ? rows : [{ line: [dim(`no provider matches ${filter}`)] }], foot: ['↑ ↓', ' choose · ', 'enter', ' next · type to filter · ', 'esc', ' back'] };
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
          foot: ['enter', ' test the key · ', 'esc', ' back'],
        };
      }
      // models
      const list = filtered(provModels, (m) => `${m.id} ${m.label ?? ''}`);
      const shown = list.slice(Math.max(0, pick - 8), Math.max(0, pick - 8) + 10);
      const offset = Math.max(0, pick - 8);
      return {
        legend: legend(`${provName} · model`),
        rows: shown.length
          ? shown.map((m, i) => listRow(m.label ?? prettyLabel(m.id), [m.id, m.context ? `${Math.round(m.context / 1000)}k context` : ''].filter(Boolean).join(' · '), offset + i === pick, st, `pick:${offset + i}`, 22))
          : [{ line: [dim(filter ? `no model matches ${filter}` : 'no models listed')] }],
        foot: ['↑ ↓', ' choose · ', 'enter', ' use it · type to filter · ', 'esc', ' back'],
      };
    },

    placeholder() {
      if (screen === 'where') return needMac ? 'MAC address to wake it, e.g. 00:11:22:33:44:55' : 'gpubox, a host name, or an IP address';
      if (screen === 'steps') return editing ? 'Edit the command, enter saves' : 'Enter runs every step';
      if (screen === 'running') return 'You can type; it sends once the model is ready';
      if (screen === 'key') return `${PRESETS[preset]?.label ?? 'API'} key`;
      if (screen === 'models' || screen === 'providers') return 'Type to filter';
      if (screen === 'model') return 'Type to filter models';
      return 'Pick an option, or type to filter';
    },

    status() {
      if (screen === 'where' && checking) return [dim(`checking ${host}…`)];
      if (screen === 'running' && !run?.state.done) return [dim(`setting up ${host}`)];
      return undefined;
    },

    masked: () => screen === 'key',
    typing: () => ['where', 'key', 'models', 'providers'].includes(screen) || editing !== null,

    key(k, buf) {
      const nav = (n: number) => {
        if (k.name === 'up') pick = (pick - 1 + n) % Math.max(1, n);
        else if (k.name === 'down') pick = (pick + 1) % Math.max(1, n);
        else return false;
        return true;
      };
      if (screen === 'start') {
        if (k.name === 'escape') return h.close(), true;
        if (nav(START.length)) return true;
        if (k.name === 'enter') {
          filter = '';
          if (pick === 0) {
            screen = 'where';
            draft = host;
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
        if (k.name === 'escape') return (screen = 'start', pick = 0, h.setBuffer(''), true);
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
        if (k.name === 'escape') return (screen = models.length ? 'model' : 'where', pick = 0, true);
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
        if (k.name === 'escape' && run && !run.state.done) {
          h.background(name(), run, run.promise.then((r) => finish(server(), r)).catch(() => {}));
          stopAnim();
          h.close();
          return true;
        }
        return true;
      }
      if (screen === 'local') {
        if (k.name === 'escape') return (screen = 'start', pick = 1, true);
        if (nav(local.length)) return true;
        if (k.name === 'enter') {
          if (!local.length) return (lookLocal(), true);
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
        return true;
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
        if (needMac) {
          if (!/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(v)) {
            add('fail', plain(`${v || 'that'} isn't a MAC address `), dim('· six pairs like 00:11:22:33:44:55'));
            return;
          }
          mac = v.toLowerCase().replace(/-/g, ':');
          h.setBuffer(host);
          survey();
          return;
        }
        if (checked && v === host) {
          screen = 'model';
          pick = 0;
          h.setBuffer('');
          return;
        }
        if (!v || checking) return;
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
      if (screen === 'where') draft = buf;
      else if (screen === 'models' || screen === 'providers') {
        filter = buf;
        pick = 0;
      }
    },
  };
}
