// /server (docs/providers.md §3.5) and /model (models grouped by provider, plus
// Rime's neutral effort and reasoning controls).

import type { Line } from '../core/term.ts';
import type { BoxRow } from '../core/view.ts';
import { listRow, settingRow } from '../core/view.ts';
import * as llama from '../providers/llamacpp.ts';
import { PRESETS } from '../providers/presets.ts';
import { connOf, listModels, modelOf, pickUrl, presetOf } from '../providers/registry.ts';
import { EFFORTS, type Effort, type Model } from '../providers/types.ts';
import type { Change, Settings } from '../core/settings.ts';
import { bar } from './loader.ts';
import { parseGpu, sections, ssh } from './ssh.ts';
import type { Host, Panel } from './ui.ts';

const STATUS = [
  "echo '###UPTIME'",
  "p=$(systemctl show -p MainPID --value llama-server 2>/dev/null); [ -n \"$p\" ] && [ \"$p\" != 0 ] && ps -o etimes= -p $p",
  "echo '###GPU'",
  'nvidia-smi --query-gpu=name,memory.total,memory.used,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits 2>/dev/null',
  "echo '###TEMP'",
  "nvidia-smi -q -d TEMPERATURE 2>/dev/null | grep -i 'max operating temp'",
  "echo '###END'",
].join('; ');

