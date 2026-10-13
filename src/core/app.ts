// The single-pane Rime screen (SPEC §4, reference/rime-prototype.html).
//
// Full screen on the alternate screen: the transcript scrolls in the top part
// (wheel, ctrl+u / ctrl+d, esc back to the end), the boxes, prompt and status line
// are pinned to the bottom.
// Models come from connected providers (docs/providers.md); /setup connects them.

import { type Chip, type Kind, LONG_PASTE, blocksFor, chipChar, chipFor, clipboardImage, fuzzy, isChip, label, listFiles, pastedPaths, textChip } from './attach.ts';
import { copy } from './clipboard.ts';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Conversation, type Db, type Stored, openDb, projectOf } from './db.ts';
import { type Decision, MODE_HELP, MODES, type Mode, decide, projectRules, removeProjectRule, ruleList } from './permissions.ts';
import { type ToolResult, TOOLS, bash as bashTool, diffOf, edit as editTool, planEdit, read as readTool, rel, write as writeTool } from './tools.ts';
import { WHEN, createSettings, phrase } from './settings.ts';
import { type Config, saveConfig } from './config.ts';
import { CUBE_COLS, type Header, type HeaderOpts, SCENE, playHeader, tildify } from './header.ts';
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
import { SSH_OPTS } from '../setup/ssh.ts';
import { Cancelled, NAMES, type Run, runSteps } from '../setup/steps.ts';
import { type Host, type Panel, type Tunnel, createSetup, createStopped } from '../setup/ui.ts';

