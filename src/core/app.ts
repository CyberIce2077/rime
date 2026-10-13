// The single-pane Rime screen (SPEC §4, reference/rime-prototype.html).
//
// Full screen on the alternate screen: the transcript scrolls in the top part
// (wheel, PgUp/PgDn), the boxes, prompt and status line are pinned to the bottom.
// Models come from connected providers (docs/providers.md); /setup connects them.

import { type Chip, type Kind, LONG_PASTE, blocksFor, chipChar, chipFor, clipboardImage, isChip, label, pastedPaths, textChip } from './attach.ts';
import { copy } from './clipboard.ts';
import { createSettings, phrase } from './settings.ts';
import { type Config, saveConfig } from './config.ts';
import { CUBE_COLS, type Header, type HeaderOpts, SCENE, playHeader } from './header.ts';
import { type InputEvent, type Key, type Line, createParser, fit, lineWidth, sliceCols, stripAnsi, strWidth, truncAnsi, wrap } from './term.ts';
import { colorMode } from './theme.ts';
import { previewBox, sendLine, sendList } from './preview.ts';
import { type BoxRow, type Hit, type Item, box, caretOf, footRows, layoutInput, listRow, offsetAt, prompt, renderItem, spaced, splitToolCalls, status, str, styles } from './view.ts';
import { createMeter, fmt$, fmtS, fmtT } from '../plugins/token-kit/meter.ts';
import * as llama from '../providers/llamacpp.ts';
import { PRESETS } from '../providers/presets.ts';
import { connOf, modelOf, pickUrl, streamFor } from '../providers/registry.ts';
import { ApiError, type Block, type Conn, type Controls, type Effort, type Message, type Model, type Usage } from '../providers/types.ts';
import { bar } from '../setup/loader.ts';
import { createModelPicker, createServer, createSettingsPanel } from '../setup/panels.ts';
import { ssh } from '../setup/ssh.ts';
import { Cancelled, NAMES, type Run, runSteps } from '../setup/steps.ts';
import { type Host, type Panel, type Tunnel, createSetup, createStopped } from '../setup/ui.ts';

const CMDS: [string, string][] = [
  ['/model', 'pick a model, effort and reasoning'],
  ['/setup', 'connect your server, this computer, or a provider'],
  ['/server', 'status and controls for your server'],
  ['/settings', 'every setting, applied right away'],
  ['/connect', 'add a provider or URL: /connect <url>'],
  ['/clear', 'start a new conversation'],
  ['/usage', 'token, cost and savings breakdown'],
  ['/exit', 'quit Rime'],
];

// SPEC §5: only keys every keyboard has and every terminal passes on (§5.1).
const KEYS: [string, string][] = [
  ['enter', 'send'],
  ['ctrl+j', 'new line (shift+enter also works where the terminal reports it)'],
  ['esc', 'stop Rime, go back one screen, or close a box'],
  ['ctrl+c', 'cancel what is open or running'],
  ['ctrl+c twice', 'quit (only when nothing is open)'],
  ['↑', 'edit your last message'],
  ['tab', 'complete a command'],
  ['ctrl+v', 'paste an image from the clipboard (or drag in a file)'],
  ['ctrl+u ctrl+d', 'scroll the conversation up / down when the prompt is empty (also the mouse wheel)'],
  ['/', 'commands'],
  ['?', 'this list'],
];

// A clicked footer key acts like pressing it (`key:esc`, `key:b`, …).
const CLICK_KEYS: Record<string, Key> = {
  esc: { name: 'escape' }, enter: { name: 'enter' }, tab: { name: 'tab' }, space: { name: 'space' }, backspace: { name: 'backspace' },
  'ctrl+c': { name: 'c', ctrl: true }, 'ctrl+j': { name: 'j', ctrl: true }, 'ctrl+v': { name: 'v', ctrl: true },
};

// Frozen for the whole session: any byte change here would break the prompt cache.
const system = (cwd: string) =>
  `You are Rime, a coding assistant running in the user's terminal.\n` +
  `Working directory: ${cwd}\n` +
  `Be brief and direct. Use plain text with light markdown (lists, \`code\`, fenced blocks); no tables.`;

const fmtP = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

// Modes: alternate screen, SGR mouse (clicks, drags for selection, wheel, and
// any-motion so hovering a chip previews it), bracketed paste, kitty
// keyboard (disambiguate) and xterm modifyOtherKeys so shift+enter is
// distinguishable, accent cursor color.
const MODES_ON = '\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[>1u\x1b[>4;1m\x1b]12;#7FD4F5\x07';
const MODES_OFF = '\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[<u\x1b[>4;0m\x1b]112\x07\x1b[?25h\x1b[?1049l';

