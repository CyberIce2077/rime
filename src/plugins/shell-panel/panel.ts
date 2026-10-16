// shell-panel (docs/split-v2.md, SPEC §8): the tabbed right panel of split view.
// Tabs are numbered: shells (each command Rime runs, and ones you open), servers
// (a command that keeps running), a diff, the files tree, read-only file viewers,
// and plug-in tabs (browser, design). The panel has its own keys (single letters
// while the tab isn't taking typing), a switcher (space), a `:` command line and
// `/` search. Shells are plain child processes with their output captured, no pty
// (docs/split-v2.md §7.2): commands that need a terminal of their own (an editor,
// a password prompt) don't work in a tab.

import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { type Key, type Line, fit, lineWidth, strWidth } from '../../core/term.ts';
import { clean } from '../../core/tools.ts';
import { type Hint, type Styles, hintLines, str } from '../../core/view.ts';
import { type TextHit, addressLike, fuzzy, grep, nameHits } from './search.ts';

// from / to: a linked tab's id (a browser opened on a server's address, a design applied to the project).
type Base = { id: number; title: string; byRime?: boolean; flash?: number; from?: number; to?: number; used?: number; name?: string };
export type ShellTab = Base & {
  kind: 'shell';
  cmd: string; out: string[]; state: 'idle' | 'running' | 'passed' | 'failed' | 'stopped'; code?: number; child?: ChildProcess;
  input: string; history: string[]; scroll: number; mirror?: boolean; typing: boolean; find?: string; started?: number;
  serve?: { script?: string; url?: string; port?: number }; // a server tab (§4.4)
  argv?: [string, string[]]; // how it runs, when not `sh -c` (auto mode's sandbox)
};
export type TextTab = Base & { kind: 'diff' | 'file'; lines: Line[]; raw: string[]; scroll: number; path?: string; mark?: number; find?: string; at?: number };
export type Search = { mode: 'name' | 'text'; q: string; sel: number };
export type FilesTab = Base & { kind: 'files'; open: Set<string>; sel: number; scroll: number; search: Search | null };
// A question in the panel line (`address ›`): what a plug-in tab or the switcher asks.
export type Ask = { label: string; value?: string; placeholder?: string; submit(v: string): void };
// A plug-in's tab (browser, design): it draws itself and takes its keys.
export type CustomTab = Base & {
  kind: 'custom';
  icon?: string;
  render(width: number, height: number): Line[];
  key?(k: Key): boolean | Ask;
  foot(): Hint[];
  close?(): void;
  busy?(): boolean;
  typing?(): boolean; // every key goes to the tab (a page being typed into)
  click?(x: number, y: number): void; // 0-based cells in its content
  wheel?(d: number): void;
  overlay?(col: number, row: number, width: number, height: number): string | null; // an image drawn after the text (Kitty, iTerm2): null when there's none, '' when it's already up
  hide?(): string; // takes the image away when the tab stops showing
};
export type Tab = ShellTab | TextTab | FilesTab | CustomTab;

export type SideHost = {
  root: string; st: Styles; redraw(): void; files(): string[]; env(): NodeJS.ProcessEnv;
  asks?(): boolean; // Rime is waiting on an answer in the chat
  plan?(): boolean; // plan mode blocks :run and :serve
  scripts?(): Record<string, string>; // package.json's scripts
  recent?(): string[]; // recent and edited files, first in name search
  addresses?(): string[]; // recent browser addresses
  designs?(): string[]; // design names (design/<name>.html)
  browse?(url: string, from?: number): void; // the browser tab; from: the server tab it came from
  design?(arg: string): void; // :design, the switcher's design rows
  idea?(text: string): void; // a design idea typed in the panel, sent as a chat message
  diff?(): string | void; // :diff; a message when there's none
  browser?(args: string[]): void; // :browser use chrome | chromium · uninstall
  mention?(ref: string, lines?: [number, number]): void; // @: into the chat prompt as a chip
  ready?(t: ShellTab): void; // a server printed its address (again)
};