const CMDS: [string, string][] = [
  ['/model', 'pick a model, effort and reasoning'],
  ['/setup', 'connect your server, this computer, or a provider'],
  ['/server', 'status and controls for your server'],
  ['/settings', 'every setting, applied right away'],
  ['/permissions', 'permission mode and allow / ask / deny rules'],
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
  ['↑ ↓', 'your earlier prompts (esc goes back to what you typed)'],
  ['option+⌫ ctrl+w', 'delete the word before the cursor'],
  ['tab', 'complete a command'],
  ['ctrl+v', 'paste an image from the clipboard (or drag in a file)'],
  ['@', 'mention a file or folder'],
  ['ctrl+r', 'search your earlier prompts'],
  ['tab  →', 'take the suggestion shown in dim text'],
  ['shift+tab', 'permission mode: ask · auto-edit · plan'],
  ['←', 'your conversations (on an empty prompt)'],
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
// The tools sit before the system prompt in the cached prefix; a stored prefix is
// reused only with the same tools.
const TOOLS_HASH = createHash('sha256').update(JSON.stringify(TOOLS)).digest('hex').slice(0, 16);

// The only project file it includes is AGENTS.md, read once at the start.
const system = (cwd: string, agents = '') =>
  `You are Rime, a coding assistant running in the user's terminal.\n` +
  `Working directory: ${cwd}\n` +
  `Do the work with your tools: read files before you change them, create files with write, change them with edit, run commands with bash. Don't paste whole files into the chat; say in a line or two what you did.\n` +
  `You run inside Rime. Use the rime tool to change Rime itself (tabs, panel, settings, model, servers). Never tell the user to restart Rime or edit its config.\n` +
  `Be brief and direct. Use plain text with light markdown (lists, \`code\`, fenced blocks); no tables.` +
  (agents ? `\n\nAGENTS.md:\n${agents}` : '');
const agentsMd = (dir: string) => {
  try {
    return fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').trim().slice(0, 8000);
  } catch {
    return '';
  }
};

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
  // Permissions (SPEC §17): the mode for this session, the open question, and
  // the last decisions for /permissions.
  let mode: Mode = 'ask';
  let approval: { use: Block; decision: Decision; sel: number; done(a: 'yes' | 'always' | 'no' | 'stop'): void; diff?: ToolResult['diff'] } | null = null;
  let declining: ((words: string | null) => void) | null = null; // "No, tell Rime instead": the next prompt is the reason
  const decisions: { at: number; tool: string; what: string; verdict: string; why: string }[] = [];
  let nextStep = ''; // suggested after a reply (tab takes it)
  let example = ''; // `Try "…"` on an empty prompt, from this project
  let lastUserSeq = 0; // the stored row of the last user message, while it has no reply
  // "Don't ask again" rules belong to this conversation and are saved with it.
  let convRules: { allow?: string[]; ask?: string[]; deny?: string[] } = {};
  const addConvRule = (kind: 'allow' | 'ask' | 'deny', pattern: string) => {
    convRules = { ...convRules, [kind]: [...new Set([...(convRules[kind] ?? []), pattern])] };
    save((d) => d.setRules(conversation()!, convRules));
  };
  // ↑ / ↓ through earlier prompts, like a shell: `draft` is what you were typing.
  let browsing: { list: string[]; i: number; draft: string } | null = null;
  let navigated = false;
  const cwd = process.cwd();
  let SYSTEM = system(cwd, agentsMd(projectOf(cwd)));

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
  // Suggestions (SPEC §5.4), all from code: @ files, ctrl+r, ghost text.
  let atPick: { start: number; sel: number } | null = null;
  let rsearch: { q: string; i: number } | null = null;
  let files: { list: string[]; recent: string[]; at: number } | null = null;
  const usedFiles: string[] = []; // attached with @ in this session, shown first
  let boxKind: 'keys' | 'usage' | null = null;
  let panel: Panel | null = null;
  let busy: { abort(): void; esc(): void } | null = null;
  let quitArmed: NodeJS.Timeout | null = null;
  let quitting: string | null = null;
  const tunnels: Record<string, Tunnel> = {};
  let bg: { name: string; run: Run; panel?: Panel; stopping?: boolean } | null = null; // an own server coming up in the background
  let waiting: { text: string; content: string | Block[] } | null = null; // a message held until the model is ready
  let promptRate: number | undefined; // local prompt tokens/s, from the last reply

  // ---- saving (SPEC §16): every message is written the moment it exists ----
  const project = projectOf(cwd);
  const db: Db | null = await openDb().catch(() => null);
  let convId: number | null = null; // created with the first message
  let continuing: { title: string; at: number } | null = null; // reopened, nothing sent yet
  let resumeOk = false; // the last reply was cut off by quitting: enter continues it
  let live: { seq: number; text: () => string } | null = null; // the reply being streamed
  let saveFailed = false;
  const save = <T>(fn: (d: Db) => T): T | undefined => {
    if (!db) return;
    try {
      return fn(db);
    } catch (e) {
      if (!saveFailed) (saveFailed = true), note(`Rime couldn't save this conversation: ${(e as Error).message}`, 'dim');
    }
  };
  const conversation = () => (convId ??= save((d) => d.create(project, SYSTEM, model?.ref, TOOLS_HASH)) ?? null);
  // An Anthropic effort-only system message is kept as one output_config block.
  const store = (m: Message) => save((d) => d.append(conversation()!, m.role, m.role === 'system' ? [{ type: 'output_config', ...(m.output_config as object) }] : m.content)) ?? 0;
  const prompts = () => [...history.slice().reverse(), ...(save((d) => d.prompts(project)) ?? [])].filter((p, i, a) => p.trim() && a.indexOf(p) === i);

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
  // A selection in the transcript (`log`) is anchored to transcript lines, so it
  // stays on its text while you scroll; elsewhere it is in screen cells.
  let selection: { a: { x: number; y: number }; b: { x: number; y: number }; log: boolean } | null = null;
  let pointer = { x: 0, y: 0 }; // where the mouse is during a drag
  let edgeScroll: NodeJS.Timeout | null = null; // dragging past the top or bottom scrolls
  let top = 0; // transcript line shown on the first row
  let logLines: string[] = [];
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
  const ago = (t: number) => {
    const s = (Date.now() - t) / 1000;
    return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} days ago`;
  };
  function headerInfo() {
    const cont = continuing ? `continuing "${continuing.title}" · ${ago(continuing.at)}` : '';
    if (!model) return { model: undefined, details: cont || (connected() ? 'no model selected' : 'no model connected') };
    if (cont && !bg) return { model: model.label, details: `${model.provider} · ${cont}` };
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

  // ---- suggestions (SPEC §5.4) ----

  // Your earlier prompts, newest first: this session, then this project's saved ones.
  let past: string[] = [];
  const earlier = () => [...history].reverse().concat(past).filter((p, i, a) => !/[\ue000-\uf8ff]/.test(p) && a.indexOf(p) === i);
  // Dim ghost text completing the line from an earlier prompt.
  function ghost() {
    if (panel || atPick || rsearch || browsing || boxKind || range() || cur !== buf.length || buf.length < 3 || buf.startsWith('/') || [...buf].some(isChip)) return '';
    const low = buf.toLowerCase();
    const h = earlier().find((p) => p.length > buf.length && p.toLowerCase().startsWith(low));
    return h ? h.slice(buf.length) : '';
  }
  const rmatches = () => earlier().filter((p) => p.toLowerCase().includes(rsearch!.q.toLowerCase()));

  // The project's files and folders for @, recently edited first; re-read every 30 s.
  function projectFiles() {
    if (files && Date.now() - files.at < 30000) return files;
    const list = listFiles(project);
    const dirs = [...new Set(list.flatMap((f) => f.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/') + '/')))];
    const mtime = (f: string) => {
      try {
        return fs.statSync(path.join(project, f)).mtimeMs;
      } catch {
        return 0;
      }
    };
    const recent = list.length <= 20000 ? list.map((f) => [f, mtime(f)] as const).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([f]) => f) : list.slice(0, 50);
    files = { list: [...list, ...dirs].sort(), recent, at: Date.now() };
    return files;
  }
  function atQuery() {
    if (!atPick) return null;
    const q = buf.slice(atPick.start + 1, cur);
    if (buf[atPick.start] !== '@' || cur <= atPick.start || /\s/.test(q) || [...q].some(isChip)) return (atPick = null), null;
    return q;
  }
  function atMatches(): { f: string; marks: number[] }[] {
    const q = atQuery();
    if (q === null) return [];
    const name = q.split(':')[0];
    const pf = projectFiles();
    if (!name) return [...new Set([...usedFiles, ...pf.recent])].slice(0, 8).map((f) => ({ f, marks: [] }));
    return pf.list
      .map((f) => ({ f, m: fuzzy(name, f) }))
      .filter((x) => x.m)
      .sort((a, b) => b.m!.score + (usedFiles.includes(b.f) ? 2 : 0) - a.m!.score - (usedFiles.includes(a.f) ? 2 : 0))
      .slice(0, 8)
      .map((x) => ({ f: x.f, marks: x.m!.marks }));
  }
  // Attaches the picked file or folder as a chip; `@file:30-60` keeps those lines.
  function takeAt(f: string) {
    const q = atQuery() ?? '';
    const lines = /:(\d+)(?:-(\d+))?$/.exec(q);
    cut(atPick!.start, cur);
    atPick = null;
    try {
      addChip(chipFor(path.join(project, f), nextN, cwd, schedule, lines && !f.endsWith('/') ? [+lines[1], +(lines[2] ?? lines[1])] : undefined));
      usedFiles.splice(0, usedFiles.length, f, ...usedFiles.filter((x) => x !== f));
    } catch (e) {
      say(`can't read ${f}: ${(e as Error).message}`);
    }
  }

  function suggestBox(width: number) {
    const dim = (t: string) => ({ t, s: st.dim });
    if (rsearch) {
      const m = rmatches();
      const at = m.length ? rsearch.i % m.length : 0;
      const from = Math.max(0, Math.min(at - 2, m.length - 6));
      return box([{ t: 'history search', s: st.accent }, dim(' · this project')], [
        { line: [dim('search: '), { t: rsearch.q, s: st.title }, { t: '▏', s: st.accent }] },
        ...(m.length ? m.slice(from, from + 6).map((p, i): BoxRow => listRow(p.replace(/\n/g, ' ⏎ '), '', from + i === at, st, undefined, width - 6)) : [{ line: [dim('no earlier prompt matches')] }]),
        ...footRows(['', 'type to filter · ', 'ctrl+r', ' older · ', 'enter', ' use it · ', 'esc', ' cancel'], st),
      ], width, st, st.accent, 'key:esc');
    }
    if (atPick && atQuery() !== null) {
      const m = atMatches(), q = atQuery()!;
      const rows: BoxRow[] = m.map((x, i) => {
        const sel = i === atPick!.sel % m.length;
        const name: Line = [...x.f].map((ch, j) => ({ t: ch, s: x.marks.includes(j) ? st.warn : sel ? st.accent : st.fg }));
        return { line: [{ t: sel ? '› ' : '  ', s: st.accent }, ...name], bg: sel ? st.panelBg : undefined, hit: `at:${i}` };
      });
      return box([{ t: '@ files', s: st.accent }, dim(q ? ` · matching "${q}"` : ' · recent first')], [
        ...(rows.length ? rows : [{ line: [dim('no file matches')] }]),
        ...footRows(['↑ ↓', ' choose · ', 'tab', ' or ', 'enter', ' attach · ', 'esc', ' keep typing'], st),
      ], width, st, st.accent, 'key:esc');
    }
    // A command's argument, once it's chosen: `/model ` lists the models Rime knows.
    const arg = /^\/model\s+(\S*)$/.exec(buf);
    if (arg) {
      const refs = knownModels().filter((r) => r.toLowerCase().includes(arg[1].toLowerCase()));
      sel = Math.min(sel, Math.max(0, refs.length - 1));
      return box([{ t: '/model', s: st.accent }, dim(' · pick one, or enter with nothing opens the list')], [
        ...(refs.length ? refs.map((r, i) => listRow(r, r === model?.ref ? [{ t: '● in use', s: st.ok }] : '', i === sel, st, `arg:${i}`, 40)) : [{ line: [dim('no model matches')] }]),
        ...footRows(['↑ ↓', ' choose · ', 'enter', ' use it · ', 'esc', ' close'], st),
      ], width, st, st.accent, 'key:esc');
    }
    if (/^\/connect\s+$/.test(buf)) return box('/connect', [{ line: [{ t: '<url> [name]', s: st.title }, dim('  a llama.cpp, Ollama, LM Studio or OpenAI-compatible server')] }], width, st);
    return null;
  }
  const knownModels = () => [...new Set([model?.ref, cfg.model, ...Object.entries(cfg.providers).map(([n, p]) => (p.model ? `${n}/${p.model}` : undefined)), ...Object.keys(cfg.models)].filter((x): x is string => !!x))];

  // The preview above the prompt: a chip full size, under the mouse or at the
  // caret, else the "what gets sent" list when it's open.
  function chipBox(width: number) {
    if (panel || cmdsOpen() || boxKind) return null;
    const sb = suggestBox(width);
    if (sb) return sb;
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
    const b = approvalBox(width) ?? currentBox(width) ?? chipBox(width);
    if (b && b.lines.length <= height - 5) {
      lines.push(...b.lines);
      rowHits.push(...b.hits);
    }
    // The line under the prompt sums up the next message.
    const sent = !panel && buf.trim() && !buf.startsWith('/') ? sendLine(buf, chips, listOpen, st, blind() && hasMedia(buf) ? `${blindNote()}` : undefined) : [];
    // The prompt grows to 10 rows (at most a third of the screen), then scrolls.
    const maxRows = Math.max(1, Math.min(10, Math.floor(height / 3), height - lines.length - 3 - (sent.length ? 1 : 0)));
    const p = prompt(buf, cur, width, maxRows, st, {
      placeholder: panel?.placeholder?.() ?? (declining ? 'tell Rime what to do instead' : resumeOk ? 'enter continues the interrupted reply, or ask something new' : nextStep ? nextStep : example ? `Try "${example}"` : undefined),
      // A suggestion shows the key that takes it.
      tabHint: !panel && !declining && !resumeOk && (buf ? !!ghost() : !!(nextStep || example)),
      masked: panel?.masked?.() ?? false,
      sel: range() ?? undefined,
      chip: chipView,
      near: nearChip() ?? undefined,
      ghost: ghost() || undefined,
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
      // Keys every keyboard has (SPEC §5.1); page up/down still work where they exist.
      left = [
        { t: '↓', s: st.accentB }, { t: ` ${scrollOff} lines below · `, s: st.dim },
        ...(buf ? [] : [{ t: 'ctrl+u ctrl+d', s: st.accentB }, { t: ' scroll · ', s: st.dim }]),
        { t: 'esc', s: st.accentB }, { t: ' to the end', s: st.dim },
      ];
      leftHits = [{ x0: 1, x1: lineWidth(left), id: 'bottom' }];
    } else if (declining) left = [{ t: 'type what Rime should do instead · ', s: st.dim }, { t: 'esc', s: st.accentB }, { t: ' to stop', s: st.dim }];
    else if (busy) left = [{ t: 'esc', s: st.accentB }, { t: ' to stop', s: st.dim }];
    else if (browsing) {
      left = [{ t: '↑', s: st.accentB }, { t: ' older · ', s: st.dim }, { t: '↓', s: st.accentB }, { t: ' newer · ', s: st.dim }, { t: 'esc', s: st.accentB }, { t: ' back to your text', s: st.dim }];
      leftHits = [{ x0: 19, x1: 21, id: 'key:esc' }];
    } else if (range()) {
      left = [{ t: 'backspace', s: st.accentB }, { t: ' delete selection · ', s: st.dim }, { t: 'esc', s: st.accentB }, { t: ' clear selection', s: st.dim }];
      leftHits = [{ x0: 1, x1: 9, id: 'key:backspace' }, { x0: 30, x1: 32, id: 'key:esc' }];
    } else if (mode !== 'ask') {
      // Like Claude Code: the mode shows while it isn't the default; a click cycles it.
      const [icon, name, s] =
        mode === 'auto-edit' ? ['⏵⏵', 'auto-edit on', st.accentB]
        : mode === 'plan' ? ['⏸', 'plan mode on', st.accentB]
        : mode === 'god' ? ['⏵⏵⏵⏵', 'god mode on · nothing asks', st.del]
        : ['⏵⏵⏵', 'auto on · risky commands still ask', st.warn];
      left = [{ t: `${icon} ${name}`, s }, { t: ' (shift+tab to cycle)', s: st.dim }];
      leftHits = [{ x0: 1, x1: lineWidth(left), id: 'mode' }];
    } else {
      left = [
        { t: '/', s: st.accentB }, { t: ' for commands', s: st.dim }, { t: ' · ', s: st.dim },
        { t: '?', s: st.accentB }, { t: ' for shortcuts', s: st.dim }, { t: ' · ', s: st.dim },
        { t: '←', s: st.accentB }, { t: ' conversations', s: st.dim },
      ];
      leftHits = [{ x0: 1, x1: 14, id: '/' }, { x0: 18, x1: 32, id: '?' }, { x0: 36, x1: 50, id: 'conversations' }];
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
    top = start;
    logLines = lines;
    // While dragging in the transcript, the selection follows the pointer, also
    // when the view scrolls under it (wheel or the edges).
    if (press && selection?.log) {
      const row = Math.max(1, Math.min(viewH, pointer.y));
      selection.b = { x: pointer.y > viewH ? width : pointer.x, y: start + row - 1 };
    }
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

  // The selected cells per line, from the anchor to the pointer in reading
  // order: `y` is a transcript line for a transcript selection, else a screen row.
  // The mascot is never part of it: on header lines only the info text beside
  // him counts, like the logo in Claude Code.
  const infoCol = 3 + SCENE.COLS;
  function selected(width: number) {
    if (!selection) return [];
    let { a, b } = selection;
    if (b.y < a.y || (b.y === a.y && b.x < a.x)) [a, b] = [b, a];
    const hasHeader = items[0] === headerItem;
    const textOf = (y: number) => (selection!.log ? logLines[y] : rows[y - 1]) ?? '';
    const spans: { y: number; x0: number; x1: number; text: string }[] = [];
    for (let y = a.y; y <= b.y; y++) {
      // Header lines: transcript lines 1–3, or their rows on screen.
      const onHeader = hasHeader && (selection.log ? y >= 1 && y <= 3 : y >= headerRow && y < headerRow + 3);
      const x0 = Math.max(y === a.y ? a.x : 1, onHeader ? infoCol : 1);
      const x1 = y === b.y ? b.x : width;
      if (onHeader && sliceCols(textOf(y), infoCol, width).trim() === '') continue; // mascot-only line
      if (x0 <= x1) spans.push({ y, x0, x1, text: textOf(y) });
    }
    return spans;
  }
  // The spans on screen now.
  const selectionSpans = (width: number) =>
    selected(width).map((sp) => ({ ...sp, y: selection!.log ? sp.y - top + 1 : sp.y })).filter((sp) => sp.y >= 1 && sp.y <= (selection!.log ? viewH : H()));

  function copySelection() {
    const text = selected(W()).map(({ text: t, x0, x1 }) => sliceCols(t, x0, x1).trimEnd()).join('\n')
      .replace(/^\n+|\n+$/g, '');
    if (!text.trim()) return;
    copy(text, write);
    if (copied) clearTimeout(copied);
    copied = setTimeout(() => {
      copied = null;
      schedule();
    }, 1500);
  }

  // Dragging on the top row or below the transcript scrolls it, a line at a time.
  function edge() {
    const dir = !press || !selection?.log ? 0 : pointer.y > viewH ? -1 : pointer.y <= 1 ? 1 : 0;
    if (!dir) {
      if (edgeScroll) clearInterval(edgeScroll);
      edgeScroll = null;
      return;
    }
    if (edgeScroll) return;
    edgeScroll = setInterval(() => {
      const d = !press || !selection?.log ? 0 : pointer.y > viewH ? -1 : pointer.y <= 1 ? 1 : 0;
      if (!d) return edge();
      scrollOff += d;
      schedule();
    }, 50);
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

  // The user's message joins the history; when the last message is already the
  // user's (a reply that never came, or tool results), the new words join it, so
  // the turns keep alternating.
  function pushUser(content: string | Block[]) {
    const last = messages.at(-1);
    if (last?.role === 'user' && lastUserSeq) {
      const blocks = (c: string | Block[]): Block[] => (typeof c === 'string' ? [{ type: 'text', text: c }] : c);
      last.content = [...blocks(last.content), ...blocks(content)];
      save((d) => d.update(convId!, lastUserSeq, last.content, false));
      return lastUserSeq;
    }
    messages.push({ role: 'user', content });
    return (lastUserSeq = store(messages.at(-1)!));
  }

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
    if (conn.wire === 'anthropic' && c.effort !== (task.sentEffort ?? task.controls.effort) && messages.length && messages.at(-1)?.role !== 'user') {
      messages.push({ role: 'system', content: [], output_config: { effort: c.effort ?? 'high' } });
      store(messages.at(-1)!);
      task.sentEffort = c.effort;
    }
    const userSeq = pushUser(content);
    continuing = null;
    resumeOk = false;
    nextStep = '';

    const ac = new AbortController();
    const m = model, cn = conn;
    const did: Did = { wrote: [], ran: [] };
    let esc = () => ac.abort();
    const me = { abort: () => ac.abort(), esc: () => esc() };
    busy = me;
    schedule();
    try {
      // The loop: a reply, its tool calls (asked about first), their results back
      // to the model, until it answers without tools or you stop it.
      for (let step = 0; step < 200; step++) {
        const r = await streamOnce(m, cn, c, ac, step === 0 ? userSeq : 0, (f) => (esc = f));
        if (!r.ok) break;
        const uses = r.blocks.filter((b) => b.type === 'tool_use');
        if (!uses.length) break;
        esc = () => ac.abort();
        const results = await runTools(uses, ac.signal, did);
        messages.push({ role: 'user', content: results });
        lastUserSeq = store(messages.at(-1)!);
        if (ac.signal.aborted) {
          note('stopped', 'dim');
          break;
        }
      }
    } finally {
      if (busy === me) busy = null;
      nextStep = suggestNext(did);
      schedule();
    }
  }

  // One streamed reply. Returns its blocks, or ok: false when it was stopped or failed.
  async function streamOnce(m: Model, cn: Conn, c: Controls, ac: AbortController, userSeq: number, setEsc: (f: () => void) => void): Promise<{ ok: boolean; blocks: Block[] }> {
    const root = llama.rootOf(cn.base);
    const thinking: Item = { kind: 'tool', verb: 'Thinking' };
    items.push(thinking);
    let dots = 0;
    const spin = setInterval(() => {
      if (thinking.kind === 'tool') thinking.verb = 'Thinking' + '.'.repeat(++dots % 4);
      schedule();
    }, 200);
    let completionId = '';
    let thinkingNow = true, ended = false;
    // esc while a local model is thinking ends the thinking instead of the reply.
    setEsc(() => {
      if (cn.llamacpp && thinkingNow && completionId && !ended) {
        ended = true;
        llama.endReasoning(root, completionId);
        if (thinking.kind === 'tool') thinking.rest = '· wrapping up (esc again stops)';
      } else ac.abort();
    });
    schedule();

    let reply: Extract<Item, { kind: 'reply' }> | null = null;
    let blocks: Block[] = [];
    let usage: Usage | null = null;
    let stop = '';
    let flush: NodeJS.Timeout | null = null;
    const charge = () => {
      if (!usage) return;
      const turn = meter.charge(usage, m.price, cn.local);
      items.push({ kind: 'cost', turn });
      save((d) => d.usage(convId!, turn.in + turn.out, turn.spent ?? 0, m.ref));
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
    // Only the user's own message is taken back when nothing came of it; tool
    // results stay, so every tool call keeps its answer.
    const forget = () => {
      if (!userSeq) return;
      if (messages.at(-1)?.role === 'user') messages.pop();
      if (live) save((d) => d.remove(convId!, live!.seq));
      save((d) => d.remove(convId!, userSeq));
      lastUserSeq = 0;
    };
    try {
      for await (const ev of streamFor(cn)({ conn: cn, model: m, system: SYSTEM, tools: TOOLS, messages, controls: cn.wire === 'anthropic' ? task!.controls : c, signal: ac.signal, slot: cn.llamacpp ? 0 : undefined })) {
        if (ev.type === 'id') completionId = ev.id;
        else if (ev.type === 'blocks') blocks = ev.blocks;
        else if (ev.type === 'usage') usage = ev.usage;
        else if (ev.type === 'stop') stop = ev.reason;
        else if (ev.type === 'text') {
          thinkingNow = false;
          if (!reply) {
            clearInterval(spin);
            drop(thinking);
            const r: Extract<Item, { kind: 'reply' }> = { kind: 'reply', text: '', done: false };
            reply = r;
            items.push(reply);
            // The reply is stored while it streams (flushed about once a second), so
            // quitting mid-reply keeps it, marked interrupted.
            const seq = save((d) => d.append(convId!, 'assistant', [{ type: 'text', text: ev.text }], true));
            if (seq) {
              live = { seq, text: () => r.text };
              flush = setInterval(() => save((d) => d.update(convId!, seq, [{ type: 'text', text: r.text }], true)), 1000);
            }
          }
          reply.text += ev.text;
          schedule();
        }
      }
      if (reply) {
        reply.done = true;
        if (!reply.text.trim() || !splitToolCalls(reply.text).text.trim()) drop(reply);
      }
      if (flush) clearInterval(flush);
      drop(thinking);
      if (blocks.length) {
        messages.push({ role: 'assistant', content: blocks });
        lastUserSeq = 0;
        if (live) save((d) => d.update(convId!, live!.seq, blocks, false));
        else store(messages.at(-1)!);
      } else forget();
      charge();
      if (stop === 'refusal') note('The model declined this request. Rephrase it, or /clear to start over.');
      else if (stop === 'max_tokens') note('The reply hit the output limit and was cut off.');
      return { ok: blocks.length > 0, blocks };
    } catch (e) {
      drop(thinking);
      if (reply) reply.done = true;
      if (flush) clearInterval(flush);
      if (ac.signal.aborted) {
        if (reply?.text.trim()) {
          messages.push({ role: 'assistant', content: [{ type: 'text', text: reply.text.trimEnd() }] });
          lastUserSeq = 0;
          if (live) save((d) => d.update(convId!, live!.seq, messages.at(-1)!.content, false));
        } else forget();
        charge();
        note('stopped', 'dim');
      } else {
        if (live) save((d) => d.remove(convId!, live!.seq));
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
      return { ok: false, blocks: [] };
    } finally {
      clearInterval(spin);
      if (flush) clearInterval(flush);
      live = null;
      schedule();
    }
  }

  // ---- tools (Phase 4) and permissions (SPEC §17) ----

  type Did = { wrote: string[]; ran: { cmd: string; ok: boolean }[] };
  const result = (id: unknown, content: string, error = false): Block => ({ type: 'tool_result', tool_use_id: id, content, ...(error ? { is_error: true } : {}) });
  const permCtx = () => ({ mode, project, rules: ruleList(cfg.permissions, projectRules(project), convRules), granted: (p: string) => [...chips.values()].some((c) => c.path && (p === c.path || p.startsWith(c.path + path.sep))) });
  const describe = (u: Block) => {
    const i = (u.input ?? {}) as Record<string, any>;
    const verb = { read: 'Read', write: 'Write', edit: 'Edit', bash: 'Bash', rime: 'Rime' }[String(u.name)] ?? String(u.name);
    const rest = u.name === 'bash' ? String(i.command ?? '').split('\n')[0] : u.name === 'rime' ? `${i.action ?? ''}${i.args ? ' ' + JSON.stringify(i.args) : ''}` : rel(cwd, path.resolve(cwd, String(i.path ?? '')));
    return { verb, rest };
  };
  const toolLine = (u: Block): Item => ({ kind: 'tool', ...describe(u) });
  const detail = (lines: Line[]) => items.push({ kind: 'lines', hug: true, lines: lines.map((l) => [{ t: '  ⎿ ', s: st.dim }, ...l]).map((l, i) => (i ? [{ t: '    ', s: '' }, ...l.slice(1)] : l)) });

  // Runs each tool call in order. Every call gets a result, also when it's
  // refused, declined or stopped, so the history stays valid.
  async function runTools(uses: Block[], signal: AbortSignal, did: Did): Promise<Block[]> {
    const out: Block[] = [];
    let skip = '';
    for (const u of uses) {
      const input = (u.input ?? {}) as Record<string, any>;
      if (signal.aborted) {
        out.push(result(u.id, 'Not run: the user stopped Rime.', true));
        continue;
      }
      if (skip) {
        out.push(result(u.id, skip, true));
        continue;
      }
      const d = decide(String(u.name), input, permCtx());
      decisions.unshift({ at: Date.now(), tool: String(u.name), what: `${describe(u).verb} ${describe(u).rest}`, verdict: d.verdict, why: d.why });
      decisions.length = Math.min(decisions.length, 50);
      if (d.verdict === 'deny') {
        items.push({ ...toolLine(u), extra: [{ t: ` · not run: ${d.why}`, s: st.warn }] } as Item);
        out.push(result(u.id, `Not run: ${d.why}.${mode === 'plan' ? ' Rime is in plan mode (read-only): answer with a plan instead. The user switches modes with shift+tab.' : ''}`, true));
        continue;
      }
      if (d.verdict === 'ask') {
        const answer = await ask(u, d, signal);
        if (answer === 'stop') {
          out.push(result(u.id, 'Not run: the user stopped Rime.', true));
          continue;
        }
        if (answer === 'no') {
          items.push({ kind: 'lines', lines: [[{ t: '✗ ', s: st.del }, { t: 'declined ', s: st.dim }, { t: `${describe(u).verb} ${describe(u).rest}`, s: st.title }, { t: ' · tell Rime what to do instead', s: st.dim }]] });
          schedule();
          // Your next words are the reason; esc (or ctrl+c) stops the whole turn instead.
          const words = await new Promise<string | null>((res) => {
            declining = res;
            signal.addEventListener('abort', () => res(null), { once: true });
          });
          declining = null;
          if (words === null) {
            out.push(result(u.id, 'Not run: the user stopped Rime.', true));
            skip = 'Not run: the user stopped Rime.';
            continue;
          }
          out.push(result(u.id, words ? `The user declined this and said: ${words}` : 'The user declined this.', true));
          skip = 'Not run: the user declined an earlier step.';
          continue;
        }
        if (answer === 'always') {
          if (u.name === 'write' || u.name === 'edit') setMode('auto-edit');
          else if (d.rule) {
            addConvRule('allow', d.rule);
            items.push({ kind: 'lines', lines: [[{ t: '⚙ ', s: st.accent }, { t: `allowed ${d.label} commands in this conversation · /permissions`, s: st.dim }]] });
          }
        }
      }
      items.push({ ...toolLine(u), ...(d.verdict === 'allow' && u.name === 'bash' ? { extra: [{ t: ` · ${d.why}`, s: st.dim }] } : {}) } as Item);
      schedule();
      let r: ToolResult;
      try {
        r = await runTool(String(u.name), input, signal);
      } catch (e) {
        r = { content: (e as Error).message, error: true, summary: (e as Error).message };
      }
      if (u.name === 'write' || u.name === 'edit') !r.error && did.wrote.push(rel(cwd, path.resolve(cwd, String(input.path))));
      if (u.name === 'bash') did.ran.push({ cmd: String(input.command), ok: !r.error });
      // What it did, short: the diff of an edit, the end of a command's output.
      if (r.diff) detail(r.diff.map((x) => [{ t: x.n ? `${String(x.n).padStart(4)} ` : '     ', s: st.dim }, { t: x.sign === ' ' ? x.text : `${x.sign} ${x.text}`, s: x.sign === '+' ? st.ok : x.sign === '-' ? st.del : st.dim }]));
      else if (r.output?.length) {
        const tail = r.output.slice(-6);
        detail([...(r.output.length > 6 ? [[{ t: `… ${r.output.length - 6} more lines`, s: st.dim }]] : []), ...tail.map((l) => [{ t: l, s: st.dim }]), [{ t: r.summary, s: r.error ? st.warn : st.dim }]]);
      } else detail([[{ t: r.summary, s: r.error ? st.warn : st.dim }]]);
      out.push(result(u.id, r.content, !!r.error));
      schedule();
    }
    return out;
  }

  function runTool(name: string, input: Record<string, any>, signal: AbortSignal): ToolResult | Promise<ToolResult> {
    if (name === 'read') return readTool(cwd, input as { path: string });
    if (name === 'write') return writeTool(cwd, input as { path: string; content: string });
    if (name === 'edit') return editTool(cwd, input as { path: string; old: string; new: string });
    if (name === 'bash') return bashTool(cwd, input as { command: string }, signal);
    if (name === 'rime') {
      const text = rimeTool(String(input.action ?? ''), (input.args ?? {}) as Record<string, any>);
      return { content: text, summary: text.split('\n')[0] };
    }
    return { content: `Unknown tool ${name}.`, error: true, summary: 'unknown tool' };
  }

  // The rime tool (SPEC §15): Rime acting on itself. It never reads or writes API
  // keys, and it can't change permission modes or rules (it opens /permissions).
  function rimeTool(action: string, args: Record<string, any>): string {
    const ACTIONS = 'help · settings.list · settings.get {key} · settings.set {key, value} · command {name: /model | /server | /setup | /settings | /permissions | /usage} · tab.open · tab.close · tab.focus · panel.show · panel.hide · panel.split';
    if (action === 'help') return `Actions: ${ACTIONS}\nSettings: ${settings.list().map((d) => `${d.key} (${d.values.join(' | ')}; applies ${WHEN[d.applies]})`).join(', ')}`;
    if (action === 'settings.list') return settings.list().map((d) => `${d.key} = ${d.get(cfg)} · ${d.help} · applies ${WHEN[d.applies]}`).join('\n');
    if (action === 'settings.get') return `${args.key} = ${settings.get(String(args.key)) ?? '(no such setting)'}`;
    if (action === 'settings.set') {
      const d = settings.list().find((x) => x.key === args.key);
      if (!d) return `No setting ${args.key}. settings.list shows them.`;
      if (!d.values.includes(String(args.value))) return `${args.key} takes ${d.values.join(' | ')}.`;
      const ch = settings.set(d.key, String(args.value));
      if (ch) items.push({ kind: 'gear', change: ch });
      return ch ? `Done: ${d.label.toLowerCase()} ${ch.to} (was ${ch.from}), ${WHEN[d.applies]}.` : `${d.label.toLowerCase()} was already ${args.value}.`;
    }
    if (action === 'command') {
      const name = String(args.name ?? '').replace(/^\/?/, '/');
      const open: Record<string, () => void> = {
        '/model': () => (panel = createModelPicker(host)),
        '/setup': () => (panel = createSetup(host)),
        '/settings': () => (panel = createSettingsPanel(host)),
        '/permissions': () => (panel = createPermissions()),
        '/usage': () => (boxKind = 'usage'),
        '/server': () => {
          const n = model && cfg.providers[model.provider]?.ssh ? model.provider : Object.keys(cfg.providers).find((k) => cfg.providers[k].ssh);
          if (n) panel = createServer(host, n);
        },
      };
      if (!open[name]) return `Rime has no box ${name}. Boxes: ${Object.keys(open).join(', ')}.`;
      open[name]();
      schedule();
      return `Opened ${name} for the user; they answer it there.`;
    }
    if (/^(tab|panel)\./.test(action)) return 'Rime has no side panel yet (split view comes in a later version), so this did nothing. Tell the user, and suggest a command they can run instead, such as `open index.html`.';
    return `Unknown action ${action}. Actions: ${ACTIONS}`;
  }

  // Asks before a command or an edit: Yes · Yes, don't ask again · No, tell Rime
  // instead. While Rime waits, the turn is paused.
  function ask(u: Block, d: Decision, signal: AbortSignal): Promise<'yes' | 'always' | 'no' | 'stop'> {
    return new Promise((resolve) => {
      const done = (a: 'yes' | 'always' | 'no' | 'stop') => {
        signal.removeEventListener('abort', stop);
        approval = null;
        schedule();
        resolve(a);
      };
      const stop = () => done('stop');
      signal.addEventListener('abort', stop, { once: true });
      const input = (u.input ?? {}) as Record<string, any>;
      let diff: ToolResult['diff'];
      if (u.name === 'edit') {
        const e = planEdit(cwd, input as { path: string; old: string; new: string });
        if (!('error' in e)) diff = diffOf(e.before, e.at, input.old, input.new, 8);
      } else if (u.name === 'write') diff = String(input.content ?? '').split('\n').slice(0, 8).map((t, i) => ({ sign: '+' as const, n: i + 1, text: t }));
      approval = { use: u, decision: d, sel: 0, done, diff };
      schedule();
    });
  }

  // /permissions (SPEC §17): the mode (auto only from here), the rules with where
  // each came from, adding and removing them, and the last decisions.
  function createPermissions(): Panel {
    const PRESETS: [Mode, string, string][] = [
      ['ask', 'Ask every time', 'before each command and edit (the default)'],
      ['auto-edit', 'Auto-edit', 'edits without asking, commands still ask'],
      ['plan', 'Plan', 'read-only: no edits, only read-only commands'],
      ['auto', 'Auto', 'runs everything; deny rules and risky commands still ask'],
      ['god', 'God mode', 'runs every command and edit without asking, even sudo and rm -rf'],
    ];
    let pick = 0;
    let sure = false; // asked "turn on god mode?"
    let adding = false;
    let error = '';
    type Row = { kind: 'mode' | 'rule' | 'add'; m?: Mode; rule?: ReturnType<typeof ruleList>[number] };
    const rowsOf = (): Row[] => [
      ...PRESETS.map(([m]): Row => ({ kind: 'mode', m })),
      ...ruleList(cfg.permissions, projectRules(project), convRules).map((rule): Row => ({ kind: 'rule', rule })),
      { kind: 'add' },
    ];
    const remove = (r: ReturnType<typeof ruleList>[number]) => {
      if (r.from === 'conversation') {
        convRules = { ...convRules, [r.kind]: (convRules[r.kind] ?? []).filter((x) => x !== r.pattern) };
        save((d) => d.setRules(conversation()!, convRules));
      } else if (r.from === 'project') removeProjectRule(project, r.kind, r.pattern);
      else {
        cfg.permissions = { ...cfg.permissions, [r.kind]: (cfg.permissions?.[r.kind] ?? []).filter((x) => x !== r.pattern) };
        settings.save();
      }
    };
    const dim = (t: string) => ({ t, s: st.dim });
    return {
      view() {
        const rows = rowsOf();
        pick = Math.min(pick, rows.length - 1);
        const out: BoxRow[] = [{ line: [dim('Mode')] }];
        rows.forEach((r, i) => {
          if (r.kind === 'mode') {
            const p = PRESETS.find((x) => x[0] === r.m)!;
            out.push(listRow(p[1], [{ t: r.m === mode ? '● ' : '', s: r.m === 'god' ? st.del : r.m === 'auto' ? st.warn : st.ok }, dim(p[2])], i === pick, st, `pick:${i}`, 22));
            if (r.m === 'god' && sure) {
              out.push(
                { line: [{ t: '  Turn on god mode? Rime will run every command and edit the model asks for, without asking you:', s: st.del }] },
                { line: [{ t: '  sudo, rm -rf, force push, writes outside the project. Only your deny rules still block.', s: st.del }] },
                { line: [{ t: '  It lasts until you quit or switch modes. ', s: st.dim }, { t: 'enter', s: st.accentB }, { t: ' turn it on · ', s: st.dim }, { t: 'esc', s: st.accentB }, { t: ' keep things as they are', s: st.dim }] },
              );
            }
            if (r.m === 'god') out.push({ line: [] }, { line: [dim('Rules · deny wins over ask, ask over allow')] });
          } else if (r.kind === 'rule') {
            const k = r.rule!;
            out.push(listRow(`${k.kind} ${k.pattern}`, `${k.from === 'conversation' ? 'this conversation' : k.from === 'project' ? 'this project (.rime/permissions.json)' : 'you (~/.rime/config)'} · d removes`, i === pick, st, `pick:${i}`, 40));
          } else out.push(listRow(adding ? 'Type the rule below' : '+ Add a rule', adding ? 'e.g. allow bash(npm run build *) · deny edit(.env)' : 'allow / ask / deny bash(…), edit(…), read(…)', i === pick, st, `pick:${i}`, 22));
        });
        if (error) out.push({ line: [{ t: error, s: st.warn }] });
        out.push({ line: [] }, { line: [dim('Recent decisions')] });
        if (!decisions.length) out.push({ line: [dim('  none yet')] });
        for (const d of decisions.slice(0, 6)) out.push({ line: [{ t: d.verdict === 'allow' ? '  ✓ ' : d.verdict === 'deny' ? '  ✗ ' : '  ? ', s: d.verdict === 'deny' ? st.del : d.verdict === 'allow' ? st.ok : st.warn }, { t: d.what, s: st.fg }, dim(` · ${d.why}`)] });
        return { legend: [{ t: 'permissions', s: st.accent }, dim(` · ${MODE_HELP[mode]}`)], rows: out, foot: adding ? ['enter', ' add · ', 'esc', ' back'] : ['↑ ↓', ' choose · ', 'enter', ' pick · ', 'd', ' remove a rule · ', 'esc', ' close'] };
      },
      placeholder: () => (adding ? 'allow bash(npm test *)' : 'Pick a mode or a rule'),
      typing: () => adding,
      key(k) {
        const rows = rowsOf();
        if (adding) {
          if (k.name === 'escape') return (adding = false), (error = ''), host.setBuffer(''), true;
          return false;
        }
        if (sure) {
          // The god mode confirm: enter turns it on, anything else keeps things as they are.
          sure = false;
          if (k.name === 'enter') setMode('god');
          return true;
        }
        if (k.name === 'escape') return host.close(), true;
        if (k.name === 'up') return (pick = (pick + rows.length - 1) % rows.length), true;
        if (k.name === 'down') return (pick = (pick + 1) % rows.length), true;
        const r = rows[pick];
        if (k.name === 'char' && k.ch === 'd' && r.kind === 'rule') return remove(r.rule!), true;
        if (k.name === 'enter') {
          if (r.kind === 'mode' && r.m === 'god' && mode !== 'god') sure = true;
          else if (r.kind === 'mode') setMode(r.m!);
          else if (r.kind === 'add') (adding = true), host.setBuffer('allow bash(');
          return true;
        }
        return true;
      },
      submit(v) {
        const m = /^(allow|ask|deny)\s+((?:bash|edit|read|fetch)\(.+\))$/.exec(v.trim());
        if (!m) return void (error = 'A rule looks like: allow bash(npm test *), ask edit(src/**), deny read(.env)');
        addConvRule(m[1] as 'allow', m[2]);
        adding = false;
        error = '';
        host.setBuffer('');
      },
      click(id) {
        pick = Number(id.split(':')[1]);
      },
    };
  }

  // Which of the three answers this question offers (0 yes, 1 don't ask again, 2 no).
  function approvalOptions() {
    const a = approval!;
    const again = a.use.name === 'bash' ? !!a.decision.rule : (a.use.name === 'write' || a.use.name === 'edit') && !/outside/.test(a.decision.why);
    return again ? [0, 1, 2] : [0, 2];
  }
  function answer(n: number) {
    if (!approval || !approvalOptions().includes(n - 1)) return;
    approval.done(n === 1 ? 'yes' : n === 2 ? 'always' : 'no');
  }
  function cycleMode() {
    setMode(mode === 'auto' || mode === 'god' ? 'ask' : MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
  }

  // The question above the prompt: the exact command (or the change), where it
  // runs, why it asks, and the three answers.
  function approvalBox(width: number) {
    if (!approval) return null;
    const { use: u, decision: d, diff } = approval;
    const i = (u.input ?? {}) as Record<string, any>;
    const dim = (t: string) => ({ t, s: st.dim });
    const rows: BoxRow[] = [];
    const title = u.name === 'bash' ? 'run a command?' : u.name === 'write' ? (fs.existsSync(path.resolve(cwd, String(i.path))) ? 'replace a file?' : 'create a file?') : u.name === 'edit' ? 'edit a file?' : 'read a file?';
    if (u.name === 'bash') {
      for (const l of String(i.command ?? '').split('\n').slice(0, 6)) rows.push({ line: [{ t: '$ ', s: st.dim }, { t: l, s: st.titleB }], bg: st.panelBg });
      rows.push({ line: [dim(`in ${tildify(cwd)}`), ...(i.reason ? [dim(' · '), { t: 'Rime: ', s: st.fg }, dim(String(i.reason))] : [])] });
      if (d.parts && d.parts.length > 1)
        rows.push({ line: d.parts.flatMap((p, j) => [...(j ? [dim(' · ')] : []), { t: `${p.state === 'ok' ? '✓' : p.state === 'guard' ? '✗' : '?'} ${p.text}`, s: p.state === 'ok' ? st.ok : p.state === 'guard' ? st.del : st.warn }, ...(p.why ? [dim(` ${p.why}`)] : [])]) });
    } else {
      rows.push({ line: [{ t: rel(cwd, path.resolve(cwd, String(i.path ?? ''))), s: st.titleB }] });
      for (const x of diff ?? []) rows.push({ line: [{ t: x.n ? `${String(x.n).padStart(4)} ` : '     ', s: st.dim }, { t: x.sign === ' ' ? x.text : `${x.sign} ${x.text}`, s: x.sign === '+' ? st.ok : x.sign === '-' ? st.del : st.dim }] });
    }
    if (d.why && !/in this mode$/.test(d.why)) rows.push({ line: [{ t: d.why, s: st.warn }] });
    rows.push({ line: [] });
    const labels = [
      'Yes',
      u.name === 'bash' ? `Yes, and don't ask again for ${d.label} commands in this conversation` : 'Yes, and allow edits for the rest of this conversation',
      'No, and tell Rime what to do instead (esc)',
    ];
    for (const n of approvalOptions()) {
      const on = approval.sel === n;
      rows.push({ line: [{ t: on ? '› ' : '  ', s: st.accent }, { t: `${n + 1} `, s: st.dim }, { t: labels[n], s: on ? st.accent : st.fg }], bg: on ? st.panelBg : undefined, hit: `dec:${n + 1}` });
    }
    rows.push(...footRows(['↑ ↓', ' choose · ', 'enter', ' or ', approvalOptions().length === 3 ? '1 2 3' : '1 3', ' · ', 'esc', ' no · ', 'shift+tab', ' mode'], st));
    return box([{ t: title, s: st.warn }, dim(` · ${MODE_HELP[mode]}`)], rows, width, st, st.warn);
  }

  // Starts a new conversation; the current one stays in the list.
  function newConversation() {
    busy?.abort();
    if (convId) save((d) => d.unlock(convId!));
    convId = null;
    continuing = null;
    resumeOk = false;
    lastUserSeq = 0;
    nextStep = '';
    example = tryExample();
    convRules = {};
    messages = [];
    task = null;
    items = [headerItem];
    scrollOff = 0;
  }

  // ← on an empty prompt: this project's conversations, newest first (SPEC §16).
  // Search, the timeline, rename, fork and delete come in Phase 4b.
  function createConversations(): Panel {
    let pick = 0;
    let filter = '';
    const all = save((d) => d.list(project)) ?? [];
    const dim = (t: string) => ({ t, s: st.dim });
    const shown = () => all.filter((c) => c.n > 0 && (!filter || c.title.toLowerCase().includes(filter.toLowerCase())));
    const group = (t: number) => {
      const day = 86400000, start = new Date().setHours(0, 0, 0, 0);
      return t >= start ? 'Today' : t >= start - day ? 'Yesterday' : t >= start - 6 * day ? 'This week' : 'Older';
    };
    const open = (id: number) => {
      if (id === convId) return host.close();
      const c = save((d) => d.take(id));
      if (!c) return void note('That conversation is open in another Rime window.', 'dim');
      newConversation();
      reopen(c);
      host.close();
    };
    return {
      view(width) {
        const list = shown();
        pick = Math.min(pick, Math.max(0, list.length - 1));
        const rows: BoxRow[] = [];
        let g = '';
        list.slice(Math.max(0, pick - 12), Math.max(0, pick - 12) + 16).forEach((c) => {
          const i = list.indexOf(c);
          if (group(c.updated) !== g) rows.push({ line: [dim((g = group(c.updated)))] });
          const model = c.model ? c.model.split('/').pop() : '';
          rows.push(listRow(c.title || 'untitled', [{ t: c.id === convId ? '● ' : '', s: st.ok }, dim([ago(c.updated), model, `${c.n} messages`].filter(Boolean).join(' · '))], i === pick, st, `pick:${i}`, Math.min(48, Math.floor(width / 2))));
        });
        if (!list.length) rows.push({ line: [dim(filter ? `no conversation matches ${filter}` : 'No conversations in this project yet.')] });
        return { legend: [{ t: 'conversations', s: st.accent }, dim(` · ${tildify(project)}`)], rows, foot: ['↑ ↓', ' choose · ', 'enter', ' open · ', 'n', ' new · type to filter · ', 'esc', ' back'] };
      },
      placeholder: () => 'Type to filter your conversations',
      typing: () => true,
      key(k) {
        const list = shown();
        if (k.name === 'escape' || (k.name === 'right' && !filter)) return host.close(), true;
        if (k.name === 'up') return (pick = (pick + list.length - 1) % Math.max(1, list.length)), true;
        if (k.name === 'down') return (pick = (pick + 1) % Math.max(1, list.length)), true;
        if (k.name === 'enter') return list[pick] && open(list[pick].id), true;
        if (k.name === 'char' && k.ch === 'n' && !filter) return newConversation(), host.close(), true;
        return false;
      },
      changed(v) {
        filter = v;
        pick = 0;
      },
      click(id) {
        pick = Number(id.split(':')[1]);
      },
    };
  }

  function setMode(m: Mode) {
    mode = m;
    say(`permission mode: ${MODE_HELP[m]}`);
    schedule();
  }

  // After a reply, one suggestion for what to do next, from what just happened
  // (SPEC §5.4). No AI call.
  function suggestNext(did: Did): string {
    const tests = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|\bvitest\b|\bjest\b|\bnode\s+--test\b/;
    const lastTest = [...did.ran].reverse().find((r) => tests.test(r.cmd));
    if (lastTest && !lastTest.ok) return 'fix the failing tests';
    const html = did.wrote.find((f) => /\.html?$/i.test(f));
    if (html) return `open ${html} in the browser`;
    if (did.wrote.length && !lastTest && hasTests()) return 'run the tests';
    if ((did.wrote.length || lastTest?.ok) && gitDirty()) return 'commit this';
    return '';
  }
  const hasTests = () => {
    try {
      return !!JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).scripts?.test;
    } catch {
      return fs.existsSync(path.join(project, 'pytest.ini')) || fs.existsSync(path.join(project, 'go.mod')) || fs.existsSync(path.join(project, 'Cargo.toml'));
    }
  };
  const gitDirty = () => {
    const r = spawnSync('git', ['-C', project, 'status', '--porcelain'], { encoding: 'utf8' });
    return r.status === 0 && r.stdout.trim().length > 0;
  };

  // An example for the empty prompt, from this project (`Try "…"`, like Claude Code).
  function tryExample() {
    const files = listFiles(project, 2000).filter((f) => /\.(ts|tsx|js|jsx|py|go|rs|rb|java|c|cpp|swift|kt|php|html|css|md)$/.test(f) && !/(^|\/)(dist|build|vendor)\//.test(f));
    const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
    if (!files.length) return pick(['build a small static page that says hello', 'start a new project: a CLI that counts words', 'make a simple todo app in one html file']);
    const code = files.filter((f) => !/\.(md|html|css)$/.test(f));
    const f = pick(code.length ? code : files);
    const ideas = [`explain what ${f} does`, `find bugs in ${f}`, `add tests for ${f}`, `make ${f} easier to read`];
    if (!files.some((x) => /^readme/i.test(x))) ideas.push('write a README for this project');
    if (hasTests()) ideas.push('run the tests and fix what fails');
    return pick(ideas);
  }

  // ---- panels ----

  const host: Host & Parameters<typeof createServer>[0] & Parameters<typeof createModelPicker>[0] & Parameters<typeof createSettingsPanel>[0] = {
    st,
    cfg,
    get system() {
      return SYSTEM;
    },
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
    // "No, and tell Rime what to do instead": these words go back as the reason.
    if (declining && !v.startsWith('/')) {
      if (v) items.push({ kind: 'user', text: v }), history.push(v);
      buf = '';
      cur = 0;
      anchor = null;
      return declining(v);
    }
    if (!v && resumeOk && !busy) return void send('continue');
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
    if (c === '/model' && args[0]) {
      const refs = knownModels().filter((r) => r.toLowerCase().includes(args[0].toLowerCase()));
      const ref = refs.includes(args[0]) ? args[0] : refs[Math.min(sel, refs.length - 1)];
      if (ref) {
        cfg.model = ref;
        settings.save();
        useRef(ref);
      } else note(`No model matches ${args[0]}. /model lists them.`, 'dim');
    } else if (c === '/model') panel = createModelPicker(host);
    else if (c === '/setup') panel = bg?.panel && !bg.run.state.done ? bg.panel : createSetup(host);
    else if (c === '/connect') panel = args[0] ? createSetup(host, 'connect', args[1], args[0]) : createSetup(host);
    else if (c === '/server') {
      const name = model && cfg.providers[model.provider]?.ssh ? model.provider : Object.keys(cfg.providers).find((n) => cfg.providers[n].ssh);
      if (name) panel = createServer(host, name);
      else note('No own server is set up. /setup connects one.', 'dim');
    } else if (c === '/settings') panel = createSettingsPanel(host);
    else if (c === '/permissions') panel = createPermissions();
    else if (c === '/conversations') panel = createConversations();
    else if (c === '/clear') {
      newConversation();
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
    if (id === 'mode') return cycleMode();
    if (id === 'conversations') return void (panel = createConversations());
    if (id.startsWith('dec:') && approval) return void answer(+id.slice(4));
    if (id.startsWith('undo:')) {
      const it = items[+id.slice(5)];
      if (it?.kind === 'gear') settings.undo(it.change);
      return;
    }
    if (id === 'sendlist') return void ((listPinned = !listPinned), (listOpen = listPinned));
    if (id.startsWith('at:')) return takeAt(atMatches()[+id.slice(3)].f);
    if (id.startsWith('arg:')) return void ((sel = +id.slice(4)), onKey({ type: 'key', name: 'enter' }));
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
    // The permission question takes the keys while it's open.
    if (approval) {
      const opts = approvalOptions();
      if (k.name === 'up' || k.name === 'down') {
        const i = opts.indexOf(approval.sel);
        approval.sel = opts[(i + (k.name === 'up' ? opts.length - 1 : 1)) % opts.length];
      } else if (k.name === 'enter') answer(approval.sel + 1);
      else if (k.name === 'char' && /^[123]$/.test(k.ch ?? '') && opts.includes(+k.ch! - 1)) answer(+k.ch!);
      else if (k.name === 'escape') answer(3);
      else if (k.name === 'tab' && k.shift) cycleMode();
      else if (k.ctrl && k.name === 'c') busy?.abort();
      return;
    }
    if (k.name === 'tab' && k.shift && !panel) return cycleMode();
    // ← on an empty prompt opens your conversations.
    if (k.name === 'left' && !k.shift && !buf && !panel && !boxKind && !busy && !rsearch) return void (panel = createConversations());
    // ctrl+c cancels what's open or running; twice quits, but only when nothing
    // is open or running, so one press never loses work (SPEC §5.2).
    if (k.ctrl && k.name === 'c') {
      if (panel) return panel.cancel ? panel.cancel() : host.close();
      if (rsearch || atPick) return void (rsearch = atPick = null);
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

    // ctrl+r searches your earlier prompts; the typing goes to the search.
    if (!panel && rsearch) {
      const m = rmatches();
      if (k.name === 'escape') rsearch = null;
      else if (k.name === 'enter' || k.name === 'tab') {
        const h = m[rsearch.i % Math.max(1, m.length)];
        rsearch = null;
        if (h) (buf = h), (cur = buf.length), (anchor = null);
      } else if ((k.ctrl && k.name === 'r') || k.name === 'up') rsearch.i++;
      else if (k.name === 'down') rsearch.i = Math.max(0, rsearch.i - 1);
      else if (k.name === 'backspace') (rsearch.q = rsearch.q.slice(0, -1)), (rsearch.i = 0);
      else if (k.name === 'space' || (k.name === 'char' && k.ch && !k.ctrl)) (rsearch.q += k.ch ?? ' '), (rsearch.i = 0);
      return;
    }
    if (!panel && k.ctrl && k.name === 'r') return void ((rsearch = { q: '', i: 0 }), (atPick = null));
    // The @ picker takes ↑ ↓, tab/enter and esc while it's open.
    if (!panel && atPick && atQuery() !== null) {
      const m = atMatches();
      if (k.name === 'up' || k.name === 'down') return void (atPick.sel = (atPick.sel + (k.name === 'up' ? m.length - 1 : 1)) % Math.max(1, m.length));
      if ((k.name === 'tab' || (k.name === 'enter' && !k.shift)) && m.length) return takeAt(m[atPick.sel % m.length].f);
      if (k.name === 'escape') return void (atPick = null);
    }
    // `/model ` lists models; ↑ ↓ choose one.
    if (!panel && /^\/model\s+\S*$/.test(buf) && (k.name === 'up' || k.name === 'down')) {
      const n = Math.max(1, knownModels().filter((r) => r.toLowerCase().includes(buf.split(/\s+/)[1].toLowerCase())).length);
      return void (sel = (sel + (k.name === 'down' ? 1 : n - 1)) % n);
    }
    // On an empty prompt, tab or → takes the suggestion (the next step, or the example).
    if (!buf && !panel && !declining && (k.name === 'tab' || (k.name === 'right' && !k.shift)) && (nextStep || example)) return insert(nextStep || example);
    // tab, or → at the end, takes the ghost text.
    const g = ghost();
    if (g && (k.name === 'tab' || (k.name === 'right' && !k.shift && !k.ctrl))) return insert(g);

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
      else if (browsing) {
        // Back to what you were typing before ↑.
        buf = browsing.draft;
        cur = buf.length;
        browsing = null;
        navigated = true;
      } else if (range()) anchor = null;
      else if (listPinned) listPinned = listOpen = false;
      else if (blindAsk) blindAsk = false;
      else if (boxKind) boxKind = null;
      else if (busy) busy.esc();
      else if (scrollOff > 0) scrollOff = 0; // back to the end of the conversation
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
        // option+← / → arrive as esc b / esc f in many terminals: a word left or right.
        if (k.alt && (k.ch === 'b' || k.ch === 'f')) (anchor = null), (cur = k.ch === 'b' ? wordLeft(cur) : wordRight(cur));
        else if (k.ch === '?' && !buf && !panel) boxKind = 'keys';
        else if (!k.alt && k.ch) {
          insert(k.ch);
          // @ at the start or after a space opens the file picker (ana@larch.dev stays text).
          if (k.ch === '@' && !panel && (cur === 1 || /\s/.test(buf[cur - 2]))) atPick = { start: cur - 1, sel: 0 };
        }
        break;
      case 'space':
        insert(' ');
        break;
      case 'backspace':
        if (r) cut(...r);
        else if (k.ctrl || k.alt) cut(wordLeft(cur), cur); // option+backspace deletes a word, as in Claude Code
        else if (cur > 0) cut(prevCp(cur), cur);
        break;
      case 'delete':
        if (r) cut(...r);
        else if (k.alt) cut(cur, wordRight(cur));
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
        } else cur = k.ctrl || k.alt ? (left ? wordLeft(cur) : wordRight(cur)) : left ? prevCp(cur) : nextCp(cur);
        break;
      }
      case 'up':
      case 'down': {
        const up = k.name === 'up';
        if (k.shift) anchor ??= cur;
        else anchor = null;
        if (vertical(up ? -1 : 1) || k.shift) break;
        // On the first line ↑ goes to older prompts; on the last line ↓ comes back
        // to newer ones and finally to what you were typing.
        if (up) {
          browsing ??= { list: [...history].reverse().concat(past).filter((p, i, a) => p.trim() && a.indexOf(p) === i), i: -1, draft: buf };
          if (browsing.i + 1 >= browsing.list.length) break;
          buf = browsing.list[++browsing.i];
        } else if (browsing) {
          buf = --browsing.i < 0 ? browsing.draft : browsing.list[browsing.i];
          if (browsing.i < 0) browsing = null;
        } else break;
        cur = buf.length;
        navigated = true;
        break;
      }
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
      if (ev.button === 64 || ev.button === 65 || ev.button === 96 || ev.button === 97) {
        // The wheel scrolls; a transcript selection stays on its text (and grows
        // with the view while the button is held).
        scrollOff += ev.button % 2 === 0 ? 3 : -3;
        if (!selection?.log) selection = null;
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
        pointer = at;
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
        pointer = at;
        if (press.prompt) cur = promptOffset(ev.x, ev.y, true)!;
        else if (at.x !== press.x || at.y !== press.y || selection) {
          const log = press.y <= viewH;
          selection ??= { a: log ? { x: press.x, y: top + press.y - 1 } : { x: press.x, y: press.y }, b: at, log };
          if (!log) selection.b = at; // in the transcript, the frame places b (it may scroll)
          edge();
        }
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
        } else if (selection) {
          if (selection.log) selection.b = { x: pointer.y > viewH ? W() : pointer.x, y: top + Math.max(1, Math.min(viewH, pointer.y)) - 1 };
          press = null;
          edge();
          copySelection();
        }
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
    if (buf !== before) {
      blindAsk = false;
      if (!navigated) browsing = null; // typing keeps the text you brought back
    }
    navigated = false;
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

  // Quitting is instant at any moment (SPEC §16): everything is already saved,
  // a reply being streamed is kept as interrupted, and each own server's onQuit
  // (stop the service or power the machine off, docs/providers.md §4.3) runs in a
  // detached child that finishes on its own and logs to ~/.rime/logs/.
  function quit() {
    if (quitting) return;
    quitting = 'bye';
    if (live && convId) save((d) => d.update(convId!, live!.seq, [{ type: 'text', text: live!.text() }], true));
    if (convId) save((d) => d.unlock(convId!));
    header?.close();
    for (const [name, p] of Object.entries(cfg.providers)) {
      if (!p.ssh || !p.onQuit || p.onQuit === 'keep' || !tunnels[name]?.port) continue;
      // ponytail: saving the slot before stopping arrives with token-kit.
      const logs = path.join(os.homedir(), '.rime', 'logs');
      fs.mkdirSync(logs, { recursive: true });
      const log = fs.openSync(path.join(logs, 'quit.log'), 'a');
      spawn('ssh', [...SSH_OPTS, p.ssh, p.onQuit === 'stop' ? 'sudo systemctl stop llama-server' : 'sudo poweroff'], { detached: true, stdio: ['ignore', log, log] }).unref();
    }
    restore();
    process.exit(0);
  }

  // Reopens this project's last conversation (SPEC §16): the exact messages, and
  // the frozen prefix it was sent with when it's recent enough for the cache to hit.
  function reopen(c: Conversation) {
    convId = c.id;
    try {
      convRules = c.rules ? JSON.parse(c.rules) : {};
    } catch {
      convRules = {};
    }
    // The stored prefix is reused when it's recent and was sent with today's tools.
    if (c.prefix && c.prefix_hash === TOOLS_HASH && Date.now() - c.updated < 86400000) SYSTEM = c.prefix;
    else save((d) => d.setPrefix(c.id, SYSTEM, TOOLS_HASH));
    const stored: Stored[] = save((d) => d.messages(c.id)) ?? [];
    for (const m of stored) {
      const blocks: Block[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      if (m.role === 'system') {
        const { type: _, ...oc } = blocks[0] ?? {};
        messages.push({ role: 'system', content: [], output_config: oc });
        continue;
      }
      messages.push({ role: m.role, content: m.content });
      const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text)).join(m.role === 'user' ? '\n' : '');
      if (m.role === 'user') {
        if (text) items.push({ kind: 'user', text }), history.push(text);
      } else {
        if (splitToolCalls(text).text.trim()) items.push({ kind: 'reply', text: text + (m.interrupted ? '…' : ''), done: true });
        for (const u of blocks.filter((b) => b.type === 'tool_use')) items.push(toolLine(u));
      }
    }
    if (!stored.length) return;
    continuing = { title: c.title || 'untitled', at: c.updated };
    // Tool calls left without results when Rime closed get them now.
    const last = messages.at(-1);
    const open = last?.role === 'assistant' && Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_use') : [];
    if (open.length) {
      messages.push({ role: 'user', content: open.map((u) => result(u.id, 'Not run: Rime was closed before this ran.', true)) });
      lastUserSeq = store(messages.at(-1)!);
    } else if (stored.at(-1)!.role === 'user') lastUserSeq = stored.at(-1)!.seq;
    if (stored.at(-1)!.interrupted || messages.at(-1)?.role === 'user') {
      resumeOk = true;
      items.push({ kind: 'lines', lines: [[{ t: '  ↻ ', s: st.warn }, { t: 'interrupted when you quit · nothing was lost · ', s: st.dim }, { t: 'enter', s: st.accentB }, { t: ' continue', s: st.dim }]] });
    }
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
  // `rime` reopens this project's last conversation; there are no sessions.
  if (db) {
    if (!db.wal) note("rime.db can't use WAL on this disk, so saving uses the default journal.", 'dim');
    const { conv, busy: taken } = save((d) => d.last(project)) ?? { conv: null, busy: false };
    if (taken) note('The last conversation here is open in another Rime window, so this is a new one.', 'dim');
    else if (conv) reopen(conv);
    past = save((d) => d.prompts(project)) ?? [];
  }
  example = tryExample();
  if (!connected()) panel = createSetup(host);
  else if (cfg.model) useRef(cfg.model, true);
  frame();
}
