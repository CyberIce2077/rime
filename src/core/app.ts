// The single-pane Rime screen (SPEC §4, reference/rime-prototype.html).
//
// Full screen on the alternate screen: the transcript scrolls in the top part
// (wheel, ctrl+u / ctrl+d, esc back to the end), the boxes, prompt and status line
// are pinned to the bottom.
// Models come from connected providers (docs/providers.md); /setup connects them.

import { type Chip, type Kind, LONG_PASTE, blocksFor, fmtK, chipChar, cleanPaste, fromBlocks, chipFor, clipboardImage, fuzzy, isChip, label, listFiles, pastedPaths, textChip } from './attach.ts';
import { copy } from './clipboard.ts';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Conversation, type Db, type Stored, openDb, projectOf } from './db.ts';
import { type Decision, MODE_HELP, MODES, type Mode, addProjectRule, decide, projectRules, removeProjectRule, ruleList, rulesHash, trustedProjectRules } from './permissions.ts';
import { type RunAs, type ToolResult, TOOLS, bash as bashTool, sandboxed, diffOf, edit as editTool, optionsOf, planEdit, read as readTool, rel, textOf, write as writeTool } from './tools.ts';
import { type AgentEvent, type TurnHost, result, runTools, runTurn } from './agent.ts';
import { WHEN, createSettings, phrase } from './settings.ts';
import { type Did, choicesOf, example as exampleFor, nextStep as nextFor } from './suggest.ts';
import { toolEvents } from './timeline.ts';
import { parse as parseQuery, rank, suggestions } from './rank.ts';
import { type Config, saveConfig } from './config.ts';
import { CUBE_COLS, type Header, type HeaderOpts, SCENE, playHeader, tildify } from './header.ts';
import { type InputEvent, type Key, type Line, createParser, fit, lineWidth, sliceCols, stripAnsi, strWidth, truncAnsi, wrap } from './term.ts';
import { colorMode } from './theme.ts';
import { previewBox, sendLine, sendList } from './preview.ts';
import { type BoxRow, type Hint, type Hit, type Item, box, caretOf, footRows, hintLines, layoutInput, listRow, offsetAt, prompt, renderItem, spaced, splitToolCalls, status, str, styles } from './view.ts';
import { type Turn, addTurns, createMeter, fmt$, fmtS, fmtT } from '../plugins/token-kit/meter.ts';
import * as llama from '../providers/llamacpp.ts';
import { PRESETS } from '../providers/presets.ts';
import { connOf, listModels, modelOf, pickUrl, streamFor } from '../providers/registry.ts';
import { recheck } from '../providers/probe.ts';
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
  ['/conversations', 'search, open, fork or delete your conversations'],
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
  ['ctrl+w', 'delete the word before the cursor'],
  ['tab', 'complete a command'],
  ['ctrl+v', 'paste an image from the clipboard (or drag in a file)'],
  ['@', 'mention a file or folder'],
  ['ctrl+r', 'search your earlier prompts'],
  ['ctrl+o', "show or hide the model's thinking"],
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
  'ctrl+c': { name: 'c', ctrl: true }, 'ctrl+j': { name: 'j', ctrl: true }, 'ctrl+v': { name: 'v', ctrl: true }, 'ctrl+o': { name: 'o', ctrl: true },
  'ctrl+r': { name: 'r', ctrl: true }, 'ctrl+d': { name: 'd', ctrl: true }, '→': { name: 'right' }, '←': { name: 'left' }, '↑': { name: 'up' }, '↓': { name: 'down' }, 'shift+tab': { name: 'tab', shift: true },
  'ctrl+p': { name: 'p', ctrl: true }, 'ctrl+f': { name: 'f', ctrl: true }, 'ctrl+e': { name: 'e', ctrl: true }, 'ctrl+s': { name: 's', ctrl: true }, 'ctrl+u': { name: 'u', ctrl: true },
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
  `When you need the user to choose before you go on, use the ask tool and stop there; never ask in text and then carry on in the same reply.\n` +
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
  const decisions: { at: number; tool: string; what: string; verdict: string; why: string }[] = [];
  let example = ''; // `Try "…"` on an empty prompt, from this project
  // "Don't ask again" rules belong to this conversation and are saved with it.
  const addConvRule = (kind: 'allow' | 'ask' | 'deny', pattern: string) => bound(S).addConvRule(kind, pattern);
  // ↑ / ↓ through earlier prompts, like a shell: `draft` is what you were typing.
  // ↑ history: `draft` is what you were typing; `edited` once you change the
  // recalled text (esc still brings the draft back, ↑ ↓ then move in the text).
  let browsing: { list: string[]; i: number; draft: string; edited?: boolean } | null = null;
  let navigated = false;
  const cwd = process.cwd();
  const SYSTEM = system(cwd, agentsMd(projectOf(cwd))); // the prefix for new conversations

  // ---- state ----
  let model: Model | undefined;
  let conn: Conn | undefined; // set once the model's provider answers
  let controls: Controls = { reasoning: cfg.reasoning !== false, effort: cfg.effort };
  // A task keeps one model; controls that would break its cache stay fixed for it.
  const unsafe = new Set<string>(); // models where changing controls was measured to reset the cache
  const history: string[] = [];
  let buf = '', cur = 0, sel = 0;
  let anchor: number | null = null; // the other end of a selection in the prompt
  const chips = new Map<string, Chip>(); // chip character -> attachment (kept for ↑ and the transcript)
  let chipSeq = 0;
  const counts: Partial<Record<Kind, number>> = {};
  let hover: string | null = null; // chip under the mouse
  let big: string | null = null; // chip opened full size
  let bigScroll = { id: '', at: 0, max: 0, page: 10 }; // where a full-size file or text is scrolled to
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
  let quitArmed: NodeJS.Timeout | null = null;
  let quitting: string | null = null;
  const tunnels: Record<string, Tunnel> = {};
  let bg: { name: string; run: Run; panel?: Panel; stopping?: boolean } | null = null; // an own server coming up in the background
  let promptRate: number | undefined; // local prompt tokens/s, from the last reply

  // ---- saving (SPEC §16): every message is written the moment it exists ----
  const project = projectOf(cwd);
  const db: Db | null = await openDb().catch(() => null);
  let saveFailed = false;
  const save = <T>(fn: (d: Db) => T): T | undefined => {
    if (!db) return;
    try {
      return fn(db);
    } catch (e) {
      if (!saveFailed) (saveFailed = true), note(`Rime couldn't save this conversation: ${(e as Error).message}`, 'dim');
    }
  };
  // Helpers bound to one conversation. Work that's running uses its own set, so it
  // keeps writing to its conversation after you switch to another one.
  function bound(x: Session) {
    const conversation = () => (x.convId ??= save((d) => d.create(project, x.system, model?.ref, TOOLS_HASH)) ?? null);
    return {
      conversation,
      // An Anthropic effort-only system message is kept as one output_config block.
      store: (m: Message) => save((d) => d.append(conversation()!, m.role, m.role === 'system' ? [{ type: 'output_config', ...(m.output_config as object) }] : m.content)) ?? 0,
      note: (text: string, tone: 'warn' | 'dim' = 'warn') => {
        x.items.push({ kind: 'note', tone, text });
        schedule();
      },
      drop: (it: Item) => {
        const i = x.items.indexOf(it);
        if (i >= 0) x.items.splice(i, 1);
      },
      addConvRule: (kind: 'allow' | 'ask' | 'deny', pattern: string) => {
        x.convRules = { ...x.convRules, [kind]: [...new Set([...(x.convRules[kind] ?? []), pattern])] };
        save((d) => d.setRules(conversation()!, x.convRules));
      },
      event: (kind: string, text: string, ref?: string) => save((d) => d.event(conversation()!, kind, text, ref)),
      detail: (lines: Line[]) => x.items.push({ kind: 'lines', hug: true, lines: lines.map((l) => [{ t: '  ⎿ ', s: st.dim }, ...l]).map((l, i) => (i ? [{ t: '    ', s: '' }, ...l.slice(1)] : l)) }),
    };
  }
  // The same helpers for the conversation on screen.
  const conversation = () => bound(S).conversation();
  const store = (m: Message) => bound(S).store(m);
  const prompts = () => [...history.slice().reverse(), ...(save((d) => d.prompts(project)) ?? [])].filter((p, i, a) => p.trim() && a.indexOf(p) === i);

  // ---- screen ----
  let scrollOff = 0; // transcript lines scrolled up from the bottom
  let lastTotal = 0;
  let viewH = 0;
  let headerRow = 0; // screen row of the header's first line (can be off screen)
  let hits: { row: number; x0: number; x1: number; id: string }[] = [];
  let scheduled = false;
  let lastFrame = 0;
  let showThinking = false; // ctrl+o: thinking opened under every "Thought for" line
  let drawn: string[] = []; // what each screen row holds now, so a frame only rewrites what changed
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

  // ---- conversations in this window ----
  // Each open conversation keeps its own state, so one can keep working (a reply,
  // tool calls, a question waiting for you) while you look at another. `S` is
  // the one on screen; work that's running holds on to its own.
  type Session = {
    convId: number | null; // created with the first message
    messages: Message[];
    items: Item[];
    // A task keeps one model; controls that would break its cache stay fixed for it.
    task: { controls: Controls; sentEffort?: Effort; lastPrompt: number; lastControls?: Controls } | null;
    busy: { abort(): void; esc(): void } | null;
    waiting: { text: string; content: string | Block[] } | null; // a message held until the model is ready
    live: { seq: number; text: () => string } | null; // the reply being streamed
    lastUserSeq: number; // the stored row of the last user message, while it has no reply
    continuing: { title: string; at: number; cost: string } | null; // reopened, nothing sent yet
    resumeOk: boolean; // the last reply was cut off by quitting: enter continues it
    approval: { use: Block; decision: Decision; sel: number; done(a: 'yes' | 'always' | 'no' | 'stop'): void; diff?: ToolResult['diff'] } | null;
    // A question with options: from the ask tool (`tool`, the turn waits for it), or
    // read from a reply that ended with "(a) … (b) …" (picking sends it).
    question: { q: string; options: { label: string; detail?: string }[]; sel: number; tool: boolean; done(answer: string | null): void } | null;
    // Messages you sent while it worked: they go with the next tool results, or as
    // the next message when the reply ends.
    queued: { text: string; content: string | Block[] | Promise<Block[]> }[];
    declining: ((words: string | null) => void) | null; // "No, tell Rime instead": the next prompt is the reason
    convRules: { allow?: string[]; ask?: string[]; deny?: string[] }; // "don't ask again", saved with it
    meter: ReturnType<typeof createMeter>; // its tokens, cost and savings
    nextStep: string; // suggested after a reply (tab takes it)
    title: string;
    mark: string; // the model and effort last put on the timeline
    planSaid: boolean; // the model was told plan mode is on
    costItem: Item | null; // this turn's ↳ line, kept last as its requests add up
    system: string; // its frozen system prompt: the stored one when reopened while the cache is warm
  };
  const newSession = (): Session => ({
    convId: null, messages: [], items: [headerItem], task: null, busy: null, waiting: null, live: null, lastUserSeq: 0,
    continuing: null, resumeOk: false, approval: null, question: null, queued: [], declining: null, convRules: {}, meter: createMeter(), nextStep: '', title: '', mark: '', planSaid: false, costItem: null, system: SYSTEM,
  });
  let S = newSession();
  const sessions: Session[] = [S]; // open in this window; the ones not on screen keep working
  const needsYou = (x: Session) => !!(x.approval || x.declining || x.question?.tool);

  const W = () => out.columns || 80;
  const H = () => out.rows || 24;
  const connected = () => Object.keys(cfg.providers).length > 0;
  const tunnel = (name: string) => (tunnels[name] ??= { child: null, port: 0 });

  // Header line 2: the model and what was actually sent, or the compact loader.
  const ago = (t: number) => {
    const s = (Date.now() - t) / 1000;
    return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} days ago`;
  };
  // What reopening costs (SPEC §16): the last prompt's size, re-read at the
  // server's measured speed, or priced as a cache write.
  function resumeCost(stored: Stored[]) {
    const us = stored.flatMap((m) => (m.usage ? [m.usage] : []));
    const last = us.at(-1);
    if (!last) return '';
    const size = last.usage.input + last.usage.cached + last.usage.written;
    if (last.local) {
      const timed = us.filter((u) => u.usage.promptMs && u.usage.input > 200).at(-1);
      return timed ? `resume ~${fmtS((size * timed.usage.promptMs!) / timed.usage.input)}` : '';
    }
    return last.price ? `resume ~${fmt$((size * (last.price.write || last.price.in)) / 1e6)}` : '';
  }
  function headerInfo() {
    const cont = S.continuing ? [`continuing "${S.continuing.title}"`, ago(S.continuing.at), S.continuing.cost, '← conversations'].filter(Boolean).join(' · ') : '';
    // A setup running in the background (any server, any model): its loader and ✕ stop.
    if (bg && !bg.run.state.done) {
      const s = bg.run.state, p = bg.name;
      const label = model?.provider === p ? model.label : undefined;
      const step = s.steps.find((v) => v.status === 'run' || v.status === 'fail');
      if (step?.status === 'fail') return { model: label, details: `${p} · couldn't start: /server` };
      const b = bar(s.overall, 6);
      if (bg.stopping) return { model: label, details: `${p} · stopping…` };
      return { model: label, details: `${p} · ${PHASE[step?.id ?? 'connect']} ${b.fill}${b.empty} ${b.pct.trim()} · ✕ stop` };
    }
    if (!model) return { model: undefined, details: cont || (connected() ? 'no model selected' : 'no model connected') };
    if (cont) return { model: model.label, details: `${model.provider} · ${cont}` };
    const p = model.provider;
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
    const pins: { at: number; i: number }[] = [];
    let prev: Item | undefined;
    S.items.forEach((it, i) => {
      if (spaced(prev, it)) lines.push('');
      if (it.kind === 'gear' && !it.note && !it.change.undone) gears.push({ at: lines.length, i });
      lines.push(...render(it, width));
      if (it.kind === 'user') pins.push({ at: lines.length - 1, i });
      prev = it;
    });
    if (prev !== headerItem) lines.push(''); // the log's bottom margin
    return { lines, gears, pins };
  }

  // ---- boxes above the prompt ----

  const matches = () => {
    const q = buf.slice(1).toLowerCase();
    const pre = CMDS.filter(([n]) => n.slice(1).startsWith(q));
    return [...pre, ...CMDS.filter((c) => !pre.includes(c) && (c[0] + ' ' + c[1]).toLowerCase().includes(q))];
  };
  const cmdsOpen = () => !panel && boxKind !== 'keys' && buf.startsWith('/') && !/\s/.test(buf);

  // /usage for a local model: tokens and the prompt-processing time the cache
  // saved, no dollar columns.
  function localUsageRows(width: number): BoxRow[] {
    const t = S.meter.tokens, inner = width - 4;
    const row = (label: string, value: string, s: string): BoxRow => ({ line: [...fit([{ t: label, s }], inner - 12, true), { t: value.padStart(12), s }] });
    return [
      row('tokens', '', st.dim),
      row('processed (not cached)', fmtT(t.uncached + t.write), st.fg),
      row('read from the cache', fmtT(t.read), st.fg),
      row('written by the model', fmtT(t.out), st.fg),
      { line: [], rule: 'inner' },
      row('total', fmtT(S.meter.totalTokens()), st.title),
      { line: [] },
      row('prompt caching saved', S.meter.saved.ms >= 100 ? `~${fmtS(S.meter.saved.ms)}` : '—', st.ok),
      { line: [], rule: 'inner' },
      ...wrap([{ t: `Local tokens cost nothing. Cached tokens skip prompt processing on ${model?.provider ?? 'the server'}${promptRate ? ` (about ${Math.round(promptRate)} tokens/s)` : ''}, which is the time shown. `, s: st.dim }, { t: '/usage', s: st.accent }, { t: ' or a click on the meter closes this.', s: st.dim }], inner).map((line) => ({ line })),
    ];
  }

  function usageRows(width: number): BoxRow[] {
    if (conn?.local || (!conn && model && cfg.providers[model.provider]?.ssh)) return localUsageRows(width);
    const t = S.meter.tokens, c = S.meter.cost, p = model?.price;
    const sp = S.meter.spent(), sv = S.meter.savedTotal();
    const savedCell = `${fmt$(sv)} (${S.meter.pct()}%)`;
    const data: [string, string, string][] = [
      ['input', fmtT(t.uncached), fmt$(c.uncached)],
      ['cache reads', fmtT(t.read), fmt$(c.read)],
      ['cache writes', fmtT(t.write), fmt$(c.write)],
      ['output', fmtT(t.out), fmt$(c.out)],
      ['total spent', fmtT(S.meter.totalTokens()), fmt$(sp)],
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
      S.meter.unpriced() ? 'Some replies came from a model with an unknown price, so their dollars aren\'t counted. ' : '',
      S.meter.saved.ms >= 1000 ? `Local prompt caching saved about ${fmtS(S.meter.saved.ms)} of prompt processing. ` : '',
    ].join('');
    const foot = wrap([
      { t: `Without Rime this conversation would have cost ${fmt$(sp + sv)}. ${prices}${notes}`, s: st.dim },
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
      row([{ t: '  prompt caching', s: st.fg }], '', fmt$(S.meter.saved.cache), st.fg),
      { line: [{ t: '  ' + why, s: st.dim }] },
      ...(S.meter.saved.handled ? [row([{ t: '  handled in Rime', s: st.fg }], '', fmt$(S.meter.saved.handled), st.fg), { line: [{ t: '  requests answered with no API call', s: st.dim }] }] : []),
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
        ? m.map(([n, h], i, all) => listRow(n, h, i === sel, st, `cmd:${i}`, Math.max(13, ...all.map(([x]) => x.length + 2))))
        : [{ line: [{ t: `no command matches ${buf}`, s: st.dim }] }];
      return box('commands', [...rows, ...footRows(['↑ ↓', ' choose · ', 'tab', ' complete · ', 'enter', ' run · ', 'esc', ' close'], st)], width, st, st.accent, 'key:esc');
    }
    if (boxKind === 'keys') {
      return box('shortcuts', [...KEYS.map(([k, h]) => listRow(k, h, false, st, undefined, 16)), ...footRows('any key to close', st)], width, st, st.accent, 'key:esc');
    }
    if (boxKind === 'usage') return box(`usage · this conversation${model ? ` · ${model.label}` : ''}`, usageRows(width), width, st, st.accent, 'key:esc');
    return null;
  }

  function meterLine(): Line {
    if (!connected()) return [{ t: 'no model', s: st.dim }];
    const tokens = `${fmtT(S.meter.totalTokens())} tokens`;
    if (conn?.local || (!conn && model && cfg.providers[model.provider]?.ssh)) {
      const ms = S.meter.saved.ms;
      // Local tokens cost nothing, so no dollars here: the time the cache saved instead.
      return [{ t: `${tokens} · local`, s: st.dim }, ...(ms >= 1000 ? [{ t: ` · saved ~${fmtS(ms)}`, s: st.ok }] : [])];
    }
    if (S.meter.unpriced() && !S.meter.spent()) return [{ t: tokens, s: st.dim }];
    return [{ t: `${tokens} · ${fmt$(S.meter.spent())} · `, s: st.dim }, { t: `saved ${fmt$(S.meter.savedTotal())} (${S.meter.pct()}%)`, s: st.ok }];
  }

  // The right end of the status line: the meter, then "esc to stop" while working.
  // Not while a question box owns esc (it means "no" there).
  const stoppable = () => !!(S.busy || S.declining) && !S.approval && !S.question?.tool;
  const rightLine = (): Line => (stoppable() ? [...meterLine(), { t: ' · ', s: st.dim }, { t: 'esc', s: st.accentB }, { t: ' to stop', s: st.dim }] : meterLine());

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
  // Dim ghost text completing the line from an earlier prompt in this
  // conversation (↑ and ctrl+r search the whole project's).
  function ghost() {
    if (panel || atPick || rsearch || browsing || boxKind || range() || cur !== buf.length || buf.length < 3 || buf.startsWith('/') || [...buf].some(isChip)) return '';
    const low = buf.toLowerCase();
    const mine = S.items.flatMap((it) => (it.kind === 'user' && !it.chips ? [it.text] : [])).reverse();
    const h = mine.find((p) => p.length > buf.length && p.toLowerCase().startsWith(low));
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
      askServed();
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
  const knownModels = () => [...new Set([model?.ref, cfg.model, ...Object.entries(cfg.providers).map(([n, p]) => (p.model ? `${n}/${p.model}` : undefined)), ...Object.entries(served).flatMap(([n, ids]) => ids.map((i) => `${n}/${i}`)), ...Object.keys(cfg.models)].filter((x): x is string => !!x))];
  // Each connected provider's own model list, for the /model hint (asked once a session).
  const served: Record<string, string[]> = {};
  let servedAsked = false;
  function askServed() {
    if (servedAsked) return;
    servedAsked = true;
    for (const [name, p] of Object.entries(cfg.providers))
      void (async () => {
        const t = p.ssh ? tunnel(name) : null;
        const base = p.ssh ? (t!.port ? `http://127.0.0.1:${t!.port}/v1` : '') : await pickUrl([p.url ?? PRESETS[p.preset]?.url ?? ''].flat());
        if (!base) return;
        const c = connOf(name, p, base);
        const ids = c.llamacpp ? (await llama.routerModels(llama.rootOf(base)).catch(() => null))?.map((m) => m.id) : null;
        served[name] = ids ?? (await listModels(c).catch(() => ({ models: [] as { id: string }[] }))).models.map((m) => m.id);
        schedule();
      })().catch(() => {});
  }

  // The preview above the prompt: a chip full size, under the mouse or at the
  // caret, else the "what gets sent" list when it's open.
  // Scrolls the full-size preview (keys and wheel); false when it can't scroll.
  function scrollBig(by: number) {
    if (!big || !bigScroll.max) return false;
    bigScroll.at = Math.max(0, Math.min(bigScroll.max, bigScroll.at + by));
    return true;
  }

  function chipBox(width: number, height: number) {
    if (panel || cmdsOpen() || boxKind) return null;
    const sb = suggestBox(width);
    if (sb) return sb;
    const id = big ?? hover ?? nearChip();
    const c = id ? chips.get(id) : undefined;
    if (c && id) {
      if (big === id && bigScroll.id !== id) bigScroll = { id, at: 0, max: 0, page: 10 };
      // Full size it takes the room the prompt and status line leave, less a few
      // transcript lines and its own frame.
      const room = Math.max(3, height - 16);
      const v = previewBox(c, width, { big: big === id, hovering: hover === id && big !== id, blind: blind() && media(c) ? `${blindNote()}. Rime asks before sending the text without it.` : undefined, scroll: bigScroll.at, room }, st, schedule);
      if (big === id) Object.assign(bigScroll, { max: v.max, at: Math.min(bigScroll.at, v.max), page: Math.max(1, Math.floor(room / 2)) });
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
    const b = approvalBox(width) ?? questionBox(width) ?? currentBox(width) ?? chipBox(width, height);
    if (b && b.lines.length <= height - 5) {
      lines.push(...b.lines);
      rowHits.push(...b.hits);
    }
    // Messages waiting for Rime to take them, dim, in the order they'll go.
    for (const q of S.queued.slice(-3)) {
      const t = [...q.text].map((ch) => (isChip(ch) && chips.get(ch) ? `[${label(chips.get(ch)!)}]` : ch)).join('').split('\n')[0];
      lines.push(str(fit([{ t: '› ', s: st.dim }, { t, s: st.dim }, { t: ' · queued', s: st.accent }], width), st));
      rowHits.push([]);
    }
    // The line under the prompt sums up the next message.
    const sent = !panel && buf.trim() && !buf.startsWith('/') ? sendLine(buf, chips, listOpen, st, blind() && hasMedia(buf) ? `${blindNote()}` : undefined) : [];
    // The prompt grows to 10 rows (at most a third of the screen), then scrolls.
    const maxRows = Math.max(1, Math.min(10, Math.floor(height / 3), height - lines.length - 3 - (sent.length ? 1 : 0)));
    const p = prompt(buf, cur, width, maxRows, st, {
      placeholder: panel?.placeholder?.() ?? (S.declining ? 'tell Rime what to do instead' : S.question ? 'pick one above, or type your own answer' : S.resumeOk ? (pendingUses(S).length ? 'enter asks the open question again, or ask something new' : 'enter continues the interrupted reply, or ask something new') : S.nextStep ? S.nextStep : unloaded() ? `load ${unloaded()}` : example && !S.messages.length ? `Try "${example}"` : undefined),
      // A suggestion shows the key that takes it.
      tabHint: !panel && !S.declining && !S.resumeOk && (buf ? !!ghost() : !!(S.nextStep || unloaded() || (example && !S.messages.length))),
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
    const more: { line: Line; hits: Hit[] }[] = []; // status parts that wrapped below
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
    } else if (browsing && !browsing.edited) {
      left = [{ t: '↑', s: st.accentB }, { t: ' older · ', s: st.dim }, { t: '↓', s: st.accentB }, { t: ' newer · ', s: st.dim }, { t: 'esc', s: st.accentB }, { t: ' back to your text', s: st.dim }];
      leftHits = [{ x0: 19, x1: 21, id: 'key:esc' }];
    } else if (range()) {
      left = [{ t: 'backspace', s: st.accentB }, { t: ' delete selection · ', s: st.dim }, { t: 'esc', s: st.accentB }, { t: ' clear selection', s: st.dim }];
      leftHits = [{ x0: 1, x1: 9, id: 'key:backspace' }, { x0: 30, x1: 32, id: 'key:esc' }];
    } else {
      // One line of parts, most important first: other conversations, the permission
      // mode, then the keys. What doesn't fit drops from the end. Stopping sits at
      // the far right, after the meter.
      const dim = (t: string) => ({ t, s: st.dim });
      const key = (t: string) => ({ t, s: st.accentB });
      const parts: { line: Line; id?: string }[] = [];
      if (S.declining) parts.push({ line: [dim('type what Rime should do instead')] });
      if (S.queued.length && !buf) parts.push({ line: [key('↑'), dim(' edit queued')] });
      if (browsing?.edited) parts.push({ line: [key('esc'), dim(browsing.draft.trim() ? ' back to your text' : ' clear')], id: 'key:esc' });
      const asking = sessions.filter((x) => x !== S && needsYou(x)).length;
      const working = sessions.filter((x) => x !== S && (x.busy || x.waiting) && !needsYou(x)).length;
      if (asking) parts.push({ line: [{ t: '● ', s: st.warn }, { t: `${asking} needs you`, s: st.fg }], id: 'conversations' });
      if (working) parts.push({ line: [{ t: '● ', s: st.accent }, { t: `${working} working`, s: st.fg }], id: 'conversations' });
      // The permission mode always shows, like Claude Code's; a click cycles it.
      const [icon, name, ms] =
        mode === 'ask' ? ['⏵', 'ask', st.accent]
        : mode === 'auto-edit' ? ['⏵⏵', 'auto-edit', st.accentB]
        : mode === 'plan' ? ['⏸', 'plan', st.accentB]
        : mode === 'god' ? ['⏵⏵⏵⏵', 'god mode', st.del]
        : ['⏵⏵⏵', 'auto', st.warn];
      parts.push({ line: [{ t: `${icon} ${name}`, s: ms }, dim(' shift+tab')], id: 'mode' });
      parts.push({ line: [key('←'), dim(' conversations')], id: 'conversations' });
      parts.push({ line: [key('/'), dim(' for commands')], id: '/' });
      parts.push({ line: [key('?'), dim(' for shortcuts')], id: '?' });
      // Parts are never cut: what doesn't fit beside the meter moves to a line
      // below, whole, in the same order.
      const room = width - lineWidth(rightLine()) - 2;
      const rowsOut: { line: Line; hits: Hit[] }[] = [{ line: [], hits: [] }];
      for (const p of parts) {
        let r = rowsOut.at(-1)!;
        const fits = (rowsOut.length === 1 ? room : width - 1) - lineWidth(r.line) - (r.line.length ? 3 : 0) >= lineWidth(p.line);
        if (r.line.length && !fits) rowsOut.push((r = { line: [], hits: [] }));
        if (r.line.length) r.line.push(dim(' · '));
        r.line.push(...p.line);
        if (p.id) r.hits.push({ x0: lineWidth(r.line) - lineWidth(p.line) + 1, x1: lineWidth(r.line), id: p.id });
      }
      left = rowsOut[0].line;
      leftHits = rowsOut[0].hits;
      more.push(...rowsOut.slice(1));
    }
    const s = status(left, rightLine(), width, st, leftHits, stoppable() ? [{ x0: 1, x1: lineWidth(meterLine()), id: 'meter' }, { x0: lineWidth(meterLine()) + 4, x1: lineWidth(rightLine()), id: 'key:esc' }] : undefined);
    lines.push(s.line);
    rowHits.push(s.hits);
    for (const m of more) lines.push(str(fit(m.line, width), st)), rowHits.push(m.hits);
    return { lines, rowHits, cursor: { row: top + p.cursor.row, col: p.cursor.col }, prompt: { rel: top + 1, first: p.first, shown: p.lines.length - 2, rows: p.rows } };
  }

  // ---- drawing ----

  // Full screen, like vim: the transcript fills the top (scrollable), the boxes,
  // prompt and status line sit at the bottom. Every frame repaints every row.
  function frame() {
    scheduled = false;
    Object.assign(headerOpts, headerInfo());
    const width = W(), height = H();
    // The conversations window fills the screen.
    if (list) {
      const v = frameList(width, height);
      hits = v.rowHits;
      rows = v.lines.map((l) => truncAnsi(l, width));
      return paint(rows.map((l) => [l, '']), width, '');
    }
    const { lines, gears, pins } = transcript(width);
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
    headerRow = S.items[0] === headerItem ? 2 - start : -99;
    hits = u.rowHits.flatMap((hs, i) => hs.map((h) => ({ ...h, row: viewH + 1 + i })));
    promptAt = { row: viewH + 1 + u.prompt.rel, first: u.prompt.first, shown: u.prompt.shown, rows: u.prompt.rows };
    rows = screen.map((l) => truncAnsi(l, width));
    // "ctrl+o to show / hide" under thinking is a key too.
    rows.slice(0, viewH).forEach((r, i) => {
      const text = stripAnsi(r);
      const x = text.indexOf('· ctrl+o to ');
      if (x >= 0 && text.trimStart().startsWith('✻')) hits.push({ row: i + 1, x0: strWidth(text.slice(0, x)) + 3, x1: strWidth(text.slice(0, x)) + 16, id: 'key:ctrl+o' });
    });
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
    for (const p of pins) {
      const row = p.at - start + 1;
      const text = row >= 1 && row <= viewH ? stripAnsi(rows[row - 1]) : '';
      const x = text.lastIndexOf('◆');
      if (x >= 0) hits.push({ row, x0: strWidth(text.slice(0, x)) + 1, x1: strWidth(text.slice(0, x)) + 1, id: `pin:${p.i}` });
    }
    const back = l2.indexOf('← conversations');
    if (back >= 0) hits.push({ row: r2, x0: strWidth(l2.slice(0, back)) + 1, x1: strWidth(l2.slice(0, back)) + 15, id: 'conversations' });
    const marks = rows.map(() => '');
    for (const { y, x0, x1 } of selectionSpans(width)) marks[y - 1] += `\x1b[${y};${x0}H${st.selection}${sliceCols(rows[y - 1], x0, x1).padEnd(x1 - x0 + 1)}${st.reset}`;
    paint(rows.map((l, i) => [l, marks[i]]), width, `\x1b[${viewH + 1 + u.cursor.row};${u.cursor.col + 1}H\x1b[?25h`);
  }

  // Writes only the rows that changed since the last frame, each overwritten in
  // place and padded to the width instead of cleared first: a row is never blank
  // on screen, so terminals without synchronized output (2026) don't flicker.
  function paint(screen: [string, string][], width: number, cursor: string) {
    let out = '';
    screen.forEach(([l, mark], i) => {
      const row = `${l}${st.reset}${' '.repeat(Math.max(0, width - strWidth(stripAnsi(l))))}${mark}`;
      if (drawn[i] !== row) out += `\x1b[${i + 1};1H${row}`;
      drawn[i] = row;
    });
    drawn.length = screen.length;
    write('\x1b[?2026h\x1b[?25l' + out + cursor + '\x1b[?2026l');
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
    const hasHeader = S.items[0] === headerItem;
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

  // At most ~60 frames a second: a fast stream asks for one per token.
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    const wait = lastFrame + 16 - Date.now();
    const go = () => {
      lastFrame = Date.now();
      frame();
    };
    if (wait > 0) setTimeout(go, wait);
    else setImmediate(go);
  };

  const note = (text: string, tone: 'warn' | 'dim' = 'warn') => bound(S).note(text, tone);

  // ---- models and servers ----

  // Brings an own server up (wake, tunnel, start, load, warm) with the compact
  // loader in the header; the prompt stays usable meanwhile.
  // Rime's tunnel closing by itself (sleep, network change, ssh dropped): the
  // connection goes and the next message opens it again, as after /server stop.
  // Not reopened at once: after a power off that would wake the server.
  const watched = new WeakSet<object>();
  function watchTunnel(name: string) {
    const t = tunnel(name), child = t.child;
    if (!child || watched.has(child)) return;
    watched.add(child);
    child.once('exit', () => {
      if (closing || t.child !== child) return;
      t.child = null;
      t.port = 0;
      if (conn?.name !== name) return; // already down (/server stop, power off)
      conn = undefined;
      if (S.convId) bound(S).event('server', `${name} tunnel closed`);
      note(`The tunnel to ${name} closed; the next message opens it again.`, 'dim');
      schedule();
    });
  }

  function ensure(name: string, quiet = false) {
    const p = cfg.providers[name];
    if (!p?.ssh) return Promise.resolve();
    if (bg?.name === name && !bg.run.state.done && !bg.run.state.error) return bg.run.promise.then(() => {});
    const run = runSteps(
      { name, host: p.ssh, remote: p.tunnel?.remote ?? '127.0.0.1:8080', mac: p.wake?.mac, broadcast: p.wake?.broadcast, model: p.model, router: p.router ?? !!p.model },
      {
        edited: p.steps,
        skip: [...(p.skip ?? []), 'test'], // the test reply belongs to /setup
        system: S.system,
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
        watchTunnel(name);
        if (model?.provider === name) {
          conn = connOf(name, p, r.base);
          serverInfo();
        }
        const worked = run.state.steps.filter((v) => ['wake', 'start', 'load'].includes(v.id) && v.status === 'done' && !['on', 'running', 'loaded'].includes(v.result));
        if (worked.length && S.convId) bound(S).event('server', `${name} ${worked.map((v) => `${NAMES[v.id]} ${v.result}`).join(' · ')}`);
        if (!quiet && worked.length) {
          S.items.push({ kind: 'lines', lines: [[{ t: '● ', s: st.ok }, { t: `${name} is ready · `, s: st.fg }, { t: model?.label ?? p.model ?? '', s: st.titleB }, { t: ` · ${worked.map((v) => `${NAMES[v.id]} ${v.result}`).join(' · ')}`, s: st.dim }]] });
        }
        if (bg?.run === run) bg = null;
        schedule();
        // Messages held in any conversation go now.
        for (const x of sessions) {
          if (!x.waiting) continue;
          const t = x.waiting;
          x.waiting = null;
          send(t.text, true, t.content, x);
        }
      },
      (e) => {
        if (bg?.run === run) bg = null;
        if (e instanceof Cancelled) {
          for (const x of sessions) {
            if (x.waiting) bound(x).note('Your message wasn\'t sent; it\'s still in ↑.', 'dim');
            x.waiting = null;
          }
          panel = createStopped(host, { name, host: p.ssh!, model: p.model, state: run.state, startup: true, after: 'Rime starts it again when you send a message.' }, () => {
            host.close();
            ensure(name);
          });
          return schedule();
        }
        note(`${name}: ${(e as Error).message}. /server shows what's going on, /setup changes the steps.`);
        for (const x of sessions) x.waiting = null;
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
    // Any llama.cpp server (also one added with /connect): its template is tested
    // for cache safety and tool calls, and again when its build changes.
    if (m) {
      const p = cfg.providers[m.provider];
      recheck(llama.rootOf(conn.base), m, p?.probe).then((pr) => {
        if (!pr || cfg.providers[m.provider] !== p) return;
        p.probe = pr;
        settings.save();
        if (model?.provider === m.provider && conn) conn = connOf(m.provider, p, conn.base);
      }).catch(() => {});
    }
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
    S.task = null;
    if (!quiet) S.items.push({ kind: 'tool', verb: 'Model', rest: `${m.label} · ${m.provider}` });
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
    if (conn?.llamacpp) return { effort: pr?.effortSafe === true, reasoning: pr?.reasoningSafe === true };
    return { effort: true, reasoning: true };
  }
  function sentControls(): Controls {
    if (!S.task) return controls;
    const safe = cacheSafe();
    return { reasoning: safe.reasoning ? controls.reasoning : S.task.controls.reasoning, effort: safe.effort ? controls.effort : S.task.controls.effort };
  }

  // ---- chat ----

  const drop = (it: Item) => bound(S).drop(it);

  // The user's message joins the history; when the last message is already the
  // user's (a reply that never came, or tool results), the new words join it, so
  // the turns keep alternating.
  function pushUser(content: string | Block[], C: Session) {
    const { conversation, store, note, drop, addConvRule, detail } = bound(C);
    const last = C.messages.at(-1);
    if (last?.role === 'user' && C.lastUserSeq) {
      const blocks = (c: string | Block[]): Block[] => (typeof c === 'string' ? [{ type: 'text', text: c }] : c);
      last.content = [...blocks(last.content), ...blocks(content)];
      save((d) => d.update(C.convId!, C.lastUserSeq, last.content, false));
      return C.lastUserSeq;
    }
    C.messages.push({ role: 'user', content });
    return (C.lastUserSeq = store(C.messages.at(-1)!));
  }

  // Tool calls of the last reply that never got results (Rime closed while asking).
  const pendingUses = (C: Session) => {
    const last = C.messages.at(-1);
    return last?.role === 'assistant' && Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_use') : [];
  };

  // `text` is the prompt as typed (chips included); `content` is what goes to the
  // model: the text, or content blocks with the attachments.
  async function send(text: string, held = false, content: string | Block[] | Promise<Block[]> = text, C: Session = S) {
    const { conversation, store, note, drop, addConvRule, detail } = bound(C);
    if (!held) {
      const labels = Object.fromEntries([...new Set([...text].filter(isChip))].flatMap((ch) => (chips.get(ch) ? [[ch, label(chips.get(ch)!)]] : [])));
      C.items.push({ kind: 'user', text, ...(Object.keys(labels).length ? { chips: labels } : {}) });
      for (const l of Object.values(labels)) bound(C).event('attach', l.replace(/^\[|\]$/g, ''));
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
      C.waiting = { text, content };
      if (!held) note(`sends once ${model.provider} is ready`, 'dim');
      ensure(model.provider);
      return;
    }
    if (!conn.key && conn.wire === 'anthropic') return note(`No API key for ${conn.name}. /setup adds one, or set ${PRESETS.anthropic.keyEnv}.`);
    const root = llama.rootOf(conn.base);
    // Another of your conversations on the same server: the server queues this one.
    // ponytail: they share slot 0, so each evicts the other's cache; per-conversation slots when total_slots > 1.
    const mine = sessions.some((x) => x !== C && x.busy && conn && x.convId !== null);
    if (conn.llamacpp && !mine && (await llama.busy(root))) return note(`${conn.name} is busy: another client is using its slot. Try again in a moment.`);
    if (conn.llamacpp && mine) note(`waits for ${conn.name}: another conversation is using it`, 'dim');

    C.task ??= { controls: { ...controls }, lastPrompt: 0 };
    const c = sentControls();
    // Anthropic keeps top-level effort fixed per task and takes changes as an
    // effort-only system message, so the cache survives.
    if (conn.wire === 'anthropic' && c.effort !== (C.task.sentEffort ?? C.task.controls.effort) && C.messages.length && C.messages.at(-1)?.role !== 'user') {
      C.messages.push({ role: 'system', content: [], output_config: { effort: c.effort ?? 'high' } });
      store(C.messages.at(-1)!);
      C.task.sentEffort = c.effort;
    }
    const ac = new AbortController();
    const m = model, cn = conn;
    // Files you attached: `[file a.ts] src/a.ts (40 lines)` heads in the message.
    const attached = (Array.isArray(content) ? content : []).flatMap((b) => (b.type === 'text' ? [...String(b.text).matchAll(/^\[file [^\]]+\] (.+?) \(\d+ lines\)\n/g)].map((x) => x[1]) : []));
    const did: Did = { wrote: [], ran: [], about: attached };
    // Tool calls still waiting for your answer when Rime closed are asked again
    // first (SPEC §17); their results go ahead of your words.
    let esc = () => ac.abort();
    const h = turnHost(C, m, cn, c, ac, did, (f) => (esc = f));
    const pending = pendingUses(C);
    if (pending.length) {
      const me = { abort: () => ac.abort(), esc: () => ac.abort() };
      C.busy = me;
      C.resumeOk = false;
      schedule();
      const results = await runTools(h, pending, ac.signal);
      if (C.busy === me) C.busy = null;
      if (ac.signal.aborted) {
        C.messages.push({ role: 'user', content: results });
        C.lastUserSeq = store(C.messages.at(-1)!);
        return note('stopped', 'dim');
      }
      content = [...results, ...(typeof content === 'string' ? [{ type: 'text', text: content } as Block] : content)];
    }
    // Plan mode is told to the model in the message (the system prompt stays frozen).
    if ((mode === 'plan') !== C.planSaid) {
      C.planSaid = mode === 'plan';
      const say = C.planSaid ? '[Rime: plan mode is on. Only read-only tools run; investigate and propose a plan instead of changing files.]' : '[Rime: plan mode is off. You can edit files and run commands again.]';
      content = [...(typeof content === 'string' ? [{ type: 'text', text: content } as Block] : content), { type: 'text', text: say }];
    }
    const userSeq = pushUser(content, C);
    C.costItem = null;
    C.continuing = null;
    C.resumeOk = false;
    C.nextStep = '';
    if (!C.question?.tool) C.question = null; // a picker from the last reply is answered or moot now

    let said = ''; // the last reply's text, for the next-step suggestion
    const me = { abort: () => ac.abort(), esc: () => esc() };
    C.busy = me;
    schedule();
    try {
      // The loop (agent.ts): a reply, its tool calls (asked about first), their
      // results back to the model, until it answers without tools or you stop it.
      said = (await runTurn(h, ac.signal, userSeq)).said;
    } finally {
      if (C.busy === me) C.busy = null;
      C.nextStep = nextFor(said, did, project);
      offerChoices(said, C);
      if (C === S) askTrust(); // the rules file changed during the reply
      example = exampleFor(project);
      // What you sent meanwhile: stopped, it goes back to the prompt; else it's next.
      if (C.queued.length && ac.signal.aborted) unqueue(C);
      else if (C.queued.length) {
        const q = C.queued.splice(0);
        const contents = await Promise.all(q.map((x) => x.content));
        const content = contents.every((x) => typeof x === 'string') ? contents.join('\n') : contents.flatMap((x) => (typeof x === 'string' ? [{ type: 'text', text: x } as Block] : x));
        void send(q.map((x) => x.text).join('\n'), false, content, C);
      }
      schedule();
    }
  }

  // Queued messages joining the conversation after tool results: shown where they
  // land in the transcript, sent as blocks after the results.
  async function takeQueued(C: Session): Promise<Block[]> {
    const q = C.queued.splice(0);
    const out: Block[] = [];
    for (const x of q) {
      const labels = Object.fromEntries([...new Set([...x.text].filter(isChip))].flatMap((ch) => (chips.get(ch) ? [[ch, label(chips.get(ch)!)]] : [])));
      C.items.push({ kind: 'user', text: x.text, ...(Object.keys(labels).length ? { chips: labels } : {}) });
      const c = await x.content;
      out.push(...(typeof c === 'string' ? [{ type: 'text', text: c } as Block] : c));
    }
    schedule();
    return out;
  }

  // Queued messages back into the prompt (after esc), ahead of anything typed since.
  function unqueue(C: Session) {
    if (C !== S) return; // waits on that conversation until you're back in it
    const text = C.queued.splice(0).map((x) => x.text).join('\n');
    buf = buf ? `${text}\n${buf}` : text;
    cur = buf.length;
    anchor = null;
  }

  // The turn loop lives in agent.ts; this is its host for one conversation: the
  // request, storage, permissions and questions, and the screen built from its
  // events (thinking, the reply, the live "writing…" row, tool rows, cost).
  function turnHost(C: Session, m: Model, cn: Conn, c: Controls, ac: AbortController, did: Did, setEsc: (f: () => void) => void): TurnHost {
    const { store, note, drop, addConvRule, detail, event } = bound(C);
    const root = llama.rootOf(cn.base);
    // Per reply: its thinking row, its text row, the live tool-call row.
    let thinking: Extract<Item, { kind: 'think' }> = { kind: 'think', text: '', start: 0, open: false };
    let reply: Extract<Item, { kind: 'reply' }> | null = null;
    let drafting: Extract<Item, { kind: 'lines' }> | null = null;
    let spin: NodeJS.Timeout | undefined;
    let completionId = '', thinkingNow = true, ended = false;
    // Thinking ends when the answer starts (or the stream does): it stays as one
    // "Thought for 6s" line, or goes when the model didn't think out loud.
    const settle = () => {
      clearInterval(spin);
      if (thinking.ms !== undefined) return;
      thinking.ms = Date.now() - thinking.start;
      thinking.note = undefined;
      if (!thinking.text.trim()) drop(thinking);
      schedule();
    };
    // A tool call being written (a long file can take a minute on a local model):
    // one live row with its name, path and size, so the reply doesn't look finished.
    const draft = (name: string, args: string) => {
      settle();
      const field = (k: string) => new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(args)?.[1] ?? new RegExp(`<parameter=${k}>\\s*([^<\\n]+)`).exec(args)?.[1];
      const { verb, rest } = describe({ type: 'tool_use', name, input: { path: field('path') ?? '', command: field('command') ?? '', question: field('question') ?? '' } });
      const size = args.length >= 1000 ? `${(args.length / 1000).toFixed(1)}k characters` : `${args.length} characters`;
      const line: Line = [{ t: '● ', s: st.accent }, { t: verb, s: st.titleB }, { t: field('path') || field('command') || field('question') ? ` ${rest}` : '', s: st.fg }, { t: ` · writing… ${size}`, s: st.dim }];
      if (!drafting) C.items.push((drafting = { kind: 'lines', lines: [line] }));
      else drafting.lines = [line];
      cache.delete(drafting);
      schedule();
    };
    // What a reply cost: the ↳ line, the meter, rime.db, and the cache-safety measure.
    const charge = (usage: Usage | null, seq: number) => {
      if (!usage) return;
      const turn = C.meter.charge(usage, m.price, cn.local);
      addCost(C, turn);
      if (seq) save((d) => d.setUsage(C.convId!, seq, { usage, ...(m.price ? { price: m.price } : {}), ...(cn.local ? { local: true } : {}) }));
      save((d) => d.usage(C.convId!, turn.in + turn.out, turn.spent ?? 0, m.ref));
      if (cn.local && usage.promptMs && usage.input > 500) promptRate = usage.input / (usage.promptMs / 1000);
      // Measured, not assumed: a control change that collapses the cached prefix
      // marks that knob unsafe for this model.
      const prompt = usage.input + usage.cached + usage.written;
      const changed = C.task?.lastControls && (C.task.lastControls.effort !== c.effort || C.task.lastControls.reasoning !== c.reasoning);
      if (C.task && changed && C.task.lastPrompt > 2000 && usage.cached < C.task.lastPrompt * 0.5) {
        unsafe.add(m.ref);
        C.task.controls = { ...C.task.lastControls! };
        note(`Changing effort reset ${m.provider}'s cache, so effort and reasoning stay fixed until /clear.`, 'dim');
      }
      if (C.task) Object.assign(C.task, { lastPrompt: prompt, lastControls: c });
    };
    const done = () => {
      if (reply) {
        reply.done = true;
        if (!reply.text.trim() || !splitToolCalls(reply.text).text.trim()) drop(reply);
      }
      settle();
    };
    const on = (e: AgentEvent) => {
      if (e.type === 'start') {
        // The model and effort go on the timeline when they change.
        const mark = `${m.label} · ${!c.reasoning ? 'reasoning off' : `${c.effort ?? 'default'} effort`}`;
        if (mark !== C.mark) (C.mark = mark), event('model', mark);
        thinking = { kind: 'think', text: '', start: Date.now(), open: showThinking };
        C.items.push(thinking);
        (reply = null), (drafting = null), (completionId = ''), (thinkingNow = true), (ended = false);
        spin = setInterval(schedule, 250);
        // esc while a local model is thinking ends the thinking instead of the reply.
        setEsc(() => {
          if (cn.llamacpp && thinkingNow && completionId && !ended) {
            ended = true;
            llama.endReasoning(root, completionId);
            thinking.note = 'wrapping up (esc again stops)';
          } else ac.abort();
        });
      } else if (e.type === 'id') completionId = e.id;
      else if (e.type === 'thinking') {
        if (thinking.ms === undefined) thinking.text += e.text;
      } else if (e.type === 'text') {
        thinkingNow = false;
        if (!reply) settle(), C.items.push((reply = { kind: 'reply', text: '', done: false }));
        reply.text += e.text;
      } else if (e.type === 'draft') draft(e.name, e.args);
      else if (e.type === 'reply') {
        done();
        charge(e.usage, e.seq);
        if (e.stop === 'refusal') note('The model declined this request. Rephrase it, or /clear to start over.');
        else if (e.stop === 'max_tokens') note('The reply hit the output limit and was cut off.');
      } else if (e.type === 'stopped') done(), charge(e.usage, e.seq), note('stopped', 'dim');
      else if (e.type === 'failed') {
        done();
        const err = e.error;
        note(
          err instanceof ApiError && (err.status === 401 || err.status === 403)
            ? `${cn.name} refused the API key. /setup can replace it.`
            : err instanceof ApiError ? `${cn.name}: ${err.message}`
            : `Couldn't reach ${cn.name} (${new URL(cn.base).host}). ${err.message}`,
        );
        if (cfg.providers[cn.name]?.ssh) conn = undefined; // bring it up again next time
      } else if (e.type === 'end') {
        clearInterval(spin);
        if (drafting) drop(drafting); // the real tool row replaces it
      } else if (e.type === 'denied') C.items.push({ ...toolLine(e.use), extra: [{ t: ` · not run: ${e.why}`, s: st.warn }] } as Item);
      else if (e.type === 'asked') {
        C.items.push(toolLine(e.use));
        detail([[e.answer === null ? { t: 'not answered', s: st.dim } : { t: e.answer, s: st.title }]]);
      } else if (e.type === 'run') C.items.push({ ...toolLine(e.use), ...(e.decision.verdict === 'allow' && e.use.name === 'bash' ? { extra: [{ t: ` · ${e.decision.why}`, s: st.dim }] } : {}) } as Item);
      else if (e.type === 'ran') {
        const input = (e.use.input ?? {}) as Record<string, any>, r = e.result;
        const file = rel(cwd, path.resolve(cwd, String(input.path ?? '')));
        if ((e.use.name === 'write' || e.use.name === 'edit') && !r.error) did.wrote.push(file);
        if (e.use.name === 'bash') did.ran.push({ cmd: String(input.command), ok: !r.error, out: r.output });
        if (e.use.name === 'read' && !r.error) (did.about ??= []).push(file);
        for (const x of toolEvents(String(e.use.name), input, r, file)) event(x.kind, x.text, x.ref);
        // What it did, short: the diff of an edit, the end of a command's output.
        if (r.diff) detail(r.diff.map((x) => [{ t: x.n ? `${String(x.n).padStart(4)} ` : '     ', s: st.dim }, { t: x.sign === ' ' ? x.text : `${x.sign} ${x.text}`, s: x.sign === '+' ? st.ok : x.sign === '-' ? st.del : st.dim }]));
        else if (r.output?.length) {
          const tail = r.output.slice(-6);
          detail([...(r.output.length > 6 ? [[{ t: `… ${r.output.length - 6} more lines`, s: st.dim }]] : []), ...tail.map((l) => [{ t: l, s: st.dim }]), [{ t: r.summary, s: r.error ? st.warn : st.dim }]]);
        } else detail([[{ t: r.summary, s: r.error ? st.warn : st.dim }]]);
      } else if (e.type === 'held') note('Rime asked you something, so it waits for your answer before running that.', 'dim');
      else if (e.type === 'full') note(`This conversation fills ${Math.round((e.used / e.size) * 100)}% of ${m.label}'s context (${fmtT(e.used)} of ${fmtT(e.size)} tokens), so Rime stopped before the next step. Say "continue" to go on anyway, or /clear to start fresh.`);
      schedule();
    };
    return {
      messages: C.messages,
      stream: (signal) => streamFor(cn)({ conn: cn, model: m, system: C.system, tools: TOOLS, messages: C.messages, controls: cn.wire === 'anthropic' ? C.task!.controls : c, signal, slot: cn.llamacpp ? 0 : undefined }),
      store: {
        append: (role, content, interrupted) => save((d) => d.append(bound(C).conversation()!, role, content, interrupted)) ?? 0,
        update: (seq, content, interrupted) => void save((d) => d.update(C.convId!, seq, content, interrupted)),
        remove: (seq) => void save((d) => d.remove(C.convId!, seq)),
      },
      emit: on,
      decide: (u) => {
        const d = decide(String(u.name), (u.input ?? {}) as Record<string, any>, permCtx(C));
        decisions.unshift({ at: Date.now(), tool: String(u.name), what: `${describe(u).verb} ${describe(u).rest}`, verdict: d.verdict, why: d.why });
        decisions.length = Math.min(decisions.length, 50);
        return d;
      },
      approve: async (u, d, signal) => {
        const answer = await ask(u, d, signal, C);
        if (answer === 'stop') return 'stop';
        if (answer === 'no') {
          C.items.push({ kind: 'lines', lines: [[{ t: '✗ ', s: st.del }, { t: 'declined ', s: st.dim }, { t: `${describe(u).verb} ${describe(u).rest}`, s: st.title }, { t: ' · tell Rime what to do instead', s: st.dim }]] });
          schedule();
          // Your next words are the reason; esc (or ctrl+c) stops the whole turn instead.
          const words = await new Promise<string | null>((res) => {
            C.declining = res;
            signal.addEventListener('abort', () => res(null), { once: true });
          });
          C.declining = null;
          return words === null ? 'stop' : { declined: words };
        }
        if (answer === 'always') {
          const edits = u.name === 'write' || u.name === 'edit';
          if (edits || d.rule) {
            for (const r of edits ? ['edit(**)'] : (d.rules ?? [d.rule!])) addConvRule('allow', r);
            C.items.push({ kind: 'lines', lines: [[{ t: '⚙ ', s: st.accent }, { t: `allowed ${edits ? 'edits' : `${d.label} commands`} in this conversation · /permissions`, s: st.dim }]] });
          }
        }
        return 'yes';
      },
      question: (q, options, signal) =>
        new Promise<string | null>((res) => {
          const finish = (v: string | null) => {
            signal.removeEventListener('abort', stop);
            C.question = null;
            schedule();
            res(v);
          };
          const stop = () => finish(null);
          signal.addEventListener('abort', stop, { once: true });
          C.question = { q, options, sel: 0, tool: true, done: finish };
          schedule();
        }),
      // Auto mode's unasked commands run in the sandbox; read-only ones get git
      // hardened. Asked-and-approved commands run as you approved them.
      run: async (u, d, signal) => runTool(String(u.name), (u.input ?? {}) as Record<string, any>, signal, C, { project, sandbox: mode === 'auto' && d.verdict === 'allow', readOnly: !!d.parts?.length && d.parts.every((p) => p.why === 'read-only'), passEnv: cfg.passEnv }),
      optionsOf,
      queued: () => takeQueued(C),
      context: () => {
        const size = m.context ?? cfg.providers[m.provider]?.probe?.ctx;
        return size ? { used: C.task?.lastPrompt ?? 0, size } : null;
      },
      planNote: () => (mode === 'plan' ? ' Rime is in plan mode (read-only): answer with a plan instead. The user switches modes with shift+tab.' : ''),
      setLive: (l) => void (C.live = l),
      setLastUser: (seq) => void (C.lastUserSeq = seq),
    };
  }

  // A reply that ended with "(a) … (b) … which one?": the picker, where a pick
  // is sent as your next message.
  function offerChoices(reply: string, C: Session) {
    const ch = choicesOf(reply);
    if (!ch) return;
    C.nextStep = '';
    C.question = {
      q: ch.question, options: ch.options, sel: 0, tool: false,
      done: (a) => {
        C.question = null;
        if (a) void send(a, false, a, C);
        schedule();
      },
    };
  }

  // One ↳ line per turn (SPEC: transcript order): each request of the turn adds to
  // it and moves it below the turn's latest text and tool rows.
  function addCost(C: Session, turn: Turn) {
    const prev = C.costItem?.kind === 'cost' ? C.costItem.turn : null;
    if (C.costItem) bound(C).drop(C.costItem);
    C.costItem = { kind: 'cost', turn: prev ? addTurns(prev, turn) : turn };
    C.items.push(C.costItem);
  }

  // A saved message as you sent it: attachments as chips, not their contents.
  const userItem = (blocks: Block[]): Item => {
    const labels: Record<string, string> = {};
    // Rime's own notes to the model ([Rime: plan mode is on…]) aren't yours.
    const text = fromBlocks(blocks.filter((b) => !(b.type === 'text' && String(b.text).startsWith('[Rime: '))), (c) => {
      const ch = chipChar(chipSeq++);
      chips.set(ch, c);
      labels[ch] = label(c);
      return ch;
    });
    return { kind: 'user', text, ...(Object.keys(labels).length ? { chips: labels } : {}) };
  };

  // ---- tools (Phase 4) and permissions (SPEC §17) ----

  // The project's .rime/permissions.json: its allow rules count once you trusted
  // this exact file (a cloned repo can't grant itself commands). Asked when Rime
  // opens the project and again before a message if the file changed.
  const projRules = () => trustedProjectRules(project, cfg.trustedRules?.[project]);
  function trustRules() {
    cfg.trustedRules = { ...cfg.trustedRules, [project]: rulesHash(project) };
    settings.save();
  }
  function askTrust() {
    const allow = projectRules(project).allow ?? [];
    if (!allow.length || cfg.trustedRules?.[project] === rulesHash(project) || S.question) return;
    S.question = {
      q: `This project's .rime/permissions.json lets these run without asking: ${allow.join(', ')}. Trust them?`,
      options: [{ label: 'Trust them', detail: 'until the file changes' }, { label: 'Not now', detail: 'they stay off; its deny and ask rules still count' }],
      sel: 1, tool: false,
      done: (a) => {
        S.question = null;
        if (a === 'Trust them') trustRules(), note('trusted this project\'s permission rules · /permissions lists them', 'dim');
        schedule();
      },
    };
    schedule();
  }

  // The rules of the conversation the tools run for, and the paths dropped into it.
  const permCtx = (C: Session) => {
    const dropped = C.items.flatMap((it) => (it.kind === 'user' ? [...it.text].filter(isChip).map((ch) => chips.get(ch)?.path ?? '') : [])).filter(Boolean);
    return { mode, project, rules: ruleList(cfg.permissions, projRules(), C.convRules), granted: (p: string) => dropped.some((d) => p === d || p.startsWith(d + path.sep)) };
  };
  const describe = (u: Block) => {
    const i = (u.input ?? {}) as Record<string, any>;
    const verb = { read: 'Read', write: 'Write', edit: 'Edit', bash: 'Bash', rime: 'Rime', ask: 'Asked' }[String(u.name)] ?? String(u.name);
    const rest = u.name === 'bash' ? String(i.command ?? '').split('\n')[0] : u.name === 'ask' ? String(i.question ?? '') : u.name === 'rime' ? `${i.action ?? ''}${i.args ? ' ' + JSON.stringify(i.args) : ''}` : rel(cwd, path.resolve(cwd, String(i.path ?? '')));
    return { verb, rest };
  };
  const toolLine = (u: Block): Item => ({ kind: 'tool', ...describe(u) });
  const detail = (lines: Line[]) => bound(S).detail(lines);

  function runTool(name: string, input: Record<string, any>, signal: AbortSignal, C: Session, as: RunAs = {}): ToolResult | Promise<ToolResult> {
    const { conversation, store, note, drop, addConvRule, detail } = bound(C);
    if (name === 'read') return readTool(cwd, input as { path: string });
    if (name === 'write') return writeTool(cwd, input as { path: string; content: string });
    if (name === 'edit') return editTool(cwd, input as { path: string; old: string; new: string });
    if (name === 'bash') return bashTool(cwd, input as { command: string }, signal, as);
    if (name === 'rime') {
      return Promise.resolve(rimeTool(String(input.action ?? ''), (input.args ?? {}) as Record<string, any>, C, signal)).then((text) => ({ content: text, summary: text.split('\n')[0] }));
    }
    return { content: `Unknown tool ${name}.`, error: true, summary: 'unknown tool' };
  }

  // The rime tool (SPEC §15): Rime acting on itself. It never reads or writes API
  // keys, and it can't change permission modes or rules (it opens /permissions).
  function rimeTool(action: string, args: Record<string, any>, C: Session = S, signal?: AbortSignal): string | Promise<string> {
    const { conversation, store, note, drop, addConvRule, detail } = bound(C);
    const ACTIONS = 'help · settings.list · settings.get {key} · settings.set {key, value} · command {name: /model | /server | /setup | /settings | /permissions | /usage} · tab.open · tab.close · tab.focus · panel.show · panel.hide · panel.split';
    if (action === 'help') return `Actions: ${ACTIONS}\nSettings: ${settings.list().map((d) => `${d.key} (${d.values.join(' | ')}; applies ${WHEN[d.applies]})`).join(', ')}`;
    if (action === 'settings.list') return settings.list().map((d) => `${d.key} = ${d.get(cfg)} · ${d.help} · applies ${WHEN[d.applies]}`).join('\n');
    if (action === 'settings.get') return `${args.key} = ${settings.get(String(args.key)) ?? '(no such setting)'}`;
    if (action === 'settings.set') {
      const d = settings.list().find((x) => x.key === args.key);
      if (!d) return `No setting ${args.key}. settings.list shows them.`;
      if (!d.values.includes(String(args.value))) return `${args.key} takes ${d.values.join(' | ')}.`;
      // Letting a secret reach commands is the user's call alone.
      if (d.key.startsWith('commands.env.')) return 'Only the user can let a secret variable through to commands, in /settings → Commands. Tell them if a command needs it.';
      const apply = () => {
        const ch = settings.set(d.key, String(args.value));
        if (ch) C.items.push({ kind: 'gear', change: ch });
        return ch ? `Done: ${d.label.toLowerCase()} ${ch.to} (was ${ch.from}), ${WHEN[d.applies]}.` : `${d.label.toLowerCase()} was already ${args.value}.`;
      };
      // Stopping or powering off a server asks first (SPEC §15), even as a setting.
      if (/^server\..+\.onQuit$/.test(d.key) && args.value !== 'keep running' && d.get(cfg) !== args.value)
        return new Promise<string>((res) => {
          const done = (v: string | null) => {
            C.question = null;
            schedule();
            res(v === 'Yes' ? apply() : 'The user said no; nothing changed.');
          };
          signal?.addEventListener('abort', () => done(null), { once: true });
          C.question = { q: `Rime wants to set ${d.label.toLowerCase()} to "${args.value}". OK?`, options: [{ label: 'Yes' }, { label: 'No' }], sel: 1, tool: true, done };
          schedule();
        });
      return apply();
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
  function ask(u: Block, d: Decision, signal: AbortSignal, C: Session): Promise<'yes' | 'always' | 'no' | 'stop'> {
    const { conversation, store, note, drop, addConvRule, detail } = bound(C);
    return new Promise((resolve) => {
      const done = (a: 'yes' | 'always' | 'no' | 'stop') => {
        signal.removeEventListener('abort', stop);
        C.approval = null;
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
      } else if (u.name === 'write') diff = textOf(input.content).split('\n').slice(0, 8).map((t, i) => ({ sign: '+' as const, n: i + 1, text: t }));
      C.approval = { use: u, decision: d, sel: 0, done, diff };
      schedule();
    });
  }

  // The question box above the prompt: the question, its options (with a dim
  // line of detail), and that you can also just type an answer.
  function questionBox(width: number) {
    const Q = S.question;
    if (!Q || panel) return null;
    const dim = (t: string) => ({ t, s: st.dim });
    const rows: BoxRow[] = wrap([{ t: Q.q, s: st.titleB }], width - 4).map((line) => ({ line }));
    rows.push({ line: [] });
    Q.options.forEach((o, i) => {
      const on = Q.sel === i;
      const head = wrap([{ t: on ? '› ' : '  ', s: st.accent }, { t: `${i + 1} `, s: st.dim }, { t: o.label, s: on ? st.accentB : st.fg }], width - 4);
      head.forEach((line, k) => rows.push({ line: k ? [{ t: '    ', s: '' }, ...line] : line, bg: on ? st.panelBg : undefined, hit: `q:${i}` }));
      if (o.detail) wrap([dim(o.detail)], width - 8).slice(0, 2).forEach((line) => rows.push({ line: [{ t: '    ', s: '' }, ...line], bg: on ? st.panelBg : undefined, hit: `q:${i}` }));
    });
    rows.push(...footRows(['↑ ↓', ' choose · ', 'enter', ' or ', Q.options.map((_, i) => i + 1).join(' '), ' · or type your own answer · ', 'esc', Q.tool ? ' stop' : ' close'], st));
    return box([{ t: Q.tool ? 'Rime asks' : 'pick one', s: st.accent }], rows, width, st, st.accent, 'key:esc');
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
      ...ruleList(cfg.permissions, projRules(), S.convRules).map((rule): Row => ({ kind: 'rule', rule })),
      { kind: 'add' },
    ];
    const remove = (r: ReturnType<typeof ruleList>[number]) => {
      if (r.from === 'conversation') {
        S.convRules = { ...S.convRules, [r.kind]: (S.convRules[r.kind] ?? []).filter((x) => x !== r.pattern) };
        save((d) => d.setRules(conversation()!, S.convRules));
      } else if (r.from === 'project') removeProjectRule(project, r.kind, r.pattern), trustRules();
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
          } else out.push(listRow(adding ? 'Type the rule below' : '+ Add a rule', adding ? 'e.g. allow bash(npm run build *) · add "for the team" to share it' : 'allow / ask / deny bash(…), edit(…), read(…)', i === pick, st, `pick:${i}`, 22));
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
        // "… for the team" goes to the project's .rime/permissions.json (it can be
        // committed); otherwise the rule is this conversation's.
        const m = /^(allow|ask|deny)\s+((?:bash|edit|read|fetch)\(.+\))(\s+for the team)?$/.exec(v.trim());
        if (!m) return void (error = 'A rule looks like: allow bash(npm test *), ask edit(src/**), deny read(.env), optionally ending "for the team"');
        if (m[3]) addProjectRule(project, m[1] as 'allow', m[2]), trustRules();
        else addConvRule(m[1] as 'allow', m[2]);
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
    const a = S.approval!;
    const again = a.use.name === 'bash' ? !!a.decision.rule : (a.use.name === 'write' || a.use.name === 'edit') && !/always asks/.test(a.decision.why);
    return again ? [0, 1, 2] : [0, 2];
  }
  // `o`: the option (0 yes, 1 don't ask again, 2 no). On screen they're numbered
  // 1, 2, 3 in the order shown, so with two options "No" is 2.
  function answer(o: number) {
    if (!S.approval || !approvalOptions().includes(o)) return;
    S.approval.done(o === 0 ? 'yes' : o === 1 ? 'always' : 'no');
  }
  function cycleMode() {
    setMode(mode === 'auto' || mode === 'god' ? 'ask' : MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
  }

  // The question above the prompt: the exact command (or the change), where it
  // runs, why it asks, and the three answers.
  function approvalBox(width: number) {
    if (!S.approval) return null;
    const { use: u, decision: d, diff } = S.approval;
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
    const opts = approvalOptions();
    opts.forEach((n, i) => {
      const on = S.approval!.sel === n;
      rows.push({ line: [{ t: on ? '› ' : '  ', s: st.accent }, { t: `${i + 1} `, s: st.dim }, { t: labels[n], s: on ? st.accent : st.fg }], bg: on ? st.panelBg : undefined, hit: `dec:${n}`, hang: 4 });
    });
    rows.push(...footRows(['↑ ↓', ' choose · ', 'enter', ' or ', opts.map((_, i) => i + 1).join(' '), ' · ', 'esc', ' no · ', 'shift+tab', ' mode'], st));
    return box([{ t: title, s: st.warn }, dim(` · ${MODE_HELP[mode]}`)], rows, width, st, st.warn, 'key:ctrl+c');
  }

  // Starts a new conversation; the current one stays in the list.
  // Puts another conversation on screen. One that's still working (or waiting
  // for you) keeps going in the background; an idle one is put away (it's saved).
  function show(x: Session) {
    if (x === S) return;
    if (!S.busy && !needsYou(S) && !S.waiting && !S.queued.length) {
      sessions.splice(sessions.indexOf(S), 1);
      if (S.convId) save((d) => d.unlock(S.convId!));
    }
    if (!sessions.includes(x)) sessions.push(x);
    S = x;
    scrollOff = 0;
    browsing = null;
    blindAsk = false;
    if (!x.busy && x.queued.length) unqueue(x);
    schedule();
  }

  // Starts a new conversation; the one you were in stays in the list (and keeps
  // working if it was).
  function newConversation() {
    show(newSession());
    example = exampleFor(project);
  }

  // ---- the conversations window (SPEC §16) ----
  // ← on an empty prompt (or /conversations, or a click on "← conversations")
  // fills the screen with your conversations: a dot on the ones working (blue,
  // pulsing), waiting for you (yellow) or open in another Rime window (dim), and
  // the highlighted one's timeline. Typing searches (describe it, src/core/rank.ts),
  // so the actions are ctrl keys that work while you type: ctrl+r rename, ctrl+d
  // delete (asks; ctrl+u undoes it for 10 s), ctrl+p keep on top, ctrl+f fork,
  // ctrl+e export, ctrl+s sort. With the search empty, space selects, n starts a
  // new conversation and a shows all projects.
  type ListRow = { id: number | null; title: string; project: string; updated: number; created: number; model: string | null; n: number; tokens: number; pinned: boolean; last: string | null; other: boolean; session?: Session };
  // `on`: the highlighted conversation, so the highlight stays on it when the list reorders.
  // `edit`: the new title being typed (`fresh`: still the old one, selected, so
  // typing replaces it); `confirm`: the conversations about to be deleted;
  // `why`: why each search result matched; `picked`: rows selected with space.
  let list: {
    pick: number; on: number | Session | null; filter: string; all: boolean; rows: ListRow[]; at: number; sort: number; picked: Set<number>;
    found?: { q: string; at: number; ids: number[]; why: Map<number, { reason: string; hits: number[] }> }; edit?: string; fresh?: boolean; confirm?: ListRow[];
  } | null = null;
  // Deleted, but `u` brings them back for 10 s; then they're gone for good.
  let undoDelete: { rows: ListRow[]; left: number; t: NodeJS.Timeout } | null = null;
  const SORTS = ['last used', 'created', 'title', 'size'];
  const keyOf = (r: ListRow) => r.id ?? r.session ?? null;
  const previews = new Map<number, { at: number; items: Item[]; cost: string }>();
  const timelines = new Map<number, { at: number; entries: { kind: string; text: string; at: number }[] }>();
  const timelineOf = (id: number, updated: number) => {
    const c = timelines.get(id);
    if (c && c.at === updated) return c.entries;
    const entries = save((d) => d.timeline(id)) ?? [];
    timelines.set(id, { at: updated, entries });
    return entries;
  };

  function openList() {
    list = { pick: 0, on: S.convId ?? S, filter: '', all: false, rows: [], at: 0, sort: 0, picked: new Set() };
    listRows();
    schedule();
  }

  function listRows(): ListRow[] {
    const L = list!;
    if (Date.now() - L.at > 1000) {
      const stored = save((d) => d.list(L.all ? null : project)) ?? [];
      const rows: ListRow[] = stored
        .filter((c) => c.n > 0)
        .map((c) => ({ id: c.id, title: c.title || 'untitled', project: c.project, updated: c.updated, created: c.created, model: c.model, n: c.n, tokens: c.tokens, pinned: !!c.pinned, last: c.last, other: c.other, session: sessions.find((x) => x.convId === c.id) }));
      // Open here but not saved yet (nothing sent): the new conversation you're in.
      for (const x of sessions) if (x.convId === null && x === S) rows.unshift({ id: null, title: 'New conversation', project, updated: Date.now(), created: Date.now(), model: model?.ref ?? null, n: 0, tokens: 0, pinned: false, last: null, other: false, session: x });
      L.rows = rows;
      L.at = Date.now();
    }
    const gone = new Set(undoDelete?.rows.map((r) => r.id));
    const rows = L.rows.filter((r) => !gone.has(r.id));
    const f = L.filter.trim().toLowerCase();
    let shown: ListRow[];
    if (f) {
      // Search (SPEC §16): describe it in plain JS, message text from FTS5.
      if (L.found?.q !== f || L.found.at !== L.at) {
        const Q = parseQuery(f);
        const scope = L.all ? null : project;
        const convs = rows.filter((r) => r.id !== null).map((r) => ({ id: r.id!, title: r.title, updated: r.updated, model: r.model, timeline: timelineOf(r.id!, r.updated) }));
        const ranked = rank(Q, convs, (w) => new Set((save((d) => d.search(scope, w)) ?? []).map((x) => x.id)));
        L.found = { q: f, at: L.at, ids: ranked.map((x) => x.id), why: new Map(ranked.map((x) => [x.id, x])) };
      }
      const byId = new Map(rows.map((r) => [r.id, r]));
      shown = [...rows.filter((r) => r.id === null && r.title.toLowerCase().includes(f)), ...L.found.ids.flatMap((id) => byId.get(id) ?? [])];
    } else {
      const key = [(r: ListRow) => -r.updated, (r: ListRow) => -r.created, (r: ListRow) => r.title.toLowerCase(), (r: ListRow) => -r.tokens][L.sort];
      shown = [...rows].sort((a, b) => (a.id === null ? -1 : b.id === null ? 1 : +b.pinned - +a.pinned || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)));
    }
    const at = shown.findIndex((r) => keyOf(r) === L.on);
    L.pick = at >= 0 ? at : Math.min(L.pick, Math.max(0, shown.length - 1));
    L.on = shown[L.pick] ? keyOf(shown[L.pick]) : null;
    return shown;
  }

  // The highlighted conversation as it would look: its own transcript when it's
  // open here (live, also while it works), else rebuilt from what was saved.
  function previewItems(r: ListRow): Item[] {
    if (r.session) return r.session.items.filter((it) => it !== headerItem);
    if (r.id === null) return [];
    const cached = previews.get(r.id);
    if (cached && cached.at === r.updated) return cached.items;
    const items: Item[] = [];
    const stored = save((d) => d.messages(r.id!)) ?? [];
    for (const m of stored) {
      const blocks: Block[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text)).join('');
      if (m.role === 'user' && text) items.push(userItem(blocks));
      else if (m.role === 'assistant') {
        if (splitToolCalls(text).text.trim()) items.push({ kind: 'reply', text, done: true });
        for (const u of blocks.filter((b) => b.type === 'tool_use')) items.push(toolLine(u));
      }
    }
    previews.set(r.id, { at: r.updated, items, cost: resumeCost(stored) });
    return items;
  }

  const dayOf = (t: number) => {
    const day = 86400000, start = new Date().setHours(0, 0, 0, 0);
    return t >= start ? 'Today' : t >= start - day ? 'Yesterday' : t >= start - 6 * day ? 'This week' : 'Older';
  };
  // A timeline entry's mark.
  const KIND: Record<string, string> = { edit: '±', test: '▸', command: '▸', error: '✗', commit: '⎇', pin: '◆', server: '●', model: '◇', attach: '+' };
  const markOf = (kind: string) => KIND[kind] ?? '·';
  const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);

  // The dot before a conversation's title.
  function dotOf(r: ListRow): Line[number] {
    const x = r.session;
    if (x && needsYou(x)) return { t: '● ', s: st.warn };
    if (x?.busy || x?.waiting) return { t: Math.floor(Date.now() / 500) % 2 ? '● ' : '◉ ', s: st.accentB };
    if (r.other) return { t: '● ', s: st.dim };
    return { t: '  ', s: '' };
  }

  // What the search field suggests for its last word (tab takes the first).
  function listSuggestions() {
    const L = list!;
    if (!L.filter.trim() || L.edit !== undefined) return [];
    const convs = L.rows.filter((r) => r.id !== null).map((r) => ({ id: r.id!, title: r.title, updated: r.updated, model: r.model, timeline: timelineOf(r.id!, r.updated) }));
    return suggestions(L.filter, convs);
  }
  function takeSuggestion(s: string) {
    const L = list!;
    L.filter = L.filter.replace(/\S*$/, s) + (s.endsWith(':') ? '' : ' ');
  }

  function frameList(width: number, height: number) {
    const L = list!;
    const rows = listRows();
    L.pick = Math.max(0, Math.min(L.pick, rows.length - 1));
    const dim = (t: string) => ({ t, s: st.dim });
    const wide = width >= 100;
    const lw = wide ? Math.floor(width * 0.48) : width;
    const pw = wide ? width - lw - 3 : width - 2;
    const searching = !!L.filter.trim();
    const sugg = listSuggestions();
    const suggHits: { x0: number; x1: number; id: string }[] = [];
    const suggLine: Line = [{ t: '   ', s: '' }];
    if (sugg.length) {
      suggLine.push({ t: 'tab ', s: st.accentB });
      sugg.forEach((x, i) => {
        const x0 = lineWidth(suggLine) + 1;
        suggLine.push({ t: x, s: i ? st.dim : st.accent });
        suggHits.push({ x0, x1: x0 + strWidth(x) - 1, id: `sugg:${i}` });
        suggLine.push({ t: '  ', s: '' });
      });
    }
    const top: Line[] = [
      [
        { t: ' conversations', s: st.titleB },
        // What just happened (renamed, deleted, why not), in place of the project
        // for a moment, since the status line is hidden here.
        ...(flash ? (flash.text.startsWith('✓') ? [{ t: ' · ✓', s: st.ok }, dim(flash.text.slice(1))] : [{ t: ` · ${flash.text}`, s: st.warn }]) : [dim(`${L.all ? ' · all projects' : ` · ${tildify(project)}`} · ${searching ? 'searching' : SORTS[L.sort]}`)]),
      ],
      [{ t: ' › ', s: st.accentB }, L.filter ? { t: L.filter, s: st.title } : { t: 'search, or describe the conversation', s: st.placeholder }],
      ...(sugg.length ? [suggLine] : []),
      [{ t: '─'.repeat(width), s: st.line }],
    ];
    // The footer's keys are clickable, like every footer (SPEC §5.1).
    const sel = rows[L.pick];
    const confirm = L.confirm ?? [];
    const parts: [string, string, string?][] =
      L.edit !== undefined ? [['enter', ' save · '], ['esc', ' cancel'], ['', '   type the new title']]
      : confirm.length ? [['', `delete ${confirm.length > 1 ? `${confirm.length} conversations` : `"${confirm[0].title}"`}? Its messages and timeline go too. `, 'warn'], ['enter', ' delete · '], ['esc', ' keep it']]
      : undoDelete ? [['', `deleted ${undoDelete.rows.length > 1 ? `${undoDelete.rows.length} conversations` : `"${undoDelete.rows[0].title}"`} · `, 'warn'], ['ctrl+u', ` undo (${undoDelete.left} s) · `], ['↑ ↓', ' choose · '], ['enter', ' open · '], ['esc', ' back']]
      : searching ? [['↑ ↓', ' choose · '], ['→', ' or '], ['enter', ' open · '], ...(sugg.length ? [['tab', ' suggestion · '] as [string, string]] : []), ['ctrl+r', ' rename · '], ['ctrl+d', ' delete · '], ['esc', ' clear']]
      : [['↑ ↓', ' choose · '], ['→', ' or '], ['enter', ' open · '], ['ctrl+r', ' rename · '], ['ctrl+d', ' delete · '], ['ctrl+p', sel?.pinned ? ' unpin · ' : ' keep on top · '], ['ctrl+f', ' fork · '], ['ctrl+e', ' export · '], ['ctrl+s', ' sort · '], ['space', ' select · '], ['n', ' new · '], ['a', L.all ? ' this project · ' : ' all projects · '], ['esc', ' back']];
    // Keys wrap onto more lines when narrow, never cut off; the dot legend comes
    // last and only when it fits on the last line.
    const fh = hintLines(parts.map(([k, label, tone]): Hint => [k, label, tone === 'warn' ? st.warn : undefined]), width - 2, st);
    const legend: Line = [dim(' · '), { t: '● ', s: st.accentB }, dim('working '), { t: '● ', s: st.warn }, dim('needs you '), { t: '● ', s: st.dim }, dim('another window')];
    if (L.edit === undefined && !confirm.length && lineWidth(fh.lines.at(-1)!) + lineWidth(legend) <= width - 2) fh.lines.at(-1)!.push(...legend);
    const foot: Line[] = [[{ t: '─'.repeat(width), s: st.line }], ...fh.lines.map((l): Line => [{ t: ' ', s: '' }, ...l])];
    const bodyH = Math.max(1, height - top.length - foot.length);
    // Narrow: the preview goes under the list.
    const listH = wide ? bodyH : Math.max(3, Math.ceil(bodyH * 0.55));
    const pvH = wide ? bodyH : Math.max(0, bodyH - listH - 1);
    // The list, grouped by day (kept-on-top first), scrolled to keep the highlight in view.
    const left: { line: Line; i?: number }[] = [];
    let g = '';
    rows.forEach((r, i) => {
      const group = searching ? '' : r.pinned ? 'Kept on top' : L.sort === 0 ? dayOf(r.updated) : '';
      if (group && group !== g) left.push({ line: [dim(` ${(g = group)}`)] });
      const on = i === L.pick;
      const why = r.id !== null ? L.found?.why.get(r.id) : undefined;
      const when = ago(r.updated);
      const meta: Line = searching && why
        ? [{ t: why.reason, s: st.accent }]
        : [dim([L.all && r.project !== project ? tildify(r.project) : '', r.model?.split('/').pop(), r.tokens ? `${fmtK(r.tokens)} tokens` : '', r.last ? `${markOf(timelineOf(r.id!, r.updated).at(-1)?.kind ?? '')} ${r.last}` : ''].filter(Boolean).join(' · '))];
      const tw = Math.max(8, Math.min(strWidth(r.title) + 1, lw - 4 - when.length - 2 - 12));
      const title =
        on && L.edit !== undefined ? [{ t: L.edit.slice(-(tw - 1)), s: L.fresh ? st.selection : st.title }, { t: '▏', s: st.accent }]
        : fit([{ t: r.title, s: on && confirm.includes(r) ? st.del : on ? st.accentB : r.session === S ? st.titleB : st.title }], tw);
      const mark = r.id !== null && L.picked.has(r.id) ? { t: '✓', s: st.ok } : { t: on ? '›' : ' ', s: st.accent };
      const head: Line = [mark, dotOf(r), ...title, { t: ' ', s: '' }, dim(when), { t: '  ', s: '' }];
      left.push({ line: [...head, ...fit(meta, Math.max(0, lw - lineWidth(head)))], i });
    });
    if (!rows.length) left.push({ line: [dim(L.filter ? ' No conversation matches. Try fewer words, or a file name.' : ' No conversations yet. n starts one.')] });
    const selAt = left.findIndex((l) => l.i === L.pick);
    const from = Math.max(0, Math.min(selAt - Math.floor(listH / 2), left.length - listH));
    const shown = left.slice(from, from + listH);
    // The preview: the highlighted conversation's timeline, then its last lines.
    const r = rows[L.pick];
    let right: string[] = [];
    if (r && pvH > 0) {
      const state: Line = r.session && needsYou(r.session) ? [{ t: '● waiting for you', s: st.warn }] : r.session?.busy ? [{ t: '● working', s: st.accentB }] : r.other ? [dim('open in another Rime window')] : [];
      const head = [
        str([{ t: r.title, s: st.titleB }], st),
        str([dim([tildify(r.project), r.model?.split('/').pop() ?? '', r.tokens ? `${fmtK(r.tokens)} tokens` : '', `started ${ago(r.created)}`, r.id !== null && !r.session ? (previewItems(r), previews.get(r.id)?.cost) : ''].filter(Boolean).join(' · ')), ...(state.length ? [dim(' · '), ...state] : [])], st),
        '',
      ];
      const hits = new Set(r.id !== null ? (L.found?.why.get(r.id)?.hits ?? []) : []);
      const tl = r.id !== null ? timelineOf(r.id, r.updated) : [];
      const tlRows = tl.map((e, k) => str(fit([dim(`${hhmm(e.at)} `), { t: `${markOf(e.kind)} `, s: e.kind === 'error' ? st.warn : e.kind === 'pin' ? st.warn : st.accent }, { t: e.text, s: hits.has(k) ? st.accentB : st.fg }], pw), st));
      const shownTl = tlRows.slice(-Math.max(0, Math.min(tlRows.length, Math.floor((pvH - head.length) / 2))));
      const body = previewItems(r).flatMap((it, k, all) => [...(spaced(all[k - 1], it) ? [''] : []), ...render(it, pw)]);
      const rest = pvH - head.length - shownTl.length - (shownTl.length ? 1 : 0);
      right = [...head, ...shownTl, ...(shownTl.length ? [str([dim('─'.repeat(Math.min(pw, 24)))], st)] : []), ...body.slice(-Math.max(0, rest))];
      if (!wide) right = right.slice(0, pvH);
    }
    const lines: string[] = [];
    const rowHits: { row: number; x0: number; x1: number; id: string }[] = [];
    for (const l of top) lines.push(str(fit(l, width), st));
    if (sugg.length) rowHits.push(...suggHits.filter((h) => h.x1 <= width).map((h) => ({ ...h, row: 3 })));
    for (let k = 0; k < listH; k++) {
      const l = shown[k];
      lines.push(str(fit(l?.line ?? [], lw), st) + (wide ? str([{ t: ' │ ', s: st.line }], st) + truncAnsi(right[k] ?? '', pw) : ''));
      if (l?.i !== undefined) rowHits.push({ row: top.length + k + 1, x0: 1, x1: lw, id: `conv:${l.i}` });
    }
    if (!wide && pvH > 0) {
      lines.push(str([{ t: '─'.repeat(width), s: st.line }], st));
      for (let k = 0; k < pvH; k++) lines.push(' ' + truncAnsi(right[k] ?? '', pw));
    }
    for (const l of foot) lines.push(str(fit(l, width), st));
    fh.segs.forEach((segs, i) => rowHits.push(...segs.map((h) => ({ x0: h.x0 + 1, x1: h.x1 + 1, id: h.id, row: lines.length - fh.lines.length + i + 1 }))));
    return { lines, rowHits };
  }

  function listKey(k: Key) {
    const L = list!;
    const rows = listRows();
    const r = rows[L.pick];
    // Typing a new title: enter saves it, esc leaves it as it was.
    if (L.edit !== undefined) {
      if (k.name === 'escape' || (k.ctrl && k.name === 'c')) return void (L.edit = undefined);
      if (k.name === 'enter') return renameRow(r, L.edit);
      const fresh = L.fresh;
      L.fresh = false;
      if (k.name === 'backspace' || (k.ctrl && k.name === 'w')) {
        if (fresh) return void (L.edit = '');
        return void (L.edit = k.alt || k.ctrl ? L.edit.replace(/\S*\s*$/, '') : [...L.edit].slice(0, -1).join(''));
      }
      if (k.ctrl && k.name === 'u') return void (L.edit = '');
      if ((k.name === 'char' && k.ch && !k.ctrl) || k.name === 'space') return void (L.edit = (fresh ? '' : L.edit) + (k.ch ?? ' '));
      return;
    }
    // Deleting asks first: enter deletes, anything else keeps them.
    if (L.confirm) {
      const gone = L.confirm;
      L.confirm = undefined;
      if (k.name === 'enter') deleteRows(gone);
      return;
    }
    if (k.name === 'escape' || (k.ctrl && k.name === 'c')) {
      if (L.filter && k.name === 'escape') return void (L.filter = '');
      if (L.picked.size && k.name === 'escape') return void L.picked.clear();
      return void (list = null);
    }
    if (k.ctrl && k.name === 'r' && r) {
      if (r.id === null) return say('send a message first; then it can have a name');
      return void ((L.edit = r.title === 'untitled' ? '' : r.title), (L.fresh = true));
    }
    if (k.ctrl && k.name === 'd' && r) {
      const many = L.picked.size ? rows.filter((x) => x.id !== null && L.picked.has(x.id)) : [r];
      if (many.some((x) => x.id === null)) return say("nothing to delete: it isn't saved until you send something");
      if (many.some((x) => x.other)) return say("it's open in another Rime window; close it there first");
      if (many.some((x) => x.session && (x.session.busy || x.session.waiting || x.session.approval))) return say("it's still working; stop it first");
      return void (L.confirm = many);
    }
    const go = (i: number) => {
      L.pick = Math.max(0, Math.min(rows.length - 1, i));
      L.on = rows[L.pick] ? keyOf(rows[L.pick]) : null;
    };
    if (k.name === 'up') return go(L.pick - 1);
    if (k.name === 'down') return go(L.pick + 1);
    // ← opened the list; → (or enter) opens the conversation it's on.
    if (k.name === 'enter' || k.name === 'right') return openRow(rows[L.pick]);
    if (k.name === 'tab' && !k.shift) {
      const s = listSuggestions()[0];
      return void (s && takeSuggestion(s));
    }
    if (k.name === 'backspace') return void (L.filter = L.filter.slice(0, -1));
    if (k.ctrl && k.name === 'u') return void (undoDelete ? undoDeleteNow() : (L.filter = ''));
    if (k.ctrl && k.name === 's') return void (L.sort = (L.sort + 1) % SORTS.length);
    if (k.ctrl && k.name === 'p' && r?.id != null) {
      save((d) => d.pin(r.id!, !r.pinned));
      L.at = 0;
      return say(r.pinned ? '✓ back in date order' : '✓ kept on top');
    }
    if (k.ctrl && k.name === 'f' && r?.id != null) {
      const id = save((d) => d.fork(r.id!));
      if (!id) return;
      L.at = 0;
      L.on = id;
      return say('✓ forked: the copy has the same messages, ready to try another direction');
    }
    if (k.ctrl && k.name === 'e' && r) return exportRows(L.picked.size ? rows.filter((x) => x.id !== null && L.picked.has(x.id)) : [r]);
    // With the search empty, a few keys act instead of typing (no search starts with them).
    if (!L.filter) {
      if (k.name === 'char' && k.ch === 'n' && !k.ctrl) return void ((list = null), newConversation());
      if (k.name === 'char' && k.ch === 'a' && !k.ctrl) return void ((L.all = !L.all), (L.at = 0));
      if (k.name === 'space') return void (r?.id != null && (L.picked.has(r.id) ? L.picked.delete(r.id) : L.picked.add(r.id), go(L.pick + 1)));
    }
    if ((k.name === 'char' && k.ch && !k.ctrl) || k.name === 'space') return void (L.filter += k.ch ?? ' ');
  }

  function renameRow(r: ListRow | undefined, title: string) {
    list!.edit = undefined;
    const t = title.replace(/\s+/g, ' ').trim();
    if (!r || r.id === null || !t || t === r.title) return;
    save((d) => d.rename(r.id!, t));
    r.title = t;
    if (r.session?.continuing) r.session.continuing.title = t;
    if (S.continuing && S.convId === r.id) S.continuing.title = t;
    list!.at = 0;
    say(`✓ renamed to "${t}"`);
  }

  // Deleted rows leave the list at once; the database forgets them after 10 s
  // unless `u` brings them back (or at once when Rime quits).
  function deleteRows(rows: ListRow[]) {
    if (undoDelete) finishDelete();
    for (const r of rows) {
      const x = r.session;
      if (!x) continue;
      sessions.splice(sessions.indexOf(x), 1);
      if (x.convId) save((d) => d.unlock(x.convId!));
      if (x === S) show(newSession()); // you were in it: a fresh one takes its place
      r.session = undefined;
    }
    list?.picked.clear();
    const t = setInterval(() => {
      if (!undoDelete || --undoDelete.left > 0) return schedule();
      finishDelete();
      schedule();
    }, 1000);
    undoDelete = { rows, left: 10, t };
  }
  function finishDelete() {
    if (!undoDelete) return;
    clearInterval(undoDelete.t);
    for (const r of undoDelete.rows) {
      save((d) => d.delete(r.id!));
      previews.delete(r.id!);
      timelines.delete(r.id!);
    }
    undoDelete = null;
    if (list) list.at = 0;
  }
  function undoDeleteNow() {
    if (!undoDelete) return;
    clearInterval(undoDelete.t);
    const n = undoDelete.rows.length;
    undoDelete = null;
    if (list) list.at = 0;
    say(`✓ ${n > 1 ? `${n} conversations are` : 'it is'} back`);
  }

  // e: a conversation as Markdown, saved in the project folder.
  function exportRows(rows: ListRow[]) {
    const out: string[] = [];
    for (const r of rows) {
      if (r.id === null) continue;
      const md = [`# ${r.title}`, '', `_${[r.model, new Date(r.updated).toISOString().slice(0, 10), 'exported from Rime'].filter(Boolean).join(' · ')}_`, ''];
      for (const m of save((d) => d.messages(r.id!)) ?? []) {
        const blocks: Block[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
        const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text)).join('\n').trim();
        const tools = blocks.filter((b) => b.type === 'tool_use').map((u) => `> ${describe(u).verb} ${describe(u).rest}`);
        if (m.role === 'user' && text) md.push('## You', '', text, '');
        else if (m.role === 'assistant' && (text || tools.length)) md.push('## Rime', '', ...(text ? [splitToolCalls(text).text.trim(), ''] : []), ...(tools.length ? [...tools, ''] : []));
      }
      const slug = r.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'conversation';
      let file = path.join(r.project, `${slug}.md`);
      for (let i = 2; fs.existsSync(file); i++) file = path.join(r.project, `${slug}-${i}.md`);
      try {
        fs.writeFileSync(file, md.join('\n'));
        out.push(rel(cwd, file));
      } catch (e) {
        return say(`can't export: ${(e as Error).message}`);
      }
    }
    list?.picked.clear();
    say(`✓ exported to ${out.join(', ')}`);
  }

  function openRow(r?: ListRow) {
    if (!r) return;
    if (r.project !== project) return void note(`That conversation belongs to ${tildify(r.project)}. Run rime there to open it.`, 'dim'), (list = null);
    list = null;
    if (r.session) return show(r.session); // open here, maybe still working
    if (r.id === null) return;
    const c = save((d) => d.take(r.id!));
    if (!c) return void note('That conversation is open in another Rime window.', 'dim');
    const x = newSession();
    show(x);
    reopen(c, x);
  }

  function setMode(m: Mode) {
    mode = m;
    say(`permission mode: ${MODE_HELP[m]}`);
    // Without a sandbox, auto's guard list is a speed bump, not a boundary: say so.
    if (m === 'auto' && !sandboxed('true', project)) note("This computer has no sandbox for auto mode (on Linux, install bubblewrap), so commands that run without asking aren't contained. The always-ask list catches common mistakes, not a determined model.");
    schedule();
  }



  // ---- panels ----

  const host: Host & Parameters<typeof createServer>[0] & Parameters<typeof createModelPicker>[0] & Parameters<typeof createSettingsPanel>[0] = {
    st,
    cfg,
    get system() {
      return S.system;
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
      S.items.push(it);
      schedule();
    },
    save: () => settings.save(),
    settings,
    openModel: () => host.open(createModelPicker(host)),
    openConnect: () => host.open(createSetup(host)),
    // Renames a connection (e.g. your server) everywhere Rime uses its name.
    rename: (from, to) => {
      if (!/^[\w.-]{1,32}$/.test(to)) return 'Use letters, digits, - _ or . (no spaces or slashes).';
      if (cfg.providers[to]) return `${to} is already the name of another connection.`;
      if (!cfg.providers[from]) return `${from} isn't connected.`;
      const fix = (ref?: string) => (ref?.startsWith(from + '/') ? to + ref.slice(from.length) : ref);
      cfg.providers[to] = cfg.providers[from];
      delete cfg.providers[from];
      cfg.model = fix(cfg.model);
      for (const k of Object.keys(cfg.models)) if (k.startsWith(from + '/')) (cfg.models[fix(k)!] = cfg.models[k]), delete cfg.models[k];
      if (tunnels[from]) (tunnels[to] = tunnels[from]), delete tunnels[from];
      if (bg?.name === from) bg.name = to;
      if (model?.provider === from) Object.assign(model, { provider: to, ref: fix(model.ref)! });
      if (conn?.name === from) conn.name = to;
      settings.save();
      note(`${from} is now called ${to}.`, 'dim');
      return null;
    },
    inContext: () => (S.messages.length ? S.task?.lastPrompt || Math.ceil(JSON.stringify(S.messages).length / 4) : 0),
    later: (m) => {
      later = m;
      note(`${m.label} from the next /clear`, 'dim');
    },
    activate: (m, base) => {
      controls = { reasoning: cfg.reasoning !== false, effort: cfg.effort };
      model = m;
      conn = connOf(m.provider, cfg.providers[m.provider], base);
      S.task = null;
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
      // Over ssh the next message brings it back up first; a direct server loads
      // the model itself when a request asks for it.
      if (model?.provider === name && cfg.providers[name]?.ssh) conn = undefined;
      if (S.convId) bound(S).event('server', `${name} stopped serving its model`);
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
  // Returns false when it isn't Rime's to handle after all (`use tabs`).
  // Your server is set up but has no model loaded (unloaded or stopped in /server).
  const unloaded = () => (model && cfg.providers[model.provider]?.ssh && !conn && !(bg && !bg.run.state.done) ? model.id : '');

  function local(text: string, ph: { key: string; value: string }) {
    if (ph.key === 'use') {
      const v = ph.value.toLowerCase();
      const refs = knownModels();
      const ref = refs.find((r) => r.toLowerCase() === v) ?? refs.find((r) => r.split('/').pop()!.toLowerCase() === v) ?? refs.find((r) => r.split('/')[0].toLowerCase() === v);
      if (!ref) return false;
      S.items.push({ kind: 'user', text });
      history.push(text);
      S.nextStep = '';
      if (ref === model?.ref && conn) S.items.push({ kind: 'note', tone: 'dim', text: `Already using ${model.label}.` });
      else {
        cfg.model = ref;
        settings.save();
        useRef(ref);
      }
      handled();
      return;
    }
    S.items.push({ kind: 'user', text });
    history.push(text);
    const c = settings.set(ph.key, ph.value);
    const d = settings.list().find((x) => x.key === ph.key)!;
    S.items.push(c ? { kind: 'gear', change: c } : { kind: 'gear', change: { key: ph.key, label: d.label.toLowerCase(), from: ph.value, to: ph.value, applies: d.applies, at: Date.now() }, note: `${d.label.toLowerCase()} is already ${ph.value}` });
    handled();
  }
  // The ↳ line, and the turn it saved on the meter: the context re-read from cache
  // plus a short reply, at this model's price. Local models cost nothing anyway.
  function handled() {
    const p = model?.price;
    const d = p && !conn?.local ? (Math.max(S.task?.lastPrompt ?? 0, 1000) * p.read + 50 * p.out) / 1e6 : 0;
    if (d) S.meter.credit(d);
    S.items.push({ kind: 'lines', lines: [[{ t: `  ↳ handled in Rime · no API call${d ? ` · saved ~${fmt$(d)}` : ''}`, s: st.dim }]] });
  }

  function submit() {
    // A prompt that is just `exit` or `quit` means /exit; nobody sends that word to a model.
    const v = /^(exit|quit)$/i.test(buf.trim()) && !S.declining && !S.question?.tool ? '/exit' : buf.trim();
    browsing = null;
    // "No, and tell Rime what to do instead": these words go back as the reason.
    if (S.declining && !v.startsWith('/')) {
      if (v) S.items.push({ kind: 'user', text: v }), history.push(v);
      buf = '';
      cur = 0;
      anchor = null;
      return S.declining(v);
    }
    // Your own answer to a question.
    if (S.question && v && !v.startsWith('/')) {
      const Q = S.question;
      if (Q.tool) {
        buf = '';
        cur = 0;
        anchor = null;
        return Q.done(v);
      }
      S.question = null; // a picker from the reply: your words go as a message
    }
    if (!v && S.resumeOk && !S.busy) return void send('continue');
    if (!v) return;
    // While it works, a message waits for the next tool results (or the end of the reply).
    if (S.busy && !v.startsWith('/')) {
      if ([...v].some(isChip) && blind() && hasMedia(v)) return say("this model can't see images; send it when the reply is done");
      S.queued.push({ text: v, content: [...v].some(isChip) ? blocksFor(v, chips, cwd, true) : v });
      history.push(v);
      buf = '';
      cur = 0;
      anchor = null;
      big = hover = null;
      return;
    }
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
      if (ph && local(v, ph) !== false) return;
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
      // Your own server: the one in use, else one set up over ssh, else any llama.cpp server.
      const own = (n: string) => !!cfg.providers[n]?.ssh || cfg.providers[n]?.preset === 'llamacpp';
      const names = Object.keys(cfg.providers);
      const name = model && own(model.provider) ? model.provider : (names.find((n) => cfg.providers[n].ssh) ?? names.find(own));
      if (name) panel = createServer(host, name);
      else note('No llama.cpp server is connected. /setup connects one.', 'dim');
    } else if (c === '/settings') panel = createSettingsPanel(host);
    else if (c === '/permissions') panel = createPermissions();
    else if (c === '/conversations') openList();
    else if (c === '/clear') {
      newConversation();
      if (later) host.choose(later);
    } else if (c === '/usage') boxKind = 'usage';
    else if (c === '/exit') quit();
    else {
      S.items.push({ kind: 'user', text: v });
      S.items.push({ kind: 'reply', text: `Unknown command ${c}. Press / to see the commands.`, done: true });
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
    // A space on each side, so typed words don't run into the chip.
    const r = range();
    const a = r ? r[0] : cur, b = r ? r[1] : cur;
    insert(`${a && !/\s/.test(buf[a - 1]) ? ' ' : ''}${ch}${/\s/.test(buf[b] ?? '') ? '' : ' '}`);
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
    const clean = cleanPaste(t);
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
      const k = CLICK_KEYS[label] ?? (/^[a-z0-9]$/.test(label) ? { name: 'char', ch: label } : null);
      if (k) onKey({ type: 'key', ...k });
      return;
    }
    if (id === 'stop') return stopBg();
    if (id === 'mode') return cycleMode();
    if (id === 'conversations') return openList();
    if (id.startsWith('conv:') && list) return openRow(listRows()[+id.slice(5)]);
    if (id.startsWith('sugg:') && list) return takeSuggestion(listSuggestions()[+id.slice(5)] ?? '');
    if (id.startsWith('dec:') && S.approval) return void answer(+id.slice(4));
    if (id.startsWith('q:') && S.question) return S.question.done(S.question.options[+id.slice(2)].label);
    if (id.startsWith('pin:')) {
      const it = S.items[+id.slice(4)];
      if (it?.kind !== 'user' || it.pinned || S.convId === null) return;
      it.pinned = true;
      cache.delete(it);
      bound(S).event('pin', plainOf(it.text).split('\n')[0].trim().slice(0, 80));
      return say('◆ pinned to the timeline');
    }
    if (id.startsWith('undo:')) {
      const it = S.items[+id.slice(5)];
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
    if (list) return listKey(k);
    if (boxKind === 'keys') {
      boxKind = null; // any key closes the sheet
      return;
    }
    // The permission question takes the keys while it's open.
    if (S.approval) {
      const opts = approvalOptions();
      if (k.name === 'up' || k.name === 'down') {
        const i = opts.indexOf(S.approval.sel);
        S.approval.sel = opts[(i + (k.name === 'up' ? opts.length - 1 : 1)) % opts.length];
      } else if (k.name === 'enter') answer(S.approval.sel);
      else if (k.name === 'char' && /^[1-9]$/.test(k.ch ?? '') && opts[+k.ch! - 1] !== undefined) answer(opts[+k.ch! - 1]);
      else if (k.name === 'escape') answer(2);
      else if (k.name === 'tab' && k.shift) cycleMode();
      else if (k.ctrl && k.name === 'c') S.busy?.abort();
      else if (k.name === 'left') openList(); // the question waits here while you look elsewhere
      return;
    }
    // A question: on an empty prompt ↑ ↓, 1 2 3 and enter pick; typing writes your
    // own answer (enter sends it); esc stops the turn, or closes a picker.
    if (S.question && !panel && !buf && !boxKind && !rsearch) {
      const Q = S.question, n = Q.options.length;
      if (k.name === 'up' || k.name === 'down') return void (Q.sel = (Q.sel + (k.name === 'up' ? n - 1 : 1)) % n);
      if (k.name === 'char' && /^[1-9]$/.test(k.ch ?? '') && +k.ch! <= n) return Q.done(Q.options[+k.ch! - 1].label);
      if (k.name === 'enter' && !k.shift) return Q.done(Q.options[Q.sel].label);
      if (k.name === 'escape') return void (Q.tool ? S.busy?.abort() : (S.question = null));
    }
    if (k.name === 'tab' && k.shift && !panel) return cycleMode();
    // ← on an empty prompt opens your conversations.
    if (k.name === 'left' && !k.shift && !buf && !panel && !boxKind && !rsearch) return openList();
    // ctrl+c cancels what's open or running; twice quits, but only when nothing
    // is open or running, so one press never loses work (SPEC §5.2).
    if (k.ctrl && k.name === 'c') {
      if (panel) return panel.cancel ? panel.cancel() : host.close();
      if (rsearch || atPick) return void (rsearch = atPick = null);
      if (boxKind) return void (boxKind = null);
      if (big || listPinned) return void ((big = null), (listPinned = listOpen = false));
      if (S.busy) return S.busy.abort();
      if (buf) {
        buf = '';
        cur = 0;
        anchor = null;
        return;
      }
      if (bg && !bg.run.state.done && !bg.stopping) return stopBg();
      if (quitArmed) return quit();
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
    if (!panel && k.ctrl && k.name === 'o') {
      showThinking = !showThinking;
      for (const x of sessions) for (const it of x.items) if (it.kind === 'think') it.open = showThinking;
      return;
    }
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
    if (!buf && !panel && !S.declining && (k.name === 'tab' || (k.name === 'right' && !k.shift)) && (S.nextStep || unloaded() || (example && !S.messages.length))) return insert(S.nextStep || (unloaded() ? `load ${unloaded()}` : example));
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
    // A full-size file or text scrolls with ↑ ↓ and ctrl+u ctrl+d while it's open.
    if (big && !panel && ((k.name === 'up' || k.name === 'down') && !k.shift || (k.ctrl && (k.name === 'u' || k.name === 'd')))) {
      const by = k.name === 'up' ? -1 : k.name === 'down' ? 1 : k.name === 'u' ? -bigScroll.page : bigScroll.page;
      if (scrollBig(by)) return;
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
      else if (S.busy) S.busy.esc();
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
        // ↑ on an empty prompt takes your last queued message back to edit.
        if (up && !buf && S.queued.length && !k.shift) {
          buf = S.queued.pop()!.text;
          cur = buf.length;
          navigated = true;
          break;
        }
        if (k.shift) anchor ??= cur;
        else anchor = null;
        if (vertical(up ? -1 : 1) || k.shift || browsing?.edited) break;
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
    if (ev.type === 'mouse' && list) {
      // In the conversations window: the wheel moves the highlight, a click opens.
      if (ev.button === 64 || ev.button === 65) return listKey({ name: ev.button === 64 ? 'up' : 'down' }), schedule();
      else if (ev.button === 0 && ev.release) {
        const h = hits.find((x) => x.row === ev.y && ev.x >= x.x0 && ev.x <= x.x1);
        if (h) act(h.id);
      }
      return schedule();
    }
    if (ev.type === 'mouse') {
      const at = { x: ev.x, y: ev.y };
      const onPrompt = !panel?.masked?.() && promptOffset(ev.x, ev.y) !== null;
      if (ev.button === 64 || ev.button === 65 || ev.button === 96 || ev.button === 97) {
        // The wheel scrolls; a transcript selection stays on its text (and grows
        // with the view while the button is held).
        if (!scrollBig(ev.button % 2 === 0 ? -3 : 3)) scrollOff += ev.button % 2 === 0 ? 3 : -3;
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
      if ((ev.name === 'pageup' || ev.name === 'pagedown') && scrollBig((ev.name === 'pageup' ? -2 : 2) * bigScroll.page)) schedule();
      else if (ev.name === 'pageup' || ev.name === 'pagedown') scrollOff += (ev.name === 'pageup' ? 1 : -1) * Math.max(1, viewH - 2);
      else onKey(ev);
    }
    if (buf !== before) {
      blindAsk = false;
      // Typing keeps the text you brought back; emptying it ends the browsing.
      if (!navigated && browsing) buf ? (browsing.edited = true) : (browsing = null);
    }
    navigated = false;
    if (panel && buf !== before) panel.changed?.(buf);
    schedule();
  }

  // ---- lifecycle ----

  let closing = false;
  const killTunnels = () => {
    closing = true;
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
    finishDelete(); // a delete waiting for undo is done now
    // Every open conversation: a reply being streamed is kept as interrupted.
    for (const x of sessions) {
      if (x.live && x.convId) save((d) => d.update(x.convId!, x.live!.seq, [{ type: 'text', text: x.live!.text() }], true));
      if (x.convId) save((d) => d.unlock(x.convId!));
    }
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
  function reopen(c: Conversation, C: Session = S) {
    const { store } = bound(C);
    C.convId = c.id;
    try {
      C.convRules = c.rules ? JSON.parse(c.rules) : {};
    } catch {
      C.convRules = {};
    }
    C.mark = save((d) => d.timeline(c.id).filter((e) => e.kind === 'model').at(-1)?.text) ?? '';
    // The stored prefix is reused when it's recent and was sent with today's tools.
    if (c.prefix && c.prefix_hash === TOOLS_HASH && Date.now() - c.updated < 86400000) C.system = c.prefix;
    else save((d) => d.setPrefix(c.id, C.system, TOOLS_HASH));
    const stored: Stored[] = save((d) => d.messages(c.id)) ?? [];
    for (const m of stored) {
      const blocks: Block[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      if (m.role === 'system') {
        const { type: _, ...oc } = blocks[0] ?? {};
        C.messages.push({ role: 'system', content: [], output_config: oc });
        continue;
      }
      C.messages.push({ role: m.role, content: m.content });
      const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text)).join('');
      if (m.role === 'user') {
        if (text) {
          C.costItem = null;
          const it = userItem(blocks);
          C.items.push(it);
          if (it.kind === 'user' && !it.chips) history.push(it.text);
        }
      } else {
        const thought = blocks.filter((b) => b.type === 'thinking').map((b) => String(b.thinking ?? '')).join('');
        if (thought.trim()) C.items.push({ kind: 'think', text: thought, start: 0, ms: 0, open: showThinking });
        if (splitToolCalls(text).text.trim()) C.items.push({ kind: 'reply', text: text + (m.interrupted ? '…' : ''), done: true });
        // What it cost comes back too: the ↳ line, the meter and /usage.
        if (m.usage) addCost(C, C.meter.charge(m.usage.usage, m.usage.price, m.usage.local));
        for (const u of blocks.filter((b) => b.type === 'tool_use')) C.items.push(toolLine(u));
      }
    }
    if (!stored.length) return;
    C.continuing = { title: c.title || 'untitled', at: c.updated, cost: resumeCost(stored) };
    // Pick up from the last reply: if it offered something, that's the suggestion.
    const lastReply = stored.at(-1)!;
    if (lastReply.role === 'assistant' && !lastReply.interrupted) {
      const t = typeof lastReply.content === 'string' ? lastReply.content : lastReply.content.filter((b) => b.type === 'text').map((b) => String(b.text)).join('');
      C.nextStep = nextFor(t, { wrote: [], ran: [] }, project);
      offerChoices(t, C);
    }
    // Tool calls left without results when Rime closed are asked again by the
    // next message (send), so the question you left open comes back.
    const last = C.messages.at(-1);
    const open = last?.role === 'assistant' && Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_use');
    if (!open && stored.at(-1)!.role === 'user') C.lastUserSeq = stored.at(-1)!.seq;
    if (open || stored.at(-1)!.interrupted || C.messages.at(-1)?.role === 'user') {
      C.resumeOk = true;
      C.items.push({ kind: 'lines', lines: [[{ t: '  ↻ ', s: st.warn }, { t: open ? 'waiting for your answer when you quit · ' : 'interrupted when you quit · nothing was lost · ', s: st.dim }, { t: 'enter', s: st.accentB }, { t: open ? ' asks again' : ' continue', s: st.dim }]] });
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
  // The terminal reflows the screen on resize, so the next frame redraws it all.
  out.on('resize', () => {
    drawn = [];
    write('\x1b[2J');
    schedule();
  });

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
  askTrust();
  example = exampleFor(project);
  if (!connected()) panel = createSetup(host);
  else if (cfg.model) useRef(cfg.model, true);
  frame();
}
