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
import { pathToFileURL } from 'node:url';
import { type Conversation, type Db, type Stored, openDb, projectOf } from './db.ts';
import { type Decision, MODE_HELP, MODES, type Mode, addProjectRule, decide, projectRules, removeProjectRule, ruleList, rulesHash, trustedProjectRules } from './permissions.ts';
import { type RunAs, type ToolDef, type ToolResult, TOOLS, bash as bashTool, commandEnv, sandboxed, diffOf, edit as editTool, optionsOf, planEdit, read as readTool, rel, textOf, write as writeTool } from './tools.ts';
import { type AgentEvent, type TurnHost, result, runTools, runTurn } from './agent.ts';
import { WHEN, createSettings, phrase } from './settings.ts';
import { type Did, choicesOf, example as exampleFor, nextStep as nextFor } from './suggest.ts';
import { toolEvents } from './timeline.ts';
import { parse as parseQuery, rank, suggestions } from './rank.ts';
import { type Config, rimeDir, saveConfig } from './config.ts';
import { CUBE_COLS, type Header, type HeaderOpts, SCENE, playHeader, shortPath, tildify } from './header.ts';
import { type InputEvent, type Key, type Line, createParser, fit, lineWidth, sliceCols, stripAnsi, strWidth, truncAnsi, wrap } from './term.ts';
import { colorMode, sgr } from './theme.ts';
import { previewBox, sendLine, sendList } from './preview.ts';
import { type BoxRow, type Hint, type Hit, type Item, type Styles, box, caretOf, footRows, hintLines, packParts, layoutInput, listRow, offsetAt, prompt, renderItem, spaced, splitToolCalls, status, str, styles } from './view.ts';
import { type Turn, addTurns, createMeter, fmt$, fmtS, fmtT } from '../plugins/token-kit/meter.ts';
import * as llama from '../providers/llamacpp.ts';
import { PRESETS } from '../providers/presets.ts';
import { connOf, keyOf as providerKey, listModels, modelOf, pickUrl, streamFor } from '../providers/registry.ts';
import { type Checkpoints, createCheckpoints } from '../plugins/diff-undo/checkpoints.ts';
import { type CodeIndex, openIndex } from '../plugins/code-index/index.ts';
import { type ShellTab, createSide } from '../plugins/shell-panel/panel.ts';
import { addressLike } from '../plugins/shell-panel/search.ts';
import { BROWSER_TOOL, type BrowserSession, type Progress, chrome as hasChrome, closeChrome, install as installBrowser, installed as browserInstalled, openBrowser, uninstall as uninstallBrowser, usesChrome } from '../plugins/browser/browser.ts';
import { DESIGN_TOOL, type DesignSession, type From, type Pick, capture, createVersions, designFile, openDesign, overflow, slug as designSlug, starter } from '../plugins/design/design.ts';
import { compare as compareVersions, install as installVersion, latest as latestVersion, newest as newestVersion } from '../plugins/updater/update.ts';
import { SUMMARY_SYSTEM, clearOld, compacted, cutPoint, tokensOf, transcript as historyText } from '../plugins/token-kit/compact.ts';
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
  ['/compact', 'summarise the earlier conversation to free context'],
  ['/diff', 'what the last change did, file by file'],
  ['/panel', 'split view: /panel shows or hides it · files | shell | diff | hide'],
  ['/browser', 'a page in a tab: /browser <url or file> · use chrome | chromium · uninstall'],
  ['/design', 'build a page by chatting: /design new <what>'],
  ['/undo', 'put the files back as they were before the last change'],
  ['/usage', 'token, cost and savings breakdown'],
  ['/update', 'install the newest Rime and restart into it'],
  ['/exit', 'quit Rime'],
];

// SPEC §5: only keys every keyboard has and every terminal passes on (§5.1).
// The ? sheet, in four groups; split view's keys are always listed, so people
// find ctrl+g (or /panel where the terminal takes it).
const KEY_GROUPS: [string, [string, string][]][] = [
  ['Send and edit', [
    ['enter', 'send'],
    ['ctrl+j', 'new line (or shift+enter)'],
    ['ctrl+a ctrl+e', 'start / end of the line'],
    ['ctrl+u ctrl+k', 'delete to the start / end'],
    ['ctrl+w', 'delete the word before'],
    ['ctrl+y', 'bring back what you deleted'],
    ['ctrl+v', 'paste an image, or drag a file'],
    ['ctrl+c', 'clear, or cancel what runs'],
    ['ctrl+c twice', 'quit (when nothing is open)'],
  ]],
  ['Ask and pick', [
    ['/', 'commands'],
    ['@', 'mention a file or folder'],
    ['ctrl+r', 'search your earlier prompts'],
    ['tab  →', 'complete / take the suggestion'],
    ['shift+tab', 'mode: ask · auto-edit · plan'],
    ['ctrl+o', "show or hide the thinking"],
    ['?', 'this list'],
  ]],
  ['Move around', [
    ['↑ ↓', 'earlier prompts (esc: yours)'],
    ['←', 'conversations (empty prompt)'],
    ['ctrl+u ctrl+d', 'scroll (empty prompt) or wheel'],
    ['esc', 'stop, go back, or close a box'],
  ]],
  ['Panel', [
    ['ctrl+g', 'to the panel and back · /panel'],
    ['', 'in the panel:'],
    ['esc', 'back one step, then the chat'],
    ['space  n', 'tabs · new tab'],
    ['1…9  tab', 'go to a tab · next tab'],
    ['x  z', 'close the tab · zoom'],
    [':  /', 'panel command · search the tab'],
    ['enter', 'type into a shell or page'],
    ['?', "this tab's keys"],
  ]],
];

// The ? sheet: two columns when every row fits in half the box, else one; when
// that's still too tall for the screen, whole groups go on pages (→ for the next).
export function keysSheet(width: number, height: number, st: Styles, page = 0) {
  const blocks = KEY_GROUPS.map(([t, keys]): BoxRow[] => [{ line: [{ t, s: st.accent }] }, ...keys.map(([k, h]) => listRow(k, h, false, st, undefined, 15))]);
  const colW = Math.floor((width - 6) / 2);
  const room = height - 9; // the box may take height - 5 rows: border, footer and its rule take 4
  let pages = [blocks.flatMap((b, i) => (i ? [{ line: [] }, ...b] : b))];
  if (pages[0].every((r) => lineWidth(r.line) <= colW)) {
    const l = [...blocks[0], { line: [] }, ...blocks[1]], r = [...blocks[2], { line: [] }, ...blocks[3]];
    pages = [l.map((x, i) => ({ line: [...x.line, { t: ' '.repeat(colW + 2 - lineWidth(x.line)), s: st.dim }, ...(r[i]?.line ?? [])] }))];
  }
  if (pages[0].length > room) {
    pages = [[]];
    for (const b of blocks) {
      const p = pages.at(-1)!;
      if (p.length && p.length + 1 + b.length > room) pages.push([...b]);
      else p.push(...(p.length ? [{ line: [] }] : []), ...b);
    }
  }
  const n = Math.min(page, pages.length - 1);
  const foot = n + 1 < pages.length ? ['→', ` more (${n + 1}/${pages.length}) · `, 'esc', ' close'] : `${pages.length > 1 ? `${n + 1}/${pages.length} · ` : ''}any key to close`;
  return { pages: pages.length, ...box('shortcuts', [...pages[n], ...footRows(foot, st)], width, st, st.accent, 'key:esc') };
}

// A clicked footer key acts like pressing it (`key:esc`, `key:b`, …).
const CLICK_KEYS: Record<string, Key> = {
  esc: { name: 'escape' }, enter: { name: 'enter' }, tab: { name: 'tab' }, space: { name: 'space' }, backspace: { name: 'backspace' },
  'ctrl+c': { name: 'c', ctrl: true }, 'ctrl+j': { name: 'j', ctrl: true }, 'ctrl+v': { name: 'v', ctrl: true }, 'ctrl+o': { name: 'o', ctrl: true },
  'ctrl+r': { name: 'r', ctrl: true }, 'ctrl+d': { name: 'd', ctrl: true }, '→': { name: 'right' }, '←': { name: 'left' }, '↑': { name: 'up' }, '↓': { name: 'down' }, 'shift+tab': { name: 'tab', shift: true },
  'ctrl+w': { name: 'w', ctrl: true }, 'ctrl+g': { name: 'g', ctrl: true },
  'ctrl+p': { name: 'p', ctrl: true }, 'ctrl+f': { name: 'f', ctrl: true }, 'ctrl+e': { name: 'e', ctrl: true }, 'ctrl+x': { name: 'x', ctrl: true }, 'ctrl+u': { name: 'u', ctrl: true },
};

// Frozen for the whole session: any byte change here would break the prompt cache.
// The tools sit before the system prompt in the cached prefix; a stored prefix is
// reused only with the same tools.
// A tool list's fingerprint: a conversation's stored prefix is reused only with the same tools.
const hashOf = (tools: ToolDef[]) => createHash('sha256').update(JSON.stringify(tools)).digest('hex').slice(0, 16);

// The only project file it includes is AGENTS.md, read once at the start.
const system = (cwd: string, agents = '', map = '') =>
  `You are Rime, a coding assistant running in the user's terminal.\n` +
  `Working directory: ${cwd}\n` +
  `Do the work with your tools: read files before you change them, create files with write, change them with edit, run commands with bash. Don't paste whole files into the chat; say in a line or two what you did.\n` +
  `When you need the user to choose before you go on, use the ask tool and stop there; never ask in text and then carry on in the same reply.\n` +
  `You run inside Rime. Use the rime tool to change Rime itself (tabs, panel, settings, model, servers). Never tell the user to restart Rime or edit its config.\n` +
  `The user sees a split view next to the chat with tabs: the project's files, a file at a line, the diff of your last change, command output, servers (bash with background: true runs a dev server in a tab that keeps running; rime tab.read {tab} shows its latest output), a browser (rime browser.open {url}; the browser tool clicks and reads pages) and the design studio (the design tool; it can start from the user's own page). The user can /diff and /undo your last change and /compact. Offer these instead of saying Rime can't.\n` +
  `Be brief and direct. Use plain text with light markdown (lists, \`code\`, fenced blocks); no tables.` +
  (agents ? `\n\nAGENTS.md:\n${agents}` : '') +
  (map ? `\n\n${map}` : '');
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