// What the compact loader says in header line 2 while a server comes up.
const PHASE: Record<string, string> = { wake: 'waking', connect: 'connecting', tunnel: 'opening the tunnel', start: 'starting', load: 'loading', warm: 'warming the cache', test: 'testing' };

export async function runApp(cfg: Config, version: string) {
  const out = process.stdout, inp = process.stdin;
  const st = styles(colorMode(out));
  const write = (s: string) => out.write(s);
  const meter = createMeter();
  // Settings apply live (SPEC §15): effort and reasoning from the next message.
  const settings = createSettings(cfg);
  settings.watch();
  settings.subscribe(() => {
    controls = { reasoning: cfg.reasoning !== false, effort: cfg.effort };
    schedule();
  });
  let later: Model | null = null; // a model switch waiting for the next /clear
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
  let anchor: number | null = null; // the other end of a selection in the prompt
  const chips = new Map<string, Chip>(); // chip character -> attachment (kept for ↑ and the transcript)
  let chipSeq = 0;
  const counts: Partial<Record<Kind, number>> = {};
  let hover: string | null = null; // chip under the mouse
  let big: string | null = null; // chip opened full size
  let listOpen = false, listPinned = false; // the "what gets sent" list
  let blindAsk = false; // asked whether to send the text without the images
  let flash: { text: string; t: NodeJS.Timeout } | null = null;
  let lastClick = { t: 0, x: 0, y: 0 };
  let promptAt = { row: 0, first: 0, shown: 0, rows: [] as { start: number; text: string }[] }; // where the prompt's text is on screen
  let boxKind: 'keys' | 'usage' | null = null;
  let panel: Panel | null = null;
  let busy: { abort(): void; esc(): void } | null = null;
  let quitArmed: NodeJS.Timeout | null = null;
  let quitting: string | null = null;
  const tunnels: Record<string, Tunnel> = {};
  let bg: { name: string; run: Run; panel?: Panel; stopping?: boolean } | null = null; // an own server coming up in the background
  let waiting: { text: string; content: string | Block[] } | null = null; // a message held until the model is ready
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
  let press: { x: number; y: number; hit?: string; prompt?: boolean } | null = null;
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
      if (bg.stopping) return { model: model.label, details: `${p} · stopping…` };
      return { model: model.label, details: `${p} · ${PHASE[step?.id ?? 'connect']} ${b.fill}${b.empty} ${b.pct.trim()} · ✕ stop` };
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

  // The transcript's lines, and where each ⚙ line (with its undo link) landed.
  function transcript(width: number) {
    const lines: string[] = [];
    const gears: { at: number; i: number }[] = [];
    let prev: Item | undefined;
    items.forEach((it, i) => {
      if (spaced(prev, it)) lines.push('');
      if (it.kind === 'gear' && !it.note && !it.change.undone) gears.push({ at: lines.length, i });
      lines.push(...render(it, width));
      prev = it;
    });
    if (prev !== headerItem) lines.push(''); // the log's bottom margin
    return { lines, gears };
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
      return box(v.legend, [...v.rows, ...footRows(v.foot, st)], width, st, v.warn ? st.warn : st.accent, 'key:ctrl+c');
    }
    if (cmdsOpen()) {
      const m = matches();
      sel = Math.min(sel, Math.max(0, m.length - 1));
      const rows: BoxRow[] = m.length
        ? m.map(([n, h], i) => listRow(n, h, i === sel, st, `cmd:${i}`))
        : [{ line: [{ t: `no command matches ${buf}`, s: st.dim }] }];
      return box('commands', [...rows, ...footRows(['↑ ↓', ' choose · ', 'tab', ' complete · ', 'enter', ' run · ', 'esc', ' close'], st)], width, st, st.accent, 'key:esc');
    }
    if (boxKind === 'keys') {
      return box('shortcuts', [...KEYS.map(([k, h]) => listRow(k, h, false, st, undefined, 16)), ...footRows('any key to close', st)], width, st, st.accent, 'key:esc');
    }
    if (boxKind === 'usage') return box(`usage · this session${model ? ` · ${model.label}` : ''}`, usageRows(width), width, st, st.accent, 'key:esc');
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

  // ---- chips ----

  const blind = () => model?.vision === false;
  const media = (c?: Chip) => !!c && (c.kind === 'image' || c.kind === 'video');
  const chipView = (ch: string) => {
    const c = chips.get(ch);
    return c ? { label: label(c, blind()), warn: blind() && media(c) } : undefined;
  };
  const nearChip = () => (range() ? null : isChip(buf[cur]) ? buf[cur] : isChip(buf[cur - 1]) ? buf[cur - 1] : null);
  const blindNote = () => `${model?.label} can't see images${conn?.llamacpp ? ' (no mmproj loaded)' : ''}`;
  const hasMedia = (s: string) => [...s].some((ch) => media(chips.get(ch)));

  // The preview above the prompt: a chip full size, under the mouse or at the
  // caret, else the "what gets sent" list when it's open.
  function chipBox(width: number) {
    if (panel || cmdsOpen() || boxKind) return null;
    const id = big ?? hover ?? nearChip();
    const c = id ? chips.get(id) : undefined;
    if (c && id) {
      const v = previewBox(c, width, { big: big === id, hovering: hover === id && big !== id, blind: blind() && media(c) ? `${blindNote()}. Rime asks before sending the text without it.` : undefined }, st, schedule);
      return box(v.legend, v.rows, width, st, st.accent, big ? 'key:esc' : undefined);
    }
    if (listOpen && buf.trim()) {
      const v = sendList(buf, chips, width, st);
      return box(v.legend, v.rows, width, st, st.accent, 'key:esc');
    }
    return null;
  }

  function ui(width: number, height: number) {
    const lines: string[] = [];
    const rowHits: Hit[][] = [];
    const b = currentBox(width) ?? chipBox(width);
    if (b && b.lines.length <= height - 5) {
      lines.push(...b.lines);
      rowHits.push(...b.hits);
    }
    // The line under the prompt sums up the next message.
    const sent = !panel && buf.trim() && !buf.startsWith('/') ? sendLine(buf, chips, listOpen, st, blind() && hasMedia(buf) ? `${blindNote()}` : undefined) : [];
    // The prompt grows to 10 rows (at most a third of the screen), then scrolls.
    const maxRows = Math.max(1, Math.min(10, Math.floor(height / 3), height - lines.length - 3 - (sent.length ? 1 : 0)));
    const p = prompt(buf, cur, width, maxRows, st, {
      placeholder: panel?.placeholder?.() ?? undefined,
      masked: panel?.masked?.() ?? false,
      sel: range() ?? undefined,
      chip: chipView,
      near: nearChip() ?? undefined,
    });
    const top = lines.length;
    lines.push(...p.lines);
    p.lines.forEach((_, i) => rowHits.push(i === p.lines.length - 1 ? p.hits : []));
    if (sent.length) {
      lines.push(str(fit(sent, width), st));
      rowHits.push([{ x0: 1, x1: lineWidth(sent), id: 'sendlist' }]);
    }

    let left: Line, leftHits: Hit[] = [];
    const ps = panel?.status?.();
    if (quitting) left = [{ t: quitting, s: st.dim }];
    else if (quitArmed) left = [{ t: 'press ctrl+c again to quit', s: st.dim }];
    else if (copied) left = [{ t: '✓', s: st.ok }, { t: ' copied to clipboard', s: st.dim }];
    else if (flash) left = flash.text.startsWith('✓') ? [{ t: '✓', s: st.ok }, { t: flash.text.slice(1), s: st.dim }] : [{ t: flash.text, s: st.dim }];
    else if (blindAsk) {
      const lead = `${blindNote()} · `;
      left = [{ t: lead, s: st.warn }, { t: 'enter', s: st.accentB }, { t: ' sends the text alone · ', s: st.dim }, { t: 'esc', s: st.accentB }, { t: ' keeps editing', s: st.dim }];
      const x = strWidth(lead) + 1;
      leftHits = [{ x0: x, x1: x + 4, id: 'key:enter' }, { x0: x + 29, x1: x + 31, id: 'key:esc' }];
    } else if (ps) left = ps;
    else if (scrollOff > 0) {
      left = [{ t: '↓', s: st.accentB }, { t: ` ${scrollOff} lines below · pgdn`, s: st.dim }];
      leftHits = [{ x0: 1, x1: lineWidth(left), id: 'bottom' }];
    } else if (busy) left = [{ t: 'esc', s: st.accentB }, { t: ' to stop', s: st.dim }];
    else if (range()) {
      left = [{ t: 'backspace', s: st.accentB }, { t: ' delete selection · ', s: st.dim }, { t: 'esc', s: st.accentB }, { t: ' clear selection', s: st.dim }];
      leftHits = [{ x0: 1, x1: 9, id: 'key:backspace' }, { x0: 30, x1: 32, id: 'key:esc' }];
    } else {
      left = [
        { t: '/', s: st.accentB }, { t: ' for commands', s: st.dim }, { t: ' · ', s: st.dim },
        { t: '?', s: st.accentB }, { t: ' for shortcuts', s: st.dim },
      ];
      leftHits = [{ x0: 1, x1: 14, id: '/' }, { x0: 18, x1: 32, id: '?' }];
    }
    const s = status(left, meterLine(), width, st, leftHits);
    lines.push(s.line);
    rowHits.push(s.hits);
    return { lines, rowHits, cursor: { row: top + p.cursor.row, col: p.cursor.col }, prompt: { rel: top + 1, first: p.first, shown: p.lines.length - 2, rows: p.rows } };
  }

  // ---- drawing ----

  // Full screen, like vim: the transcript fills the top (scrollable), the boxes,
  // prompt and status line sit at the bottom. Every frame repaints every row.
  function frame() {
    scheduled = false;
    Object.assign(headerOpts, headerInfo());
    const width = W(), height = H();
    const { lines, gears } = transcript(width);
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
    promptAt = { row: viewH + 1 + u.prompt.rel, first: u.prompt.first, shown: u.prompt.shown, rows: u.prompt.rows };
    rows = screen.map((l) => truncAnsi(l, width));
    for (const g of gears) {
      const row = g.at - start + 1;
      const text = row >= 1 && row <= viewH ? stripAnsi(rows[row - 1]) : '';
      const x = text.lastIndexOf('undo');
      if (x >= 0) hits.push({ row, x0: strWidth(text.slice(0, x)) + 1, x1: strWidth(text.slice(0, x)) + 4, id: `undo:${g.i}` });
    }
    // The compact loader's "✕ stop" on header line 2.
    const r2 = headerRow + 1;
    const l2 = r2 >= 1 && r2 <= viewH ? stripAnsi(rows[r2 - 1]) : '';
    const at = l2.indexOf('✕ stop');
    if (at >= 0) hits.push({ row: r2, x0: strWidth(l2.slice(0, at)) + 1, x1: strWidth(l2.slice(0, at)) + 6, id: 'stop' });
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
          serverInfo();
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
          send(t.text, true, t.content);
        }
      },
      (e) => {
        if (bg?.run === run) bg = null;
        if (e instanceof Cancelled) {
          if (waiting) note('Your message wasn\'t sent; it\'s still in ↑.', 'dim');
          waiting = null;
          panel = createStopped(host, { name, host: p.ssh!, model: p.model, state: run.state, startup: true, after: 'Rime starts it again when you send a message.' }, () => {
            host.close();
            ensure(name);
          });
          return schedule();
        }
        note(`${name}: ${(e as Error).message}. /server shows what's going on, /setup changes the steps.`);
        waiting = null;
        schedule();
      },
    );
  }

  // ctrl+c or the header's "✕ stop": stop the server that's coming up. Whoever
  // started the run (startup or /setup) then asks what to do about it.
  function stopBg() {
    if (!bg || bg.run.state.done || bg.stopping) return;
    bg.stopping = true;
    bg.run.cancel();
    schedule();
  }

  // What a llama.cpp server says about its model: the context size, and whether
  // it can see images (`modalities.vision`, only with an mmproj loaded).
  function serverInfo() {
    if (!conn?.llamacpp) return;
    const m = model;
    llama.props(llama.rootOf(conn.base)).then((pr) => {
      if (!m || m !== model) return;
      const ctx = pr?.json?.default_generation_settings?.n_ctx;
      if (ctx && !m.context) m.context = ctx;
      const v = pr?.json?.modalities?.vision;
      if (typeof v === 'boolean') m.vision = v;
      schedule();
    }).catch(() => {});
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
      const root = `http://127.0.0.1:${t.port}`;
      const up = t.port ? await llama.health(root).catch(() => null) : null;
      // A router-mode server answers /health with nothing loaded (after an unload,
      // or with --no-models-autoload), so it's only ready with a loaded model.
      const list = up ? await llama.routerModels(root).catch(() => null) : null;
      const ready = up && (up.status === 200 || up.status === 503) && (!list || list.some((x) => x.status === 'loaded'));
      if (ready) (conn = connOf(m.provider, p, `${root}/v1`)), serverInfo();
      else ensure(m.provider, quiet);
      return;
    }
    const urls = [p.url ?? PRESETS[p.preset]?.url ?? ''].flat();
    const base = urls.length > 1 ? await pickUrl(urls) : urls[0];
    if (!base) return note(`${m.provider} isn't answering at ${urls.join(' or ')}.`);
    conn = connOf(m.provider, p, base);
    serverInfo();
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

  // `text` is the prompt as typed (chips included); `content` is what goes to the
  // model: the text, or content blocks with the attachments.
  async function send(text: string, held = false, content: string | Block[] | Promise<Block[]> = text) {
    if (!held) {
      const labels = Object.fromEntries([...new Set([...text].filter(isChip))].flatMap((ch) => (chips.get(ch) ? [[ch, label(chips.get(ch)!)]] : [])));
      items.push({ kind: 'user', text, ...(Object.keys(labels).length ? { chips: labels } : {}) });
      history.push(text);
      schedule();
    }
    try {
      content = await content;
    } catch (e) {
      return note(`Couldn't read an attachment: ${(e as Error).message}`);
    }
    if (!connected()) return note('No model is connected yet. /setup connects your server, this computer, or a provider.');
    if (!model) return note('No model selected. Pick one with /model.');
    if (!conn) {
      // An own server that isn't up yet: the message goes once it is.
      waiting = { text, content };
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
    messages.push({ role: 'user', content });

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
      const tc = reply ? splitToolCalls(reply.text).calls : [];
      if (tc.length) note(`${m.label.split(/[\s\d.]/)[0] || m.label} wanted to run ${tc.join(' and ')}. Rime can't run tools until Phase 4.`, 'dim');
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

  const host: Host & Parameters<typeof createServer>[0] & Parameters<typeof createModelPicker>[0] & Parameters<typeof createSettingsPanel>[0] = {
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
    save: () => settings.save(),
    settings,
    openModel: () => host.open(createModelPicker(host)),
    openConnect: () => host.open(createSetup(host)),
    inContext: () => (messages.length ? task?.lastPrompt || Math.ceil(JSON.stringify(messages).length / 4) : 0),
    later: (m) => {
      later = m;
      note(`${m.label} from the next /clear`, 'dim');
    },
    activate: (m, base) => {
      controls = { reasoning: cfg.reasoning !== false, effort: cfg.effort };
      model = m;
      conn = connOf(m.provider, cfg.providers[m.provider], base);
      task = null;
      serverInfo();
      schedule();
    },
    tunnel,
    background: (name, run, done, p) => {
      bg = { name, run, panel: p };
      done.finally(() => {
        if (bg?.run === run) bg = null;
        schedule();
      });
    },
    open: (p) => {
      panel = p;
      buf = '';
      cur = 0;
      schedule();
    },
    // The server stopped serving its model (unload, stop, power off): the next
    // message brings it back up first.
    down: (name) => {
      if (model?.provider === name) conn = undefined;
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
      settings.set('effort', c.effort ?? 'default');
      settings.set('reasoning', c.reasoning ? 'on' : 'off');
    },
    choose: (m) => {
      later = null;
      cfg.model = m.ref;
      settings.save();
      useModel(m);
    },
  };

  // ---- commands ----

  // A short, exact request ("effort high") runs in Rime with no API call.
  function local(text: string, ph: { key: string; value: string }) {
    items.push({ kind: 'user', text });
    history.push(text);
    const c = settings.set(ph.key, ph.value);
    const d = settings.list().find((x) => x.key === ph.key)!;
    items.push(c ? { kind: 'gear', change: c } : { kind: 'gear', change: { key: ph.key, label: d.label.toLowerCase(), from: ph.value, to: ph.value, applies: d.applies, at: Date.now() }, note: `${d.label.toLowerCase()} is already ${ph.value}` });
    items.push({ kind: 'lines', lines: [[{ t: '  ↳ handled in Rime · no API call', s: st.dim }]] });
  }

  function submit() {
    const v = buf.trim();
    if (!v) return;
    if (busy && !v.startsWith('/')) return; // one reply at a time; esc stops it
    // A model that can't see: ask before sending the text without the images.
    // ponytail: the router (Phase 7) will move the task to a connected model that can see.
    if (!v.startsWith('/') && blind() && hasMedia(v) && !blindAsk) return void (blindAsk = true);
    const see = !blindAsk;
    blindAsk = false;
    buf = '';
    cur = 0;
    sel = 0;
    anchor = null;
    big = hover = null;
    listOpen = listPinned = false;
    if (!v.startsWith('/')) {
      scrollOff = 0;
      const ph = [...v].some(isChip) ? null : phrase(v);
      if (ph) return local(v, ph);
      return void send(v, false, [...v].some(isChip) ? blocksFor(v, chips, cwd, see) : v);
    }
    const [c, ...args] = v.split(/\s+/);
    boxKind = null;
    if (c === '/model') panel = createModelPicker(host);
    else if (c === '/setup') panel = bg?.panel && !bg.run.state.done ? bg.panel : createSetup(host);
    else if (c === '/connect') panel = args[0] ? createSetup(host, 'connect', args[1], args[0]) : createSetup(host);
    else if (c === '/server') {
      const name = model && cfg.providers[model.provider]?.ssh ? model.provider : Object.keys(cfg.providers).find((n) => cfg.providers[n].ssh);
      if (name) panel = createServer(host, name);
      else note('No own server is set up. /setup connects one.', 'dim');
    } else if (c === '/settings') panel = createSettingsPanel(host);
    else if (c === '/clear') {
      busy?.abort();
      messages = [];
      task = null;
      items = [headerItem];
      scrollOff = 0;
      if (later) host.choose(later);
    } else if (c === '/usage') boxKind = 'usage';
    else if (c === '/exit') quit();
    else {
      items.push({ kind: 'user', text: v });
      items.push({ kind: 'reply', text: `Unknown command ${c}. Press / to see the commands.`, done: true });
    }
  }

  // ---- input ----
  // The prompt is a small editor (SPEC §5.3): a selection is a range of buffer
  // offsets that backspace/delete remove and typing replaces; chips are single
  // characters, so arrows step over them and backspace removes them whole.

  const tw = () => Math.max(1, W() - 6);
  const prevCp = (i: number) => (i >= 2 && /[\udc00-\udfff]/.test(buf[i - 1]) ? i - 2 : Math.max(0, i - 1));
  const nextCp = (i: number) => (/[\ud800-\udbff]/.test(buf[i] || '') ? i + 2 : Math.min(buf.length, i + 1));
  const range = (): [number, number] | null => (anchor === null || anchor === cur ? null : [Math.min(anchor, cur), Math.max(anchor, cur)]);
  const cut = (a: number, b: number) => {
    buf = buf.slice(0, a) + buf.slice(b);
    cur = a;
    anchor = null;
  };
  const insert = (s: string) => {
    const r = range();
    if (r) cut(...r);
    anchor = null;
    buf = buf.slice(0, cur) + s + buf.slice(cur);
    cur += s.length;
    sel = 0;
  };
  const isWord = (ch: string | undefined) => !!ch && !isChip(ch) && /\w/.test(ch);
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
  const chipW = (ch: string) => {
    const c = chipView(ch);
    return c ? strWidth(c.label) + 2 : undefined;
  };
  // The prompt text with chips written out, for copying.
  const plainOf = (s: string) => [...s].map((ch) => (chips.get(ch) ? `[${label(chips.get(ch)!)}]` : ch)).join('');

  // Moves the caret one visual row up or down. Returns false at the edge.
  function vertical(dir: -1 | 1) {
    const rows = layoutInput(buf, tw(), chipW);
    const c = caretOf(rows, cur, chipW);
    const r = rows[c.row + dir];
    if (!r) return false;
    cur = offsetAt(r, c.col, chipW);
    return true;
  }

  // The buffer offset under a screen cell of the prompt, or null when it isn't one.
  function promptOffset(x: number, y: number, clamp = false) {
    const i = promptAt.first + y - promptAt.row;
    if (!promptAt.rows.length || (!clamp && (i < promptAt.first || i >= promptAt.first + promptAt.shown || x < 3 || x > W() - 2))) return null;
    const r = promptAt.rows[Math.max(0, Math.min(promptAt.rows.length - 1, i))];
    return offsetAt(r, Math.max(0, x - 5), chipW);
  }

  // A chip shown at a screen cell: in the prompt, or in a sent message.
  function chipAt(x: number, y: number) {
    const o = y >= promptAt.row && y < promptAt.row + promptAt.shown ? promptOffset(x, y) : null;
    if (o !== null) {
      if (isChip(buf[o])) return buf[o];
      if (isChip(buf[o - 1]) && x < 5 + caretOf(promptAt.rows, o, chipW).col) return buf[o - 1];
    }
    const text = stripAnsi(rows[y - 1] ?? '');
    for (const [ch, c] of chips) {
      for (const l of new Set([label(c), label(c, true)])) {
        let i = text.indexOf(`[${l}]`);
        while (i >= 0) {
          const x0 = strWidth(text.slice(0, i)) + 1;
          if (x >= x0 && x < x0 + strWidth(l) + 2) return ch;
          i = text.indexOf(`[${l}]`, i + 1);
        }
      }
    }
    return null;
  }

  const nextN = (k: Kind) => (counts[k] = (counts[k] ?? 0) + 1);
  const addChip = (c: Chip) => {
    const ch = chipChar(chipSeq++);
    chips.set(ch, c);
    insert(ch);
  };
  function say(text: string) {
    if (flash) clearTimeout(flash.t);
    flash = { text, t: setTimeout(() => ((flash = null), schedule()), 2000) };
  }

  // A paste: dropped paths become chips, an empty paste reads a screenshot from the
  // clipboard, long text becomes one chip; anything else is typed in.
  function pasteText(raw: string) {
    const t = raw.replace(/\r\n?/g, '\n');
    if (!t.trim()) return void pasteImage();
    const paths = pastedPaths(t, cwd);
    if (paths) {
      for (const p of paths) {
        try {
          addChip(chipFor(p, nextN, cwd, schedule));
        } catch (e) {
          say(`can't read ${p}: ${(e as Error).message}`);
        }
      }
      return;
    }
    const clean = t.replace(/\t/g, '  ').replace(/[\x00-\x09\x0b-\x1f\x7f-]/g, '');
    if (clean.split('\n').length > LONG_PASTE.lines || clean.length > LONG_PASTE.chars) return addChip(textChip(clean, nextN));
    insert(clean);
  }

  async function pasteImage() {
    const f = await clipboardImage(cwd).catch(() => null);
    if (!f) return say('no image on the clipboard'), schedule();
    addChip(chipFor(f, nextN, cwd, schedule));
    schedule();
  }

  function act(id: string) {
    if (id.startsWith('key:')) {
      const label = id.slice(4);
      const k = CLICK_KEYS[label] ?? (/^[a-z]$/.test(label) ? { name: 'char', ch: label } : null);
      if (k) onKey({ type: 'key', ...k });
      return;
    }
    if (id === 'stop') return stopBg();
    if (id.startsWith('undo:')) {
      const it = items[+id.slice(5)];
      if (it?.kind === 'gear') settings.undo(it.change);
      return;
    }
    if (id === 'sendlist') return void ((listPinned = !listPinned), (listOpen = listPinned));
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
    // ctrl+c cancels what's open or running; twice quits, but only when nothing
    // is open or running, so one press never loses work (SPEC §5.2).
    if (k.ctrl && k.name === 'c') {
      if (panel) return panel.cancel ? panel.cancel() : host.close();
      if (boxKind) return void (boxKind = null);
      if (big || listPinned) return void ((big = null), (listPinned = listOpen = false));
      if (busy) busy.abort();
      else if (buf) {
        buf = '';
        cur = 0;
        anchor = null;
        return;
      } else if (bg && !bg.run.state.done && !bg.stopping) return stopBg();
      else if (quitArmed) return quit();
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
      if (k.name === 'enter' && !k.shift) return panel.submit?.(buf);
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
      if (k.name === 'enter' && !k.shift) {
        if (m.length) buf = m[sel][0];
        return submit();
      }
      if (k.name === 'escape') {
        buf = '';
        cur = 0;
        return;
      }
    }
    // esc closes the nearest thing first: a full-size preview, the selection, the
    // "what gets sent" list, a box; then it stops Rime.
    if (k.name === 'escape') {
      if (big) big = null;
      else if (range()) anchor = null;
      else if (listPinned) listPinned = listOpen = false;
      else if (blindAsk) blindAsk = false;
      else if (boxKind) boxKind = null;
      else busy?.esc();
      return;
    }
    const r = range();
    const was = buf;
    switch (k.name) {
      case 'enter':
        if (k.shift) insert('\n');
        else if (buf[cur - 1] === '\\' && !r) {
          cut(cur - 1, cur);
          insert('\n');
        } else submit();
        break;
      case 'char':
        if (k.ch === '?' && !buf && !panel) boxKind = 'keys';
        else if (!k.alt && k.ch) insert(k.ch);
        break;
      case 'space':
        insert(' ');
        break;
      case 'backspace':
        if (r) cut(...r);
        else if (k.ctrl) cut(wordLeft(cur), cur);
        else if (cur > 0) cut(prevCp(cur), cur);
        break;
      case 'delete':
        if (r) cut(...r);
        else if (cur < buf.length) cut(cur, nextCp(cur));
        break;
      case 'left':
      case 'right': {
        const left = k.name === 'left';
        if (k.shift) {
          anchor ??= cur;
          cur = left ? prevCp(cur) : nextCp(cur);
        } else if (r) {
          cur = left ? r[0] : r[1];
          anchor = null;
        } else cur = k.ctrl ? (left ? wordLeft(cur) : wordRight(cur)) : left ? prevCp(cur) : nextCp(cur);
        break;
      }
      case 'up':
      case 'down':
        if (k.shift) anchor ??= cur;
        else anchor = null;
        if (!vertical(k.name === 'up' ? -1 : 1) && k.name === 'up' && !buf && history.length) {
          buf = history.at(-1)!;
          cur = buf.length;
        }
        break;
      case 'home': case 'end':
        anchor = null;
        cur = k.name === 'home' ? lineStart() : lineEnd();
        break;
      default:
        if (!k.ctrl) break;
        if (k.name === 'j') insert('\n');
        else if (k.name === 'a') (anchor = null), (cur = lineStart());
        else if (k.name === 'e') (anchor = null), (cur = lineEnd());
        else if (k.name === 'k') r ? cut(...r) : cut(cur, lineEnd());
        else if (k.name === 'w') r ? cut(...r) : cut(wordLeft(cur), cur);
        else if (k.name === 'v') void pasteImage();
        // With text, ctrl+u / ctrl+d edit as in a shell; on an empty prompt they scroll.
        else if (k.name === 'u') buf ? (r ? cut(...r) : cut(lineStart(), cur)) : (scrollOff += Math.max(1, Math.floor(viewH / 2)));
        else if (k.name === 'd') buf ? (r ? cut(...r) : cur < buf.length && cut(cur, nextCp(cur))) : (scrollOff -= Math.max(1, Math.floor(viewH / 2)));
    }
    if (buf !== was) blindAsk = false;
  }

  function onEvent(ev: InputEvent) {
    const before = buf;
    if (ev.type === 'mouse') {
      const at = { x: ev.x, y: ev.y };
      const onPrompt = !panel?.masked?.() && promptOffset(ev.x, ev.y) !== null;
      if (ev.button === 64 || ev.button === 65) {
        scrollOff += ev.button === 64 ? 3 : -3; // wheel
        selection = null;
      } else if (ev.button === 35) {
        // Motion with no button (any-motion reporting): hovering a chip previews
        // it, hovering the "what gets sent" line lists the parts.
        const h = chipAt(ev.x, ev.y);
        const overList = hits.some((x) => x.id === 'sendlist' && x.row === ev.y && ev.x >= x.x0 && ev.x <= x.x1);
        const open = listPinned || overList;
        if (h === hover && open === listOpen) return;
        hover = h;
        listOpen = open;
      } else if (ev.button === 0 && !ev.release) {
        selection = null;
        press = { ...at, hit: hits.find((h) => h.row === ev.y && ev.x >= h.x0 && ev.x <= h.x1)?.id };
        const now = Date.now();
        const double = now - lastClick.t < 400 && lastClick.x === ev.x && lastClick.y === ev.y;
        lastClick = { t: now, x: ev.x, y: ev.y };
        if (onPrompt) {
          // In the prompt: place the caret, start a selection, or select a word.
          const o = promptOffset(ev.x, ev.y)!;
          if (double && isWord(buf[o] ?? buf[o - 1])) {
            let a = isWord(buf[o]) ? o : o - 1, b = a;
            while (a > 0 && isWord(buf[a - 1])) a--;
            while (b < buf.length && isWord(buf[b])) b++;
            anchor = a;
            cur = b;
            press = null;
          } else {
            cur = o;
            anchor = o;
            press = { ...at, hit: chipAt(ev.x, ev.y) ? `chip:${chipAt(ev.x, ev.y)}` : press.hit, prompt: true };
          }
        }
        const onCube = ev.x >= CUBE_COLS[0] && ev.x <= CUBE_COLS[1] && ev.y >= headerRow && ev.y < headerRow + 3;
        if (onCube && ev.y <= viewH) header.blink();
      } else if (ev.button === 32 && press) {
        // Drag with the left button held: prompt text, or screen cells elsewhere.
        if (press.prompt) cur = promptOffset(ev.x, ev.y, true)!;
        else if (at.x !== press.x || at.y !== press.y || selection) selection = { a: press, b: at };
      } else if (ev.button === 0 && ev.release && press) {
        if (press.prompt) {
          const r = range();
          if (r) {
            copy(plainOf(buf.slice(...r)), write); // a drag still copies, as before
            say('✓ copied to clipboard');
          } else {
            anchor = null;
            if (press.hit?.startsWith('chip:')) big = big === press.hit.slice(5) ? null : press.hit.slice(5);
          }
        } else if (selection) copySelection();
        else if (chipAt(ev.x, ev.y)) {
          const ch = chipAt(ev.x, ev.y)!;
          big = big === ch ? null : ch; // a click opens a chip full size
        } else if (press.hit) act(press.hit); // a plain click
        press = null;
      }
    } else if (ev.type === 'paste') {
      if (boxKind === 'keys') boxKind = null;
      if (!panel) pasteText(ev.text);
      else if (panel.typing?.()) insert(ev.text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ''));
    } else if (ev.type === 'key') {
      selection = null;
      if (ev.name === 'pageup' || ev.name === 'pagedown') scrollOff += (ev.name === 'pageup' ? 1 : -1) * Math.max(1, viewH - 2);
      else onKey(ev);
    }
    if (buf !== before) blindAsk = false;
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