const ago = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m`);

type ServerHost = Host & { openSteps(name: string): void; ensure(name: string): void; down(name: string): void; promptRate(): number | undefined };
type Confirm = { q: string; why: string; cmd: string; yes: string; no: string; run: (signal: AbortSignal, progress: (p: number | null) => void) => Promise<string>; label: string; stopped: string };

export function createServer(h: ServerHost, name: string): Panel {
  const { st } = h;
  const p = h.cfg.providers[name];
  const host = p.ssh ?? name;
  const dim = (t: string) => ({ t, s: st.dim });
  const plain = (t: string) => ({ t, s: st.fg });
  const dot = (ok: boolean) => ({ t: '● ', s: ok ? st.ok : st.warn });
  let lines: Line[] = [[dim(`checking ${host}…`)]];
  let online = false;
  let loaded: string | undefined;
  let models: llama.ServerModel[] = [];
  let cached = 0;
  let pick = 0;
  let mode: 'list' | 'models' | 'confirm' | 'action' = 'list';
  let confirm: Confirm | null = null;
  let action: { c: Confirm; ac: AbortController; progress: number | null; bg: boolean } | null = null;
  let note: Line | null = null;

  const root = () => `http://127.0.0.1:${h.tunnel(name).port}`;

  async function refresh() {
    const t = h.tunnel(name);
    const hp = t.port ? await llama.health(root()).catch(() => null) : null;
    online = !!hp && (hp.status === 200 || hp.status === 503);
    const sv = sections((await ssh(host, STATUS, 15000)).out);
    const out: Line[] = [];
    const g = parseGpu(sv.GPU ?? '');
    const maxT = (sv.TEMP ?? '').match(/(\d+)\s*C/)?.[1];
    cached = 0;
    if (online) {
      const pr = await llama.props(root()).catch(() => null);
      const build = String(pr?.json?.build_info ?? '').match(/b\d+/)?.[0];
      const up = Number(sv.UPTIME?.trim());
      out.push([dot(true), plain('online '), dim(`· ${p.tunnel?.remote.split(':')[0] === '127.0.0.1' ? `${host} via tunnel 127.0.0.1:${t.port}` : root()}${build ? ` · llama.cpp ${build}` : ''}${up ? ` · up ${ago(up)}` : ''}`)]);
      const list = await llama.routerModels(root()).catch(() => null);
      models = list ?? [];
      loaded = list?.find((m) => m.status === 'loaded')?.id ?? (list ? undefined : p.model);
      const ctx = pr?.json?.default_generation_settings?.n_ctx;
      if (loaded) out.push([dot(true), { t: loaded, s: st.titleB }, plain(' loaded'), dim([ctx ? `${Math.round(ctx / 1000)}k context` : '', g ? `VRAM ${(g.memUsed / 1024).toFixed(1)} / ${Math.round(g.memTotal / 1024)} GB` : ''].filter(Boolean).map((x) => ` · ${x}`).join(''))]);
      else out.push([dot(false), plain('no model loaded'), dim(`${g ? ` · VRAM ${(g.memUsed / 1024).toFixed(1)} / ${Math.round(g.memTotal / 1024)} GB` : ''} · messages wait until one is loaded`)]);
      const slots = loaded ? await fetch(`${root()}/slots`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => null) : null;
      const s0 = Array.isArray(slots) ? slots[0] : null;
      const n = s0 ? (s0.n_past ?? s0.n_cache_tokens ?? s0.n_prompt_tokens_cache) : undefined;
      if (typeof n === 'number' && n > 0) {
        cached = n;
        const rate = h.promptRate();
        out.push([dim(`  main chat   ${(n / 1000).toFixed(1)}k tokens cached${rate ? ` (would take ~${Math.round(n / rate)} s to rebuild)` : ''}`)]);
      }
    } else out.push([dot(false), plain(`${host} isn't answering `), dim('· start it below, or it may be off')]);
    if (g) out.splice(online ? 2 : 1, 0, [dot(g.temp < (Number(maxT) || 83) - 5), plain(`${g.name.replace(/^(NVIDIA|Tesla)\s+/g, '').replace(/-(PCIE|SXM\d?).*$/i, '')} `), { t: `${g.temp}°C`, s: st.title }, dim(` · ${Math.round(g.power)} W of ${Math.round(g.powerLimit)} W${maxT ? ` · throttles at ${maxT}°C` : ''}`)]);
    lines = out;
    if (pick >= actions().length) pick = 0;
    h.redraw();
  }
  refresh();

  const sshRun = (cmd: string, done: string) => async (signal: AbortSignal) => {
    const r = await ssh(host, cmd, 60000, undefined, signal);
    if (signal.aborted) throw new Error('cancelled');
    if (r.code !== 0) throw new Error(`${cmd}: ${r.err.trim().split('\n').at(-1) || `exit ${r.code}`}`);
    return done;
  };
  const cacheNote = () => (cached ? `The main chat's cache (${(cached / 1000).toFixed(1)}k tokens) is dropped with it. ` : '');

  // Loading follows /models/sse; a cancel unloads it again (which also stops a download).
  const load = (model: string): Confirm => ({
    q: '', why: '', cmd: 'POST /models/load', yes: 'Load', no: '',
    label: `loading ${model}`,
    stopped: 'Loading was stopped and the model unloaded again; llama-server is still running.',
    run: async (signal, progress) => {
      try {
        const r = await llama.loadModel(root(), model, signal);
        if (r.status >= 400) throw new Error(`POST /models/load: ${r.json?.error?.message ?? r.status}`);
        await llama.waitLoaded(root(), model, progress, undefined, signal);
      } catch (e) {
        if (signal.aborted) await llama.unloadModel(root(), model).catch(() => {});
        throw e;
      }
      h.ensure(name); // connects the chat to it (the other steps are already done)
      return `${model} is loaded.`;
    },
  });

  type Action = { n: string; d: string; go: () => void };
  const ask = (c: Confirm) => () => {
    confirm = c;
    mode = 'confirm';
    pick = 0;
  };
  const actions = (): Action[] => {
    const target = p.model ?? models[0]?.id;
    const others = models.filter((m) => m.id !== loaded);
    const list: Action[] = [];
    if (!online) list.push({ n: 'Start', d: 'wake, connect, start and load, like at startup', go: () => (h.ensure(name), h.close()) });
    else {
      if (!loaded && target) list.push({ n: `Load ${target}`, d: 'POST /models/load', go: () => start(load(target)) });
      if (others.length > (loaded ? 0 : 1)) list.push({ n: 'Load another model', d: others.map((m) => m.id).join(', '), go: () => ((mode = 'models'), (pick = 0)) });
      if (loaded) {
        list.push({ n: 'Unload model', d: 'free the GPU, keep the server running', go: ask({
          q: `Unload ${loaded}?`, why: `${cacheNote()}Messages wait until a model is loaded again.`, cmd: 'POST /models/unload', yes: 'Unload', no: 'Keep it loaded',
          label: `unloading ${loaded}`, stopped: 'Unloading was stopped part-way.',
          run: async (signal) => {
            const r = await llama.unloadModel(root(), loaded!);
            if (signal.aborted) throw new Error('cancelled');
            if (r.status >= 400) throw new Error(`POST /models/unload: ${r.json?.error?.message ?? r.status}`);
            h.down(name);
            return `${loaded} was unloaded; llama-server is still running.`;
          },
        }) });
      }
      list.push({ n: 'Restart server', d: 'sudo systemctl restart llama-server', go: ask({
        q: 'Restart llama-server?', why: `${cacheNote()}The model loads again when the next message needs it.`, cmd: 'sudo systemctl restart llama-server', yes: 'Restart', no: 'Keep it running',
        label: 'restarting llama-server', stopped: 'The restart was stopped part-way; /server shows where it is.',
        run: async (signal) => (h.down(name), sshRun('sudo systemctl restart llama-server', 'llama-server was restarted.')(signal)),
      }) });
      list.push({ n: 'Stop server', d: 'sudo systemctl stop llama-server', go: ask({
        q: 'Stop llama-server?', why: `${cacheNote()}Messages start it again when you send one.`, cmd: 'sudo systemctl stop llama-server', yes: 'Stop it', no: 'Keep it running',
        label: 'stopping llama-server', stopped: 'Stopping was cancelled part-way; /server shows where it is.',
        run: async (signal) => (h.down(name), sshRun('sudo systemctl stop llama-server', `llama-server was stopped; ${host} is still on.`)(signal)),
      }) });
    }
    list.push({ n: `Power off ${host}`, d: 'sudo poweroff', go: ask({
      q: `Power off ${host}?`, why: `${cacheNote()}${p.wake?.mac ? `Rime wakes ${host} again the next time you send a message.` : `Turn ${host} on again yourself; Rime has no MAC address to wake it.`}`, cmd: 'sudo poweroff', yes: 'Power off', no: 'Keep it on',
      label: `powering off ${host}`, stopped: 'Power off was cancelled before it went through.',
      run: async (signal) => (h.down(name), sshRun('sudo poweroff', `${host} is powering off.`)(signal).catch((e) => (signal.aborted ? Promise.reject(e) : `${host} is powering off.`))),
    }) });
    list.push({ n: 'Show log', d: 'journalctl -u llama-server, last 200 lines', go: () => void showLog() });
    list.push({ n: 'Edit steps', d: 'same list as in /setup', go: () => h.openSteps(name) });
    return list;
  };

  async function showLog() {
    const r = await ssh(host, 'journalctl -u llama-server -n 200 --no-pager', 15000);
    h.say({ kind: 'lines', lines: (r.out || r.err || 'no log').trim().split('\n').map((l) => [dim(l)]) });
  }

  // Runs a confirmed action with progress; ctrl+c stops it, b moves it to the background.
  async function start(c: Confirm) {
    const a = { c, ac: new AbortController(), progress: null as number | null, bg: false };
    action = a;
    mode = 'action';
    note = null;
    h.redraw();
    const tick = setInterval(() => h.redraw(), 350);
    let msg: string;
    try {
      msg = await c.run(a.ac.signal, (pr) => ((a.progress = pr), h.redraw()));
    } catch (e) {
      msg = a.ac.signal.aborted ? `Cancelled. ${c.stopped}` : (e as Error).message;
    }
    clearInterval(tick);
    if (a.bg) return h.say({ kind: 'note', tone: 'dim', text: msg });
    action = null;
    mode = 'list';
    note = [dim(msg)];
    pick = 0;
    refresh();
  }

  const legend: Line = [{ t: 'server', s: st.accent }, dim(` · ${host}`)];

  return {
    view() {
      const rows: BoxRow[] = lines.map((line) => ({ line }));
      rows.push({ line: [] });
      if (mode === 'confirm' && confirm) {
        rows.push({ line: [plain(confirm.q)] }, { line: [dim(confirm.why)] }, { line: [dim('  runs: '), { t: confirm.cmd, s: st.title }] }, { line: [] });
        [confirm.yes, confirm.no].forEach((t, i) => rows.push(listRow(t, '', i === pick, st, `pick:${i}`, 22)));
        return { legend, rows, warn: true, foot: ['enter', ` ${(pick ? confirm.no : confirm.yes).toLowerCase()} · `, 'esc', ` ${confirm.no.toLowerCase()}`] };
      }
      if (mode === 'action' && action) {
        const pr = action.progress;
        rows.push({ line: [{ t: '● ', s: st.accent }, plain(action.c.label), dim(pr !== null ? ` · ${Math.round(pr * 100)}%` : '.'.repeat(1 + (Math.floor(Date.now() / 350) % 3)))] });
        if (pr !== null) {
          const b = bar(pr);
          rows.push({ line: [{ t: b.fill, s: st.accent }, { t: b.empty, s: st.line }] });
        }
        rows.push({ line: [dim('ctrl+c stops it part-way. b keeps it going in the background.')] });
        return { legend, rows, foot: ['ctrl+c', ' cancel · ', 'b', ' run in background'] };
      }
      if (mode === 'models') {
        rows.push({ line: [dim('Load which model?')] });
        models.forEach((m, i) => rows.push(listRow(m.id, m.status === 'loaded' ? 'loaded' : m.path?.split('/').pop() ?? '', i === pick, st, `pick:${i}`, 22)));
        return { legend, rows, foot: ['↑ ↓', ' choose · ', 'enter', ' load · ', 'esc', ' back'] };
      }
      actions().forEach((a, i) => rows.push(listRow(a.n, a.d, i === pick, st, `pick:${i}`, 22)));
      if (note) rows.push({ line: [] }, { line: note });
      return { legend, rows, foot: ['↑ ↓', ' choose · ', 'enter', ' pick · ', 'esc', ' close'] };
    },
    placeholder: () => (mode === 'confirm' ? 'Enter to confirm, esc to keep things as they are' : mode === 'action' ? `Working on ${host}` : 'Pick an action'),
    cancel() {
      if (mode === 'action') return action?.ac.abort();
      if (mode === 'confirm' || mode === 'models') return void ((mode = 'list'), (pick = 0));
      h.close();
    },
    key(k) {
      if (mode === 'action') {
        if (k.name === 'char' && k.ch === 'b' && action) {
          action.bg = true;
          h.say({ kind: 'note', tone: 'dim', text: `${action.c.label} in the background` });
          h.close();
        }
        return true;
      }
      const n = mode === 'confirm' ? 2 : mode === 'models' ? models.length : actions().length;
      if (k.name === 'escape') {
        if (mode === 'list') h.close();
        else (mode = 'list'), (pick = 0);
        return true;
      }
      if (k.name === 'up') return (pick = (pick + n - 1) % n, true);
      if (k.name === 'down') return (pick = (pick + 1) % n, true);
      if (k.name === 'enter') {
        if (mode === 'confirm') {
          if (pick === 0) start(confirm!);
          else (mode = 'list'), (pick = 0);
        } else if (mode === 'models') {
          if (models[pick] && models[pick].id !== loaded) start(load(models[pick].id));
        } else {
          note = null;
          actions()[pick]?.go();
        }
        return true;
      }
      return true;
    },
    click(id) {
      pick = Number(id.split(':')[1]);
    },
  };
}