export async function runApp(cfg: Config, version: string, pkgName = 'rime-cli', updates = false) {
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
  const decisions: { at: number; tool: string; what: string; verdict: string; why: string; src?: object; answered?: string }[] = [];
  let example = ''; // `Try "…"` on an empty prompt, from this project
  // "Don't ask again" rules belong to this conversation and are saved with it.
  const addConvRule = (kind: 'allow' | 'ask' | 'deny', pattern: string) => bound(S).addConvRule(kind, pattern);
  // ↑ / ↓ through earlier prompts, like a shell: `draft` is what you were typing.
  // ↑ history: `draft` is what you were typing; `edited` once you change the
  // recalled text (esc still brings the draft back, ↑ ↓ then move in the text).
  let browsing: { list: string[]; i: number; draft: string; edited?: boolean } | null = null;
  let navigated = false;
  let cleared = ''; // the prompt ctrl+c cleared, first on ↑
  let heldPrompt: string | null = null; // sent with no model: waits for /setup
  const cwd = process.cwd();
  // The tools a new conversation freezes: the core ones, plus enabled plug-ins'.
  const toolsNow = (): ToolDef[] => [...TOOLS, ...(cfg.plugins?.browser ? [BROWSER_TOOL] : []), ...(cfg.plugins?.design ? [DESIGN_TOOL] : [])];
  let SYSTEM = system(cwd, agentsMd(projectOf(cwd))); // the prefix for new conversations (the repo map joins once the index is ready)

  // ---- state ----
  let model: Model | undefined;
  let conn: Conn | undefined; // set once the model's provider answers
  let index: CodeIndex | null = null; // the code index, once it's open (Phase 5)
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
  let keysPage = 0; // the ? sheet's page, when it needs more than one
  let panel: Panel | null = null;
  let quitArmed: NodeJS.Timeout | null = null;
  let quitting: string | null = null;
  const tunnels: Record<string, Tunnel> = {};
  let bg: { name: string; run: Run; panel?: Panel; stopping?: boolean } | null = null; // an own server coming up in the background
  let promptRate: number | undefined; // local prompt tokens/s, from the last reply

  // ---- saving (SPEC §16): every message is written the moment it exists ----
  const project = projectOf(cwd);
  // Split view (docs/split-v2.md): the tabbed panel on the right, and whether it
  // has the keys (ctrl+g moves them to the other side).
  const side = createSide({
    root: project, st, redraw: () => schedule(),
    files: () => (index ? index.files().sort() : listFiles(project)),
    env: () => commandEnv(process.env, cfg.passEnv),
    asks: () => needsYou(S),
    plan: () => mode === 'plan',
    scripts: () => scriptsOf(),
    recent: () => [...edited, ...usedFiles],
    addresses: () => addresses,
    designs: () => designNames(),
    browse: (url, from) => void browse(url, from),
    design: (arg) => designAny(arg),
    idea: (text) => designIdea(text),
    diff: () => {
      const cps = checkpointsOf(), cp = cps?.last();
      if (!cps || !cp) return 'no change on record to diff yet';
      side.diff(cps.diff(cp), true);
    },
    browser: (args) => browserCmd(args),
    mention: (ref, lines) => mention(ref, lines),
    ready: (t) => {
      // A server ready again (after a restart): a browser on its address reloads.
      if (browser && t.serve?.url && browser.url().startsWith(t.serve.url)) browser.reload();
    },
  });
  const edited: string[] = []; // files Rime changed this session, first in name search
  const addresses: string[] = []; // browser addresses, most recent first
  let quitServers = false; // quitting with servers running asks first
  let sideFocus = false, dragging = false; // dragging: the divider, with the mouse
  // The chat's width and where the panel starts (0: no panel). Under 72 columns
  // there's room for one pane, so the one with focus takes the screen.
  const layout = () => {
    const width = W();
    if (!side.visible) return { cw: width, px: 0, full: false };
    if (width < 72 || side.zoomed) return sideFocus ? { cw: 0, px: 1, full: true } : { cw: width, px: 0, full: false };
    const pw = Math.max(30, Math.min(width - 40, Math.round(width * side.ratio)));
    return { cw: width - pw, px: width - pw + 1, full: false };
  };
  const CW = () => layout().cw || W();
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
    const conversation = () => (x.convId ??= save((d) => d.create(project, x.system, model?.ref, hashOf(x.tools))) ?? null);
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
  let hoverRow = 0; // the screen row under the mouse: a message's ◆ shows only there (or once pinned)
  let edgeScroll: NodeJS.Timeout | null = null; // dragging past the top or bottom scrolls
  let top = 0; // transcript line shown on the first row
  let logLines: string[] = [];
  let rows: string[] = [];

  let header!: Header;
  const headerOpts: HeaderOpts & { ready: (h: Header) => void } = {
    version, cwd, mode: st.mode, interactive: false, cols: () => CW(),
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
    slot?: number; // its llama.cpp slot when the server has several
    tell: string[]; // notes for the model, sent with the next message (an /undo)
    costItem: Item | null; // this turn's ↳ line, kept last as its requests add up
    system: string; // its frozen system prompt: the stored one when reopened while the cache is warm
    tools: ToolDef[]; // its frozen tool list: the core tools, plus plug-ins' (browser) on when it started
  };
  const newSession = (): Session => ({
    convId: null, messages: [], items: [headerItem], task: null, busy: null, waiting: null, live: null, lastUserSeq: 0,
    continuing: null, resumeOk: false, approval: null, question: null, queued: [], declining: null, convRules: {}, meter: createMeter(), nextStep: '', title: '', mark: '', planSaid: false, tell: [], costItem: null, system: SYSTEM, tools: toolsNow(),
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
      return keysSheet(width, H(), st, keysPage);
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
  // Files by fuzzy name, and (from the code index) declarations whose name starts
  // with what's typed: `@validate` finds validateEmail in src/signup.ts.
  function atMatches(): { f: string; marks: number[]; sym?: string; lines?: [number, number] }[] {
    const q = atQuery();
    if (q === null) return [];
    const name = q.split(':')[0];
    const pf = projectFiles();
    if (!name) return [...new Set([...usedFiles, ...pf.recent])].slice(0, 8).map((f) => ({ f, marks: [] }));
    const syms = name.length >= 3 && /^[\w$]+$/.test(name) && index ? index.symbols(name, 3).map((s) => ({ f: s.path, marks: [], sym: `${s.kind} ${s.name}`, lines: [s.line, s.line + 59] as [number, number] })) : [];
    return [
      ...syms,
      ...pf.list
        .map((f) => ({ f, m: fuzzy(name, f) }))
        .filter((x) => x.m)
        .sort((a, b) => b.m!.score + (usedFiles.includes(b.f) ? 2 : 0) - a.m!.score - (usedFiles.includes(a.f) ? 2 : 0))
        .slice(0, 8 - syms.length)
        .map((x) => ({ f: x.f, marks: x.m!.marks })),
    ];
  }
  // Attaches the picked file or folder as a chip; `@file:30-60` keeps those lines,
  // a declaration keeps 60 lines from where it starts.
  function takeAt(f: string, from?: [number, number]) {
    const q = atQuery() ?? '';
    const typed = /:(\d+)(?:-(\d+))?$/.exec(q);
    const lines = from ? (['', String(from[0]), String(from[1])] as unknown as RegExpExecArray) : typed;
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
        const name: Line = x.sym ? [{ t: x.sym, s: sel ? st.accent : st.fg }, { t: `  ${x.f}:${x.lines![0]}`, s: st.dim }] : [...x.f].map((ch, j) => ({ t: ch, s: x.marks.includes(j) ? st.warn : sel ? st.accent : st.fg }));
        return { line: [{ t: sel ? '› ' : '  ', s: st.accent }, ...name], bg: sel ? st.panelBg : undefined, hit: `at:${i}` };
      });
      return box([{ t: index ? '@ files and code' : '@ files', s: st.accent }, dim(q ? ` · matching "${q}"` : ' · recent first')], [
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
    if (/^\/browser\s+$/.test(buf))
      return box('/browser', [
        { line: [{ t: '<url or file>', s: st.title }, dim('  a web address, localhost:5173, or a file like index.html')] },
        { line: [{ t: 'use chrome', s: st.title }, dim(' · '), { t: 'use chromium', s: st.title }, dim(`  switch browsers${browserInstalled() ? ` (now ${usesChrome() ? 'your Chrome' : 'Chromium'})` : ''}`)] },
        { line: [{ t: 'uninstall', s: st.title }, dim('  remove the plug-in and the Chromium it downloaded')] },
      ], width, st);
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
      placeholder: panel?.placeholder?.() ?? (S.approval ? 'answer above' : S.declining ? 'tell Rime what to do instead' : S.question ? 'pick one above, or type your own answer' : S.resumeOk ? (pendingUses(S).length ? 'enter asks the open question again, or ask something new' : 'enter continues the interrupted reply, or ask something new') : S.nextStep ? S.nextStep : unloaded() ? `load ${unloaded()}` : example && !S.messages.length && connected() ? `Try "${example}"` : undefined),
      // A suggestion shows the key that takes it.
      tabHint: !panel && !S.approval && !S.declining && !S.resumeOk && (buf ? !!ghost() : !!(S.nextStep || unloaded() || (example && !S.messages.length && connected()))),
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
    else if (quitServers) {
      const n = side.servers(), lead = `${n} server${n === 1 ? '' : 's'} running · `;
      left = [{ t: lead, s: st.warn }, { t: 'enter', s: st.accentB }, { t: ' stop them and quit · ', s: st.dim }, { t: 'esc', s: st.accentB }, { t: ' stay', s: st.dim }];
      const x = strWidth(lead) + 1;
      leftHits = [{ x0: x, x1: x + 4, id: 'key:enter' }, { x0: x + 26, x1: x + 28, id: 'key:esc' }];
    } else if (quitArmed) left = [{ t: 'press ctrl+c again to quit', s: st.dim }];
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
      // The panel has the keys: the chat's own keys would do nothing, so only the way back.
      const away = sideFocus && side.visible;
      if (away) parts.push(needsYou(S) ? { line: [{ t: '● Rime is asking · ', s: st.warn }, key('ctrl+g'), dim(' answer')], id: 'chat' } : { line: [key('ctrl+g'), dim(' focus')], id: 'chat' });
      if (S.declining && !away) parts.push({ line: [dim('type what Rime should do instead')] });
      if (!away) {
        if (S.queued.length && !buf) parts.push({ line: [key('↑'), dim(' edit queued')] });
        if (side.tabs.length && !side.visible) parts.push({ line: [dim(`panel hidden · ${side.tabs.length} tab${side.tabs.length === 1 ? '' : 's'}${side.running() ? `, ${side.running()} running` : ''} · `), key('ctrl+g')], id: 'panel' });
        else if (side.visible && !sideFocus) parts.push({ line: [key('ctrl+g'), dim(' panel')], id: 'panel' });
        if (running) parts.push({ line: [{ t: '⟳ ', s: st.accent }, dim(`${running.label} · `), key('ctrl+c'), dim(' stop')], id: 'key:ctrl+c' });
        if ((upd.state === 'available' && upd.folded) || (upd.state === 'ready' && upd.folded)) parts.push({ line: [{ t: '↑ ', s: st.ok }, dim(`${upd.version} · `), key('/update')], id: 'update' });
        if (browsing?.edited) parts.push({ line: [key('esc'), dim(browsing.draft.trim() ? ' back to your text' : ' clear')], id: 'key:esc' });
      }
      const asking = sessions.filter((x) => x !== S && needsYou(x)).length;
      const working = sessions.filter((x) => x !== S && (x.busy || x.waiting) && !needsYou(x)).length;
      if (asking) parts.push({ line: [{ t: '● ', s: st.warn }, { t: `${asking} needs you`, s: st.fg }], id: 'conversations' });
      if (working) parts.push({ line: [{ t: '● ', s: st.accent }, { t: `${working} working`, s: st.fg }], id: 'conversations' });
      // The permission mode shows whenever the chat has the keys; a click cycles it.
      if (!away) {
        const [icon, name, ms] =
          mode === 'ask' ? ['⏵', 'ask', st.accent]
          : mode === 'auto-edit' ? ['⏵⏵', 'auto-edit', st.accentB]
          : mode === 'plan' ? ['⏸', 'plan', st.accentB]
          : mode === 'god' ? ['⏵⏵⏵⏵', 'god mode', st.del]
          : ['⏵⏵⏵', 'auto', st.warn];
        // Short labels keep it to one row down to about 85 columns; each part is clickable.
        parts.push({ line: [{ t: `${icon} ${name}`, s: ms }], id: 'mode' });
        parts.push({ line: [key('←'), dim(' chats')], id: 'conversations' });
        parts.push({ line: [key('/'), dim(' commands')], id: '/' });
        parts.push({ line: [key('?'), dim(' keys')], id: '?' });
      }
      // Parts are never cut: what doesn't fit beside the meter moves to a line
      // below, whole, in the same order.
      const room = width - lineWidth(rightLine()) - 2;
      const rowsOut = packParts(parts, room, width - 1, dim(' · '));
      left = rowsOut[0].line;
      leftHits = rowsOut[0].hits;
      more.push(...rowsOut.slice(1));
    }
    // A one-off message that doesn't fit beside the meter wraps below it too.
    const room0 = width - lineWidth(rightLine()) - 2;
    if (!more.length && lineWidth(left) > room0) {
      const [head, ...rest] = packParts([{ line: left }], room0, width - 1, { t: ' · ', s: st.dim });
      left = head.line;
      leftHits = leftHits.filter((h) => h.x1 <= lineWidth(left));
      more.push(...rest);
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
    const full = W(), height = H();
    // The conversations window fills the screen.
    if (list) {
      const v = frameList(full, height);
      hits = v.rowHits;
      rows = v.lines.map((l) => truncAnsi(l, full));
      return paint(rows.map((l) => [l, '']), full, v.cursor);
    }
    const L = layout();
    // Narrow or zoomed, with the panel focused: the panel is the screen, under
    // one line for the chat (Rime asking shows on the panel's own line).
    if (L.full) {
      const v = side.render(full, height - 1, true, false);
      hits = [{ row: 1, x0: 1, x1: 15, id: 'chat' }, ...v.hits.map((h) => ({ ...h, row: h.row + 1 }))];
      rows = [str([{ t: 'chat · ', s: st.dim }, { t: 'ctrl+g', s: st.accentB }], st), ...v.lines];
      paint(rows.map((l) => [l, '']), full, '\x1b[?25l');
      return images(side.overlay(1, 1));
    }
    const width = L.cw;
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
    // The panel has focus: the chat's transcript is dimmed slightly.
    if (sideFocus && L.px) rows = rows.map((r, i) => (i < viewH ? st.faint + r.split(st.reset).join(st.reset + st.faint) : r));
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
    for (const h of hits) if (h.id.startsWith('pin:') && h.row !== hoverRow && !(S.items[+h.id.slice(4)] as { pinned?: boolean })?.pinned) marks[h.row - 1] += `\x1b[${h.row};${h.x0}H${st.reset} `;
    // Split: the panel takes the columns right of the chat, top to bottom.
    if (L.px) {
      const v = side.render(full - width, height, sideFocus);
      rows = rows.map((r, i) => `${r}${st.reset}${' '.repeat(Math.max(0, width - strWidth(stripAnsi(r))))}${v.lines[i] ?? ''}`);
      hits.push(...v.hits.map((h) => ({ ...h, x0: h.x0 + width, x1: h.x1 + width })));
    }
    const cursor = sideFocus ? '\x1b[?25l' : `\x1b[${viewH + 1 + u.cursor.row};${u.cursor.col + 1}H\x1b[?25h`;
    paint(rows.map((l, i) => [l, marks[i]]), full, cursor);
    images(L.px ? side.overlay(L.px) : null, cursor);
  }

  // A plug-in tab's picture (Kitty, iTerm2), drawn over its cells after the text;
  // when it stops showing, Kitty is told to drop it.
  let imaged = false;
  function images(seq: string | null, cursor = '') {
    if (seq) write(`\x1b[?25l${seq}${cursor}`);
    else if (seq === null && imaged) write(side.hideImages());
    imaged = seq !== null;
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
    const text = selected(CW()).map(({ text: t, x0, x1 }) => sliceCols(t, x0, x1).trimEnd()).join('\n')
      .replace(/^\n+|\n+$/g, '');
    if (text.trim()) copyOut(text);
  }
  // Says whether it reached the clipboard; when only OSC 52 was left (GNOME
  // Terminal ignores it), how to copy with the terminal instead.
  const copyOut = (text: string) =>
    void copy(text, write).then((ok) => (say(ok ? '✓ copied to clipboard' : "shift+drag to copy with your terminal (no wl-copy, xclip or xsel here)"), schedule()));

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
        tools: S.tools,
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
        if (worked.some((v) => v.id === 'wake' || v.id === 'start')) void restoreCache(name);
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
    // The index catches up with changes made outside Rime (and by commands).
    await index?.refresh().catch(() => 0);
    // A file or declaration the prompt names goes along up front, so the model
    // doesn't spend a turn finding it.
    if (!held && typeof content === 'string' && index) {
      const extra = preattach(content);
      if (extra.length) {
        content = [{ type: 'text', text: content }, ...extra.map((x) => x.block)];
        C.items.push({ kind: 'lines', hug: true, lines: [[{ t: '  + ', s: st.dim }, { t: extra.map((x) => x.label).join(', '), s: st.dim }, { t: ' · from the code index', s: st.dim }]] });
        schedule();
      }
    }
    const root = llama.rootOf(conn.base);
    // Another of your conversations on the same server: the server queues this one.
    // With one slot they share it (and evict each other's cache); with several each has its own.
    const mine = slotCount(conn.name) < 2 && sessions.some((x) => x !== C && x.busy && conn && x.convId !== null);
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
    const h = turnHost(C, m, cn, c, ac, did, (f) => (esc = f), text.split('\n')[0]);
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
    // A part picked in a design tab (@Headline) goes along as its selector and HTML.
    if (!held && picks.size) {
      const named = [...picks.values()].filter((p) => text.includes(`@${p.name}`));
      if (named.length) content = [...(typeof content === 'string' ? [{ type: 'text', text: content } as Block] : content), ...named.map((p): Block => ({ type: 'text', text: `[Rime: @${p.name} is ${p.selector} in ${p.file}]\n${p.html}` }))];
    }
    // What Rime did meanwhile (an /undo) goes to the model with this message.
    if (C.tell.length) content = [...(typeof content === 'string' ? [{ type: 'text', text: content } as Block] : content), ...C.tell.splice(0).map((t): Block => ({ type: 'text', text: t }))];
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
      await makeRoom(C, m, cn, ac.signal, true); // already full from earlier turns: compact first
      said = (await runTurn(h, ac.signal, userSeq)).said;
    } finally {
      if (C.busy === me) C.busy = null;
      C.nextStep = did.dev ? `/browser ${did.dev}` : nextFor(said, did, project);
      if (applying && C === S && did.wrote.length) finishApply();
      offerChoices(said, C);
      if (C === S) askTrust(); // the rules file changed during the reply
      if (upd.state === 'ready' && upd.folded && C === S) offerRestart();
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

  // ---- token-kit (Phase 6) ----

  // The slot a conversation uses on a llama.cpp server: its own when the server
  // has several (the last stays free for side calls), else slot 0 for everyone.
  const slotCount = (provider: string) => cfg.providers[provider]?.probe?.slots ?? 1;
  function slotOf(C: Session, provider: string) {
    const n = slotCount(provider);
    if (n < 2) return 0;
    const taken = new Set(sessions.filter((x) => x !== C && x.slot !== undefined).map((x) => x.slot));
    if (C.slot === undefined || C.slot >= n - 1 || taken.has(C.slot)) C.slot = [...Array(n - 1).keys()].find((k) => !taken.has(k)) ?? 0;
    return C.slot;
  }
  const sideSlot = (provider: string) => (slotCount(provider) >= 2 ? slotCount(provider) - 1 : 0);

  // A side call (a summary): no tools, reasoning off, the side slot on llama.cpp.
  // Its tokens count on the meter. ponytail: it uses the conversation's model; the
  // cheapest connected model, local first, comes with the router (Phase 7).
  async function sideCall(m: Model, cn: Conn, prompt: string, system: string, C: Session, signal?: AbortSignal) {
    let text = '', usage: Usage | null = null;
    for await (const ev of streamFor(cn)({ conn: cn, model: m, system, messages: [{ role: 'user', content: prompt }], controls: { reasoning: false }, signal, slot: cn.llamacpp ? sideSlot(cn.name) : undefined })) {
      if (ev.type === 'text') text += ev.text;
      else if (ev.type === 'usage') usage = ev.usage;
    }
    if (usage) C.meter.charge(usage, m.price, cn.local);
    return splitToolCalls(text).text.trim();
  }

  const contextOf = (m: Model) => m.context ?? cfg.providers[m.provider]?.probe?.ctx;
  // Pi-style compaction: the older part of the history becomes a summary, the
  // last ~20k tokens stay as they were. The system prompt and tools don't change,
  // so only the messages are processed again. Kept in rime.db as a compaction row.
  async function compact(C: Session, m: Model, cn: Conn, signal?: AbortSignal) {
    const size = contextOf(m) ?? 128000;
    const cut = cutPoint(C.messages, Math.min(20000, size * 0.25));
    if (!cut) return false;
    const before = Math.max(C.task?.lastPrompt ?? 0, tokensOf(C.messages));
    const row: Extract<Item, { kind: 'lines' }> = { kind: 'lines', lines: [[{ t: '  ⟳ ', s: st.accent }, { t: `compacting · summarising ${fmtT(tokensOf(C.messages.slice(0, cut)))} tokens of earlier conversation…`, s: st.dim }]] };
    const show = (l: Line) => ((row.lines = [l]), cache.delete(row), schedule());
    C.items.push(row);
    schedule();
    let summary = '';
    try {
      summary = await sideCall(m, cn, historyText(C.messages.slice(0, cut)), SUMMARY_SYSTEM, C, signal);
    } catch (e) {
      show([{ t: '  ! ', s: st.warn }, { t: `couldn't compact: ${(e as Error).message}`, s: st.dim }]);
      return false;
    }
    if (!summary) {
      show([{ t: '  ! ', s: st.warn }, { t: "couldn't compact: the summary came back empty", s: st.dim }]);
      return false;
    }
    const kept = C.messages.length - cut;
    C.messages.splice(0, C.messages.length, ...compacted(C.messages, cut, summary));
    save((d) => d.append(bound(C).conversation()!, 'system', [{ type: 'compaction', summary, kept }], false));
    const after = tokensOf(C.messages) + Math.ceil(C.system.length / 4);
    if (C.task) C.task.lastPrompt = after;
    bound(C).event('compact', `compacted ${fmtT(before)} → ${fmtT(after)} tokens`);
    show([{ t: '  ⟳ ', s: st.accent }, { t: `compacted ${fmtT(before)} → ${fmtT(after)} tokens · the next reply rebuilds the cache`, s: st.dim }]);
    return true;
  }

  // read with summary: a side call summarises the whole file; kept in
  // .rime/cache/ by the file's content and the model, so it's done once.
  async function summarize(file: string, C: Session, signal?: AbortSignal): Promise<ToolResult> {
    const p = path.resolve(cwd, file);
    let text: string;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch (e) {
      return { content: (e as Error).message, error: true, summary: 'not found' };
    }
    if (!model || !conn) return readTool(cwd, { path: file });
    const lines = text.split('\n').length;
    const key = createHash('sha256').update(text).digest('hex').slice(0, 16);
    const dir = rimeDir(project, 'cache');
    const hit = path.join(dir, `${key}-${model.ref.replace(/[^\w.-]+/g, '_')}.md`);
    if (fs.existsSync(hit)) return { content: fs.readFileSync(hit, 'utf8'), summary: `summary · ${lines} lines (cached)` };
    const size = contextOf(model) ?? 32000;
    const body = text.length > size * 2 ? text.slice(0, size * 2) + '\n… (cut)' : text; // half the context at most
    let out = '';
    try {
      out = await sideCall(model, conn, `File: ${rel(cwd, p)} (${lines} lines)\n\n${body}`, 'Summarise this file for a programmer who will change it: its purpose, its main parts with line numbers, exported names, and anything surprising. Plain text, under 300 words.', C, signal);
    } catch (e) {
      return { content: `Couldn't summarise: ${(e as Error).message}. Read it in ranges instead.`, error: true, summary: "couldn't summarise" };
    }
    const content = `Summary of ${rel(cwd, p)} (${lines} lines; read ranges with offset for exact code):\n${out}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(hit, content);
    return { content, summary: `summary · ${lines} lines` };
  }

  // ---- updater (Phase 9, SPEC §4.3, §10) ----
  // checking → offline / current (a line that goes after a few seconds), or
  // available (offered above the prompt; "not now" folds it into the status line)
  // → installing (in the background, while you work) → ready (offered at a quiet
  // moment: restart now, or the next start picks it up through the launcher).
  const upd: { state: 'off' | 'checking' | 'offline' | 'current' | 'available' | 'installing' | 'ready' | 'failed'; version?: string; changes?: string[]; folded?: boolean } = { state: 'off' };
  const launchVersion = (v: string) => {
    const n = newestVersion(pkgName, version);
    return n && n.version === v ? launchEntry(n.entry) : 0;
  };
  const launchEntry = (entry: string) => spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, RIME_LAUNCHED: '1', RIME_RESTARTED: '1' } }).status ?? 0;
  function checkUpdates() {
    if (!updates || process.env.RIME_NO_UPDATE_CHECK || cfg.updates === 'off') return;
    upd.state = 'checking';
    const row: Extract<Item, { kind: 'lines' }> = { kind: 'lines', lines: [[{ t: '  ● ', s: st.dim }, { t: 'checking npm…', s: st.dim }]] };
    const shown = S;
    shown.items.push(row);
    const gone = (ms: number) => setTimeout(() => (bound(shown).drop(row), schedule()), ms);
    void latestVersion(pkgName).then((l) => {
      if (!l) {
        upd.state = 'offline';
        row.lines = [[{ t: '  ○ ', s: st.dim }, { t: "offline · couldn't check npm for a new version", s: st.dim }]];
        gone(4000);
      } else if (compareVersions(l.version, version) <= 0) {
        upd.state = 'current';
        row.lines = [[{ t: '  ✓ ', s: st.ok }, { t: `Rime ${version} is up to date`, s: st.dim }]];
        gone(3000);
      } else {
        Object.assign(upd, { state: 'available', version: l.version, changes: l.changes });
        bound(shown).drop(row);
        offerUpdate();
      }
      cache.delete(row);
      schedule();
    });
  }
  function offerUpdate() {
    if (S.question || S.approval) return void (upd.folded = true);
    S.question = {
      q: `Rime ${upd.version} is out (you have ${version}).`,
      options: [{ label: `Update to ${upd.version}`, detail: upd.changes?.length ? upd.changes.join(' · ') : 'installs in the background while you work' }, { label: 'Not now', detail: '/update any time' }],
      sel: 0, tool: false,
      done: (a) => {
        S.question = null;
        if (a?.startsWith('Update')) void updateNow();
        else upd.folded = true;
        schedule();
      },
    };
    schedule();
  }
  async function updateNow() {
    if (upd.state === 'ready') return offerRestart(true);
    if (upd.state === 'installing') return say(`installing ${upd.version}…`);
    if (!updates) return note(`Rime ${version} isn't published to npm yet, so there's nothing to update from.`, 'dim');
    if (upd.state !== 'available') {
      say('checking npm…');
      const l = await latestVersion(pkgName);
      if (!l) return note("Couldn't reach npm to check for a new version.", 'dim');
      if (compareVersions(l.version, version) <= 0) return note(`Rime ${version} is up to date.`, 'dim');
      Object.assign(upd, { version: l.version, changes: l.changes });
    }
    upd.state = 'installing';
    upd.folded = false;
    const ac = new AbortController();
    const pr = progressRow(() => ac.abort());
    pr.update({ step: `Installing Rime ${upd.version} (npm)` });
    const r = await installVersion(pkgName, upd.version!, undefined, undefined, ac.signal);
    if (r.stopped) {
      upd.state = 'available';
      upd.folded = true;
      pr.finish(`stopped · Rime ${upd.version} wasn't installed; /update starts again`, 'stopped');
    } else if (!r.ok) {
      upd.state = 'failed';
      pr.finish(`couldn't install Rime ${upd.version}: ${r.error}`, false);
    } else {
      pr.finish(`Rime ${upd.version} installed`, true);
      upd.state = 'ready';
      offerRestart();
    }
    schedule();
  }
  // At a quiet moment (no reply or tool running anywhere), or when asked.
  function offerRestart(asked = false) {
    if (upd.state !== 'ready') return;
    if (!asked && (sessions.some((x) => x.busy) || S.question || S.approval)) return void (upd.folded = true);
    S.question = {
      q: `Rime ${upd.version} is installed.`,
      options: [{ label: 'Restart now', detail: 'this conversation reopens in the new version' }, { label: 'At the next start', detail: 'the launcher picks it up' }],
      sel: 0, tool: false,
      done: (a) => {
        S.question = null;
        if (a === 'Restart now') return quit(upd.version);
        upd.folded = true;
        schedule();
      },
    };
    schedule();
  }

  // ---- downloads and installs, live ----
  // One row in the transcript, updated in place: a ▰▱ bar with the size, speed
  // and time left once the size is known, else a spinner and the seconds so far.
  // ctrl+c stops it (the status line says so too, in case the row scrolled away).
  let running: { stop(): void; label: string } | null = null;
  const fmtB = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
  function progressRow(stop: () => void) {
    const row: Extract<Item, { kind: 'lines' }> = { kind: 'lines', lines: [] };
    S.items.push(row);
    const t0 = Date.now();
    let step = '', done: number | undefined, total: number | undefined, samples: [number, number][] = [];
    const me = { stop, label: '' };
    running = me;
    const elapsed = () => fmtS(Date.now() - t0);
    const draw = () => {
      const spin = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[Math.floor(Date.now() / 100) % 10];
      const stops: Line = [{ t: 'ctrl+c', s: st.accentB }, { t: ' stops', s: st.dim }];
      if (total && done !== undefined) {
        const b = bar(done / total, 24);
        const w = samples.filter(([t]) => Date.now() - t < 4000);
        const speed = w.length > 1 && w.at(-1)![0] > w[0][0] ? (w.at(-1)![1] - w[0][1]) / ((w.at(-1)![0] - w[0][0]) / 1000) : 0;
        const left = speed > 0 ? Math.ceil((total - done) / speed) : 0;
        me.label = `${step.replace(/^Downloading /, '')} ${b.pct.trim()}`;
        row.lines = [[{ t: `  ${spin} `, s: st.accent }, { t: `${step}  `, s: st.fg }, { t: b.fill, s: st.accent }, { t: b.empty, s: st.line }, { t: ` ${b.pct.trim()}`, s: st.titleB }, { t: ` · ${fmtB(done)} of ${fmtB(total)}${speed ? ` · ${fmtB(speed)}/s` : ''}${left ? ` · ${left < 60 ? `${left} s` : `${Math.ceil(left / 60)} min`} left` : ''} · `, s: st.dim }, ...stops]];
      } else {
        me.label = `${step} · ${elapsed()}`;
        row.lines = [[{ t: `  ${spin} `, s: st.accent }, { t: step, s: st.fg }, { t: ` · ${elapsed()} · `, s: st.dim }, ...stops]];
      }
      cache.delete(row);
      schedule();
    };
    const tick = setInterval(draw, 120);
    return {
      update(p: Progress) {
        if (p.step !== step) (step = p.step), (samples = []);
        (done = p.done), (total = p.total);
        if (p.done !== undefined) samples.push([Date.now(), p.done]);
        draw();
      },
      finish(text: string, ok: boolean | 'stopped') {
        clearInterval(tick);
        if (running === me) running = null;
        row.lines = [[{ t: ok === true ? '  ✓ ' : ok === 'stopped' ? '  ■ ' : '  ✗ ', s: ok === true ? st.ok : ok === 'stopped' ? st.dim : st.warn }, { t: `${text} · ${elapsed()}`, s: st.dim }]];
        cache.delete(row);
        schedule();
      },
    };
  }

  // ---- browser plug-in (Phase 11) ----
  // One browser per window, in a split-view tab; it starts with the first /browser
  // or the first browser tool call, and closes with its tab or with Rime.
  let browser: BrowserSession | null = null;
  let opening: Promise<BrowserSession> | null = null;
  let browserTab: object | null = null;
  function browserNow() {
    if (browser) {
      // Already open: bring its tab into view.
      const i = side.tabs.indexOf(browserTab as never);
      if (i >= 0) side.go(i);
      return Promise.resolve(browser);
    }
    opening ??= openBrowser({ st, color: (rgb, bg) => sgr(rgb, bg, st.mode), redraw: () => schedule(), onClose: () => (browser = null), log: (l) => note(l, 'dim') })
      .then((b) => {
        browser = b;
        browserTab = side.custom(b.tab, true); // you'll want to watch it, so it's the tab showing
        return b;
      })
      .finally(() => (opening = null));
    return opening;
  }
  // The browser and design plug-ins share Playwright in ~/.rime/plugins/browser:
  // asked about once, then each is turned on (its tool joins new conversations).
  function withPlaywright(plugin: 'browser' | 'design', then: () => void) {
    const on = () => {
      if (!cfg.plugins?.[plugin]) {
        cfg.plugins = { ...cfg.plugins, [plugin]: true };
        settings.save();
        note(`${plugin} plug-in on · its tool joins your next conversation (/clear starts one)`, 'dim');
      }
      then();
    };
    if (browserInstalled()) return on();
    const chromeHere = hasChrome();
    S.question = {
      q: `Turn on the ${plugin} plug-in? It shows ${plugin === 'browser' ? 'your web app' : 'the page you design'} in a tab here, rendered by Chrome. Playwright goes into ~/.rime/plugins/browser, not into your project.`,
      options: [
        ...(chromeHere ? [{ label: 'Use my Chrome', detail: 'downloads Playwright only (~10 MB)' }] : []),
        { label: 'Download Chromium', detail: '~150 MB, once' },
        { label: 'Not now', detail: 'nothing is installed' },
      ],
      sel: 0, tool: false,
      done: (a) => {
        S.question = null;
        if (!a || a === 'Not now') return schedule();
        const useChrome = a === 'Use my Chrome';
        const ac = new AbortController();
        const pr = progressRow(() => ac.abort());
        void installBrowser(useChrome, (p) => pr.update(p), ac.signal).then((r) => {
          if (r.stopped) return pr.finish(`stopped · nothing was turned on; /${plugin} starts again`, 'stopped');
          if (!r.ok) return pr.finish(`couldn't set up Playwright: ${r.error}`, false);
          pr.finish(useChrome ? 'Playwright installed · it uses your Chrome' : 'Playwright and Chromium installed', true);
          on();
        });
        schedule();
      },
    };
    schedule();
  }
  // A local file (index.html, ./site/a.html, ~/x.html) as a file:// address.
  const pageUrl = (raw: string) => {
    const p = path.resolve(cwd, raw.replace(/^~(?=\/)/, os.homedir()));
    return !/^[a-z]+:\/\//i.test(raw) && fs.existsSync(p) ? pathToFileURL(p).href : raw;
  };
  // /browser [url | file] · /browser use chrome | chromium · /browser uninstall
  function browserCmd(args: string[] | string = []) {
    const a = typeof args === 'string' ? [args] : args;
    if (a[0] === 'uninstall') return browserUninstall();
    if (a[0] === 'use') {
      if (!/^(chrome|chromium)$/i.test(a[1] ?? '')) return void note('/browser use chrome, or /browser use chromium', 'dim');
      return browserUse(a[1].toLowerCase() === 'chrome');
    }
    const url = a.join(' ').trim() ? pageUrl(a.join(' ').trim()) : '';
    withPlaywright('browser', async () => {
      try {
        const b = await browserNow();
        if (url) note((await b.act({ action: 'open', url })).split('.')[0], 'dim');
      } catch (e) {
        note(`The browser didn't start: ${(e as Error).message.split('\n')[0]}`);
      }
    });
  }

  // Switching browsers: the open browser and design tabs close (they share one
  // Chrome), and the next /browser starts the other one. Chromium downloads with
  // its progress the first time.
  function browserUse(chrome: boolean) {
    if (chrome && !hasChrome()) return void note("Google Chrome isn't installed on this computer; /browser use chromium downloads Chromium instead.", 'dim');
    if (browserInstalled() && usesChrome() === chrome) return void note(`The browser plug-in already uses ${chrome ? 'your Chrome' : 'Chromium'}.`, 'dim');
    side.closePlugins();
    closeChrome();
    browser = null;
    const ac = new AbortController();
    const pr = progressRow(() => ac.abort());
    void installBrowser(chrome, (p) => pr.update(p), ac.signal).then((r) => {
      if (r.stopped) return pr.finish('stopped · the browser plug-in is as it was', 'stopped');
      if (!r.ok) return pr.finish(`couldn't switch: ${r.error}`, false);
      if (!cfg.plugins?.browser) (cfg.plugins = { ...cfg.plugins, browser: true }), settings.save();
      pr.finish(`the browser plug-in now uses ${chrome ? 'your Chrome' : 'Chromium'} · /browser opens it`, true);
    });
  }
  // /browser uninstall: asks, then removes Playwright, the Chromium it downloaded
  // and the plug-ins' settings; their tools leave new conversations.
  function browserUninstall() {
    if (!browserInstalled() && !cfg.plugins?.browser && !cfg.plugins?.design) return void note('The browser plug-in isn\'t installed.', 'dim');
    S.question = {
      q: `Remove the browser plug-in? It deletes ~/.rime/plugins/browser${usesChrome() ? '' : ' and the Chromium it downloaded'}; the browser and design tabs close. Your Chrome and your design files stay.`,
      options: [{ label: 'Remove it' }, { label: 'Keep it' }],
      sel: 1, tool: false,
      done: (a) => {
        S.question = null;
        if (a !== 'Remove it') return schedule();
        side.closePlugins();
        browser = null;
        const pr = progressRow(() => {});
        pr.update({ step: 'Removing the browser plug-in' });
        void uninstallBrowser().then((r) => {
          if (!r.ok) return pr.finish(`couldn't remove it: ${r.error}`, false);
          cfg.plugins = { ...cfg.plugins, browser: false, design: false };
          settings.save();
          pr.finish('the browser plug-in is removed · its tools leave your next conversation; /browser sets it up again', true);
        });
        schedule();
      },
    };
    schedule();
  }

  // ---- design plug-in (Phase 12) ----
  const designs = new Map<string, DesignSession>();
  const picks = new Map<string, Pick>(); // @Name in the prompt -> what was picked
  const designHost = () => ({
    st, color: (rgb: [number, number, number], bg: boolean) => sgr(rgb, bg, st.mode), redraw: () => schedule(), onClose: () => {}, log: (l: string) => note(l, 'dim'), project,
    insert: (t: string) => ((buf = buf.slice(0, cur) + t + buf.slice(cur)), (cur += t.length), (sideFocus = false), schedule()),
    pick: (p: Pick) => void picks.set(p.name, p),
    // a: a sketch becomes a page in the project (today's export); a design made
    // from the project's page changes that page's real source (docs/split-v2.md §4.6).
    apply: (file: string, version: number, from?: From) => {
      sideFocus = false;
      if (!from?.url && !from?.file) return void send(`Turn ${file} (version ${version}) into components in this project's stack (for example src/pages/${file.replace(/^design\/|\.html$/g, '').replace(/(^|-)(\w)/g, (_, _d, c) => c.toUpperCase())}.tsx), following its conventions, and start the dev server if it isn't running.`);
      applying = { file, url: from.url };
      void send(`Apply ${file} (version ${version}) to the project: change the source files that render ${from.url ?? from.file}${from.file ? ` (${from.file} and its CSS)` : " (the route's component and its CSS)"} so the page matches it. Read ${file} first, and keep the project's components and conventions.`);
    },
    credit: () => void credit(),
  });
  async function designTab(name: string) {
    const open = designs.get(name);
    if (open && side.tabs.some((t) => t.title === open.tab.title)) return side.go(side.tabs.findIndex((t) => t.title === open.tab.title)), open;
    const d = await openDesign(designHost(), name);
    designs.set(name, d);
    const close = d.tab.close;
    side.custom({ ...d.tab, close: () => (close?.(), designs.delete(name)) }, true);
    return d;
  }
  // /design new <what> · /design <name> · /design (the last one)
  function designCmd(args: string[]) {
    withPlaywright('design', async () => {
      try {
        let name = args[0] === 'new' ? designSlug(args.slice(1).join(' ') || 'page') : args[0] ? designSlug(args[0]) : '';
        if (!name) {
          const dir = path.join(project, 'design');
          const last = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs)[0] : '';
          if (!last) return note('No design yet. /design new <what> starts one, e.g. /design new landing page for a notes app', 'dim');
          name = last.replace(/\.html$/, '');
        }
        const abs = path.join(project, designFile(name));
        if (!fs.existsSync(abs)) {
          if (args[0] !== 'new') return note(`There's no ${designFile(name)}. /design new ${args.join(' ')} starts it.`, 'dim');
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, starter(args.slice(1).join(' ') || name));
          S.tell.push(`[Rime: the user started a design in ${designFile(name)}. Change it with the design tool (name "${name}").]`);
        }
        await designTab(name);
      } catch (e) {
        note(`The design tab didn't open: ${(e as Error).message.split('\n')[0]}`);
      }
    });
  }

  // ---- split view v2 (docs/split-v2.md): what the panel asks of the app ----
  const scriptsOf = (): Record<string, string> => {
    try {
      return JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).scripts ?? {};
    } catch {
      return {};
    }
  };
  const designNames = () => {
    try {
      return fs.readdirSync(path.join(project, 'design')).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5));
    } catch {
      return [];
    }
  };
  const runningServer = () => side.tabs.find((t): t is ShellTab & { serve: { url: string } } => t.kind === 'shell' && !!t.serve?.url && t.state === 'running');
  const shortUrl = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/$/, '');
  // @ in the panel: the file (or its lines) goes into the chat prompt as a chip;
  // focus stays where it is.
  function mention(ref: string, lines?: [number, number]) {
    try {
      addChip(chipFor(path.join(project, ref), nextN, cwd, schedule, lines));
      side.toast(`@${ref}${lines ? `:${lines[0]}${lines[1] !== lines[0] ? `-${lines[1]}` : ''}` : ''} is in the chat prompt`);
    } catch (e) {
      side.toast(`can't add ${ref}: ${(e as Error).message}`);
    }
  }
  // The browser tab at an address (or a local HTML file); `from`: the server tab
  // it came from (found by its address when not given). `say`: one chat line.
  function browse(raw: string, from?: number, say = false): Promise<void> {
    const url = pageUrl(raw);
    const short = shortUrl(url);
    addresses.splice(0, addresses.length, short, ...addresses.filter((a) => a !== short).slice(0, 9));
    from ??= side.tabs.find((t) => t.kind === 'shell' && t.serve?.url && /^(https?:\/\/)?/.test(url) && shortUrl(url).startsWith(shortUrl(t.serve.url)))?.id;
    return new Promise((done) =>
      withPlaywright('browser', async () => {
        try {
          const b = await browserNow();
          if (browserTab) side.link(browserTab, { from });
          await b.act({ action: 'open', url });
          if (say) S.items.push({ kind: 'tool', verb: '◐', rest: `opened ${short} → tab ${side.tabs.indexOf(browserTab as never) + 1}` });
        } catch (e) {
          side.toast(`couldn't open ${short}: ${(e as Error).message.split('\n')[0]}`);
        }
        done();
        schedule();
      }),
    );
  }
  // :design [name or url], the switcher's rows, "redesign my pricing page": your
  // page at an address, a source file's page on the running server, or a sketch.
  function designAny(arg: string) {
    const a = arg.trim(), sv = runningServer();
    if (!a) return sv ? designFromPage(shortUrl(sv.serve.url)) : designCmd([]);
    if (/^(localhost|127\.|https?:|\/)/.test(a)) return designFromPage(a.startsWith('/') ? `${sv ? shortUrl(sv.serve.url) : 'localhost:3000'}${a}` : a);
    if (!a.startsWith('design/') && /\.\w+$/.test(a) && fs.existsSync(path.join(project, a))) {
      if (!sv) return note(`Start the server first (:serve in the panel), then :design ${a} captures its page.`, 'dim');
      const route = path.basename(a).replace(/\.\w+$/, '').toLowerCase().replace(/^(index|home|app|page)$/, '');
      return designFromPage(`${shortUrl(sv.serve.url)}/${route}`, a);
    }
    designCmd(fs.existsSync(path.join(project, designFile(designSlug(a)))) ? [a] : ['new', a]);
  }
  // A design idea typed in the panel: the tab starts, and the idea goes to the
  // chat as a message, so the conversation keeps the record.
  function designIdea(text: string) {
    designCmd(['new', text]);
    sideFocus = false;
    void send(`design ${text}`);
  }
  // "Your page" (§4.6): the running page saved as design/<name>.html v1, a static
  // copy; nothing in the project changes until the user applies a version.
  function designFromPage(url: string, file?: string) {
    const short = shortUrl(url);
    const name = designSlug(short.split('/').slice(1).filter(Boolean).pop() || 'home');
    withPlaywright('design', async () => {
      try {
        const html = await capture(designHost(), url);
        const abs = path.join(project, designFile(name));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, html);
        createVersions(project, name).setFrom({ url: short, ...(file ? { file } : {}) });
        index?.put(designFile(name));
        const d = await designTab(name);
        S.items.push({ kind: 'tool', verb: '✎', rest: `captured ${short} as ${designFile(name)} v${d.version()} → tab ${side.active + 1}` });
        S.tell.push(`[Rime: the user started a design from their page ${short}${file ? ` (${file})` : ''}: ${designFile(name)}, a static copy. Change it with the design tool (name "${name}"); nothing in the project changes until they apply it.]`);
      } catch (e) {
        note(`Couldn't capture ${short}: ${(e as Error).message.split('\n')[0]}`);
      }
      schedule();
    });
  }
  // After an apply's turn wrote files: the page opens in the browser tab, linked
  // from the server and from the design (✎ pricing v3 → 3).
  let applying: { file: string; url?: string } | null = null;
  function finishApply() {
    const a = applying!;
    applying = null;
    if (!a.url) return;
    const sv = runningServer();
    if (!sv) return note(`No server is running: :serve in the panel starts it, then :open ${a.url} shows the page.`, 'dim');
    const name = path.basename(a.file, '.html');
    const d = side.tabs.find((t) => t.kind === 'custom' && t.title.startsWith(`${name} v`));
    void browse(a.url, sv.id).then(() => d && browserTab && side.link(d, { to: (browserTab as { id: number }).id }));
  }

  // ---- code-index (Phase 5) ----

  // Names in the prompt that the index knows: a file path (or a unique file name),
  // or a declaration that looks like code (validateEmail, parse_config, UserForm)
  // with at most two definitions. At most two pieces, 80 lines of a file or 60
  // from a declaration.
  function preattach(text: string): { label: string; block: Block }[] {
    const ix = index!, out: { label: string; block: Block }[] = [], seen = new Set<string>();
    const all = ix.files();
    for (const tok of text.match(/[\w$./-]+/g) ?? []) {
      if (out.length >= 2) break;
      let pick: { path: string; line: number } | null = null;
      const t = tok.replace(/^\.\//, '').replace(/[.,:;]+$/, '');
      if (/\.\w{1,5}$/.test(t) && /[a-z]/i.test(t)) {
        const m = ix.has(t) ? [t] : all.filter((f) => f.endsWith('/' + t) || f === t);
        if (m.length === 1) pick = { path: m[0], line: 1 };
      } else if (/^[A-Za-z_$][\w$]{3,}$/.test(t) && /[a-z][A-Z]|[a-z]_[a-z]|^[A-Z][a-z]+[A-Z]/.test(t)) {
        const d = ix.exact(t);
        if (d.length && d.length <= 2) pick = { path: d[0].path, line: Math.max(1, d[0].line - 3) };
      }
      if (!pick || seen.has(pick.path)) continue;
      seen.add(pick.path);
      const r = readTool(cwd, { path: path.join(project, pick.path), offset: pick.line, limit: pick.line === 1 ? 80 : 60 } as { path: string });
      if (r.error) continue;
      out.push({ label: pick.line === 1 ? pick.path : `${pick.path}:${pick.line}`, block: { type: 'text', text: `[Rime: from the code index, likely relevant: ${pick.path}]\n${r.content}` } });
    }
    return out;
  }

  // ---- diff-undo (Phase 8) ----
  let cpsMade: Checkpoints | null | undefined;
  const checkpointsOf = () => {
    if (cpsMade === undefined)
      try {
        cpsMade = createCheckpoints(project);
      } catch {
        cpsMade = null;
      }
    return cpsMade;
  };
  const changeLine = (ch: { file: string; how: string }[]) => ch.map((c) => `${c.file} ${c.how === 'added' ? 'created' : c.how}`).join(' · ');
  // /diff: what changed since the last checkpoint, coloured, at most 400 lines.
  function showDiff() {
    S.items.push({ kind: 'user', text: '/diff' });
    const cps = checkpointsOf(), cp = cps?.last();
    if (!cps || !cp) return void (note('No changes to show: Rime takes a checkpoint before it changes a file.', 'dim'), handled());
    const ch = cps.changes(cp);
    if (!ch.length) return void (note(`Nothing changed since before "${cp.label}".`, 'dim'), handled());
    if (side.visible) {
      side.diff(cps.diff(cp), true);
      S.items.push({ kind: 'lines', lines: [[{ t: '± ', s: st.accent }, { t: `since before "${cp.label}" · `, s: st.dim }, { t: changeLine(ch), s: st.title }, { t: ' → diff tab', s: st.accent }]] });
      return void handled();
    }
    const lines = cps.diff(cp).split('\n').filter((l) => !/^(index |diff --git|new file mode|deleted file mode|similarity)/.test(l));
    const show = lines.slice(0, 400).map((l): Line => [{ t: '  ' + l, s: l.startsWith('+++') || l.startsWith('---') ? st.titleB : l.startsWith('+') ? st.ok : l.startsWith('-') ? st.del : l.startsWith('@@') ? st.accent : st.dim }]);
    S.items.push({ kind: 'lines', lines: [[{ t: '± ', s: st.accent }, { t: `since before "${cp.label}" · ${ago(cp.at)} · `, s: st.dim }, { t: changeLine(ch), s: st.title }], ...show, ...(lines.length > 400 ? [[{ t: `  … ${lines.length - 400} more lines`, s: st.dim }]] : []), [{ t: '  /undo', s: st.accent }, { t: ' puts them back', s: st.dim }]] });
    handled();
  }
  // /undo: the files go back to the last checkpoint, and the model hears about it
  // with the next message. Again goes one change further back.
  function undo() {
    S.items.push({ kind: 'user', text: '/undo' });
    if (S.busy) return void note('Rime is working; /undo after this reply.', 'dim');
    const cps = checkpointsOf(), cp = cps?.last();
    if (!cps || !cp) return void (note('Nothing to undo: no change by Rime is on record here.', 'dim'), handled());
    let ch: { file: string; how: string }[];
    try {
      ch = cps.undo(cp);
    } catch (e) {
      return void note(`Couldn't undo: ${(e as Error).message}`);
    }
    const what = ch.length ? ch.map((c) => `${c.file} ${c.how === 'added' ? 'removed' : 'restored'}`).join(', ') : 'nothing had changed';
    S.items.push({ kind: 'lines', lines: [[{ t: '↶ ', s: st.accent }, { t: `undid "${cp.label}" · `, s: st.dim }, { t: what, s: st.title }]] });
    S.tell.push(`[Rime: the user undid your changes from "${cp.label}": ${what}. Those files are as they were before that.]`);
    if (S.convId) bound(S).event('edit', `undid "${cp.label}"`);
    handled();
  }

  // /compact: now, between replies.
  async function compactNow() {
    const C = S;
    if (C.busy) return say('Rime is working; /compact after this reply');
    if (!model || !conn) return note('Connect a model first; /compact uses it to write the summary.');
    if (!C.messages.length) return say('nothing to compact yet');
    const ac = new AbortController(), me = { abort: () => ac.abort(), esc: () => ac.abort() };
    C.busy = me;
    schedule();
    try {
      if (!(await compact(C, model, conn, ac.signal))) note('Nothing to compact: the conversation is still short.', 'dim');
    } finally {
      if (C.busy === me) C.busy = null;
      schedule();
    }
  }

  // Before the context overflows: hosted models first lose old tool output, all at
  // once and rarely (from half full); at 80% the older part is summarised. Not on
  // llama.cpp, where clearing the middle means reprocessing everything after it.
  // False when it's still over 90% and nothing helped.
  async function makeRoom(C: Session, m: Model, cn: Conn, signal?: AbortSignal, quiet = false) {
    const size = contextOf(m);
    if (!size) return true;
    let used = C.task?.lastPrompt ?? 0;
    if (!cn.llamacpp && used > size * 0.5) {
      const freed = Math.floor(clearOld(C.messages) / 4);
      if (freed > 500) {
        used -= freed;
        if (C.task) C.task.lastPrompt = used;
        bound(C).note(`cleared old tool output (~${fmtT(freed)} tokens) to save context`, 'dim');
      }
    }
    if (used <= size * 0.8 || (await compact(C, m, cn, signal))) return true;
    if (used <= size * 0.9 || quiet) return true;
    bound(C).note(`This conversation fills ${Math.round((used / size) * 100)}% of ${m.label}'s context (${fmtT(used)} of ${fmtT(size)} tokens) and couldn't be compacted, so Rime stopped before the next step. Say "continue" to go on anyway, or /clear to start fresh.`);
    return false;
  }

  // Saved slots (providers.md §6.2): before the server stops or powers off, each
  // open conversation's slot goes to a file on its disk; after the next start the
  // one on screen is restored, so it doesn't rebuild a long context. The file is
  // named by conversation and prefix, so a changed prompt never restores old state.
  const slotFile = (C: Session) => `rime-${C.convId}-${createHash('sha256').update(hashOf(C.tools) + C.system).digest('hex').slice(0, 8)}.bin`;
  const cached = (name: string) => sessions.filter((x) => x.convId && x.messages.length && model?.provider === name);
  const routerModel = (name: string) => (cfg.providers[name]?.router ? (model?.provider === name ? model.id : cfg.providers[name].model) : undefined);
  async function saveCache(name: string) {
    const port = tunnels[name]?.port;
    if (!port) return '';
    let n = 0;
    for (const x of cached(name)) {
      const r = await llama.slotAction(`http://127.0.0.1:${port}`, slotOf(x, name), 'save', slotFile(x), routerModel(name)).catch(() => null);
      if (r && r.status < 300) n += Number(r.json?.n_saved ?? 0);
    }
    return n ? `saved the cache (${fmtT(n)} tokens)` : '';
  }
  async function restoreCache(name: string) {
    const port = tunnels[name]?.port;
    if (!port || !S.convId || !cached(name).includes(S)) return;
    const t0 = Date.now();
    const r = await llama.slotAction(`http://127.0.0.1:${port}`, slotOf(S, name), 'restore', slotFile(S), routerModel(name)).catch(() => null);
    const n = Number(r?.json?.n_restored ?? 0);
    if (r && r.status < 300 && n) note(`restored this conversation's cache (${fmtT(n)} tokens in ${fmtS(Date.now() - t0)})`, 'dim');
  }
  // The same save, as shell commands run on the server when Rime quits (quitting
  // never waits): one curl per conversation, then the stop or power off.
  function saveOnServer(name: string) {
    const p = cfg.providers[name], remote = p.tunnel?.remote ?? '127.0.0.1:8080', key = providerKey(p), rm = routerModel(name);
    return cached(name)
      .map((x) => `curl -s -m 120 -X POST 'http://${remote}/slots/${slotOf(x, name)}?action=save${rm ? `&model=${encodeURIComponent(rm)}` : ''}' -H 'Content-Type: application/json'${key ? ` -H 'Authorization: Bearer ${key}'` : ''} -d '{"filename":"${slotFile(x)}"}' >/dev/null 2>&1; `)
      .join('');
  }

  // The turn loop lives in agent.ts; this is its host for one conversation: the
  // request, storage, permissions and questions, and the screen built from its
  // events (thinking, the reply, the live "writing…" row, tool rows, cost).
  function turnHost(C: Session, m: Model, cn: Conn, c: Controls, ac: AbortController, did: Did, setEsc: (f: () => void) => void, label = ''): TurnHost {
    // Commands mirrored into split view's tabs, by tool call; the tab learns how it ended.
    const mirrors = new Map<unknown, { tab: number; write: (s: string) => void; done: (code: number) => void }>();
    const tabbed = async (u: Block, r: ToolResult | Promise<ToolResult>) => {
      const res = await r;
      mirrors.get(u.id)?.done(res.error ? Number(/exit (\d+)/.exec(res.summary)?.[1] ?? 1) : 0);
      return res;
    };
    const { store, note, drop, addConvRule, detail, event } = bound(C);
    // diff-undo: a checkpoint before this turn's first change.
    let cp: ReturnType<Checkpoints['begin']> | null = null;
    const checkpoint = (u: Block, d: Decision) => {
      const cps = checkpointsOf();
      const writes = u.name === 'write' || u.name === 'edit' || u.name === 'design';
      if (!cps || !(writes || (u.name === 'bash' && !d.parts?.every((p) => p.why === 'read-only')))) return;
      try {
        cp ??= cps.begin(label || 'a turn');
        if (writes) cps.touch(cp, u.name === 'design' ? designFile(designSlug(String((u.input as Record<string, unknown>)?.name ?? 'page'))) : rel(project, path.resolve(cwd, String((u.input as Record<string, unknown>)?.path ?? ''))));
      } catch {} // no git binary, unreadable file: the change still runs
    };
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
      } else if (e.type === 'run') {
        // In split view a command's output streams into its own tab ("→ tab 4").
        const bg = e.use.name === 'bash' && !!(e.use.input as Record<string, unknown>)?.background;
        const tab = e.use.name === 'bash' && !bg && side.visible && C === S ? side.mirror(String((e.use.input as Record<string, unknown>)?.command ?? '')) : null;
        if (tab) mirrors.set(e.use.id, tab);
        const extra = [...(e.decision.verdict === 'allow' && e.use.name === 'bash' ? [{ t: ` · ${e.decision.why}`, s: st.dim }] : []), ...(tab ? [{ t: ` → tab ${tab.tab}`, s: st.accent }] : bg ? [{ t: ` → tab ${side.tabs.length + 1} · server, stays running`, s: st.accent }] : [])];
        C.items.push({ ...toolLine(e.use), ...(extra.length ? { extra } : {}) } as Item);
      }
      else if (e.type === 'ran') {
        const input = (e.use.input ?? {}) as Record<string, any>, r = e.result;
        const file = rel(cwd, path.resolve(cwd, String(input.path ?? '')));
        if ((e.use.name === 'write' || e.use.name === 'edit') && !r.error) {
          const rp = rel(project, path.resolve(cwd, String(input.path ?? '')));
          did.wrote.push(file), index?.put(rp);
          edited.splice(0, edited.length, rp, ...edited.filter((x) => x !== rp).slice(0, 19));
        }
        if (e.use.name === 'bash') did.ran.push({ cmd: String(input.command), ok: !r.error, out: r.output });
        // A dev server's address in a command's output: the next step offers it in the browser tab.
        if (e.use.name === 'bash') did.dev = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+[^\s'")]*/.exec(r.output?.join('\n') ?? r.content)?.[0] ?? did.dev;
        if (e.use.name === 'read' && !r.error) (did.about ??= []).push(file);
        for (const x of toolEvents(String(e.use.name), input, r, file)) event(x.kind, x.text, x.ref);
        // What it did, short: the diff of an edit, the end of a command's output.
        if (r.diff) detail(r.diff.map((x) => [{ t: x.n ? `${String(x.n).padStart(4)} ` : '     ', s: st.dim }, { t: x.sign === ' ' ? x.text : `${x.sign} ${x.text}`, s: x.sign === '+' ? st.ok : x.sign === '-' ? st.del : st.dim }]));
        else if (r.output?.length) {
          const tail = r.output.slice(-6);
          detail([...(r.output.length > 6 ? [[{ t: `… ${r.output.length - 6} more lines`, s: st.dim }]] : []), ...tail.map((l) => [{ t: l, s: st.dim }]), [{ t: r.summary, s: r.error ? st.warn : st.dim }]]);
        } else detail([[{ t: r.summary, s: r.error ? st.warn : st.dim }]]);
      } else if (e.type === 'held') note('Rime asked you something, so it waits for your answer before running that.', 'dim');
      schedule();
    };
    return {
      messages: C.messages,
      stream: (signal) => streamFor(cn)({ conn: cn, model: m, system: C.system, tools: C.tools, messages: C.messages, controls: cn.wire === 'anthropic' ? C.task!.controls : c, signal, slot: cn.llamacpp ? slotOf(C, cn.name) : undefined }),
      store: {
        append: (role, content, interrupted) => save((d) => d.append(bound(C).conversation()!, role, content, interrupted)) ?? 0,
        update: (seq, content, interrupted) => void save((d) => d.update(C.convId!, seq, content, interrupted)),
        remove: (seq) => void save((d) => d.remove(C.convId!, seq)),
      },
      emit: on,
      decide: (u) => {
        const inp = (u.input ?? {}) as Record<string, any>;
        // The design tool writes design/<name>.html: the same check as a write.
        const d = u.name === 'design' ? decide('write', { path: designFile(designSlug(String(inp.name ?? 'page'))), content: inp.html }, permCtx(C)) : decide(String(u.name), inp, permCtx(C));
        decisions.unshift({ at: Date.now(), tool: String(u.name), what: `${describe(u).verb} ${describe(u).rest}`, verdict: d.verdict, why: d.why, src: d });
        decisions.length = Math.min(decisions.length, 50);
        return d;
      },
      approve: async (u, d, signal) => {
        const answer = await ask(u, d, signal, C);
        const e = decisions.find((x) => x.src === d);
        if (e) e.answered = answer === 'no' ? 'no' : answer === 'stop' ? 'stopped' : 'yes';
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
            C.items.push({ kind: 'lines', lines: [[{ t: '⚙ ', s: st.accent }, { t: `allowed ${edits ? 'edits' : u.name === 'browser' ? `pages on ${d.label}` : `${d.label} commands`} in this conversation · /permissions`, s: st.dim }]] });
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
      run: async (u, d, signal) => (checkpoint(u, d), tabbed(u, runTool(String(u.name), (u.input ?? {}) as Record<string, any>, signal, C, { project, sandbox: mode === 'auto' && d.verdict === 'allow', readOnly: !!d.parts?.length && d.parts.every((p) => p.why === 'read-only'), passEnv: cfg.passEnv, onOutput: mirrors.get(u.id)?.write }))),
      optionsOf,
      queued: () => takeQueued(C),
      afterRound: (signal) => makeRoom(C, m, cn, signal),
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
    const verb = { read: 'Read', write: 'Write', edit: 'Edit', bash: 'Bash', rime: 'Rime', ask: 'Asked', search: 'Search', browser: 'Browser', design: 'Design' }[String(u.name)] ?? String(u.name);
    const rest = u.name === 'design' ? designFile(designSlug(String(i.name ?? 'page'))) : u.name === 'browser' ? [i.action, i.url ?? (i.ref ? `[ref=${i.ref}]` : ''), i.text ? `"${i.text}"` : ''].filter(Boolean).join(' ') : u.name === 'search' ? String(i.query ?? '') : u.name === 'bash' ? String(i.command ?? '').split('\n')[0] : u.name === 'ask' ? String(i.question ?? '') : u.name === 'rime' ? `${i.action ?? ''}${i.args ? ' ' + JSON.stringify(i.args) : ''}` : rel(cwd, path.resolve(cwd, String(i.path ?? '')));
    return { verb, rest };
  };
  const toolLine = (u: Block): Item => ({ kind: 'tool', ...describe(u) });
  const detail = (lines: Line[]) => bound(S).detail(lines);

  function runTool(name: string, input: Record<string, any>, signal: AbortSignal, C: Session, as: RunAs = {}): ToolResult | Promise<ToolResult> {
    const { conversation, store, note, drop, addConvRule, detail } = bound(C);
    if (name === 'read') return input.summary ? summarize(String(input.path ?? ''), C, signal) : readTool(cwd, input as { path: string });
    if (name === 'write') return writeTool(cwd, input as { path: string; content: string });
    if (name === 'edit') return editTool(cwd, input as { path: string; old: string; new: string });
    if (name === 'bash' && input.background) return background(String(input.command ?? ''), as);
    if (name === 'bash') return bashTool(cwd, input as { command: string }, signal, as);
    if (name === 'browser') {
      if (!cfg.plugins?.browser || !browserInstalled()) return { content: 'The browser plug-in is off; the user turns it on with /browser.', error: true, summary: 'browser off' };
      return browserNow()
        .then((b) => b.act(input))
        .then((text) => ({ content: text, summary: text.split('\n')[0].slice(0, 80) }))
        .catch((e) => ({ content: (e as Error).message.split('\n').slice(0, 3).join('\n'), error: true, summary: (e as Error).message.split('\n')[0].slice(0, 80) }));
    }
    if (name === 'design') {
      const n = designSlug(String(input.name ?? 'page'));
      const abs = path.join(project, designFile(n));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, textOf(input.html));
      index?.put(designFile(n));
      return designTab(n)
        .then(async (d) => {
          const fits = await overflow(designHost(), abs).catch((e) => `couldn't check the sizes: ${(e as Error).message.split('\n')[0]}`);
          return { content: `Saved ${designFile(n)} as version ${d.version()}. ${fits}.`, summary: `version ${d.version()} · ${/overflows/.test(fits) ? 'overflows' : 'fits'}` };
        })
        .catch((e) => ({ content: `Saved ${designFile(n)}; the tab didn't open: ${(e as Error).message.split('\n')[0]}`, summary: 'saved' }));
    }
    if (name === 'search') {
      if (!index) return { content: 'The code index is still being built; use bash with rg or grep for now.', error: true, summary: 'index not ready' };
      const hits = index.search(String(input.query ?? ''), Math.min(20, Math.max(1, Number(input.limit) || 20)));
      const content = hits.map((h) => `${h.path}:${h.line}: ${h.symbol ? `[${h.symbol}] ` : ''}${h.text.slice(0, 160)}`).join('\n');
      return { content: content || 'No matches.', summary: `${hits.length} match${hits.length === 1 ? '' : 'es'}`, output: content ? content.split('\n') : [] };
    }
    if (name === 'rime') {
      return Promise.resolve(rimeTool(String(input.action ?? ''), (input.args ?? {}) as Record<string, any>, C, signal)).then((text) => ({ content: text, summary: text.split('\n')[0] }));
    }
    return { content: `Unknown tool ${name}.`, error: true, summary: 'unknown tool' };
  }

  // bash with background: true (docs/split-v2.md §4.4, §6): the command runs in a
  // server tab, not bound to the bash timeout, and the model gets its first lines
  // once it prints an address or after 10 s. Auto mode's sandbox still applies.
  async function background(cmd: string, as: RunAs): Promise<ToolResult> {
    const box = as.sandbox ? sandboxed(cmd, project) : null;
    const t = side.serve(cmd, { byRime: true, focus: false, ...(box ? { argv: box } : {}) });
    for (const t0 = Date.now(); Date.now() - t0 < 10000 && t.state === 'running' && !t.serve?.url; ) await new Promise((r) => setTimeout(r, 200));
    const n = side.tabs.indexOf(t) + 1;
    const first = t.out.slice(1, 31).join('\n');
    const up = t.state === 'running';
    const where = up ? `running in tab ${n} (tab.read to see more)` : `ended in tab ${n} (exit ${t.code ?? '?'})`;
    return { content: `${t.serve?.url ? `Serving at ${t.serve.url}, ` : ''}${where}\n${first}`, error: !up, summary: t.serve?.url ? `${shortUrl(t.serve.url)} · tab ${n}` : where, output: t.out.slice(1, 31) };
  }

  // The rime tool (SPEC §15): Rime acting on itself. It never reads or writes API
  // keys, and it can't change permission modes or rules (it opens /permissions).
  function rimeTool(action: string, args: Record<string, any>, C: Session = S, signal?: AbortSignal): string | Promise<string> {
    const { conversation, store, note, drop, addConvRule, detail } = bound(C);
    const ACTIONS = 'help · settings.list · settings.get {key} · settings.set {key, value} · command {name: /model | /server | /setup | /settings | /permissions | /usage} · tab.open {kind: files {query?, text?: true} | file {path, line} | diff | browser {url} | design {name | url}} · tab.read {tab, lines?} · tab.close {n} · tab.focus {n} · panel.show · panel.hide · browser.open {url: a web address or a local HTML file} · design.open {name} or {new: what to build} or {url: the user\'s page}';
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
    // Split view's tabs (SPEC §8, §15). The model opens tabs without taking the
    // keys from the chat; it never runs a command this way (that's bash, with its
    // permission check, whose output shows in a tab while the panel is open).
    if (action === 'tab.open') {
      const kind = String(args.kind ?? (args.path ? 'file' : 'files'));
      if (kind === 'files') return side.files(true, args.query ? { mode: args.text ? 'text' : 'name', q: String(args.query) } : undefined), args.query ? `Opened the files tab searching for "${args.query}".` : 'Opened the files tab.';
      if (kind === 'file') {
        const rp = rel(project, path.resolve(cwd, String(args.path ?? '')));
        return side.file(rp, Number(args.line) || undefined) ? `Opened ${rp}${args.line ? ` at line ${args.line}` : ''} in a tab.` : `Couldn't open ${rp}.`;
      }
      if (kind === 'diff') {
        const cps = checkpointsOf(), cp = cps?.last();
        if (!cps || !cp) return 'No change on record to diff.';
        return side.diff(cps.diff(cp), true), 'Opened the diff of the last change in a tab.';
      }
      if (kind === 'browser' || kind === 'web' || kind === 'page') return openPage(args);
      if (kind === 'design') return openDesign_(args);
      if (kind === 'shell' || kind === 'server') return 'Run commands with the bash tool; while the panel is open their output shows in a tab of its own. A server: bash with background: true.';
      return `No tab kind ${kind}. Kinds: files {query?}, file {path, line}, diff, browser {url: a web address or a local HTML file}, design {name} or {new: what to build} or {url}.`;
    }
    // The last lines of a shell or server tab (default 60, at most 4,000 characters),
    // so a server's errors can be read without running it again.
    if (action === 'tab.read') {
      const n = Number(args.tab ?? args.n) - 1;
      const text = side.read(n, Number(args.lines) || 60);
      if (text === null) return side.tabs[n] ? `Tab ${n + 1} isn't a shell or server tab.` : `No tab ${n + 1}; there are ${side.tabs.length}.`;
      const t = side.tabs[n] as ShellTab;
      return `Tab ${n + 1} · ${side.titleOf(t)} · ${t.state}${t.serve?.url ? ` · ${t.serve.url}` : ''}\n${text || '(no output yet)'}`;
    }
    if (action === 'tab.close' || action === 'tab.focus') {
      const n = Number(args.n ?? args.tab) - 1;
      if (!side.tabs[n]) return `No tab ${n + 1}; there are ${side.tabs.length}.`;
      side.go(n);
      if (action === 'tab.focus') return `Showing tab ${n + 1}.`;
      if (side.asking() || (side.tabs[n].kind === 'shell' && (side.tabs[n] as { state: string }).state === 'running')) return 'That tab is still running a command; the user closes it with x in the panel.';
      return side.close(), `Closed tab ${n + 1}.`;
    }
    // The browser tab: a web address, or a local file shown as file://. The first
    // time, the user is asked to turn the plug-in on (a one-time set-up).
    if (action === 'browser.open') return openPage(args);
    if (action === 'design.open') return openDesign_(args);
    if (action === 'panel.show' || action === 'panel.split') return side.tabs.length ? (side.show(true), `The panel is showing. ${tabList()}`) : (side.files(), 'Opened the panel with the files tab.');
    if (action === 'panel.hide') return side.show(false), (sideFocus = false), 'The panel is hidden; its tabs keep running.';
    return `Unknown action ${action}. Actions: ${ACTIONS}`;
  }

  // The browser tab at a web address, or a local file shown as file:// (rime tool
  // browser.open, or tab.open {kind: browser}). The first time, the user is asked
  // to turn the plug-in on (a one-time set-up).
  function openPage(args: Record<string, any>): string | Promise<string> {
    const raw = String(args.url ?? args.path ?? '').trim();
    if (!raw) return 'Opening the browser tab needs {url}: a web address or a local HTML file.';
    const url = pageUrl(raw);
    if (!cfg.plugins?.browser || !browserInstalled()) return browserCmd(url), "The browser plug-in isn't on yet, so Rime asked the user to turn it on (a one-time set-up); the page opens in a tab when they do.";
    return browserNow()
      .then((b) => b.act({ action: 'open', url }))
      .then((t) => `${t.split('. Use snapshot')[0]}. ${onScreen()}`)
      .catch((e) => `Couldn't open it: ${(e as Error).message.split('\n')[0]}`);
  }
  // What the user sees of the browser tab, so the model describes the screen, not
  // a guess: its tab number, and when the split can't be drawn (a terminal under
  // 72 columns with the chat focused), how to get to it.
  function onScreen(): string {
    const n = side.tabs.indexOf(browserTab as never) + 1;
    const L = layout();
    if (!n) return 'The browser tab is closed.';
    if (L.px || L.full) return `The user sees it now in tab ${n} of the split view next to the chat. ${tabList()}`;
    return `It's in tab ${n}, but the terminal is ${W()} columns wide and the split needs 72, so the user sees the panel only with ctrl+g (full screen).`;
  }
  const tabList = () => `Tabs: ${side.tabs.map((t, i) => `${i + 1} ${side.titleOf(t)}`).join(' · ')}.`;
  function openDesign_(args: Record<string, any>) {
    if (args.url) return designAny(String(args.url)), cfg.plugins?.design && browserInstalled() ? `Capturing ${args.url} into the design studio.` : "The design plug-in isn't on yet, so Rime asked the user to turn it on; the tab opens when they do.";
    designCmd(args.new ? ['new', String(args.new)] : args.name ? [String(args.name)] : []);
    return cfg.plugins?.design && browserInstalled() ? 'Opened the design tab.' : "The design plug-in isn't on yet, so Rime asked the user to turn it on; the tab opens when they do.";
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
      // In split view the change also flashes into the diff tab (focus stays here).
      if (diff && side.visible) side.diff(`--- ${input.path}\n+++ ${input.path}\n` + diff.map((x) => `${x.sign === ' ' ? ' ' : x.sign}${x.n ? String(x.n).padStart(5) : '     '} ${x.text}`).join('\n'));
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
        for (const d of decisions.slice(0, 6)) out.push({ line: [{ t: d.verdict === 'allow' ? '  ✓ ' : d.verdict === 'deny' ? '  ✗ ' : '  ? ', s: d.verdict === 'deny' ? st.del : d.verdict === 'allow' ? st.ok : st.warn }, { t: d.what, s: st.fg }, dim(` · ${d.why}`), ...(d.answered ? [{ t: ` → ${d.answered}`, s: d.answered === 'yes' ? st.ok : st.del }] : [])] });
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

  // /panel: split view for terminals where ctrl+g never arrives.
  function panelCmd(a = '') {
    if (a === 'hide') return void (side.show(false), (sideFocus = false));
    if (a === 'files') side.files(true, null);
    else if (a === 'shell') side.shell();
    else if (a === 'diff') {
      const cps = checkpointsOf(), cp = cps?.last();
      if (!cps || !cp) return note('No changes to show: Rime takes a checkpoint before it changes a file.', 'dim');
      side.diff(cps.diff(cp), true);
    } else if (a) return note(`/panel ${a}? Try /panel, /panel files, shell, diff or hide.`, 'dim');
    else if (side.visible) return void (side.show(false), (sideFocus = false));
    else return otherSide();
    sideFocus = side.visible;
  }

  // ctrl+g: from the chat, the panel gets the keys (showing it first, on the
  // new-tab chooser when there are no tabs); from the panel, the chat does. The
  // panel stays as it was, so the next ctrl+g lands back there.
  function otherSide() {
    if (sideFocus && side.visible) return void ((sideFocus = false), side.zoom(false));
    if (!side.tabs.length) side.choose();
    else side.show(true);
    sideFocus = true;
  }

  // Which of the three answers this question offers (0 yes, 1 don't ask again, 2 no).
  function approvalOptions() {
    const a = S.approval!;
    const again = a.use.name === 'bash' || a.use.name === 'browser' ? !!a.decision.rule : (a.use.name === 'write' || a.use.name === 'edit') && !/always asks/.test(a.decision.why);
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
    const title = u.name === 'browser' ? 'open a web page?' : u.name === 'bash' ? 'run a command?' : u.name === 'write' ? (fs.existsSync(path.resolve(cwd, String(i.path))) ? 'replace a file?' : 'create a file?') : u.name === 'edit' ? 'edit a file?' : 'read a file?';
    if (u.name === 'bash') {
      for (const l of String(i.command ?? '').split('\n').slice(0, 6)) rows.push({ line: [{ t: '$ ', s: st.dim }, { t: l, s: st.titleB }], bg: st.panelBg });
      // The folder only when it isn't the project's own.
      const where = path.resolve(cwd) === path.resolve(project) ? [] : [dim(`in ${tildify(rel(project, cwd))}`)];
      const why = i.reason ? [{ t: 'Rime: ', s: st.fg }, dim(String(i.reason))] : [];
      if (where.length || why.length) rows.push({ line: [...where, ...(where.length && why.length ? [dim(' · ')] : []), ...why] });
      if (d.parts && d.parts.length > 1)
        rows.push({ line: d.parts.flatMap((p, j) => [...(j ? [dim(' · ')] : []), { t: `${p.state === 'ok' ? '✓' : p.state === 'guard' ? '✗' : '?'} ${p.text}`, s: p.state === 'ok' ? st.ok : p.state === 'guard' ? st.del : st.warn }, ...(p.why ? [dim(` ${p.why}`)] : [])]) });
    } else if (u.name === 'browser') rows.push({ line: [{ t: String(i.url ?? ''), s: st.titleB }], bg: st.panelBg });
    else {
      rows.push({ line: [{ t: rel(cwd, path.resolve(cwd, String(i.path ?? ''))), s: st.titleB }] });
      for (const x of diff ?? []) rows.push({ line: [{ t: x.n ? `${String(x.n).padStart(4)} ` : '     ', s: st.dim }, { t: x.sign === ' ' ? x.text : `${x.sign} ${x.text}`, s: x.sign === '+' ? st.ok : x.sign === '-' ? st.del : st.dim }] });
    }
    if (d.why && !/in this mode$/.test(d.why)) rows.push({ line: [{ t: d.why, s: st.warn }] });
    rows.push({ line: [] });
    const labels = [
      'Yes',
      u.name === 'browser' ? `Yes, and don't ask again for ${d.label} in this conversation` : u.name === 'bash' ? `Yes, and don't ask again for ${d.label} commands in this conversation` : 'Yes, and allow edits for the rest of this conversation',
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
  // so the actions are ctrl keys that work while you type: ctrl+r rename, ctrl+x
  // delete (asks; ctrl+u undoes it for 10 s), ctrl+p keep on top, ctrl+f fork,
  // ctrl+e export, ctrl+o sort (not ctrl+s: flow control; not ctrl+d: it scrolls in the chat). With the search empty, space selects, n starts a
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
  const KIND: Record<string, string> = { edit: '±', test: '▸', command: '▸', error: '✗', commit: '⎇', pin: '◆', server: '●', model: '◇', attach: '+', compact: '⟳' };
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
        ...(flash ? (flash.text.startsWith('✓') ? [{ t: ' · ✓', s: st.ok }, dim(flash.text.slice(1))] : [{ t: ` · ${flash.text}`, s: st.warn }]) : [dim(`${L.all ? ' · all projects' : ` · ${shortPath(tildify(project), width - 34)}`} · ${searching ? 'searching' : SORTS[L.sort]}`)]),
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
      : searching ? [['↑ ↓', ' choose · '], ['→', ' or '], ['enter', ' open · '], ...(sugg.length ? [['tab', ' suggestion · '] as [string, string]] : []), ['ctrl+r', ' rename · '], ['ctrl+x', ' delete · '], ['esc', ' clear']]
      : [['↑ ↓', ' choose · '], ['→', ' or '], ['enter', ' open · '], ['ctrl+r', ' rename · '], ['ctrl+x', ' delete · '], ['ctrl+p', sel?.pinned ? ' unpin · ' : ' keep on top · '], ['ctrl+f', ' fork · '], ['ctrl+e', ' export · '], ['ctrl+o', ' sort · '], ['space', ' select · '], ['n', ' new · '], ['a', L.all ? ' this project · ' : ' all projects · '], ['esc', ' back']];
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
      const parts = [L.all && r.project !== project ? tildify(r.project) : '', r.model?.split('/').pop(), r.tokens ? `${fmtK(r.tokens)} tokens` : '', r.last ? `${markOf(timelineOf(r.id!, r.updated).at(-1)?.kind ?? '')} ${r.last}` : ''].filter((x): x is string => !!x);
      const tw = Math.max(8, Math.min(strWidth(r.title) + 1, lw - 4 - when.length - 2 - 12));
      const title =
        on && L.edit !== undefined ? [{ t: L.edit.slice(-(tw - 1)), s: L.fresh ? st.selection : st.title }, { t: '▏', s: st.accent }]
        : fit([{ t: r.title, s: on && confirm.includes(r) ? st.del : on ? st.accentB : r.session === S ? st.titleB : st.title }], tw);
      const mark = r.id !== null && L.picked.has(r.id) ? { t: '✓', s: st.ok } : { t: on ? '›' : ' ', s: st.accent };
      const head: Line = [mark, dotOf(r), ...title, { t: ' ', s: '' }, dim(when), { t: '  ', s: '' }];
      // Whole parts only, never "±…": what doesn't fit is in the preview.
      const room = Math.max(0, lw - lineWidth(head));
      let m = '';
      for (const x of parts) if (strWidth(m ? `${m} · ${x}` : x) <= room) m = m ? `${m} · ${x}` : x;
      const meta: Line = searching && why ? fit([{ t: why.reason, s: st.accent }], room) : [dim(m)];
      left.push({ line: [...head, ...meta], i });
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
    // The search line has the same blinking caret as the prompt (not while a title is typed).
    const cursor = L.edit === undefined ? `\x1b[2;${Math.min(width, 4 + strWidth(L.filter))}H\x1b[?25h` : '';
    return { lines, rowHits, cursor };
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
    if (k.ctrl && k.name === 'x' && r) {
      const many = L.picked.size ? rows.filter((x) => x.id !== null && L.picked.has(x.id)) : [r];
      // The empty new conversation you're in: nothing to lose, so it goes at once
      // and you're in the next one (there's always one you're in).
      if (r.id === null && !L.picked.size) {
        const next = rows.find((x) => x !== r && x.project === project && !x.other);
        if (!next) return say("it's empty, and it's the only one");
        openRow(next, true);
        L.on = keyOf(next);
        L.at = 0;
        return say('✓ deleted the empty conversation');
      }
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
    if (k.ctrl && k.name === 'o') return void (L.sort = (L.sort + 1) % SORTS.length);
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

  // stay: open it behind the list, which stays open.
  function openRow(r?: ListRow, stay = false) {
    if (!r) return;
    if (r.project !== project) return void note(`That conversation belongs to ${tildify(r.project)}. Run rime there to open it.`, 'dim'), (list = null);
    if (!stay) list = null;
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
    published: updates,
    get system() {
      return S.system;
    },
    redraw: () => schedule(),
    close: () => {
      panel = null;
      buf = heldPrompt ?? '';
      cur = buf.length;
      heldPrompt = null;
      if (buf && connected() && model) submit();
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
    saveCache: (name) => saveCache(name),
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
    if (ph.key === 'tab') {
      // The test command comes from package.json; without one it's the model's job.
      let tests = '';
      try {
        tests = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).scripts?.test ? 'npm test' : '';
      } catch {}
      if (ph.value === 'tests' && !tests) return false;
      S.items.push({ kind: 'user', text });
      history.push(text);
      if (ph.value === 'files') side.files(true, null), tabLine('▤', 'files');
      else if (ph.value === 'tests') checked(tests, () => (side.shell(tests, true, false), tabLine('Bash', tests)));
      else {
        const cps = checkpointsOf(), cp = cps?.last();
        if (cps && cp) side.diff(cps.diff(cp), true), tabLine('±', 'diff');
        else note('No change on record to diff yet.', 'dim');
      }
      handled();
      return;
    }
    // Split view v2's plain words (docs/split-v2.md §5), with no API call.
    const said = () => (S.items.push({ kind: 'user', text }), history.push(text));
    if (ph.key === 'panel') {
      said();
      if (ph.value === 'hide') side.show(false), (sideFocus = false), note('Panel hidden. Tabs keep running · ctrl+g shows it.', 'dim');
      else otherSide(), note('Split open · ctrl+g to the chat', 'dim');
      return void handled();
    }
    if (ph.key === 'open') {
      const v = ph.value, file = fs.existsSync(path.resolve(cwd, v.replace(/^~(?=\/)/, os.homedir())));
      if (file ? !/\.html?$/i.test(v) : !addressLike(v)) return false; // a file to read is the model's
      said();
      // Another site asks first; the project's pages (localhost, files) open.
      if (file || /^(localhost|127\.|file:|\[::1\]|0\.0\.0\.0)/.test(v)) void browse(v, undefined, true);
      else
        S.question = {
          q: `Open ${v}? It is another site.`, options: [{ label: 'Open it' }, { label: 'No' }], sel: 0, tool: false,
          done: (a) => {
            S.question = null;
            if (a === 'Open it') void browse(v, undefined, true);
            else note('Not opened.', 'dim');
            schedule();
          },
        };
      return void handled();
    }
    if (ph.key === 'run' || ph.key === 'serve') {
      const sc = scriptsOf(), script = ph.key === 'serve' ? (sc.dev ? 'dev' : sc.start ? 'start' : '') : '';
      if (ph.key === 'serve' && !script) return false; // no dev script: the model finds out how
      const cmd = script ? `npm run ${script}` : ph.value;
      said();
      checked(cmd, () => {
        if (!script) return void (side.shell(cmd, true, false), tabLine('Bash', cmd));
        const old = side.tabs.findIndex((t) => t.kind === 'shell' && t.serve?.script === script && t.state === 'running');
        if (old >= 0) return side.go(old), note(`${script} is already running in tab ${old + 1}.`, 'dim');
        side.serve(cmd, { script, byRime: true, focus: false });
        tabLine('Bash', cmd, ' · server, stays running');
      });
      return void handled();
    }
    if (ph.key === 'search') {
      const [m, q] = [ph.value.slice(0, 4) as 'name' | 'text', ph.value.slice(5)];
      said();
      side.files(true, { mode: m, q });
      tabLine('▤', `files, searching ${m === 'name' ? 'names' : 'text'} for "${q}"`);
      return void handled();
    }
    if (ph.key === 'design') {
      const v = ph.value.trim(), sv = runningServer();
      // A page by name on the running server, an address, or a design by that name;
      // anything else is the model's to find.
      const page = /^(localhost|127\.|https?:|\/)/.test(v) ? v : sv ? `${shortUrl(sv.serve.url)}/${designSlug(v).replace(/^(home|index)$/, '')}` : '';
      if (!page && !designNames().includes(designSlug(v))) return false;
      said();
      if (page) designAny(page);
      else designCmd([designSlug(v)]);
      return void handled();
    }
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
  // What a turn would have cost: the context re-read from cache plus a short reply.
  function credit() {
    const p = model?.price;
    const d = p && !conn?.local ? (Math.max(S.task?.lastPrompt ?? 0, 1000) * p.read + 50 * p.out) / 1e6 : 0;
    if (d) S.meter.credit(d);
    return d;
  }
  // A chat step saying where a tab went ("● Bash npm test → tab 4").
  function tabLine(verb: string, rest: string, more = '') {
    S.items.push({ kind: 'tool', verb, rest, extra: [{ t: ` → tab ${side.tabs.length}${more}`, s: st.accent }] });
  }
  // A command asked for in plain words goes through the bash permission check,
  // like one Rime runs: allowed, asked (yes · don't ask again · no) or refused.
  function checked(cmd: string, run: () => void) {
    const d = decide('bash', { command: cmd }, permCtx(S));
    if (d.verdict === 'deny') return note(`Not run: ${d.why}`, 'dim');
    if (d.verdict === 'allow') return run();
    const u = { type: 'tool_use', id: `words-${Date.now()}`, name: 'bash', input: { command: cmd } } as Block;
    void ask(u, d, new AbortController().signal, S).then((a) => {
      if (a === 'always' && d.rule) for (const r of d.rules ?? [d.rule]) addConvRule('allow', r);
      if (a === 'yes' || a === 'always') run();
      else note('Not run.', 'dim');
      schedule();
    });
  }
  function handled() {
    const d = credit();
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
    // No model yet: the message waits while /setup connects one, then goes; a
    // setup closed early puts it back in the prompt.
    if (!v.startsWith('/') && !connected()) {
      heldPrompt = buf;
      buf = '';
      cur = 0;
      anchor = null;
      return void (panel = createSetup(host));
    }
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
    else if (c === '/browser') browserCmd(args);
    else if (c === '/design') designCmd(args);
    else if (c === '/clear') {
      newConversation();
      if (later) host.choose(later);
    } else if (c === '/usage') boxKind = 'usage';
    else if (c === '/exit') quit();
    else if (c === '/update') void updateNow();
    else if (c === '/compact') void compactNow();
    else if (c === '/diff') showDiff();
    else if (c === '/undo') undo();
    else if (c === '/panel') panelCmd(args[0]);
    else {
      S.items.push({ kind: 'user', text: v });
      S.items.push({ kind: 'reply', text: `Unknown command ${c}. Press / to see the commands.`, done: true });
    }
  }

  // ---- input ----
  // The prompt is a small editor (SPEC §5.3): a selection is a range of buffer
  // offsets that backspace/delete remove and typing replaces; chips are single
  // characters, so arrows step over them and backspace removes them whole.

  const tw = () => Math.max(1, CW() - 6);
  const prevCp = (i: number) => (i >= 2 && /[\udc00-\udfff]/.test(buf[i - 1]) ? i - 2 : Math.max(0, i - 1));
  const nextCp = (i: number) => (/[\ud800-\udbff]/.test(buf[i] || '') ? i + 2 : Math.min(buf.length, i + 1));
  const range = (): [number, number] | null => (anchor === null || anchor === cur ? null : [Math.min(anchor, cur), Math.max(anchor, cur)]);
  const cut = (a: number, b: number) => {
    buf = buf.slice(0, a) + buf.slice(b);
    cur = a;
    anchor = null;
  };
  // ctrl+c, ctrl+u, ctrl+k and ctrl+w keep what they remove for ctrl+y (readline's yank).
  let yank = '';
  const kill = (a: number, b: number) => ((yank = buf.slice(a, b)), cut(a, b));
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
    if (!promptAt.rows.length || (!clamp && (i < promptAt.first || i >= promptAt.first + promptAt.shown || x < 3 || x > CW() - 2))) return null;
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
  function say(text: string, ms = 2000) {
    if (flash) clearTimeout(flash.t);
    flash = { text, t: setTimeout(() => ((flash = null), schedule()), ms) };
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
      const k = CLICK_KEYS[label] ?? (/^[a-z0-9?:/@]$/.test(label) ? { name: 'char', ch: label } : null);
      if (k) onKey({ type: 'key', ...k });
      return;
    }
    if (id === 'stop') return stopBg();
    if (id === 'mode') return cycleMode();
    if (id === 'chat') return void ((sideFocus = false), side.zoom(false));
    if (id.startsWith('side:')) return void ((sideFocus = true), side.click(id), side.visible || (sideFocus = false));
    if (id === 'panel') return void (side.show(true), (sideFocus = side.visible));
    if (id === 'update') return void updateNow();
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
    if (id.startsWith('at:')) {
      const x = atMatches()[+id.slice(3)];
      return x && takeAt(x.f, x.lines);
    }
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
    if (quitServers) {
      quitServers = false;
      return k.name === 'enter' ? quit(undefined, true) : undefined;
    }
    if (list) return listKey(k);
    if (boxKind === 'keys') {
      // → or tab turns the page when there's more; any other key closes the sheet.
      if ((k.name === 'right' || k.name === 'tab') && keysPage + 1 < keysSheet(CW(), H(), st).pages) return void keysPage++;
      boxKind = null;
      keysPage = 0;
      return;
    }
    // Split view (docs/split-v2.md §2): ctrl+g moves focus to the other side; only
    // the focused side takes keys, Rime's questions too.
    if (k.ctrl && k.name === 'g' && !panel) return otherSide();
    if (sideFocus && side.visible && !panel) {
      const r = side.key(k);
      if (r === 'blur') (sideFocus = false), side.zoom(false);
      return; // one side has the keys: what the panel doesn't use goes nowhere
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
      if (running) return running.stop(); // a download or install
      // A cleared prompt stays at the top of ↑ and comes back with ctrl+y.
      if (buf) {
        cleared = buf;
        kill(0, buf.length);
        browsing = null;
        return say('cleared · ctrl+y brings it back', 4000);
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
      if ((k.name === 'tab' || (k.name === 'enter' && !k.shift)) && m.length) return takeAt(m[atPick.sel % m.length].f, m[atPick.sel % m.length].lines);
      if (k.name === 'escape') return void (atPick = null);
    }
    // `/model ` lists models; ↑ ↓ choose one.
    if (!panel && /^\/model\s+\S*$/.test(buf) && (k.name === 'up' || k.name === 'down')) {
      const n = Math.max(1, knownModels().filter((r) => r.toLowerCase().includes(buf.split(/\s+/)[1].toLowerCase())).length);
      return void (sel = (sel + (k.name === 'down' ? 1 : n - 1)) % n);
    }
    // On an empty prompt, tab or → takes the suggestion (the next step, or the example).
    if (!buf && !panel && !S.declining && (k.name === 'tab' || (k.name === 'right' && !k.shift)) && (S.nextStep || unloaded() || (example && !S.messages.length && connected()))) return insert(S.nextStep || (unloaded() ? `load ${unloaded()}` : example));
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
          browsing ??= { list: [cleared, ...[...history].reverse(), ...past].filter((p, i, a) => p.trim() && a.indexOf(p) === i), i: -1, draft: buf };
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
        else if (k.name === 'k') r ? kill(...r) : kill(cur, lineEnd());
        else if (k.name === 'w') r ? kill(...r) : kill(wordLeft(cur), cur);
        else if (k.name === 'y') yank && insert(yank);
        else if (k.name === 'v') void pasteImage();
        // With text, ctrl+u / ctrl+d edit as in a shell; on an empty prompt they scroll.
        else if (k.name === 'u') buf ? (r ? kill(...r) : kill(lineStart(), cur)) : (scrollOff += Math.max(1, Math.floor(viewH / 2)));
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
      // Split view: the wheel scrolls the pane it's over; a click there gives it focus.
      const Lo = layout();
      // The divider (the panel's left border) drags to resize the split.
      if (ev.button === 0 && !ev.release && Lo.px > 0 && ev.x === Lo.px && !panel) return void ((dragging = true), schedule());
      if (dragging) {
        if (ev.button === 32) side.setRatio((W() - ev.x + 1) / W());
        if (ev.release) dragging = false;
        return schedule();
      }
      const overSide = Lo.full || (Lo.px > 0 && ev.x >= Lo.px);
      if (overSide && (ev.button === 64 || ev.button === 65)) return side.wheel(ev.button === 64 ? -3 : 3), schedule();
      if (ev.button === 0 && !ev.release && side.visible && !panel) {
        sideFocus = overSide;
        if (overSide) side.press(ev.x - (Lo.full ? 0 : Lo.px - 1), ev.y - (Lo.full ? 1 : 0));
      }
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
        const pinRow = (y: number) => hits.some((x) => x.row === y && x.id.startsWith('pin:'));
        const moved = ev.y !== hoverRow && (pinRow(ev.y) || pinRow(hoverRow));
        hoverRow = ev.y;
        if (h === hover && open === listOpen && !moved) return;
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
            copyOut(plainOf(buf.slice(...r))); // a drag still copies, as before
          } else {
            anchor = null;
            if (press.hit?.startsWith('chip:')) big = big === press.hit.slice(5) ? null : press.hit.slice(5);
          }
        } else if (selection) {
          if (selection.log) selection.b = { x: pointer.y > viewH ? CW() : pointer.x, y: top + Math.max(1, Math.min(viewH, pointer.y)) - 1 };
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
      // A paste goes where the keys go: with the panel focused, typed into its tab.
      if (sideFocus && side.visible && !panel) {
        if (side.typing()) for (const ch of ev.text.replace(/\s+/g, ' ')) side.key(ch === ' ' ? { name: 'space' } : { name: 'char', ch });
      } else if (!panel) pasteText(ev.text);
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
  function quit(into?: string, sure = false) {
    if (quitting) return;
    // Servers in tabs stop with Rime, so it asks first (docs/split-v2.md §4.4).
    if (!into && !sure && side.servers()) return void ((quitServers = true), schedule());
    quitting = 'bye';
    finishDelete(); // a delete waiting for undo is done now
    side.killAll(); // commands in tabs stop with Rime
    closeChrome();
    // Every open conversation: a reply being streamed is kept as interrupted.
    for (const x of sessions) {
      if (x.live && x.convId) save((d) => d.update(x.convId!, x.live!.seq, [{ type: 'text', text: x.live!.text() }], true));
      if (x.convId) save((d) => d.unlock(x.convId!));
    }
    header?.close();
    // Restarting into an update: the conversations are free again, servers stay up,
    // and the new version takes this terminal and reopens the conversation.
    if (into) {
      restore();
      process.exit(launchVersion(into));
    }
    for (const [name, p] of Object.entries(cfg.providers)) {
      if (!p.ssh || !p.onQuit || p.onQuit === 'keep' || !tunnels[name]?.port) continue;
      const logs = path.join(os.homedir(), '.rime', 'logs');
      fs.mkdirSync(logs, { recursive: true });
      const log = fs.openSync(path.join(logs, 'quit.log'), 'a');
      spawn('ssh', [...SSH_OPTS, p.ssh, saveOnServer(name) + (p.onQuit === 'stop' ? 'sudo systemctl stop llama-server' : 'sudo poweroff')], { detached: true, stdio: ['ignore', log, log] }).unref();
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
    if (c.prefix && c.prefix_hash === hashOf(C.tools) && Date.now() - c.updated < 86400000) C.system = c.prefix;
    else save((d) => d.setPrefix(c.id, C.system, hashOf(C.tools)));
    const stored: Stored[] = save((d) => d.messages(c.id)) ?? [];
    for (const m of stored) {
      const blocks: Block[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      // A compaction: the history from here on is its summary plus the kept tail.
      if (m.role === 'system' && blocks[0]?.type === 'compaction') {
        const kept = Number(blocks[0].kept ?? 0);
        C.messages.splice(0, C.messages.length, ...compacted(C.messages, Math.max(0, C.messages.length - kept), String(blocks[0].summary)));
        C.items.push({ kind: 'lines', lines: [[{ t: '  ⟳ ', s: st.accent }, { t: 'compacted here: what came before was summarised', s: st.dim }]] });
        continue;
      }
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
  process.on('SIGTERM', () => void quit(undefined, true));
  process.on('SIGHUP', () => void quit(undefined, true));
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
  checkUpdates();
  if (process.env.RIME_RESTARTED) setTimeout(() => header?.blink(), 400); // back in the new version
  // The code index opens in the background (a first build yields often, so the
  // screen stays live); then new conversations get the repo map in their frozen
  // prompt, including this one if nothing was sent yet.
  void openIndex(project)
    .then(async (ix) => {
      await ix.refresh(ix.files().length ? Infinity : 200);
      index = ix;
      SYSTEM = system(cwd, agentsMd(projectOf(cwd)), ix.map());
      if (!S.convId && !S.messages.length) S.system = SYSTEM;
      schedule();
    })
    .catch(() => {});
  if (!connected()) panel = createSetup(host);
  else if (cfg.model) useRef(cfg.model, true);
  frame();
}
