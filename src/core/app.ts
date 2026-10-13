// The single-pane Rime screen (SPEC §4, reference/rime-prototype.html).
//
// Full screen on the alternate screen: the transcript scrolls in the top part
// (wheel, PgUp/PgDn), the boxes, prompt and status line are pinned to the bottom.
// Models come from connected providers (docs/providers.md); /setup connects them.

import { copy } from './clipboard.ts';
import { type Config, saveConfig } from './config.ts';
import { CUBE_COLS, type Header, type HeaderOpts, SCENE, playHeader } from './header.ts';
import { type InputEvent, type Line, createParser, fit, lineWidth, sliceCols, strWidth, truncAnsi, wrap } from './term.ts';
import { colorMode } from './theme.ts';
import { type BoxRow, type Hit, type Item, box, caretOf, footRows, layoutInput, listRow, prompt, renderItem, spaced, status, styles } from './view.ts';
import { createMeter, fmt$, fmtS, fmtT } from '../plugins/token-kit/meter.ts';
import * as llama from '../providers/llamacpp.ts';
import { PRESETS } from '../providers/presets.ts';
import { connOf, modelOf, pickUrl, streamFor } from '../providers/registry.ts';
import { ApiError, type Block, type Conn, type Controls, type Effort, type Message, type Model, type Usage } from '../providers/types.ts';
import { bar } from '../setup/loader.ts';
import { createModelPicker, createServer } from '../setup/panels.ts';
import { ssh } from '../setup/ssh.ts';
import { NAMES, type Run, runSteps } from '../setup/steps.ts';
import { type Host, type Panel, type Tunnel, createSetup } from '../setup/ui.ts';

const CMDS: [string, string][] = [
  ['/model', 'pick a model, effort and reasoning'],
  ['/setup', 'connect your server, this computer, or a provider'],
  ['/server', 'status and controls for your server'],
  ['/connect', 'add a provider or URL: /connect <url>'],
  ['/clear', 'start a new conversation'],
  ['/usage', 'token, cost and savings breakdown'],
  ['/exit', 'quit Rime'],
];

const KEYS: [string, string][] = [
  ['enter', 'send'], ['shift+enter', 'new line'], ['esc', 'stop Rime, or close a box'],
  ['↑', 'edit your last message'], ['tab', 'complete a command'], ['ctrl+c ×2', 'quit'],
  ['pgup pgdn', 'scroll, or use the wheel'], ['/', 'commands'], ['?', 'this list'],
];

// Frozen for the whole session: any byte change here would break the prompt cache.
const system = (cwd: string) =>
  `You are Rime, a coding assistant running in the user's terminal.\n` +
  `Working directory: ${cwd}\n` +
  `Be brief and direct. Use plain text with light markdown (lists, \`code\`, fenced blocks); no tables.`;

const fmtP = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

// Modes: alternate screen, SGR mouse (clicks, drags for selection, wheel), bracketed paste, kitty
// keyboard (disambiguate) and xterm modifyOtherKeys so shift+enter is
// distinguishable, accent cursor color.
const MODES_ON = '\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[>1u\x1b[>4;1m\x1b]12;#7FD4F5\x07';
const MODES_OFF = '\x1b[?1002l\x1b[?1006l\x1b[?2004l\x1b[<u\x1b[>4;0m\x1b]112\x07\x1b[?25h\x1b[?1049l';

// What the compact loader says in header line 2 while a server comes up.
const PHASE: Record<string, string> = { wake: 'waking', connect: 'connecting', tunnel: 'opening the tunnel', start: 'starting', load: 'loading', warm: 'warming the cache', test: 'testing' };