// ---- /model ----

type Group = { name: string; label: string; models: Model[] | null; error?: string };

export function createModelPicker(
  h: Host & {
    current(): Model | undefined; controls(): { reasoning: boolean; effort?: Effort }; setControls(c: { reasoning: boolean; effort?: Effort }): void; choose(m: Model): void;
    inContext(): number; // tokens the current task has built up (0: nothing to lose)
    later(m: Model): void; // switch at the next /clear instead
  },
): Panel {
  const { st, cfg } = h;
  const dim = (t: string) => ({ t, s: st.dim });
  const groups: Group[] = Object.entries(cfg.providers).map(([name, p]) => ({ name, label: p.ssh ? `${name} · ${presetOf(p).label}${p.probe?.build ? ` ${p.probe.build}` : ''}` : presetOf(p).label === name ? name : `${name} · ${presetOf(p).label}`, models: null }));
  let pick = 0;
  const effortVals: (Effort | undefined)[] = [undefined, ...EFFORTS];

  // Model lists come from each provider; an own server that isn't up yet shows
  // the model it's set to load.
  for (const g of groups) {
    const p = cfg.providers[g.name];
    (async () => {
      const t = p.ssh ? h.tunnel(g.name) : null;
      const base = p.ssh ? (t!.port ? `http://127.0.0.1:${t!.port}/v1` : '') : await pickUrl([p.url ?? PRESETS[p.preset]?.url ?? ''].flat());
      const conn = connOf(g.name, p, base || '');
      if (!base) {
        g.models = p.model ? [modelOf(cfg, conn, p.model)] : [];
        return;
      }
      const server = conn.llamacpp ? await llama.routerModels(llama.rootOf(base)).catch(() => null) : null;
      if (server) g.models = server.map((m) => modelOf(cfg, conn, m.id));
      else {
        const r = await listModels(conn).catch(() => ({ status: 0, models: [] }));
        if (r.status !== 200) g.error = r.status === 401 ? 'the key was refused' : `not answering (${r.status || 'offline'})`;
        g.models = r.models.map((m) => modelOf(cfg, conn, m.id, m));
      }
    })().finally(() => h.redraw());
  }

  const flat = () => groups.flatMap((g) => g.models ?? []);
  // A task keeps one model (SPEC §15: the model applies from the next task), so
  // switching mid-conversation asks first and says what the cache costs.
  let asking: Model | null = null;

  return {
    view() {
      const rows: BoxRow[] = [];
      if (asking) {
        const n = h.inContext();
        rows.push(
          { line: [{ t: `Switch to ${asking.label} now?`, s: st.fg }] },
          { line: [dim(`A task keeps one model. Switching now rebuilds the cache (~${n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n} tokens) on ${asking.provider}.`)] },
          { line: [] },
          listRow('Switch now', 'rebuilds the cache', pick === 0, st, 'pick:0', 22),
          listRow('At the next /clear', `keeps ${h.current()?.label ?? 'the current model'} until then`, pick === 1, st, 'pick:1', 22),
        );
        return { legend: [{ t: 'model', s: st.accent }], rows, warn: true, foot: ['enter', ' choose · ', 'esc', ' back'] };
      }
      const cur = h.current();
      let i = 0;
      if (!groups.length) rows.push({ line: [dim('Nothing is connected yet. /setup connects a server or a provider.')] });
      for (const g of groups) {
        rows.push({ line: [dim(g.label)] });
        if (!g.models) rows.push({ line: [dim('  loading…')] });
        else if (g.error) rows.push({ line: [dim(`  ${g.error}`)] });
        for (const m of g.models ?? []) {
          const here = i;
          rows.push(listRow(m.label, [{ t: m.ref === cur?.ref ? '● ' : '', s: st.ok }, dim([m.id !== m.label ? m.id : '', m.context ? `${Math.round(m.context / 1000)}k context` : ''].filter(Boolean).join(' · '))], pick === here, st, `pick:${here}`, 22));
          i++;
        }
      }
      const c = h.controls();
      rows.push({ line: [] }, { line: [dim('Settings')] });
      rows.push(settingRow('Effort', c.effort ?? 'default', pick === i, st, `pick:${i}`));
      rows.push(settingRow('Reasoning', c.reasoning ? 'on' : 'off', pick === i + 1, st, `pick:${i + 1}`));
      return { legend: [{ t: 'model', s: st.accent }], rows, foot: ['↑ ↓', ' choose · ', '← →', ' change a setting · ', 'enter', ' use it · ', 'esc', ' close'] };
    },
    placeholder: () => 'Pick a model',
    cancel() {
      if (asking) return void ((asking = null), (pick = 0));
      h.close();
    },
    key(k) {
      if (asking) {
        if (k.name === 'up' || k.name === 'down') return (pick = 1 - pick, true);
        if (k.name === 'escape') return (asking = null, pick = 0, true);
        if (k.name === 'enter') {
          if (pick === 0) h.choose(asking);
          else h.later(asking);
          h.close();
        }
        return true;
      }
      const n = flat().length + 2;
      if (k.name === 'escape') return h.close(), true;
      if (k.name === 'up') return (pick = (pick + n - 1) % n, true);
      if (k.name === 'down') return (pick = (pick + 1) % n, true);
      const at = pick - flat().length;
      if ((k.name === 'left' || k.name === 'right') && at >= 0) {
        const c = h.controls();
        const d = k.name === 'right' ? 1 : -1;
        if (at === 0) {
          const i = effortVals.indexOf(c.effort);
          h.setControls({ ...c, effort: effortVals[(i + d + effortVals.length) % effortVals.length] });
        } else h.setControls({ ...c, reasoning: !c.reasoning });
        return true;
      }
      if (k.name === 'enter') {
        const m = flat()[pick];
        if (m && m.ref !== h.current()?.ref && h.inContext() > 0) {
          asking = m;
          pick = 0;
          return true;
        }
        if (m) h.choose(m);
        h.close();
        return true;
      }
      return true;
    },
    click(id) {
      pick = Number(id.split(':')[1]);
    },
  };
}