const ICON = { files: '▤', file: '≡', shell: '$', server: '●', diff: '±' };
export const CMDS: [string, string, string][] = [
  ['open', '<url or file>', 'browser tab'], ['run', '<command>', 'shell tab'], ['serve', '[script]', 'server tab'],
  ['files', '[query]', 'files tab, searching'], ['file', '<path[:line]>', 'file viewer'], ['design', '[name or url]', 'design studio'],
  ['diff', '', 'diff tab'], ['close', '[n]', 'close a tab'], ['reopen', '', 'reopen the last closed tab'],
  ['move', '<n>', 'move this tab'], ['rename', '<title>', 'rename this tab'], ['size', '<percent or even>', 'move the divider'],
  ['hide', '', 'hide the split'], ['browser', 'use chrome | use chromium | uninstall', 'browser engine'],
];
// The panel's own keys, after the tab's (§3.2).
const PANEL: Hint[] = [['space', ' tabs · '], [':', ' command · '], ['?', ' keys']];
const SHEET: [string, string][] = [['ctrl+g', 'to the chat'], ['esc', 'back one step'], ['space', 'switcher'], ['1–9', 'go to tab'], ['tab', 'next tab · shift+tab back'], ['n', 'new tab'], ['x', 'close tab'], ['z', 'zoom'], [':', 'panel command'], ['/', 'search this tab']];
const ADDRESS = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d+)[^\s'")]*/;
const MAX_OUT = 5000; // lines kept per shell tab

type Pin = { kind: 'switch' | 'cmd' | 'search' | 'find' | 'ask'; value: string; sel: number; ask?: Ask };
type Row = { ic: string; lab: string; meta?: string; idx?: number[]; run(): void; tab?: Tab };

export function createSide(h: SideHost) {
  const { st } = h;
  const tabs: Tab[] = [];
  const closed: Tab[] = [];
  let active = 0, seq = 0, clock = 0;
  let visible = false;
  let ratio = 0.45; // the panel's share of the width
  let asking: number | null = null; // closing a running tab: "x again stops it"
  let lead = 2; // columns before the content: the border and a space (1 without the border)
  let shown = { w: 0, rows: 0 }; // the content area of the last frame
  let zoomed = false; // the panel takes the whole width
  let sheet = false; // the ? sheet
  let pin: Pin | null = null; // the panel line's input, or the switcher
  let toastMsg = '';
  let toastTimer: NodeJS.Timeout | undefined;
  let grepCache = { q: '', hits: [] as TextHit[] };
  let hitRows: number[] = []; // search hits by content row, for clicks

  const cur = () => tabs[active] as Tab | undefined;
  const touch = (t?: Tab) => t && (t.used = ++clock);
  const add = <T extends Tab>(t: T, focus = true): T => {
    tabs.push(t);
    visible = true;
    if (focus || tabs.length === 1) (active = tabs.length - 1), touch(t);
    else t.flash = Date.now() + 1500; // a new tab flashes in without taking the active tab
    if (t.flash) setTimeout(h.redraw, 1600);
    h.redraw();
    return t;
  };
  const toast = (msg: string) => {
    toastMsg = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ((toastMsg = ''), h.redraw()), 2500);
    h.redraw();
  };
  const scripts = () => h.scripts?.() ?? {};
  const devScript = () => (scripts().dev ? 'dev' : scripts().start ? 'start' : '');

  // ---- titles (§3.1) ----
  const short = (cmd: string) => cmd.split(/\s+/).slice(0, 3).join(' ');
  function titleOf(t: Tab): string {
    if (t.name) return t.name;
    if (t.kind === 'shell' && t.serve) return t.serve.port ? `${t.serve.script ?? short(t.cmd)} :${t.serve.port}` : t.serve.script ?? short(t.cmd);
    if (t.kind === 'shell') return t.cmd ? short(t.cmd) : 'shell';
    return t.title;
  }
  const iconOf = (t: Tab) => (t.kind === 'custom' ? t.icon ?? '◆' : t.kind === 'shell' && t.serve ? ICON.server : ICON[t.kind]);
  const running = (t?: Tab) => !!t && ((t.kind === 'shell' && t.state === 'running') || (t.kind === 'custom' && !!t.busy?.()));
  const stateMark = (t: Tab) => (t.kind !== 'shell' ? '' : t.serve ? (t.state === 'running' ? '' : ' ■') : t.state === 'running' ? ' ●' : t.state === 'passed' ? ' ✓' : t.state === 'failed' ? ' ✗' : t.state === 'stopped' ? ' ■' : '');
  const markStyle = (t: Tab) => (t.kind !== 'shell' ? st.dim : t.state === 'running' ? st.accent : t.state === 'passed' ? st.ok : t.state === 'idle' ? st.dim : st.del);
  const indexOf = (id?: number) => (id === undefined ? -1 : tabs.findIndex((x) => x.id === id));
  const linkOf = (t: Tab) => {
    const f = indexOf(t.from), o = indexOf(t.to);
    return f >= 0 ? `← ${f + 1}` : o >= 0 ? `→ ${o + 1}` : '';
  };
  const ago = (ms: number) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s` : ms < 3600000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 3600000)}h`);
  function metaOf(t: Tab) {
    if (t.kind === 'shell' && t.serve) return t.state === 'running' ? `running ${ago(Date.now() - (t.started ?? Date.now()))}` : t.state;
    if (t.kind === 'shell') return t.state === 'idle' ? '' : t.state === 'running' ? 'running' : t.state === 'passed' ? '✓ exit 0' : t.state === 'stopped' ? 'stopped' : `✗ exit ${t.code}`;
    if (t.kind === 'file') return t.path ?? '';
    const l = linkOf(t), o = tabs[indexOf(t.from) >= 0 ? indexOf(t.from) : indexOf(t.to)];
    return l && o ? `${l} ${titleOf(o)}` : '';
  }

  // ---- shells and servers ----
  function start(t: ShellTab, cmd: string) {
    if (cmd !== t.cmd) t.argv = undefined;
    t.cmd = cmd;
    t.out.push(...(t.out.length ? [''] : []), `$ ${cmd}`);
    t.state = 'running';
    t.scroll = 0;
    t.code = undefined;
    t.started = Date.now();
    if (t.serve) (t.serve.url = undefined), (t.serve.port = undefined);
    const [bin, args] = t.argv && cmd === t.cmd ? t.argv : ['sh', ['-c', cmd]];
    const p = spawn(bin, args, { cwd: h.root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: h.env() });
    t.child = p;
    const take = (d: Buffer) => t.child === p && write(t, d.toString('utf8'));
    p.stdout!.on('data', take);
    p.stderr!.on('data', take);
    p.on('error', (e) => write(t, e.message + '\n'));
    p.on('close', (code, sig) => t.child === p && done(t, sig ? 130 : (code ?? 1)));
  }
  const partial = new WeakMap<ShellTab, string>(); // a line still being written
  function write(t: ShellTab, chunk: string) {
    const text = (partial.get(t) ?? '') + clean(chunk);
    const parts = text.split('\n');
    partial.set(t, parts.pop()!);
    t.out.push(...parts);
    if (t.out.length > MAX_OUT) t.out.splice(0, t.out.length - MAX_OUT);
    // A server's address: the port goes in the title, and each time it's printed
    // (ready again after a restart) a browser on it reloads.
    if (t.serve)
      for (const l of parts) {
        const m = ADDRESS.exec(l);
        if (!m) continue;
        t.serve.url = m[0].replace(/\/$/, '').replace(/0\.0\.0\.0|127\.0\.0\.1|\[::1?\]/, 'localhost');
        t.serve.port = +m[1];
        h.ready?.(t);
      }
    h.redraw();
  }
  function done(t: ShellTab, code: number) {
    const rest = partial.get(t);
    if (rest) t.out.push(rest), partial.set(t, '');
    t.child = undefined;
    t.code = code;
    t.state = t.state === 'stopped' || t.serve ? 'stopped' : code === 0 ? 'passed' : 'failed'; // a server that ended isn't "passed"
    h.redraw();
  }
  const stop = (t: ShellTab) => {
    if (!t.child?.pid) return;
    t.state = 'stopped';
    const p = t.child;
    try {
      process.kill(-p.pid!, 'SIGKILL');
    } catch {
      p.kill('SIGKILL');
    }
    if (t.serve) t.out.push('^C', '(stopped)');
  };
  // A new empty shell starts typing; one with a command waits for enter.
  const shellTab = (cmd = '', byRime = false): ShellTab => ({ id: ++seq, kind: 'shell', title: cmd ? short(cmd) : 'shell', cmd, out: [], state: 'idle', input: '', history: [], scroll: 0, byRime, typing: !cmd });
  // A tab taking typing gets every key but ctrl+g (§3.3).
  const typing = (t = cur()) => !!pin || (!!t && (t.kind === 'shell' ? t.typing : t.kind === 'custom' && !!t.typing?.()));

  // ---- files ----
  function rowsOf(t: FilesTab): { path: string; dir: boolean; depth: number }[] {
    const out: { path: string; dir: boolean; depth: number }[] = [];
    const seen = new Set<string>();
    for (const f of h.files()) {
      const parts = f.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join('/'), dir = i < parts.length;
        if (seen.has(p)) continue;
        // Shown only when every folder above it is open.
        if (!parts.slice(0, i - 1).every((_, j) => t.open.has(parts.slice(0, j + 1).join('/')))) break;
        seen.add(p);
        out.push({ path: p, dir, depth: i - 1 });
      }
    }
    // Folders first within each folder, by name.
    const key = (r: { path: string; dir: boolean }) => r.path.split('/').map((s, i, a) => (i < a.length - 1 || r.dir ? '0' : '1') + s).join('/');
    return out.sort((a, b) => key(a).localeCompare(key(b)));
  }
  // The search's hits: file names (with the matched letters) or lines in files.
  function hitsOf(s: Search): { path: string; line?: number; text?: string; idx?: number[] }[] {
    if (!s.q) return [];
    if (s.mode === 'name') return nameHits(s.q, h.files(), h.recent?.() ?? []);
    if (grepCache.q !== s.q) grepCache = { q: s.q, hits: grep(h.root, s.q, h.files()) };
    return grepCache.hits;
  }

  // ---- text tabs ----
  function fileLines(rel: string): string[] | null {
    try {
      return fs.readFileSync(path.join(h.root, rel), 'utf8').split('\n').slice(0, 20000);
    } catch {
      return null;
    }
  }
  const numbered = (raw: string[]): Line[] => {
    const w = String(raw.length).length;
    return raw.map((l, i) => [{ t: `${String(i + 1).padStart(w)}  `, s: st.dim }, { t: l.replace(/\t/g, '  '), s: st.fg }]);
  };
  const diffRaw = (text: string) => text.split('\n').filter((l) => !/^(index |diff --git|new file mode|deleted file mode)/.test(l));
  const diffLines = (raw: string[]): Line[] => raw.map((l) => [{ t: l, s: l.startsWith('+++') || l.startsWith('---') ? st.titleB : l.startsWith('+') ? st.ok : l.startsWith('-') ? st.del : l.startsWith('@@') ? st.accent : st.fg }]);
  // The diff's hunk at the top of the view (or the first one below it), as a file and line.
  function hunkAt(t: TextTab): { path: string; line: number } | null {
    const isHunk = (l: string) => /^@@ -\d+(?:,\d+)? \+\d+/.test(l);
    let i = Math.min(t.scroll, t.raw.length - 1);
    while (i >= 0 && !isHunk(t.raw[i])) i--;
    if (i < 0) i = t.raw.findIndex(isHunk);
    if (i < 0) return null;
    let line = +/\+(\d+)/.exec(t.raw[i])![1];
    for (let j = i + 1; j < t.scroll; j++) if (!t.raw[j].startsWith('-')) line++;
    for (let j = i; j >= 0; j--) {
      const f = /^\+\+\+ (?:b\/)?(.+)$/.exec(t.raw[j]);
      if (f && f[1].trim() !== '/dev/null') return { path: f[1].trim(), line };
    }
    return null;
  }

  // ---- find (§4.2, §4.3, §4.7): the lines with the text, and the next one ----
  const matchLines = (raw: string[], q: string) => (q ? raw.flatMap((l, i) => (l.toLowerCase().includes(q.toLowerCase()) ? [i] : [])) : []);
  function findNext(t: TextTab | ShellTab, from: number, d = 1) {
    const raw = t.kind === 'shell' ? t.out : t.raw;
    const ms = matchLines(raw, t.find ?? '');
    if (!ms.length) return void (t.find && toast(`no "${t.find}" here`));
    const i = d > 0 ? ms.find((m) => m >= from) ?? ms[0] : [...ms].reverse().find((m) => m <= from) ?? ms.at(-1)!;
    if (t.kind === 'shell') t.scroll = Math.max(0, raw.length - i - Math.ceil(shown.rows / 2));
    else (t.at = i), (t.scroll = Math.max(0, i - 3));
    h.redraw();
  }
  const highlight = (l: Line, q?: string): Line => {
    if (!q) return l;
    const text = l.map((r) => r.t).join(''), lo = text.toLowerCase(), ql = q.toLowerCase();
    const on = new Array(text.length).fill(false);
    for (let i = lo.indexOf(ql); i >= 0; i = lo.indexOf(ql, i + 1)) for (let j = i; j < i + ql.length; j++) on[j] = true;
    if (!on.includes(true)) return l;
    const out: Line = [];
    let x = 0;
    for (const r of l)
      for (const ch of r.t) {
        const s = on[x] ? st.selection : r.s;
        x += ch.length;
        if (out.at(-1)?.s === s) out.at(-1)!.t += ch;
        else out.push({ t: ch, s });
      }
    return out;
  };

  // ---- drawing ----
  function body(t: Tab, w: number, rows: number): Line[] {
    const dim = (s: string) => ({ t: s, s: st.dim });
    if (t.kind === 'custom') return t.render(w, rows);
    if (t.kind === 'shell') {
      const foot: Line[] = [];
      if (!t.mirror && !t.serve) foot.push([{ t: '$ ', s: st.ok }, ...(t.typing ? [{ t: t.input, s: st.title }, { t: '▏', s: st.accent }] : [dim('enter to type a command')])]);
      const room = Math.max(0, rows - foot.length);
      const end = Math.max(0, t.out.length - t.scroll);
      const out = t.out.slice(Math.max(0, end - room), end).map((l): Line => highlight([{ t: l, s: l.startsWith('$ ') ? st.titleB : st.fg }], t.find));
      if (!t.out.length && t.serve) out.push([dim('starting…')]);
      return [...out, ...new Array(Math.max(0, room - out.length)).fill([]), ...foot];
    }
    if (t.kind === 'files') {
      const s = t.search;
      if (s && (s.q || pin?.kind === 'search')) {
        const hs = hitsOf(s);
        s.sel = Math.max(0, Math.min(s.sel, hs.length - 1));
        const mode: Line = [{ t: ' names ', s: s.mode === 'name' ? st.accent + st.panelBg : st.dim }, { t: ' text in files ', s: s.mode === 'text' ? st.accent + st.panelBg : st.dim }];
        const count = s.q ? `${hs.length}${hs.length >= 200 ? '+' : ''} match${hs.length === 1 ? '' : 'es'}` : '';
        const head: Line = [{ t: '/ ', s: st.accent }, { t: s.q, s: st.title }, dim(count ? `  ${count}` : '')];
        const bar: Line = [...head, { t: ' '.repeat(Math.max(1, w - lineWidth(head) - lineWidth(mode))), s: '' }, ...mode];
        if (!s.q) return [bar, [], [dim('Type to search file names. tab searches the text inside files.')]];
        if (!hs.length) return [bar, [], [dim(`Nothing matches "${s.q}".${s.mode === 'name' ? ' tab searches inside files.' : ''}`)]];
        // Text hits grouped by file, with line numbers; the selected one stays in view.
        const lines: { line: Line; hit?: number }[] = [];
        let last = '';
        hs.forEach((x, i) => {
          const on = i === s.sel;
          if (s.mode === 'name') {
            const dir = x.path.lastIndexOf('/') + 1;
            const name: Line = [...x.path].map((ch, j) => ({ t: ch, s: x.idx!.includes(j) ? st.accentB : j < dir ? st.dim : on ? st.title : st.fg }));
            return void lines.push({ line: [{ t: on ? '› ' : '  ', s: st.accent }, { t: '≡ ', s: st.dim }, ...name], hit: i });
          }
          if (x.path !== last) lines.push({ line: [dim(x.path)] }), (last = x.path);
          lines.push({ line: [{ t: on ? '› ' : '  ', s: st.accent }, dim(String(x.line).padStart(5) + ' '), ...highlight([{ t: x.text!.trim(), s: on ? st.title : st.fg }], s.q)], hit: i });
        });
        const room = rows - 1;
        const at = lines.findIndex((l) => l.hit === s.sel);
        const from = Math.max(0, Math.min(at - Math.floor(room / 2), lines.length - room));
        hitRows = lines.slice(from, from + room).map((l) => l.hit ?? -1);
        return [bar, ...lines.slice(from, from + room).map((l) => l.line)];
      }
      const rs = rowsOf(t);
      t.sel = Math.max(0, Math.min(t.sel, rs.length - 1));
      if (t.sel < t.scroll) t.scroll = t.sel;
      if (t.sel >= t.scroll + rows) t.scroll = t.sel - rows + 1;
      const out: Line[] = [];
      rs.slice(t.scroll, t.scroll + rows).forEach((r, i) => {
        const on = t.scroll + i === t.sel;
        const name = r.path.split('/').pop()!;
        out.push([{ t: on ? '› ' : '  ', s: st.accent }, { t: '  '.repeat(r.depth), s: '' }, ...(r.dir ? [{ t: t.open.has(r.path) ? '▾ ' : '▸ ', s: st.accent }, { t: name + '/', s: on ? st.accentB : st.title }] : [{ t: name, s: on ? st.accentB : st.fg }])]);
      });
      if (!rs.length) out.push([dim('no files')]);
      return out;
    }
    // diff and file viewer: the asked-for line and the found one stay in view.
    t.scroll = Math.max(0, Math.min(t.scroll, Math.max(0, t.lines.length - rows)));
    return t.lines.slice(t.scroll, t.scroll + rows).map((l, i) => {
      const n = t.scroll + i;
      const m = highlight(l, t.find);
      return (t.mark && n + 1 === t.mark) || (t.find && n === t.at) ? m.map((r) => ({ t: r.t, s: st.panelBg + r.s })) : m;
    });
  }

  // A tab's own keys before the panel's: its last group has to end, or the two
  // would run together ("esc stop typingspace tabs").
  const ended = (h: Hint[]): Hint[] => h.map(([k, l, s], i) => [k, i === h.length - 1 && !l.endsWith(' · ') ? `${l} · ` : l, s]);
  function own(t: Tab): Hint[] {
    if (t.kind === 'custom') return t.foot();
    if (t.kind === 'shell' && t.serve) return t.state === 'running' ? [...(t.serve.url ? [['o', ' open in browser · ']] as Hint[] : []), ['r', ' restart · '], ['ctrl+c', ' stop · '], ['/', ' find']] : [['r', ' start · '], ['/', ' find']];
    if (t.kind === 'shell') return t.mirror ? [['↑ ↓', ' scroll · '], ['ctrl+c', ' stop · '], ['/', ' find']] : [['enter', ' type a command · '], ['r', ' rerun · '], ['ctrl+c', ' stop · '], ['/', ' find']];
    if (t.kind === 'files') return t.search?.q ? [['↑ ↓', ' choose · '], ['enter', ' open · '], ['@', ' to chat · '], ['/', ' edit search · '], ['esc', ' clear']] : [['↑ ↓', ' move · '], ['enter', ' open · '], ['← →', ' fold · '], ['/', ' search · '], ['@', ' to chat']];
    if (t.kind === 'file') return [['↑ ↓', ' scroll · '], ['/', ' find · '], ['@', ' to chat']];
    return [['↑ ↓', ' scroll · '], ['/', ' find · '], ['enter', ' open the file']];
  }
  function foot(t: Tab | undefined): Hint[] {
    if (pin) {
      const p = pin;
      if (p.kind === 'switch') return [['↑ ↓', ' choose · '], ['enter', ' go · '], ['esc', ' back']];
      if (p.kind === 'cmd') return [['↑ ↓', ' choose · '], ['tab', ' complete · '], ['enter', ' run · '], ['esc', ' back']];
      if (p.kind === 'search') return [['tab', (t as FilesTab)?.search?.mode === 'text' ? ' names · ' : ' text in files · '], ['↑ ↓', ' choose · '], ['enter', ' open · '], ['esc', ' clear']];
      if (p.kind === 'find') return [['enter', ' next · '], ['↑', ' previous · '], ['esc', ' back']];
      return [['enter', /what should/.test(p.ask?.label ?? '') ? ' start · ' : ' open · '], ['esc', ' back']];
    }
    if (!t) return [['space', ' new tab · '], ['esc', ' chat']];
    if (asking !== null) return [['', `${titleOf(t)} is running · `, st.warn], ['x', ' stop it and close · '], ['esc', ' keep it']];
    if (t.kind === 'shell' && t.typing) return [['', `typing into ${titleOf(t)} · `, st.warn], ['enter', ' run · '], ['ctrl+c', ' stop · '], ['esc', ' stop typing · '], ['ctrl+g', ' chat']];
    if (t.kind === 'custom' && t.typing?.()) return [...ended(t.foot()), ['ctrl+g', ' chat']];
    return [...ended(own(t)), ...PANEL];
  }

  // A box drawn over the content's top rows (the switcher) or its bottom rows
  // (the : completions): a frame with a title in the top border.
  function frame(title: string, rows: Line[], w: number): Line[] {
    const inner = w - 4;
    const top: Line = [{ t: `┌ ${title} `, s: st.dim }, { t: '─'.repeat(Math.max(0, w - strWidth(title) - 4)) + '┐', s: st.dim }];
    return [top, ...rows.map((r): Line => [{ t: '│ ', s: st.dim }, ...fit(r, inner), { t: ' │', s: st.dim }]), [{ t: '└' + '─'.repeat(w - 2) + '┘', s: st.dim }]];
  }

  // ---- the switcher (§3.4) ----
  const host = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const server = () => tabs.find((t): t is ShellTab => t.kind === 'shell' && !!t.serve && t.state === 'running' && !!t.serve.url);
  function switchRows(q: string): { open: Row[]; neu: Row[]; all: Row[] } {
    const ql = q.trim().toLowerCase();
    const sv = server();
    const open: Row[] = tabs
      .map((t, i) => ({ t, i }))
      .sort((a, b) => (b.t.used ?? 0) - (a.t.used ?? 0))
      .flatMap(({ t, i }) => {
        const lab = `${i + 1} ${titleOf(t)}`;
        return ql && !fuzzy(ql, lab) ? [] : [{ ic: iconOf(t), lab, meta: metaOf(t), run: () => api.go(i), tab: t }];
      });
    const neu: Row[] = [];
    const top: Row[] = [];
    const served = (s: string): Row => ({ ic: ICON.server, lab: 'server', meta: `npm run ${s}`, run: () => serveScript(s) });
    if (!ql) {
      neu.push({ ic: ICON.files, lab: 'file', meta: 'find one by name', run: () => ((api.files(true, { mode: 'name', q: '' }), (pin = { kind: 'search', value: '', sel: 0 }))) });
      neu.push({ ic: ICON.files, lab: 'folder', meta: "the project's files", run: () => void api.files(true, null) });
      neu.push({ ic: ICON.shell, lab: 'shell', meta: 'run your own commands', run: () => void api.shell() });
      for (const s of ['dev', 'start']) if (scripts()[s]) neu.push(served(s));
      neu.push({ ic: '◐', lab: 'browser', meta: sv?.serve?.url ? `${host(sv.serve.url)}  (from tab ${tabs.indexOf(sv) + 1})` : 'an address or a local HTML file', run: () => askAddress(sv?.serve?.url ? host(sv.serve.url) : '') });
      neu.push({ ic: '✎', lab: 'design studio', meta: 'your page, or a new idea', run: () => askIdea() });
    } else {
      // An address offers "open in browser" first.
      if (addressLike(ql)) {
        const base = sv?.serve?.url ? host(sv.serve.url) : 'localhost:3000';
        const u = ql.startsWith('/') ? base + ql : ql.startsWith(':') ? `localhost${ql}` : ql;
        top.push({ ic: '◐', lab: 'browser', meta: `open ${u}`, run: () => h.browse?.(u, sv && u.startsWith(base) ? sv.id : undefined) });
        if (/^localhost/.test(u)) neu.push({ ic: '✎', lab: 'design studio', meta: `from ${u}`, run: () => h.design?.(u) });
      }
      for (const [k, v] of Object.entries(scripts())) if (fuzzy(ql, k)) neu.push(k === 'dev' || k === 'start' ? served(k) : { ic: ICON.shell, lab: 'shell', meta: `npm run ${k} · ${v}`, run: () => void api.shell(`npm run ${k}`) });
      for (const x of nameHits(ql, h.files(), h.recent?.() ?? []).slice(0, 4)) neu.push({ ic: ICON.files, lab: 'file', meta: x.path, idx: x.idx, run: () => void api.file(x.path) });
      for (const a of h.addresses?.() ?? []) if (fuzzy(ql, a) && !top.some((r) => r.meta === `open ${a}`)) neu.push({ ic: '◐', lab: 'browser', meta: a, run: () => h.browse?.(a) });
      for (const d of h.designs?.() ?? []) if (fuzzy(ql, d)) neu.push({ ic: '✎', lab: 'design', meta: d, run: () => h.design?.(d) });
    }
    return { open, neu, all: [...top, ...open, ...neu] };
  }
  const askAddress = (value = '') =>
    openAsk({ label: 'address ›', value, placeholder: 'localhost:5173/pricing or example.com', submit: (v) => {
      const u = v.trim(), sv = server();
      if (u) h.browse?.(u, sv && u.startsWith(host(sv.serve!.url!)) ? sv.id : undefined);
    } });
  const askIdea = () =>
    openAsk({ label: 'what should it be? ›', placeholder: 'a new idea, or /pricing for your page', submit: (v) => {
      const s = v.trim(), sv = server();
      if (!s || s.startsWith('/') || addressLike(s)) h.design?.(s.startsWith('/') ? (sv?.serve?.url ? host(sv.serve.url) : 'localhost:3000') + s : s);
      else h.idea?.(s);
    } });
  function openAsk(a: Ask) {
    pin = { kind: 'ask', value: a.value ?? '', sel: 0, ask: a };
    visible = true;
    h.redraw();
  }
  function serveScript(s: string) {
    const old = tabs.findIndex((t) => t.kind === 'shell' && t.serve?.script === s && t.state === 'running');
    if (old >= 0) return api.go(old);
    api.serve(`npm run ${s}`, { script: s });
  }

  // ---- : commands (§3.5) ----
  const cmdMatches = (v: string) => {
    const w = v.trim().split(/\s+/)[0] ?? '';
    return /\s/.test(v.trimStart()) ? CMDS.filter((c) => c[0] === w) : CMDS.filter((c) => c[0].startsWith(w));
  };
  // Commands you type yourself run as yourself: :run and :serve don't ask, but
  // plan mode blocks them.
  function runCmd(v: string) {
    const [w, ...rest] = v.trim().split(/\s+/);
    const arg = rest.join(' ');
    const t = cur();
    const planned = (what: string) => (h.plan?.() ? (toast(`plan mode: :${what} is off until you leave plan mode`), true) : false);
    switch (w) {
      case 'open':
        return arg ? h.browse?.(arg) : askAddress();
      case 'run':
        if (planned('run')) return;
        return void api.shell(arg);
      case 'serve': {
        if (planned('serve')) return;
        const s = arg || devScript();
        if (scripts()[s]) return serveScript(s);
        if (arg) return void api.serve(arg);
        return toast('no dev or start script in package.json · :serve <command>');
      }
      case 'files':
        return void api.files(true, arg ? { mode: 'name', q: arg } : null);
      case 'file': {
        const m = /^(.*?)(?::(\d+))?$/.exec(arg)!;
        const files = h.files();
        const p = files.includes(m[1]) ? m[1] : m[1] ? nameHits(m[1], files)[0]?.path : undefined;
        return p && api.file(p, m[2] ? +m[2] : undefined) ? undefined : toast(`no file matches ${arg || '(nothing)'}`);
      }
      case 'design':
        return h.design?.(arg);
      case 'diff': {
        const msg = h.diff?.();
        return msg ? toast(msg) : undefined;
      }
      case 'close':
        if (arg && !tabs[+arg - 1]) return toast(`no tab ${arg}`);
        if (arg) active = +arg - 1;
        return api.close();
      case 'reopen':
        return closed.length ? api.reopen() : toast('nothing to reopen');
      case 'move': {
        if (!t || !+arg) return toast(':move <n>');
        const n = Math.max(1, Math.min(tabs.length, +arg)) - 1;
        tabs.splice(active, 1);
        tabs.splice(n, 0, t);
        active = n;
        return h.redraw();
      }
      case 'rename':
        if (t) t.name = arg || undefined;
        return h.redraw();
      case 'size':
        return arg === 'even' ? api.setRatio(0.5) : +arg ? api.setRatio(+arg / 100) : toast(':size 60 (percent of the width) or :size even');
      case 'hide':
        return api.show(false);
      case 'browser':
        return h.browser?.(rest);
      default:
        return toast(`:${w} is not a panel command · : lists them`);
    }
  }

  // The panel as `height` rows of `width` cells (a border column on the left),
  // and its clickable spots (1-based, relative to the panel).
  function render(width: number, height: number, focused: boolean, border = true): { lines: string[]; hits: { row: number; x0: number; x1: number; id: string }[] } {
    const hits: { row: number; x0: number; x1: number; id: string }[] = [];
    const b: Line = border ? [{ t: '│', s: focused ? st.accent : st.line }] : [];
    const w = width - lineWidth(b) - 1; // a space after the border
    lead = lineWidth(b) + 1;
    const t = cur();
    const bar = tabBar(w, border, hits);
    // Only the focused side shows its keys; this one says how to get here.
    const say: Hint[] = toastMsg ? [['', `${toastMsg} · `, st.ok]] : [];
    const fh = hintLines(
      !focused ? [...say, ['ctrl+g', ' focus']]
      : h.asks?.() ? [['', '● Rime is asking · ', st.warn], ['ctrl+g', ' answer']]
      : sheet ? [['', 'any key closes this']]
      : [...say, ...foot(t)], w, st);
    // The panel line's input (: command, / search, address ›).
    const pinLine: Line[] = focused && pin && pin.kind !== 'switch' ? [pinRow()] : [];
    const rows = Math.max(1, height - 3 - pinLine.length - fh.lines.length);
    shown = { w, rows };
    hitRows = [];
    let content: Line[] = sheet ? sheetLines(t) : t ? body(t, w, rows) : [[{ t: 'No tabs yet.', s: st.dim }]];
    content = [...content.slice(0, rows), ...new Array(Math.max(0, rows - content.length)).fill([])];
    // Clicks in the content, before the boxes drawn over it.
    if (!sheet && t?.kind === 'files') {
      if (hitRows.length) hitRows.forEach((n, i) => n >= 0 && hits.push({ row: 4 + i, x0: lead + 1, x1: width, id: `side:hit:${n}` }));
      else if (!t.search?.q && pin?.kind !== 'search') for (let i = 0; i < rows; i++) hits.push({ row: 3 + i, x0: lead + 1, x1: width, id: `side:row:${i}` });
    }
    if (!sheet && t?.kind === 'shell' && !t.mirror && !t.serve && !pin) hits.push({ row: 2 + rows, x0: lead + 1, x1: width, id: 'side:type' });
    if (focused && pin?.kind === 'switch') {
      const { open, neu, all } = switchRows(pin.value);
      pin.sel = Math.max(0, Math.min(pin.sel, all.length - 1));
      const top = all.slice(0, all.length - open.length - neu.length);
      const out: { line: Line; i?: number }[] = [];
      let n = 0;
      const item = (r: Row) => {
        const i = n++, on = i === pin!.sel;
        const lab: Line = [{ t: on ? '› ' : '  ', s: st.accent }, { t: `${r.ic} `, s: on || r.tab?.byRime ? st.accent : st.dim }, { t: r.lab, s: on ? st.titleB : st.fg }];
        const meta: Line = r.idx ? [...(r.meta ?? '')].map((ch, j) => ({ t: ch, s: r.idx!.includes(j) ? st.accentB : st.dim })) : [{ t: r.meta ?? '', s: st.dim }];
        out.push({ line: [...lab, { t: ' '.repeat(Math.max(2, 26 - lineWidth(lab))), s: '' }, ...meta], i });
      };
      top.forEach(item);
      if (open.length) out.push({ line: [{ t: 'open', s: st.dim }] }), open.forEach(item);
      if (neu.length) out.push({ line: [{ t: 'new', s: st.dim }] }), neu.forEach(item);
      if (!all.length) out.push({ line: [{ t: '  nothing matches', s: st.dim }] });
      // The query on top; the selected row stays inside the box.
      const room = Math.max(2, rows - 3);
      const at = out.findIndex((r) => r.i === pin!.sel);
      const from = Math.max(0, Math.min(at - room + 1, out.length - room));
      const vis = out.slice(from, from + room);
      const query: Line = [{ t: '› ', s: st.accent }, { t: pin.value, s: st.title }, { t: '▏', s: st.accent }, ...(pin.value ? [] : [{ t: 'type a tab, file, script or address', s: st.placeholder }])];
      const boxed = frame('go to', [query, ...vis.map((r) => r.line)], w);
      content.splice(0, boxed.length, ...boxed);
      for (let i = hits.length - 1; i >= 0; i--) if (hits[i].row >= 3) hits.splice(i, 1);
      vis.forEach((r, j) => r.i !== undefined && hits.push({ row: 3 + 2 + j, x0: lead + 1, x1: width, id: `side:sw:${r.i}` }));
    }
    if (focused && pin?.kind === 'cmd') {
      const ms = cmdMatches(pin.value);
      pin.sel = Math.max(0, Math.min(pin.sel, ms.length - 1));
      if (ms.length) {
        const nameW = Math.max(...ms.map(([c, a]) => strWidth(`:${c} ${a}`))) + 2;
        const shownMs = ms.slice(0, Math.max(1, rows - 2));
        const boxed = frame('panel commands', shownMs.map(([c, a, d], i): Line => [{ t: i === pin!.sel ? '› ' : '  ', s: st.accent }, { t: `:${c}`, s: i === pin!.sel ? st.accentB : st.accent }, { t: ` ${a}`.padEnd(nameW - strWidth(`:${c}`)), s: st.dim }, { t: d, s: i === pin!.sel ? st.title : st.fg }]), w);
        const at = Math.max(0, rows - boxed.length);
        content.splice(at, boxed.length, ...boxed);
        for (let i = hits.length - 1; i >= 0; i--) if (hits[i].row >= 3 + at && hits[i].row <= 2 + rows) hits.splice(i, 1);
        shownMs.forEach((_, i) => hits.push({ row: 3 + at + 1 + i, x0: lead + 1, x1: width, id: `side:cmd:${i}` }));
      }
    }
    const rule: Line = [{ t: '─'.repeat(w), s: st.line }];
    const dimmed = (l: Line): Line => (focused ? l : l.map((r) => ({ t: r.t, s: r.s + st.faint })));
    const lines: Line[] = [bar, rule, ...content.map(dimmed), rule, ...pinLine, ...fh.lines];
    const footAt = 3 + rows + pinLine.length;
    fh.segs.forEach((segs, i) => hits.push(...segs.map((s) => ({ row: footAt + 1 + i, x0: s.x0 + lead, x1: s.x1 + lead, id: !focused ? 'panel' : s.id }))));
    return { lines: lines.slice(0, height).map((l) => str([...b, { t: ' ', s: '' }, ...fit(l, w)], st)), hits };
  }

  function pinRow(): Line {
    const p = pin!;
    const lead: Line = p.kind === 'cmd' ? [{ t: ':', s: st.accentB }] : p.kind === 'search' || p.kind === 'find' ? [{ t: '/', s: st.accentB }] : [{ t: `${p.ask?.label ?? '›'} `, s: st.accent }];
    const ph = p.kind === 'cmd' ? 'open, run, serve, files, design…' : p.kind === 'search' ? ((cur() as FilesTab)?.search?.mode === 'text' ? 'text in files' : 'file names') : p.kind === 'find' ? 'find in this tab' : p.ask?.placeholder ?? '';
    return [...lead, { t: p.value, s: st.title }, { t: '▏', s: st.accent }, ...(p.value ? [] : [{ t: ph, s: st.placeholder }])];
  }

  // The tab bar (§3.1): number, icon, title, state and link; titles shorten
  // before tabs drop, and dropped tabs show as +3 (the switcher).
  function tabBar(w: number, both: boolean, hits: { row: number; x0: number; x1: number; id: string }[]): Line {
    const right: Line = [{ t: 'space', s: st.accentB }, { t: ' ≡', s: st.dim }, ...(both ? [{ t: '  ✕', s: st.dim }] : [])];
    const room = w - lineWidth(right) - 1;
    const label = (t: Tab, i: number, max: number) => {
      const title = titleOf(t), tt = strWidth(title) > max ? title.slice(0, Math.max(1, max - 1)) + '…' : title;
      const on = i === active, flash = !!t.flash && t.flash > Date.now();
      const bg = on ? st.panelBg : '';
      const link = linkOf(t);
      const line: Line = [
        { t: ` ${i + 1} `, s: (on ? st.accent : st.dim) + bg },
        { t: iconOf(t), s: (t.kind === 'shell' && t.serve && t.state === 'running' ? st.ok : t.byRime ? st.accent : st.dim) + bg },
        { t: ` ${tt}`, s: (on ? st.titleB : flash ? st.warn : st.dim) + bg },
        ...(stateMark(t) ? [{ t: stateMark(t), s: markStyle(t) + bg }] : []),
        ...(link ? [{ t: ` ${link}`, s: st.dim + bg }] : []),
        { t: ' ', s: bg },
      ];
      return { line, w: lineWidth(line), i };
    };
    let parts = tabs.map((t, i) => label(t, i, 24));
    for (const max of [16, 10, 6]) if (parts.reduce((n, p) => n + p.w + 1, 0) > room) parts = tabs.map((t, i) => label(t, i, max));
    // Still too wide: the active tab and its neighbours, and +N for the rest.
    let from = 0, to = parts.length;
    const width = (a: number, z: number) => parts.slice(a, z).reduce((n, p) => n + p.w + 1, 0) + (z - a < parts.length ? 4 : 0);
    while (width(from, to) > room && to - from > 1) {
      if (active - from > to - 1 - active) from++;
      else to--;
    }
    const bar: Line = [];
    for (const p of parts.slice(from, to)) {
      hits.push({ row: 1, x0: lead + lineWidth(bar) + 1, x1: lead + lineWidth(bar) + p.w, id: `side:tab:${p.i}` });
      bar.push(...p.line, { t: ' ', s: '' });
    }
    const more = parts.length - (to - from);
    if (more) {
      hits.push({ row: 1, x0: lead + lineWidth(bar) + 1, x1: lead + lineWidth(bar) + String(more).length + 1, id: 'key:space' });
      bar.push({ t: `+${more}`, s: st.accent });
    }
    const pad = Math.max(1, w - lineWidth(bar) - lineWidth(right));
    hits.push({ row: 1, x0: lead + lineWidth(bar) + pad + 1, x1: lead + lineWidth(bar) + pad + 7, id: 'key:space' });
    if (both) hits.push({ row: 1, x0: lead + w, x1: lead + w, id: 'side:hide' });
    return [...bar, { t: ' '.repeat(pad), s: '' }, ...right];
  }

  // The ? sheet: this tab's keys, then the panel's.
  function sheetLines(t: Tab | undefined): Line[] {
    const row = ([k, x]: [string, string]): Line => [{ t: k.padEnd(10), s: st.accentB }, { t: x, s: st.fg }];
    const mine = t ? own(t).filter(([k]) => k).map(([k, x]): [string, string] => [k, x.replace(/ · $/, '').trim()]) : [];
    return [...(mine.length ? [[{ t: `This tab · ${titleOf(t!)}`, s: st.titleB }] as Line, ...mine.map(row), []] : []), [{ t: 'Panel', s: st.titleB }], ...SHEET.map(row)];
  }

  // ---- keys (when the panel has focus; ctrl+g never reaches here) ----
  // 'blur' hands focus back to the chat; true when the key was used. Order: the
  // panel line's input or a tab taking typing gets everything; then the panel's
  // single keys; then the tab's.
  function key(k: Key): boolean | 'blur' {
    const r = keyIn(k);
    return api.visible ? r : 'blur';
  }
  function keyIn(k: Key): boolean | 'blur' {
    if (sheet) return (sheet = false), h.redraw(), true;
    if (pin) return pinKey(k), h.redraw(), true;
    const t = cur();
    if (asking !== null) {
      const yes = k.name === 'char' && k.ch === 'x';
      asking = null;
      if (yes) api.close(true);
      return h.redraw(), true;
    }
    const char = k.name === 'char' && !k.ctrl ? k.ch ?? '' : '';
    if (!typing(t)) {
      if (k.name === 'space') return api.choose(), true;
      if (char === 'n') return api.choose(true), true;
      if (/^[1-9]$/.test(char)) return api.go(+char - 1), true;
      if (k.name === 'tab') return api.next(k.shift ? -1 : 1), true;
      if (char === 'x') return api.close(), true;
      if (char === 'z') return (zoomed = !zoomed), h.redraw(), true;
      if (char === '?') return (sheet = true), h.redraw(), true;
      if (char === ':') return (pin = { kind: 'cmd', value: '', sel: 0 }), h.redraw(), true;
      if (char === '/' && t?.kind === 'files') return (t.search ??= { mode: 'name', q: '', sel: 0 }), (pin = { kind: 'search', value: t.search.q, sel: 0 }), h.redraw(), true;
      if (char === '/' && t && t.kind !== 'custom') return (pin = { kind: 'find', value: (t as TextTab | ShellTab).find ?? '', sel: 0 }), h.redraw(), true;
    }
    if (!t) return k.name === 'escape' ? 'blur' : true;
    if (t.kind === 'custom') {
      const r = t.key?.(k);
      if (r && typeof r === 'object') return openAsk(r), true;
      if (r) return h.redraw(), true;
      return k.name === 'escape' ? 'blur' : true;
    }
    if (t.kind === 'shell') return shellKey(t, k, char);
    if (t.kind === 'files') return filesKey(t, k, char);
    // diff and file viewer
    const page = Math.max(1, shown.rows - 2);
    if (k.name === 'down') t.scroll++;
    else if (k.name === 'up') t.scroll = Math.max(0, t.scroll - 1);
    else if (k.ctrl && k.name === 'd') t.scroll += page;
    else if (k.ctrl && k.name === 'u') t.scroll = Math.max(0, t.scroll - page);
    else if (char === '@' && t.kind === 'file' && t.path) h.mention?.(t.path, [t.scroll + 1, Math.min(t.raw.length, t.scroll + shown.rows)]);
    else if (k.name === 'enter' && t.kind === 'diff') {
      const at = hunkAt(t);
      if (!at || !api.file(at.path, at.line)) toast('no file for this hunk');
    } else if (k.name === 'escape') return t.find ? ((t.find = undefined), h.redraw(), true) : 'blur';
    else return true;
    h.redraw();
    return true;
  }

  function shellKey(t: ShellTab, k: Key, char: string): boolean | 'blur' {
    if (!t.typing) {
      if (k.name === 'escape') return t.find ? ((t.find = undefined), h.redraw(), true) : 'blur';
      if (k.ctrl && k.name === 'c') return stop(t), h.redraw(), true;
      if (k.name === 'enter' && !t.mirror && !t.serve) return (t.typing = true), h.redraw(), true;
      if (char === 'r' && t.cmd && !t.mirror) {
        if (t.state === 'running' && !t.serve) return true;
        if (t.state === 'running') stop(t), t.out.push('(restarted)');
        return start(t, t.cmd), true;
      }
      if (char === 'o' && t.serve?.url) return h.browse?.(host(t.serve.url), t.id), true;
      if (k.name === 'down') return (t.scroll = Math.max(0, t.scroll - 1)), h.redraw(), true;
      if (k.name === 'up') return (t.scroll = Math.min(t.out.length, t.scroll + 1)), h.redraw(), true;
      return true;
    }
    // Typing: every key goes to the $ line, ctrl+c and ctrl+w too.
    if (k.name === 'escape') return (t.typing = false), h.redraw(), true;
    if (k.ctrl && k.name === 'c') return t.state === 'running' ? stop(t) : (t.input = ''), h.redraw(), true;
    if (k.name === 'enter') {
      const cmd = t.input.trim() || t.cmd;
      if (!cmd || t.state === 'running') return true;
      if (t.input.trim()) t.history.push(t.input.trim());
      t.input = '';
      start(t, cmd);
      return true;
    }
    if (k.name === 'backspace') t.input = t.input.slice(0, -1);
    else if (k.name === 'up') t.input = t.history.at(-1) ?? t.cmd;
    else if (k.ctrl && k.name === 'u') t.input = '';
    else if (k.ctrl && k.name === 'w') t.input = t.input.replace(/\S+\s*$/, '');
    else if (char) t.input += char;
    else if (k.name === 'space') t.input += ' ';
    return h.redraw(), true;
  }

  function filesKey(t: FilesTab, k: Key, char: string): boolean | 'blur' {
    // A search left open (from :files <query>, or Rime): its hits take ↑ ↓ enter @.
    if (t.search?.q) {
      const hs = hitsOf(t.search), x = hs[t.search.sel];
      if (k.name === 'escape') return (t.search = null), h.redraw(), true;
      if (k.name === 'down') t.search.sel = Math.min(hs.length - 1, t.search.sel + 1);
      else if (k.name === 'up') t.search.sel = Math.max(0, t.search.sel - 1);
      else if (k.name === 'enter' && x) api.file(x.path, x.line);
      else if (char === '@' && x) h.mention?.(x.path, x.line ? [x.line, x.line] : undefined);
      return h.redraw(), true;
    }
    const rs = rowsOf(t), r = rs[t.sel];
    if (k.name === 'escape') return 'blur';
    if (k.name === 'down') return (t.sel = Math.min(rs.length - 1, t.sel + 1)), h.redraw(), true;
    if (k.name === 'up') return (t.sel = Math.max(0, t.sel - 1)), h.redraw(), true;
    if (!r) return true;
    if (char === '@') return h.mention?.(r.dir ? r.path + '/' : r.path), true;
    if (k.name === 'right' && r.dir) return t.open.add(r.path), h.redraw(), true;
    if (k.name === 'left') {
      if (r.dir && t.open.has(r.path)) t.open.delete(r.path);
      else if (r.path.includes('/')) {
        const up = r.path.slice(0, r.path.lastIndexOf('/'));
        t.open.delete(up);
        t.sel = rowsOf(t).findIndex((x) => x.path === up);
      }
      return h.redraw(), true;
    }
    if (k.name === 'enter') {
      if (r.dir) t.open.has(r.path) ? t.open.delete(r.path) : t.open.add(r.path);
      else api.file(r.path);
      return h.redraw(), true;
    }
    return true;
  }

  // The panel line's input and the switcher take every key.
  function pinKey(k: Key) {
    const p = pin!, t = cur();
    const char = k.name === 'char' && !k.ctrl ? k.ch ?? '' : k.name === 'space' ? ' ' : '';
    const edit = () => {
      if (k.name === 'backspace') p.value = p.value.slice(0, -1);
      else if (k.ctrl && k.name === 'u') p.value = '';
      else if (k.ctrl && k.name === 'w') p.value = p.value.replace(/\S+\s*$/, '');
      else if (char) p.value += char;
      else return false;
      p.sel = 0;
      return true;
    };
    if (k.ctrl && k.name === 'c') return void (pin = null);
    if (p.kind === 'search' && t?.kind === 'files') {
      const s = (t.search ??= { mode: 'name', q: '', sel: 0 });
      // esc clears the search; a second esc leaves it.
      if (k.name === 'escape') return void (p.value ? ((p.value = s.q = ''), (s.sel = 0)) : ((pin = null), (t.search = null)));
      if (k.name === 'tab') return void ((s.mode = s.mode === 'name' ? 'text' : 'name'), (s.sel = 0));
      const hs = hitsOf(s);
      if (k.name === 'down') return void (s.sel = Math.min(hs.length - 1, s.sel + 1));
      if (k.name === 'up') return void (s.sel = Math.max(0, s.sel - 1));
      if (k.name === 'enter') {
        const x = hs[s.sel];
        if (x) (pin = null), api.file(x.path, x.line);
        return;
      }
      if (edit()) (s.q = p.value), (s.sel = 0);
      return;
    }
    if (k.name === 'escape') {
      if (p.kind === 'find' && t && (t.kind === 'file' || t.kind === 'diff' || t.kind === 'shell')) t.find = undefined;
      pin = null;
      return;
    }
    if (p.kind === 'switch') {
      const all = switchRows(p.value).all;
      if (k.name === 'down') p.sel = Math.min(all.length - 1, p.sel + 1);
      else if (k.name === 'up') p.sel = Math.max(0, p.sel - 1);
      else if (k.name === 'enter') {
        const x = all[p.sel];
        pin = null;
        x?.run();
      } else edit();
      return;
    }
    if (p.kind === 'cmd') {
      const ms = cmdMatches(p.value);
      if (k.name === 'down') return void (p.sel = Math.min(ms.length - 1, p.sel + 1));
      if (k.name === 'up') return void (p.sel = Math.max(0, p.sel - 1));
      if (k.name === 'tab') return void (ms[p.sel] && (p.value = ms[p.sel][0] + ' '));
      if (k.name === 'enter') {
        let v = p.value.trim();
        const m = ms[p.sel];
        // A command that needs something completes first ("open " waits for the address).
        if (!/\s/.test(v) && m && m[0] !== v && m[1].startsWith('<')) return void (p.value = m[0] + ' ');
        if (!/\s/.test(v) && m) v = m[0];
        pin = null;
        return void (v && runCmd(v));
      }
      edit();
      return;
    }
    if (p.kind === 'find' && t && (t.kind === 'file' || t.kind === 'diff' || t.kind === 'shell')) {
      const at = t.kind === 'shell' ? t.out.length - t.scroll - Math.ceil(shown.rows / 2) : t.at ?? t.scroll;
      if (k.name === 'enter' || k.name === 'down') return findNext(t, at + 1);
      if (k.name === 'up') return findNext(t, at - 1, -1);
      if (edit()) (t.find = p.value || undefined), (t.kind !== 'shell' && (t.at = undefined)), p.value && findNext(t, t.kind === 'shell' ? 0 : t.scroll);
      return;
    }
    if (p.kind === 'ask') {
      if (k.name === 'enter') {
        pin = null;
        return p.ask!.submit(p.value);
      }
      edit();
    }
  }

  // ---- tabs, from the outside ----
  const api = {
    tabs,
    get active() {
      return active;
    },
    get visible() {
      return visible && (tabs.length > 0 || !!pin);
    },
    get ratio() {
      return ratio;
    },
    get zoomed() {
      return zoomed && visible;
    },
    // The switcher (space), or on its "new" rows (n).
    choose(onNew = false) {
      pin = { kind: 'switch', value: '', sel: onNew ? switchRows('').open.length : 0 };
      visible = true;
      h.redraw();
    },
    asking: () => asking !== null,
    typing: () => visible && typing(),
    toast,
    zoom(on: boolean) {
      zoomed = on;
      h.redraw();
    },
    show(on = !visible) {
      visible = on;
      if (!on) (pin = null), (zoomed = false), (sheet = false);
      h.redraw();
    },
    // Dragging the divider or :size: the panel's share of the width, kept between a quarter and three quarters.
    setRatio(r: number) {
      ratio = Math.min(0.75, Math.max(0.25, r));
      h.redraw();
    },
    go(i: number) {
      if (tabs[i]) (active = i), (visible = true), (asking = null), touch(tabs[i]), h.redraw();
    },
    next: (d: number) => void (tabs.length && api.go((active + d + tabs.length) % tabs.length)),
    indexOf,
    // Links two tabs: a browser on a server's address (← 2), a design applied to the project (→ 3).
    link(t: object, o: { from?: number; to?: number }) {
      Object.assign(t as Tab, o);
      h.redraw();
    },
    // Closes the active tab; a running one asks first (call again to stop it).
    close(force = false) {
      const t = cur();
      if (!t) return;
      if (running(t) && !force && asking !== active) return void ((asking = active), h.redraw());
      asking = null;
      if (t.kind === 'shell') stop(t);
      if (t.kind === 'custom') t.close?.();
      closed.push(...tabs.splice(active, 1));
      active = Math.max(0, Math.min(active, tabs.length - 1));
      if (!tabs.length) (visible = false), (zoomed = false); // closing the last tab un-splits
      h.redraw();
    },
    reopen() {
      const t = closed.pop();
      if (!t) return;
      if (t.kind === 'custom') return toast('a browser or design tab opens again from its command');
      if (t.kind === 'shell') t.state = t.state === 'running' ? 'stopped' : t.state;
      add(t);
    },
    shell: (cmd = '', byRime = false, focus = true) => {
      const t = add(shellTab(cmd, byRime), focus);
      if (cmd) start(t, cmd);
      return t;
    },
    // A server tab (§4.4): not bound to any timeout; it stops with ctrl+c, x or quitting.
    serve(cmd: string, o: { script?: string; byRime?: boolean; focus?: boolean; argv?: [string, string[]] } = {}) {
      const t = add<ShellTab>({ ...shellTab(cmd, o.byRime), typing: false, serve: { script: o.script }, argv: o.argv }, o.focus ?? true);
      start(t, cmd);
      return t;
    },
    // The last lines of a shell or server tab, for the model (rime tab.read).
    read(n: number, lines = 60) {
      const t = tabs[n];
      if (t?.kind !== 'shell') return null;
      const text = t.out.slice(-Math.max(1, lines)).join('\n');
      return text.length > 4000 ? '…' + text.slice(-4000) : text;
    },
    // A command Rime runs itself: its output mirrored into a new tab as it comes.
    mirror(cmd: string) {
      const t = add({ ...shellTab(cmd, true), state: 'running' as const, mirror: true, typing: false, out: [`$ ${cmd}`] }, false);
      return { tab: tabs.indexOf(t) + 1, write: (s: string) => write(t, s), done: (code: number) => done(t, code) };
    },
    // One diff tab, updated in place.
    diff(text: string, focus = false) {
      const old = tabs.find((t): t is TextTab => t.kind === 'diff');
      const raw = diffRaw(text);
      if (old) {
        Object.assign(old, { raw, lines: diffLines(raw), scroll: 0, find: undefined });
        if (focus) (active = tabs.indexOf(old)), (visible = true), touch(old);
        else old.flash = Date.now() + 1500;
        setTimeout(h.redraw, 1600);
        return h.redraw();
      }
      add({ id: ++seq, kind: 'diff', title: 'diff', raw, lines: diffLines(raw), scroll: 0, byRime: true }, focus);
    },
    // The files tab; search: open it searching (null: the tree).
    files(focus = true, search?: { mode: 'name' | 'text'; q: string } | null) {
      let t = tabs.find((x): x is FilesTab => x.kind === 'files');
      if (!t) t = add({ id: ++seq, kind: 'files', title: 'files', open: new Set(), sel: 0, scroll: 0, search: null }, focus);
      else if (focus) api.go(tabs.indexOf(t));
      if (search !== undefined) t.search = search && { ...search, sel: 0 };
      h.redraw();
      return t;
    },
    // A read-only viewer at a line (reused when the file is already open).
    file(rel: string, line?: number, focus = true) {
      const raw = fileLines(rel);
      if (!raw) return false;
      const old = tabs.findIndex((t) => t.kind === 'file' && t.path === rel);
      const scroll = line ? Math.max(0, line - 6) : 0;
      const title = path.basename(rel) + (line ? `:${line}` : '');
      if (old >= 0) Object.assign(tabs[old], { raw, lines: numbered(raw), mark: line, scroll, title }), focus && api.go(old), (visible = true), h.redraw();
      else add({ id: ++seq, kind: 'file', title, path: rel, raw, lines: numbered(raw), scroll, mark: line, byRime: !focus }, focus);
      return true;
    },
    custom: (t: Omit<CustomTab, 'id' | 'kind'>, focus = true) => add({ ...t, id: ++seq, kind: 'custom' } as CustomTab, focus),
    // Mouse: a tab in the bar, a row in the files tree or the search, the
    // switcher's rows, the : completions; the wheel scrolls.
    click(id: string) {
      const t = cur();
      if (id === 'side:hide') return api.show(false);
      if (id === 'side:type') return void (t?.kind === 'shell' && !t.mirror && ((t.typing = true), h.redraw()));
      const m = /^side:(tab|row|hit|sw|cmd):(\d+)$/.exec(id);
      if (!m) return;
      const n = +m[2];
      if (m[1] === 'tab') return api.go(n);
      if (m[1] === 'sw' && pin?.kind === 'switch') {
        const x = switchRows(pin.value).all[n];
        pin = null;
        x?.run();
        return h.redraw();
      }
      if (m[1] === 'cmd' && pin?.kind === 'cmd') return void ((pin.value = cmdMatches(pin.value)[n][0] + ' '), h.redraw());
      if (t?.kind !== 'files') return;
      if (m[1] === 'hit' && t.search) {
        const x = hitsOf(t.search)[n];
        if (x) (pin = null), api.file(x.path, x.line);
        return;
      }
      t.sel = t.scroll + n;
      keyIn({ name: 'enter' });
    },
    wheel(d: number) {
      const t = cur();
      if (!t) return;
      if (t.kind === 'shell') t.scroll = Math.max(0, Math.min(t.out.length, t.scroll - d));
      else if (t.kind === 'files') t.search?.q ? (t.search.sel = Math.max(0, t.search.sel + d)) : (t.sel = Math.max(0, t.sel + d));
      else if (t.kind !== 'custom') t.scroll = Math.max(0, t.scroll + d);
      else t.wheel?.(d);
      h.redraw();
    },
    // A press inside the panel (1-based, relative to its first column): a plug-in
    // tab gets it in its own cells.
    press(x: number, y: number) {
      const t = cur();
      if (t?.kind !== 'custom' || y < 3 || pin || sheet) return;
      t.click?.(x - lead - 1, y - 3);
      h.redraw();
    },
    // What a plug-in tab draws over its cells after a frame (images), with where
    // its content starts on screen.
    overlay(col: number, top = 0) {
      const t = cur();
      if (!visible || sheet || pin?.kind === 'switch' || t?.kind !== 'custom' || !t.overlay) return null;
      return t.overlay(col + lead, 3 + top, shown.w, shown.rows);
    },
    hideImages: () => tabs.map((t) => (t.kind === 'custom' ? (t.hide?.() ?? '') : '')).join(''),
    // Closes every plug-in tab (the browser and design share one Chrome).
    closePlugins() {
      for (let i = tabs.length - 1; i >= 0; i--) if (tabs[i].kind === 'custom') (active = i), this.close(true);
    },
    running: () => tabs.filter((t) => t.kind === 'shell' && t.state === 'running').length,
    servers: () => tabs.filter((t) => t.kind === 'shell' && t.serve && t.state === 'running').length,
    killAll: () => tabs.forEach((t) => (t.kind === 'shell' ? stop(t) : t.kind === 'custom' ? t.close?.() : null)),
    titleOf,
    key,
    render,
  };
  return api;
}
export type Side = ReturnType<typeof createSide>;