export async function runApp(cfg: Config, version: string) {
  const out = process.stdout, inp = process.stdin;
  const st = styles(colorMode(out));
  const write = (s: string) => out.write(s);
  const meter = createMeter();
  const cwd = process.cwd();
  const SYSTEM = system(cwd);

  // ---- state ----
  let model: Model | undefined;
  let conn: Conn | undefined; // set once the model's provider answers
  let controls: Controls = { reasoning: cfg.reasoning !== false, effort: cfg.effort };
  // A task keeps one model; controls that would break its cache stay fixed for it.
  let task: { controls: Controls; sentEffort?: Effort; lastPrompt: number; lastControls?: Controls } | null = null;
  const unsafe = new Set<string>(); // models where changing controls was measured to reset the cache
  let messages: Message[] = [];
  const history: string[] = [];
  let buf = '', cur = 0, sel = 0;
  let boxKind: 'keys' | 'usage' | null = null;
  let panel: Panel | null = null;
  let busy: { abort(): void; esc(): void } | null = null;
  let quitArmed: NodeJS.Timeout | null = null;
  let quitting: string | null = null;
  const tunnels: Record<string, Tunnel> = {};
  let bg: { name: string; run: Run } | null = null; // an own server coming up in the background
  let waiting: string | null = null; // a message held until the model is ready
  let promptRate: number | undefined; // local prompt tokens/s, from the last reply

  // ---- screen ----
  let scrollOff = 0; // transcript lines scrolled up from the bottom
  let lastTotal = 0;
  let viewH = 0;
  let headerRow = 0; // screen row of the header's first line (can be off screen)
  let hits: { row: number; x0: number; x1: number; id: string }[] = [];
  let scheduled = false;
  const cache = new WeakMap<Item, { width: number; lines: string[] }>();

  // Mouse selection, in screen cells. `rows` is what the last frame drew.
  let press: { x: number; y: number; hit?: string } | null = null;
  let selection: { a: { x: number; y: number }; b: { x: number; y: number } } | null = null;
  let copied: NodeJS.Timeout | null = null;
  let rows: string[] = [];

  let header!: Header;
  const headerOpts: HeaderOpts & { ready: (h: Header) => void } = {
    version, cwd, mode: st.mode, interactive: false,
    onFrame: () => schedule(),
    ready: (h) => (header = h),
  };
  const headerItem: Item = { kind: 'header', lines: () => header.lines() };
  let items: Item[] = [headerItem];

  const W = () => out.columns || 80;
  const H = () => out.rows || 24;
  const connected = () => Object.keys(cfg.providers).length > 0;
  const tunnel = (name: string) => (tunnels[name] ??= { child: null, port: 0 });

  // Header line 2: the model and what was actually sent, or the compact loader.
  function headerInfo() {
    if (!model) return { model: undefined, details: connected() ? 'no model selected' : 'no model connected' };
    const p = model.provider;
    if (bg && bg.name === p && !bg.run.state.done) {
      const s = bg.run.state;
      const step = s.steps.find((v) => v.status === 'run' || v.status === 'fail');
      if (step?.status === 'fail') return { model: model.label, details: `${p} · couldn't start: /server` };
      const b = bar(s.overall, 6);
      return { model: model.label, details: `${p} · ${PHASE[step?.id ?? 'connect']} ${b.fill}${b.empty} ${b.pct.trim()}` };
    }
    const ctx = model.context ? `${model.context >= 1000 ? Math.round(model.context / 1000) + 'k' : model.context} context` : '';
    const c = sentControls();
    const eff = !c.reasoning ? 'reasoning off' : c.effort ? `${conn?.llamacpp ? llama.effortsFor(model)[c.effort] : c.effort} effort` : '';
    return { model: model.label, details: [p, ctx, eff].filter(Boolean).join(' · ') };
  }

  function render(it: Item, width: number) {
    const done = it.kind === 'user' || it.kind === 'cost' || it.kind === 'note' || it.kind === 'lines' || (it.kind === 'reply' && it.done);
    const hit = cache.get(it);
    if (done && hit && hit.width === width) return hit.lines;
    const lines = renderItem(it, width, st);
    if (done) cache.set(it, { width, lines });
    return lines;
  }

  function transcript(width: number) {
    const lines: string[] = [];
    let prev: Item | undefined;
    for (const it of items) {
      if (spaced(prev, it)) lines.push('');
      lines.push(...render(it, width));
      prev = it;
    }
    if (prev !== headerItem) lines.push(''); // the log's bottom margin
    return lines;
  }

  // ---- boxes above the prompt ----

  const matches = () => {
    const q = buf.slice(1).toLowerCase();
    const pre = CMDS.filter(([n]) => n.slice(1).startsWith(q));
    return [...pre, ...CMDS.filter((c) => !pre.includes(c) && (c[0] + ' ' + c[1]).toLowerCase().includes(q))];
  };
  const cmdsOpen = () => !panel && boxKind !== 'keys' && buf.startsWith('/') && !/\s/.test(buf);

  function usageRows(width: number): BoxRow[] {
    const t = meter.tokens, c = meter.cost, p = model?.price;
    const sp = meter.spent(), sv = meter.savedTotal();
    const savedCell = `${fmt$(sv)} (${meter.pct()}%)`;
    const data: [string, string, string][] = [
      ['input', fmtT(t.uncached), fmt$(c.uncached)],
      ['cache reads', fmtT(t.read), fmt$(c.read)],
      ['cache writes', fmtT(t.write), fmt$(c.write)],
      ['output', fmtT(t.out), fmt$(c.out)],
      ['total spent', fmtT(meter.totalTokens()), fmt$(sp)],
    ];
    const inner = width - 4;
    const tw = Math.max(6, ...data.map((d) => d[1].length));
    const cw = Math.max(4, savedCell.length, ...data.map((d) => d[2].length));
    const row = (label: Line, tok: string, cost: string, s: string): BoxRow => ({
      line: [...fit(label, inner - tw - cw - 2, true), { t: ' ' + tok.padStart(tw) + ' ' + cost.padStart(cw), s }],
    });
    const why = p && p.in ? `context re-read at ${fmtP(p.read)} instead of ${fmtP(p.in)}` : 'context re-read at the cache price';
    const prices = p && p.in ? `Prices per million tokens: ${fmtP(p.in)} input, ${fmtP(p.read)} cache read, ${fmtP(p.write)} cache write, ${fmtP(p.out)} output. ` : '';
    const notes = [
      meter.unpriced() ? 'Some replies came from a model with an unknown price, so their dollars aren\'t counted. ' : '',
      meter.saved.ms >= 1000 ? `Local prompt caching saved about ${fmtS(meter.saved.ms)} of prompt processing. ` : '',
    ].join('');
    const foot = wrap([
      { t: `Without Rime this session would have cost ${fmt$(sp + sv)}. ${prices}${notes}`, s: st.dim },
      { t: '/usage', s: st.accent },
      { t: ' or a click on the meter closes this.', s: st.dim },
    ], inner);
    return [
      row([{ t: 'spent', s: st.dim }], 'tokens', 'cost', st.dim),
      ...data.slice(0, 4).map(([a, b, d]) => row([{ t: a, s: st.fg }], b, d, st.fg)),
      { line: [], rule: 'inner' },
      row([{ t: data[4][0], s: st.title }], data[4][1], data[4][2], st.title),
      { line: [] },
      { line: [], rule: 'inner' },
      row([{ t: 'Rime saved', s: st.ok }], '', savedCell, st.ok),
      row([{ t: '  prompt caching', s: st.fg }], '', fmt$(meter.saved.cache), st.fg),
      { line: [{ t: '  ' + why, s: st.dim }] },
      { line: [], rule: 'inner' },
      ...foot.map((line) => ({ line })),
    ];
  }

  function currentBox(width: number) {
    if (panel) {
      const v = panel.view(width);
      return box(v.legend, [...v.rows, ...footRows(v.foot, st)], width, st);
    }
    if (cmdsOpen()) {
      const m = matches();
      sel = Math.min(sel, Math.max(0, m.length - 1));
      const rows: BoxRow[] = m.length
        ? m.map(([n, h], i) => listRow(n, h, i === sel, st, `cmd:${i}`))
        : [{ line: [{ t: `no command matches ${buf}`, s: st.dim }] }];
      return box('commands', [...rows, ...footRows('↑↓ choose · tab complete · ↵ run · esc close', st)], width, st);
    }
    if (boxKind === 'keys') {
      return box('shortcuts', [...KEYS.map(([k, h]) => listRow(k, h, false, st)), ...footRows('any key to close', st)], width, st);
    }
    if (boxKind === 'usage') return box(`usage · this session${model ? ` · ${model.label}` : ''}`, usageRows(width), width, st);
    return null;
  }

  function meterLine(): Line {
    if (!connected()) return [{ t: 'no model', s: st.dim }];
    const tokens = `${fmtT(meter.totalTokens())} tokens`;
    if (conn?.local || (!conn && model && cfg.providers[model.provider]?.ssh)) {
      const ms = meter.saved.ms;
      return [{ t: `${tokens} · ${fmt$(meter.spent())} · local`, s: st.dim }, ...(ms >= 1000 ? [{ t: ` · saved ~${fmtS(ms)}`, s: st.ok }] : [])];
    }
    if (meter.unpriced() && !meter.spent()) return [{ t: tokens, s: st.dim }];
    return [{ t: `${tokens} · ${fmt$(meter.spent())} · `, s: st.dim }, { t: `saved ${fmt$(meter.savedTotal())} (${meter.pct()}%)`, s: st.ok }];
  }

  function ui(width: number, height: number) {
    const lines: string[] = [];
    const rowHits: Hit[][] = [];
    const b = currentBox(width);
    if (b && b.lines.length <= height - 4) {
      lines.push(...b.lines);
      b.hits.forEach((id) => rowHits.push(id ? [{ x0: 1, x1: width, id }] : []));
    }
    const p = prompt(buf, cur, width, Math.max(1, Math.min(10, height - lines.length - 3)), st, panel?.placeholder?.() ?? undefined, panel?.masked?.() ?? false);
    const promptAt = lines.length;
    lines.push(...p.lines);
    p.lines.forEach(() => rowHits.push([]));

    let left: Line, leftHits: Hit[] = [];
    const ps = panel?.status?.();
    if (quitting) left = [{ t: quitting, s: st.dim }];
    else if (quitArmed) left = [{ t: 'press ctrl+c again to quit', s: st.dim }];
    else if (copied) left = [{ t: '✓', s: st.ok }, { t: ' copied to clipboard', s: st.dim }];
    else if (ps) left = ps;
    else if (scrollOff > 0) {
      left = [{ t: '↓', s: st.accentB }, { t: ` ${scrollOff} lines below · pgdn`, s: st.dim }];
      leftHits = [{ x0: 1, x1: lineWidth(left), id: 'bottom' }];
    } else if (busy) left = [{ t: 'esc', s: st.accentB }, { t: ' to stop', s: st.dim }];
    else {
      left = [
        { t: '/', s: st.accentB }, { t: ' for commands', s: st.dim }, { t: ' · ', s: st.dim },
        { t: '?', s: st.accentB }, { t: ' for shortcuts', s: st.dim },
      ];
      leftHits = [{ x0: 1, x1: 14, id: '/' }, { x0: 18, x1: 32, id: '?' }];
    }
    const s = status(left, meterLine(), width, st, leftHits);
    lines.push(s.line);
    rowHits.push(s.hits);
    return { lines, rowHits, cursor: { row: promptAt + p.cursor.row, col: p.cursor.col } };
  }

  // ---- drawing ----

  // Full screen, like vim: the transcript fills the top (scrollable), the boxes,
  // prompt and status line sit at the bottom. Every frame repaints every row.
  function frame() {
    scheduled = false;
    Object.assign(headerOpts, headerInfo());
    const width = W(), height = H();
    const lines = transcript(width);
    const u = ui(width, height);
    viewH = Math.max(0, height - u.lines.length);
    if (scrollOff > 0) scrollOff += lines.length - lastTotal; // hold still while scrolled up
    lastTotal = lines.length;
    scrollOff = Math.max(0, Math.min(scrollOff, lines.length - viewH));
    const start = Math.max(0, lines.length - viewH - scrollOff);
    const view = lines.slice(start, start + viewH);
    const screen = [...view, ...new Array(viewH - view.length).fill(''), ...u.lines];
    headerRow = items[0] === headerItem ? 2 - start : -99;
    hits = u.rowHits.flatMap((hs, i) => hs.map((h) => ({ ...h, row: viewH + 1 + i })));
    rows = screen.map((l) => truncAnsi(l, width));
    write(
      '\x1b[?2026h\x1b[?25l' +
      // Clear first: erasing after a full-width line would eat its last cell.
      rows.map((l, i) => `\x1b[${i + 1};1H\x1b[2K${l}${st.reset}`).join('') +
      selectionSpans(width).map(({ y, x0, x1 }) => `\x1b[${y};${x0}H${st.selection}${sliceCols(rows[y - 1], x0, x1).padEnd(x1 - x0 + 1)}${st.reset}`).join('') +
      `\x1b[${viewH + 1 + u.cursor.row};${u.cursor.col + 1}H\x1b[?25h\x1b[?2026l`,
    );
  }

  // The selected cells per screen row, from the anchor to the pointer in reading
  // order. The mascot is never part of it: on header rows only the info text beside
  // him counts, like the logo in Claude Code.
  const infoCol = 3 + SCENE.COLS;
  function selectionSpans(width: number) {
    if (!selection) return [];
    let { a, b } = selection;
    if (b.y < a.y || (b.y === a.y && b.x < a.x)) [a, b] = [b, a];
    const headerLines = items[0] === headerItem ? 3 : 0;
    const spans: { y: number; x0: number; x1: number }[] = [];
    for (let y = a.y; y <= b.y; y++) {
      const onHeader = y >= headerRow && y < headerRow + headerLines;
      const x0 = Math.max(y === a.y ? a.x : 1, onHeader ? infoCol : 1);
      const x1 = y === b.y ? b.x : width;
      if (onHeader && sliceCols(rows[y - 1] || '', infoCol, width).trim() === '') continue; // mascot-only row
      if (x0 <= x1) spans.push({ y, x0, x1 });
    }
    return spans;
  }

  function copySelection() {
    const text = selectionSpans(W()).map(({ y, x0, x1 }) => sliceCols(rows[y - 1] || '', x0, x1).trimEnd()).join('\n')
      .replace(/^\n+|\n+$/g, '');
    if (!text.trim()) return;
    copy(text, write);
    if (copied) clearTimeout(copied);
    copied = setTimeout(() => {
      copied = null;
      schedule();
    }, 1500);
  }

  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      setImmediate(frame);
    }
  };

  const note = (text: string, tone: 'warn' | 'dim' = 'warn') => {
    items.push({ kind: 'note', tone, text });
    schedule();
  };

  // ---- models and servers ----

  // Brings an own server up (wake, tunnel, start, load, warm) with the compact
  // loader in the header; the prompt stays usable meanwhile.
  function ensure(name: string, quiet = false) {
    const p = cfg.providers[name];
    if (!p?.ssh) return Promise.resolve();
    if (bg?.name === name && !bg.run.state.done && !bg.run.state.error) return bg.run.promise.then(() => {});
    const run = runSteps(
      { name, host: p.ssh, remote: p.tunnel?.remote ?? '127.0.0.1:8080', mac: p.wake?.mac, broadcast: p.wake?.broadcast, model: p.model, router: !!p.model },
      {
        edited: p.steps,
        skip: [...(p.skip ?? []), 'test'], // the test reply belongs to /setup
        system: SYSTEM,
        model: model?.provider === name ? model : undefined,
        controls,
        tunnel: tunnel(name),
        onUpdate: schedule,
      },
    );
    bg = { name, run };
    schedule();
    return run.promise.then(
      (r) => {
        if (model?.provider === name) {
          conn = connOf(name, p, r.base);
          llama.props(llama.rootOf(r.base)).then((pr) => {
            const ctx = pr?.json?.default_generation_settings?.n_ctx;
            if (model && ctx && !model.context) model.context = ctx;
            schedule();
          }).catch(() => {});
        }
        const worked = run.state.steps.filter((v) => ['wake', 'start', 'load'].includes(v.id) && v.status === 'done' && !['on', 'running', 'loaded'].includes(v.result));
        if (!quiet && worked.length) {
          items.push({ kind: 'lines', lines: [[{ t: '● ', s: st.ok }, { t: `${name} is ready · `, s: st.fg }, { t: model?.label ?? p.model ?? '', s: st.titleB }, { t: ` · ${worked.map((v) => `${NAMES[v.id]} ${v.result}`).join(' · ')}`, s: st.dim }]] });
        }
        if (bg?.run === run) bg = null;
        schedule();
        if (waiting) {
          const t = waiting;
          waiting = null;
          send(t, true);
        }
      },
      (e) => {
        note(`${name}: ${(e as Error).message}. /server shows what's going on, /setup changes the steps.`);
        waiting = null;
        schedule();
      },
    );
  }

  // Makes `m` the model for new tasks; switching models starts a new task.
  async function useModel(m: Model, quiet = false) {
    const p = cfg.providers[m.provider];
    if (!p) return;
    model = m;
    conn = undefined;
    task = null;
    if (!quiet) items.push({ kind: 'tool', verb: 'Model', rest: `${m.label} · ${m.provider}` });
    schedule();
    if (p.ssh) {
      const t = tunnel(m.provider);
      const up = t.port ? await llama.health(`http://127.0.0.1:${t.port}`).catch(() => null) : null;
      if (up && (up.status === 200 || up.status === 503)) conn = connOf(m.provider, p, `http://127.0.0.1:${t.port}/v1`);
      else ensure(m.provider, quiet);
      return;
    }
    const urls = [p.url ?? PRESETS[p.preset]?.url ?? ''].flat();
    const base = urls.length > 1 ? await pickUrl(urls) : urls[0];
    if (!base) return note(`${m.provider} isn't answering at ${urls.join(' or ')}.`);
    conn = connOf(m.provider, p, base);
    schedule();
  }

  function useRef(ref: string, quiet = false) {
    const [name, ...rest] = ref.split('/');
    const p = cfg.providers[name];
    if (!p || !rest.length) return;
    useModel(modelOf(cfg, connOf(name, p, ''), rest.join('/')), quiet);
  }

  // The controls this message is sent with: ones that would reset the model's
  // cache stay at the task's values (docs/providers.md §5).
  function cacheSafe() {
    if (!model || unsafe.has(model.ref)) return { effort: false, reasoning: false };
    const pr = cfg.providers[model.provider]?.probe;
    if (conn?.llamacpp) return { effort: pr?.effortSafe !== false, reasoning: pr?.reasoningSafe !== false };
    return { effort: true, reasoning: true };
  }
  function sentControls(): Controls {
    if (!task) return controls;
    const safe = cacheSafe();
    return { reasoning: safe.reasoning ? controls.reasoning : task.controls.reasoning, effort: safe.effort ? controls.effort : task.controls.effort };
  }

  // ---- chat ----

  const drop = (it: Item) => {
    const i = items.indexOf(it);
    if (i >= 0) items.splice(i, 1);
  };

  async function send(text: string, held = false) {
    if (!held) {
      items.push({ kind: 'user', text });
      history.push(text);
    }
    if (!connected()) return note('No model is connected yet. /setup connects your server, this computer, or a provider.');
    if (!model) return note('No model selected. Pick one with /model.');
    if (!conn) {
      // An own server that isn't up yet: the message goes once it is.
      waiting = text;
      if (!held) note(`sends once ${model.provider} is ready`, 'dim');
      ensure(model.provider);
      return;
    }
    if (!conn.key && conn.wire === 'anthropic') return note(`No API key for ${conn.name}. /setup adds one, or set ${PRESETS.anthropic.keyEnv}.`);
    const root = llama.rootOf(conn.base);
    if (conn.llamacpp && (await llama.busy(root))) return note(`${conn.name} is busy: another client is using its slot. Try again in a moment.`);

    task ??= { controls: { ...controls }, lastPrompt: 0 };
    const c = sentControls();
    // Anthropic keeps top-level effort fixed per task and takes changes as an
    // effort-only system message, so the cache survives.
    if (conn.wire === 'anthropic' && c.effort !== (task.sentEffort ?? task.controls.effort) && messages.length) {
      messages.push({ role: 'system', content: [], output_config: { effort: c.effort ?? 'high' } });
      task.sentEffort = c.effort;
    }
    messages.push({ role: 'user', content: text });

    const thinking: Item = { kind: 'tool', verb: 'Thinking' };
    items.push(thinking);
    let dots = 0;
    const spin = setInterval(() => {
      if (thinking.kind === 'tool') thinking.verb = 'Thinking' + '.'.repeat(++dots % 4);
      schedule();
    }, 200);
    const ac = new AbortController();
    let completionId = '';
    let thinkingNow = true, ended = false;
    const me = {
      abort: () => ac.abort(),
      // esc while a local model is thinking ends the thinking instead of the reply.
      esc: () => {
        if (conn?.llamacpp && thinkingNow && completionId && !ended) {
          ended = true;
          llama.endReasoning(root, completionId);
          if (thinking.kind === 'tool') thinking.rest = '· wrapping up (esc again stops)';
        } else ac.abort();
      },
    };
    busy = me;
    schedule();

    let reply: Extract<Item, { kind: 'reply' }> | null = null;
    let blocks: Block[] = [];
    let usage: Usage | null = null;
    let stop = '';
    const m = model, cn = conn;
    const charge = () => {
      if (!usage) return;
      items.push({ kind: 'cost', turn: meter.charge(usage, m.price, cn.local) });
      if (cn.local && usage.promptMs && usage.input > 500) promptRate = usage.input / (usage.promptMs / 1000);
      // Measured, not assumed: a control change that collapses the cached prefix
      // marks that knob unsafe for this model.
      const prompt = usage.input + usage.cached + usage.written;
      const changed = task?.lastControls && (task.lastControls.effort !== c.effort || task.lastControls.reasoning !== c.reasoning);
      if (task && changed && task.lastPrompt > 2000 && usage.cached < task.lastPrompt * 0.5) {
        unsafe.add(m.ref);
        task.controls = { ...task.lastControls! };
        note(`Changing effort reset ${m.provider}'s cache, so effort and reasoning stay fixed until /clear.`, 'dim');
      }
      if (task) Object.assign(task, { lastPrompt: prompt, lastControls: c });
    };
    const forget = () => {
      if (messages.at(-1)?.role === 'user') messages.pop();
    };
    try {
      for await (const ev of streamFor(cn)({ conn: cn, model: m, system: SYSTEM, messages, controls: cn.wire === 'anthropic' ? task.controls : c, signal: ac.signal, slot: cn.llamacpp ? 0 : undefined })) {
        if (ev.type === 'id') completionId = ev.id;
        else if (ev.type === 'blocks') blocks = ev.blocks;
        else if (ev.type === 'usage') usage = ev.usage;
        else if (ev.type === 'stop') stop = ev.reason;
        else if (ev.type === 'text') {
          thinkingNow = false;
          if (!reply) {
            clearInterval(spin);
            drop(thinking);
            reply = { kind: 'reply', text: '', done: false };
            items.push(reply);
          }
          reply.text += ev.text;
          schedule();
        }
      }
      if (reply) reply.done = true;
      if (blocks.length) messages.push({ role: 'assistant', content: blocks });
      else forget();
      drop(thinking);
      charge();
      if (stop === 'refusal') note('The model declined this request. Rephrase it, or /clear to start over.');
      else if (stop === 'max_tokens') note('The reply hit the output limit and was cut off.');
    } catch (e) {
      drop(thinking);
      if (reply) reply.done = true;
      if (ac.signal.aborted) {
        if (reply?.text.trim()) messages.push({ role: 'assistant', content: [{ type: 'text', text: reply.text.trimEnd() }] });
        else forget();
        charge();
        note('stopped', 'dim');
      } else {
        if (messages.at(-1)?.role === 'assistant') messages.pop();
        forget();
        const err = e as Error;
        note(
          err instanceof ApiError && (err.status === 401 || err.status === 403)
            ? `${cn.name} refused the API key. /setup can replace it.`
            : err instanceof ApiError ? `${cn.name}: ${err.message}`
            : `Couldn't reach ${cn.name} (${new URL(cn.base).host}). ${err.message}`,
        );
        if (cfg.providers[cn.name]?.ssh) conn = undefined; // bring it up again next time
      }
    } finally {
      clearInterval(spin);
      if (busy === me) busy = null;
      schedule();
    }
  }

  // ---- panels ----

  const host: Host & Parameters<typeof createServer>[0] & Parameters<typeof createModelPicker>[0] = {
    st,
    cfg,
    system: SYSTEM,
    redraw: () => schedule(),
    close: () => {
      panel = null;
      buf = '';
      cur = 0;
      schedule();
    },
    setBuffer: (s) => {
      buf = s;
      cur = s.length;
    },
    say: (it) => {
      items.push(it);
      schedule();
    },
    save: () => saveConfig(cfg),
    activate: (m, base) => {
      controls = { reasoning: cfg.reasoning !== false, effort: cfg.effort };
      model = m;
      conn = connOf(m.provider, cfg.providers[m.provider], base);
      task = null;
      schedule();
    },
    tunnel,
    background: (name, run, done) => {
      bg = { name, run };
      done.finally(() => {
        if (bg?.run === run) bg = null;
        schedule();
      });
    },
    openSteps: (name) => {
      panel = createSetup(host, 'steps', name);
      schedule();
    },
    ensure: (name) => void ensure(name),
    promptRate: () => promptRate,
    current: () => model,
    controls: () => controls,
    setControls: (c) => {
      controls = c;
      cfg.effort = c.effort;
      cfg.reasoning = c.reasoning;
      saveConfig(cfg);
    },
    choose: (m) => {
      cfg.model = m.ref;
      saveConfig(cfg);
      useModel(m);
    },
  };

  // ---- commands ----

  function submit() {
    const v = buf.trim();
    if (!v) return;
    if (busy && !v.startsWith('/')) return; // one reply at a time; esc stops it
    buf = '';
    cur = 0;
    sel = 0;
    if (!v.startsWith('/')) {
      scrollOff = 0;
      return void send(v);
    }
    const [c, ...args] = v.split(/\s+/);
    boxKind = null;
    if (c === '/model') panel = createModelPicker(host);
    else if (c === '/setup') panel = createSetup(host);
    else if (c === '/connect') panel = args[0] ? createSetup(host, 'connect', args[1], args[0]) : createSetup(host);
    else if (c === '/server') {
      const name = model && cfg.providers[model.provider]?.ssh ? model.provider : Object.keys(cfg.providers).find((n) => cfg.providers[n].ssh);
      if (name) panel = createServer(host, name);
      else note('No own server is set up. /setup connects one.', 'dim');
    } else if (c === '/clear') {
      busy?.abort();
      messages = [];
      task = null;
      items = [headerItem];
      scrollOff = 0;
    } else if (c === '/usage') boxKind = 'usage';
    else if (c === '/exit') quit();
    else {
      items.push({ kind: 'user', text: v });
      items.push({ kind: 'reply', text: `Unknown command ${c}. Press / to see the commands.`, done: true });
    }
  }

  // ---- input ----

  const tw = () => Math.max(1, W() - 6);
  const prevCp = (i: number) => (i >= 2 && /[\udc00-\udfff]/.test(buf[i - 1]) ? i - 2 : Math.max(0, i - 1));
  const nextCp = (i: number) => (/[\ud800-\udbff]/.test(buf[i] || '') ? i + 2 : Math.min(buf.length, i + 1));
  const insert = (s: string) => {
    buf = buf.slice(0, cur) + s + buf.slice(cur);
    cur += s.length;
    sel = 0;
  };
  const wordLeft = (i: number) => {
    while (i > 0 && /\s/.test(buf[i - 1])) i--;
    while (i > 0 && !/\s/.test(buf[i - 1])) i--;
    return i;
  };
  const wordRight = (i: number) => {
    while (i < buf.length && /\s/.test(buf[i])) i++;
    while (i < buf.length && !/\s/.test(buf[i])) i++;
    return i;
  };
  const lineStart = () => buf.lastIndexOf('\n', cur - 1) + 1;
  const lineEnd = () => (buf.indexOf('\n', cur) < 0 ? buf.length : buf.indexOf('\n', cur));

  // Moves the caret one visual row up or down. Returns false at the edge.
  function vertical(dir: -1 | 1) {
    const rows = layoutInput(buf, tw());
    const c = caretOf(rows, cur);
    const r = rows[c.row + dir];
    if (!r) return false;
    let i = 0, w = 0;
    for (const ch of r.text) {
      if (w + strWidth(ch) > c.col) break;
      w += strWidth(ch);
      i += ch.length;
    }
    cur = r.start + i;
    return true;
  }

  function act(id: string) {
    if (panel && (id.startsWith('pick:') || id.startsWith('step:'))) return panel.click?.(id);
    if (id.startsWith('cmd:')) {
      buf = matches()[+id.slice(4)][0];
      submit();
    } else if (id === '/') {
      buf = '/';
      cur = 1;
      sel = 0;
      boxKind = null;
    } else if (id === '?') {
      buf = '';
      cur = 0;
      boxKind = 'keys';
    } else if (id === 'meter') boxKind = boxKind === 'usage' ? null : 'usage';
    else if (id === 'bottom') scrollOff = 0;
  }

  function onKey(k: Extract<InputEvent, { type: 'key' }>) {
    if (boxKind === 'keys') {
      boxKind = null; // any key closes the sheet
      return;
    }
    if (k.ctrl && k.name === 'c') {
      if (busy) busy.abort();
      else if (buf) {
        buf = '';
        cur = 0;
        return;
      } else if (quitArmed) return quit();
      if (quitArmed) clearTimeout(quitArmed);
      quitArmed = setTimeout(() => {
        quitArmed = null;
        schedule();
      }, 2000);
      return;
    }
    if (quitArmed) {
      clearTimeout(quitArmed);
      quitArmed = null;
    }

    // An open panel gets the keys first; text goes to the prompt only where the
    // panel takes typing (host names, keys, filters, step edits).
    if (panel) {
      if (panel.key(k, buf)) return;
      if (k.name === 'enter' && !k.shift && !k.alt) return panel.submit?.(buf);
      if (!panel.typing?.()) return;
    }

    if (cmdsOpen()) {
      const m = matches();
      if (k.name === 'up' || k.name === 'down') {
        if (m.length) sel = (sel + (k.name === 'down' ? 1 : -1) + m.length) % m.length;
        return;
      }
      if (k.name === 'tab') {
        if (m.length) buf = m[sel][0], cur = buf.length;
        return;
      }
      if (k.name === 'enter' && !k.shift && !k.alt) {
        if (m.length) buf = m[sel][0];
        return submit();
      }
      if (k.name === 'escape') {
        buf = '';
        cur = 0;
        return;
      }
    }
    if (k.name === 'escape') {
      if (boxKind) boxKind = null;
      else busy?.esc();
      return;
    }

    switch (k.name) {
      case 'enter':
        if (k.shift || k.alt) insert('\n');
        else if (buf[cur - 1] === '\\') {
          buf = buf.slice(0, cur - 1) + buf.slice(cur);
          cur--;
          insert('\n');
        } else submit();
        return;
      case 'j':
        if (k.ctrl) insert('\n');
        return;
      case 'char':
        if (k.alt && k.ch === 'b') cur = wordLeft(cur);
        else if (k.alt && k.ch === 'f') cur = wordRight(cur);
        else if (k.ch === '?' && !buf && !k.alt && !panel) boxKind = 'keys';
        else if (!k.alt && k.ch) insert(k.ch);
        return;
      case 'space':
        insert(' ');
        return;
      case 'tab':
        return;
      case 'backspace':
        if (k.alt || k.ctrl) {
          const i = wordLeft(cur);
          buf = buf.slice(0, i) + buf.slice(cur);
          cur = i;
        } else if (cur > 0) {
          const i = prevCp(cur);
          buf = buf.slice(0, i) + buf.slice(cur);
          cur = i;
        }
        return;
      case 'delete':
        if (cur < buf.length) buf = buf.slice(0, cur) + buf.slice(nextCp(cur));
        return;
      case 'left':
        cur = k.alt || k.ctrl ? wordLeft(cur) : prevCp(cur);
        return;
      case 'right':
        cur = k.alt || k.ctrl ? wordRight(cur) : nextCp(cur);
        return;
      case 'home': case 'a':
        if (k.name === 'home' || k.ctrl) cur = lineStart();
        return;
      case 'end': case 'e':
        if (k.name === 'end' || k.ctrl) cur = lineEnd();
        return;
      case 'u':
        if (k.ctrl) {
          const i = lineStart();
          buf = buf.slice(0, i) + buf.slice(cur);
          cur = i;
        }
        return;
      case 'k':
        if (k.ctrl) buf = buf.slice(0, cur) + buf.slice(lineEnd());
        return;
      case 'w':
        if (k.ctrl) {
          const i = wordLeft(cur);
          buf = buf.slice(0, i) + buf.slice(cur);
          cur = i;
        }
        return;
      case 'up':
        if (!vertical(-1) && !buf && history.length) {
          buf = history.at(-1)!;
          cur = buf.length;
        }
        return;
      case 'down':
        vertical(1);
        return;
    }
  }

  function onEvent(ev: InputEvent) {
    const before = buf;
    if (ev.type === 'mouse') {
      const at = { x: ev.x, y: ev.y };
      if (ev.button === 64 || ev.button === 65) {
        scrollOff += ev.button === 64 ? 3 : -3; // wheel
        selection = null;
      } else if (ev.button === 0 && !ev.release) {
        // Press: start a selection, blink if it's on him.
        selection = null;
        press = { ...at, hit: hits.find((h) => h.row === ev.y && ev.x >= h.x0 && ev.x <= h.x1)?.id };
        const onCube = ev.x >= CUBE_COLS[0] && ev.x <= CUBE_COLS[1] && ev.y >= headerRow && ev.y < headerRow + 3;
        if (onCube && ev.y <= viewH) header.blink();
      } else if (ev.button === 32 && press) {
        // Drag with the left button held.
        if (at.x !== press.x || at.y !== press.y || selection) selection = { a: press, b: at };
      } else if (ev.button === 0 && ev.release && press) {
        if (selection) copySelection();
        else if (press.hit) act(press.hit); // a plain click
        press = null;
      }
    } else if (ev.type === 'paste') {
      if (boxKind === 'keys') boxKind = null;
      if (!panel || panel.typing?.()) insert(ev.text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ''));
    } else if (ev.type === 'key') {
      selection = null;
      if (ev.name === 'pageup' || ev.name === 'pagedown') scrollOff += (ev.name === 'pageup' ? 1 : -1) * Math.max(1, viewH - 2);
      else onKey(ev);
    }
    if (panel && buf !== before) panel.changed?.(buf);
    schedule();
  }

  // ---- lifecycle ----

  const killTunnels = () => {
    for (const t of Object.values(tunnels)) t.child?.kill();
  };
  const restore = () => {
    killTunnels();
    write(MODES_OFF);
    if (inp.isTTY) inp.setRawMode(false);
  };

  // Quitting runs each own server's onQuit (docs/providers.md §4.3): keep it
  // running (default), stop the service, or power the machine off.
  async function quit() {
    if (quitting) return;
    busy?.abort();
    header?.close();
    for (const [name, p] of Object.entries(cfg.providers)) {
      if (!p.ssh || !p.onQuit || p.onQuit === 'keep' || !tunnels[name]?.port) continue;
      // ponytail: saving the slot before stopping arrives with token-kit.
      quitting = p.onQuit === 'stop' ? `stopping llama-server on ${p.ssh}…` : `powering off ${p.ssh}…`;
      schedule();
      await ssh(p.ssh, p.onQuit === 'stop' ? 'sudo systemctl stop llama-server' : 'sudo poweroff', 8000);
    }
    restore();
    process.exit(0);
  }

  const parse = createParser();
  inp.setRawMode(true);
  inp.resume();
  inp.on('data', (d: Buffer) => {
    for (const ev of parse(d.toString('utf8'))) onEvent(ev);
  });
  process.on('exit', restore);
  process.on('SIGTERM', () => void quit());
  process.on('SIGHUP', () => void quit());
  out.on('resize', schedule);

  write(MODES_ON);
  playHeader(headerOpts);
  // First run: nothing connected, so setup opens by itself.
  if (!connected()) panel = createSetup(host);
  else if (cfg.model) useRef(cfg.model, true);
  frame();
}