// ---- /settings ----

type SettingsHost = Host & { settings: Settings; current(): Model | undefined; openModel(): void; openSteps(name: string): void; openConnect(): void };
type Row = { group: string; label: string; help: string; kind: 'value' | 'action' | 'undo'; key?: string; go?: () => void; change?: Change };

// Every setting in one box, grouped, changed in place and applied live (SPEC §15).
// Typing filters; ← → change a value; recent changes are listed with undo.
export function createSettingsPanel(h: SettingsHost): Panel {
  const { st, settings, cfg } = h;
  const dim = (t: string) => ({ t, s: st.dim });
  let pick = 0;
  let filter = '';
  const ago = (t: number) => {
    const s = Math.round((Date.now() - t) / 1000);
    return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
  };

  function rows(): Row[] {
    const defs = settings.list();
    const out: Row[] = [
      { group: 'Model', label: 'Model', help: `${h.current()?.label ?? 'none'} · enter picks one`, kind: 'action', go: h.openModel },
      ...defs.filter((d) => d.group === 'Model').map((d): Row => ({ group: 'Model', label: d.label, help: d.help, kind: 'value', key: d.key })),
      ...Object.entries(cfg.providers).map(([name, p]): Row => ({ group: 'Providers', label: name, help: `${p.ssh ? `own server over ssh (${p.ssh})` : p.url ? String(p.url) : p.preset}`, kind: 'action', go: p.ssh ? () => h.openSteps(name) : h.openConnect })),
      { group: 'Providers', label: 'Add a provider or URL', help: '/connect', kind: 'action', go: h.openConnect },
      ...defs.filter((d) => d.group === 'Server').map((d): Row => ({ group: 'Server', label: d.label, help: d.help, kind: 'value', key: d.key })),
      ...Object.entries(cfg.providers).filter(([, p]) => p.ssh).map(([name]): Row => ({ group: 'Server', label: `${name}: steps`, help: 'the commands that bring it up', kind: 'action', go: () => h.openSteps(name) })),
      ...settings.recent().slice(0, 5).map((c): Row => ({ group: 'Recent changes', label: `${c.label} ${c.to}`, help: c.undone ? 'undone' : `was ${c.from} · ${ago(c.at)} · enter undoes`, kind: 'undo', change: c })),
    ];
    const f = filter.toLowerCase();
    return f ? out.filter((r) => `${r.group} ${r.label} ${r.help}`.toLowerCase().includes(f)) : out;
  }

  return {
    view(width) {
      const list = rows();
      pick = Math.min(pick, Math.max(0, list.length - 1));
      const out: BoxRow[] = [];
      let group = '';
      list.forEach((r, i) => {
        if (r.group !== group) {
          if (group) out.push({ line: [] });
          group = r.group;
          out.push({ line: [dim(r.group)] });
        }
        if (r.kind === 'value') {
          const v = settings.get(r.key!) ?? '';
          const row = settingRow(r.label, v, i === pick, st, `pick:${i}`);
          out.push({ ...row, line: [{ t: i === pick ? '› ' : '  ', s: st.accent }, ...row.line.slice(0, 1).map((x) => ({ ...x, t: x.t.slice(0, 26) })), ...row.line.slice(1), dim(`  ${r.help}`)] });
        } else out.push(listRow(r.label, r.kind === 'undo' && r.change?.undone ? [dim(r.help)] : r.help, i === pick, st, `pick:${i}`, 28));
      });
      if (!list.length) out.push({ line: [dim(`no setting matches ${filter}`)] });
      void width;
      return { legend: [{ t: 'settings', s: st.accent }, dim(' · applied right away')], rows: out, foot: ['↑ ↓', ' choose · ', '← →', ' change · ', 'enter', ' open or undo · type to filter · ', 'esc', ' close'] };
    },
    placeholder: () => 'Type to filter settings',
    typing: () => true,
    key(k) {
      const list = rows();
      const r = list[pick];
      if (k.name === 'escape') {
        if (filter) return h.setBuffer(''), (filter = ''), true;
        return h.close(), true;
      }
      if (k.name === 'up') return (pick = (pick + list.length - 1) % Math.max(1, list.length), true);
      if (k.name === 'down') return (pick = (pick + 1) % Math.max(1, list.length), true);
      if ((k.name === 'left' || k.name === 'right') && r?.kind === 'value') {
        const d = settings.list().find((x) => x.key === r.key)!;
        const i = d.values.indexOf(d.get(cfg));
        settings.set(d.key, d.values[(i + (k.name === 'right' ? 1 : -1) + d.values.length) % d.values.length]);
        return true;
      }
      if (k.name === 'left' || k.name === 'right') return false; // move in the filter text
      if (k.name === 'enter') {
        if (r?.kind === 'action') r.go!();
        else if (r?.kind === 'undo') settings.undo(r.change!);
        else if (r?.kind === 'value') {
          const d = settings.list().find((x) => x.key === r.key)!;
          settings.set(d.key, d.values[(d.values.indexOf(d.get(cfg)) + 1) % d.values.length]);
        }
        return true;
      }
      return false;
    },
    changed(buf) {
      filter = buf;
      pick = 0;
    },
    click(id) {
      pick = Number(id.split(':')[1]);
    },
  };
}
