// /server (docs/providers.md §3.5) and /model (models grouped by provider, plus
// Rime's neutral effort and reasoning controls).

import type { Line } from '../core/term.ts';
import type { BoxRow } from '../core/view.ts';
import { listRow, settingRow } from '../core/view.ts';
import * as llama from '../providers/llamacpp.ts';
import { PRESETS } from '../providers/presets.ts';
import { connOf, listModels, modelOf, pickUrl, presetOf } from '../providers/registry.ts';
import { EFFORTS, type Effort, type Model } from '../providers/types.ts';
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

export function createServer(h: Host & { openSteps(name: string): void; ensure(name: string): void; promptRate(): number | undefined }, name: string): Panel {
  const { st } = h;
  const p = h.cfg.providers[name];
  const host = p.ssh ?? name;
  const dim = (t: string) => ({ t, s: st.dim });
  const plain = (t: string) => ({ t, s: st.fg });
  const dot = (ok: boolean) => ({ t: '● ', s: ok ? st.ok : st.warn });
  let lines: Line[] = [[dim(`checking ${host}…`)]];
  let online = false;
  let loaded: string | undefined;
  let pick = 0;
  let confirm = -1;
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
    if (online) {
      const pr = await llama.props(root()).catch(() => null);
      const build = String(pr?.json?.build_info ?? '').match(/b\d+/)?.[0];
      const up = Number(sv.UPTIME?.trim());
      out.push([dot(true), plain('online '), dim(`· ${p.tunnel?.remote.split(':')[0] === '127.0.0.1' ? `${host} via tunnel 127.0.0.1:${t.port}` : root()}${build ? ` · llama.cpp ${build}` : ''}${up ? ` · up ${ago(up)}` : ''}`)]);
      const list = await llama.routerModels(root()).catch(() => null);
      loaded = list?.find((m) => m.status === 'loaded')?.id ?? (list ? undefined : p.model);
      const ctx = pr?.json?.default_generation_settings?.n_ctx;
      if (loaded) out.push([dot(true), { t: loaded, s: st.titleB }, plain(' loaded'), dim([ctx ? `${Math.round(ctx / 1000)}k context` : '', g ? `VRAM ${(g.memUsed / 1024).toFixed(1)} / ${Math.round(g.memTotal / 1024)} GB` : ''].filter(Boolean).map((x) => ` · ${x}`).join(''))]);
      else out.push([dot(false), plain('no model loaded')]);
      const slots = await fetch(`${root()}/slots`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => null);
      const s0 = Array.isArray(slots) ? slots[0] : null;
      const cached = s0 ? (s0.n_past ?? s0.n_cache_tokens ?? s0.n_prompt_tokens_cache) : undefined;
      if (typeof cached === 'number' && cached > 0) {
        const rate = h.promptRate();
        out.push([dim(`  main chat   ${(cached / 1000).toFixed(1)}k tokens cached${rate ? ` (would take ~${Math.round(cached / rate)} s to rebuild)` : ''}`)]);
      }
    } else out.push([dot(false), plain(`${host} isn't answering `), dim('· start it below, or it may be off')]);
    if (g) out.splice(online ? 2 : 1, 0, [dot(g.temp < (Number(maxT) || 83) - 5), plain(`${g.name.replace(/^(NVIDIA|Tesla)\s+/g, '').replace(/-(PCIE|SXM\d?).*$/i, '')} `), { t: `${g.temp}°C`, s: st.title }, dim(` · ${Math.round(g.power)} W of ${Math.round(g.powerLimit)} W${maxT ? ` · throttles at ${maxT}°C` : ''}`)]);
    lines = out;
    h.redraw();
  }
  refresh();

  type Action = [string, string, () => Promise<string | void> | string | void];
  const actions = (): Action[] =>
    online
      ? [
          ['Unload model', 'free the GPU, keep the server running', async () => loaded ? (await llama.unloadModel(root(), loaded), `unloaded ${loaded}`) : 'nothing is loaded'],
          ['Restart server', 'sudo systemctl restart llama-server', async () => ((await ssh(host, 'sudo systemctl restart llama-server', 60000)).code === 0 ? 'restarted' : 'restart failed')],
          ['Stop server', 'sudo systemctl stop llama-server', async () => ((await ssh(host, 'sudo systemctl stop llama-server', 60000)).code === 0 ? 'stopped' : 'stop failed')],
          [`Power off ${host}`, 'saves the cache first, then sudo poweroff', async () => (await ssh(host, 'sudo poweroff', 15000), `${host} is powering off`)],
          ['Show log', 'journalctl -u llama-server, last 200 lines', () => showLog()],
          ['Edit steps', 'same list as in /setup', () => h.openSteps(name)],
        ]
      : [
          ['Start', 'wake, connect, start and load, like at startup', () => (h.ensure(name), h.close())],
          ['Show log', 'journalctl -u llama-server, last 200 lines', () => showLog()],
          ['Edit steps', 'same list as in /setup', () => h.openSteps(name)],
        ];

  async function showLog() {
    const r = await ssh(host, 'journalctl -u llama-server -n 200 --no-pager', 15000);
    h.say({ kind: 'lines', lines: (r.out || r.err || 'no log').trim().split('\n').map((l) => [dim(l)]) });
  }

  async function runAction(i: number) {
    const a = actions()[i];
    if (!a) return;
    if (a[0].startsWith('Power off') && confirm !== i) {
      confirm = i;
      note = [{ t: '! ', s: st.warn }, plain(`press enter again to power off ${host}`)];
      return h.redraw();
    }
    confirm = -1;
    note = [dim(`${a[0].toLowerCase()}…`)];
    h.redraw();
    const r = await a[2]();
    if (typeof r === 'string') note = [dim(r)];
    else note = null;
    refresh();
  }

  return {
    view() {
      const rows: BoxRow[] = lines.map((line) => ({ line }));
      rows.push({ line: [] });
      actions().forEach(([n, d], i) => rows.push(listRow(n, d, i === pick, st, `pick:${i}`, 22)));
      if (note) rows.push({ line: [] }, { line: note });
      return { legend: [{ t: 'server', s: st.accent }, dim(` · ${host}`)], rows, foot: ['↑ ↓', ' choose · ', 'enter', ' run · ', 'esc', ' close'] };
    },
    placeholder: () => 'Pick an action',
    key(k) {
      const n = actions().length;
      if (k.name === 'escape') return h.close(), true;
      if (k.name === 'up') return (pick = (pick + n - 1) % n, confirm = -1, true);
      if (k.name === 'down') return (pick = (pick + 1) % n, confirm = -1, true);
      if (k.name === 'enter') return (runAction(pick), true);
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
  h: Host & { current(): Model | undefined; controls(): { reasoning: boolean; effort?: Effort }; setControls(c: { reasoning: boolean; effort?: Effort }): void; choose(m: Model): void },
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

  return {
    view() {
      const rows: BoxRow[] = [];
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
    key(k) {
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

