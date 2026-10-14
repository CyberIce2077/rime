// shell-panel (SPEC §8, Phase 10): the tabbed right panel of split view. Tabs are
// numbered: shells (each command Rime runs, and ones you open with ctrl+t), a
// diff, the files tree, read-only file viewers, and plug-in tabs (browser,
// design). Shells are plain child processes with their output captured, no pty
// (SPEC §8 allows starting there): commands that need a terminal of their own
// (an editor, a prompt for a password) don't work in a tab.

import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { type Key, type Line, fit, lineWidth, strWidth } from '../../core/term.ts';
import { clean } from '../../core/tools.ts';
import { type Hint, type Styles, hintLines, str } from '../../core/view.ts';

type Base = { id: number; title: string; byRime?: boolean; flash?: number };
export type ShellTab = Base & { kind: 'shell'; cmd: string; out: string[]; state: 'idle' | 'running' | 'passed' | 'failed' | 'stopped'; code?: number; child?: ChildProcess; input: string; history: string[]; scroll: number; mirror?: boolean };
export type TextTab = Base & { kind: 'diff' | 'file'; lines: Line[]; scroll: number; path?: string; mark?: number };
export type FilesTab = Base & { kind: 'files'; open: Set<string>; sel: number; filter: string; filtering: boolean; scroll: number };
// A plug-in's tab (browser, design): it draws itself and takes its keys.
export type CustomTab = Base & {
  kind: 'custom';
  render(width: number, height: number): Line[];
  key?(k: Key): boolean;
  foot(): Hint[];
  close?(): void;
  busy?(): boolean;
  click?(x: number, y: number): void; // 0-based cells in its content
  wheel?(d: number): void;
  overlay?(col: number, row: number, width: number, height: number): string | null; // an image drawn after the text (Kitty, iTerm2): null when there's none, '' when it's already up
  hide?(): string; // takes the image away when the tab stops showing
};
export type Tab = ShellTab | TextTab | FilesTab | CustomTab;

export type SideHost = { root: string; st: Styles; redraw(): void; files(): string[]; env(): NodeJS.ProcessEnv; open(path: string, line?: number): void };

const MAX_OUT = 5000; // lines kept per shell tab

export function createSide(h: SideHost) {
  const { st } = h;
  const tabs: Tab[] = [];
  const closed: Tab[] = [];
  let active = 0, seq = 0;
  let visible = false;
  let ratio = 0.45; // the panel's share of the width
  let asking: number | null = null; // closing a running tab: "ctrl-w q again stops it"
  let lead = 2; // columns before the content: the border and a space (1 without the border)
  let shown = { w: 0, rows: 0 }; // the content area of the last frame

  const add = <T extends Tab>(t: T, focus = true): T => {
    tabs.push(t);
    visible = true;
    if (focus || tabs.length === 1) active = tabs.length - 1;
    else t.flash = Date.now() + 1500; // a new tab flashes in without stealing focus
    if (t.flash) setTimeout(h.redraw, 1600);
    h.redraw();
    return t;
  };
  const cur = () => tabs[active] as Tab | undefined;

  // ---- shells ----
  function start(t: ShellTab, cmd: string) {
    t.cmd = cmd;
    t.title = cmd.split(/\s+/).slice(0, 3).join(' ');
    t.out = [];
    t.state = 'running';
    t.scroll = 0;
    t.code = undefined;
    const p = spawn('sh', ['-c', cmd], { cwd: h.root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: h.env() });
    t.child = p;
    const take = (d: Buffer) => write(t, d.toString('utf8'));
    p.stdout!.on('data', take);
    p.stderr!.on('data', take);
    p.on('error', (e) => write(t, e.message + '\n'));
    p.on('close', (code, sig) => done(t, sig ? 130 : (code ?? 1)));
  }
  const partial = new WeakMap<ShellTab, string>(); // a line still being written
  function write(t: ShellTab, chunk: string) {
    const text = (partial.get(t) ?? '') + clean(chunk);
    const parts = text.split('\n');
    partial.set(t, parts.pop()!);
    t.out.push(...parts);
    if (t.out.length > MAX_OUT) t.out.splice(0, t.out.length - MAX_OUT);
    h.redraw();
  }
  function done(t: ShellTab, code: number) {
    const rest = partial.get(t);
    if (rest) t.out.push(rest), partial.set(t, '');
    t.child = undefined;
    t.code = code;
    t.state = t.state === 'stopped' ? 'stopped' : code === 0 ? 'passed' : 'failed';
    h.redraw();
  }
  const stop = (t: ShellTab) => {
    if (!t.child?.pid) return;
    t.state = 'stopped';
    try {
      process.kill(-t.child.pid, 'SIGKILL');
    } catch {
      t.child.kill('SIGKILL');
    }
  };
  const shellTab = (cmd = '', byRime = false): ShellTab => ({ id: ++seq, kind: 'shell', title: cmd ? cmd.split(/\s+/).slice(0, 3).join(' ') : 'shell', cmd, out: [], state: 'idle', input: '', history: [], scroll: 0, byRime });

  // ---- files tree ----
  // Visible rows: folders (open or not) and files, indented; a filter lists the
  // matching paths flat.
  function rowsOf(t: FilesTab): { path: string; dir: boolean; depth: number }[] {
    const files = h.files();
    if (t.filter) {
      const f = t.filter.toLowerCase();
      return files.filter((p) => p.toLowerCase().includes(f)).slice(0, 500).map((p) => ({ path: p, dir: false, depth: 0 }));
    }
    const out: { path: string; dir: boolean; depth: number }[] = [];
    const seen = new Set<string>();
    for (const f of files) {
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

  // ---- text tabs ----
  function fileLines(rel: string): Line[] | null {
    try {
      const text = fs.readFileSync(path.join(h.root, rel), 'utf8');
      const all = text.split('\n');
      const w = String(all.length).length;
      return all.slice(0, 20000).map((l, i) => [{ t: `${String(i + 1).padStart(w)}  `, s: st.dim }, { t: l.replace(/\t/g, '  '), s: st.fg }]);
    } catch {
      return null;
    }
  }
  const diffLines = (text: string): Line[] =>
    text.split('\n').filter((l) => !/^(index |diff --git|new file mode|deleted file mode)/.test(l)).map((l) => [{ t: l, s: l.startsWith('+++') || l.startsWith('---') ? st.titleB : l.startsWith('+') ? st.ok : l.startsWith('-') ? st.del : l.startsWith('@@') ? st.accent : st.fg }]);

  // ---- drawing ----
  const mark = (t: Tab) => (t.kind !== 'shell' ? '' : t.state === 'running' ? '● ' : t.state === 'passed' ? '✓ ' : t.state === 'failed' ? '✗ ' : t.state === 'stopped' ? '■ ' : '');
  const markStyle = (t: Tab) => (t.kind !== 'shell' ? st.dim : t.state === 'running' ? st.accent : t.state === 'passed' ? st.ok : t.state === 'idle' ? st.dim : st.del);

  function body(t: Tab, w: number, rows: number): Line[] {
    const dim = (s: string) => ({ t: s, s: st.dim });
    if (t.kind === 'custom') return t.render(w, rows);
    if (t.kind === 'shell') {
      const head: Line[] = t.cmd ? [[{ t: '$ ', s: st.dim }, { t: t.cmd, s: st.titleB }]] : [];
      const foot: Line[] = [];
      if (t.state === 'running') foot.push([{ t: '● ', s: st.accent }, dim('running')]);
      else if (t.state !== 'idle') foot.push([{ t: mark(t), s: markStyle(t) }, dim(t.state === 'stopped' ? 'stopped' : `exit ${t.code}`)]);
      if (t.state !== 'running' && !t.mirror) foot.push([{ t: '$ ', s: st.accent }, { t: t.input, s: st.title }, { t: '▏', s: st.accent }]);
      const room = Math.max(0, rows - head.length - foot.length);
      const end = Math.max(0, t.out.length - t.scroll);
      const shown = t.out.slice(Math.max(0, end - room), end).map((l): Line => [{ t: l, s: st.fg }]);
      return [...head, ...shown, ...new Array(Math.max(0, room - shown.length)).fill([]), ...foot];
    }
    if (t.kind === 'files') {
      const rs = rowsOf(t);
      t.sel = Math.max(0, Math.min(t.sel, rs.length - 1));
      const room = rows - (t.filtering || t.filter ? 1 : 0);
      if (t.sel < t.scroll) t.scroll = t.sel;
      if (t.sel >= t.scroll + room) t.scroll = t.sel - room + 1;
      const out: Line[] = (t.filtering || t.filter) ? [[{ t: '/', s: st.accent }, { t: t.filter, s: st.title }, ...(t.filtering ? [{ t: '▏', s: st.accent }] : [])]] : [];
      rs.slice(t.scroll, t.scroll + room).forEach((r, i) => {
        const on = t.scroll + i === t.sel;
        const name = t.filter ? r.path : r.path.split('/').pop()!;
        out.push([{ t: on ? '› ' : '  ', s: st.accent }, { t: '  '.repeat(r.depth), s: '' }, ...(r.dir ? [{ t: t.open.has(r.path) ? '▾ ' : '▸ ', s: st.accent }, { t: name + '/', s: on ? st.accentB : st.title }] : [{ t: name, s: on ? st.accentB : st.fg }])]);
      });
      if (!rs.length) out.push([dim(t.filter ? 'no file matches' : 'no files')]);
      return out;
    }
    // diff and file viewer: the marked line stays in view.
    const room = rows;
    t.scroll = Math.max(0, Math.min(t.scroll, Math.max(0, t.lines.length - room)));
    return t.lines.slice(t.scroll, t.scroll + room).map((l, i) => (t.mark && t.scroll + i + 1 === t.mark ? l.map((r) => ({ t: r.t, s: st.panelBg + r.s })) : l));
  }

  function foot(t: Tab | undefined): Hint[] {
    if (!t) return [['ctrl-t', ' new shell · '], ['esc', ' chat']];
    const tabs: Hint[] = [['ctrl-w n p', ' tabs · '], ['ctrl-w q', ' close · '], ['ctrl-w h', ' chat · '], ['?', ' all keys']];
    if (asking !== null) return [['', 'it is still running · ', st.warn], ['ctrl-w q', ' stop it and close · '], ['esc', ' keep it']];
    if (t.kind === 'custom') return [...t.foot(), ...tabs];
    if (t.kind === 'shell')
      return t.state === 'running' ? [['ctrl+c', ' stop · '], ['j k', ' scroll · '], ...tabs] : [['enter', t.input || !t.cmd ? ' run · ' : ' run again · '], ['↑', ' last command · '], ...tabs];
    if (t.kind === 'files') return t.filtering ? [['', 'type to filter · '], ['enter', ' done · '], ['esc', ' clear']] : [['↑ ↓', ' choose · '], ['enter', ' open · '], ['← →', ' fold · '], ['/', ' filter · '], ...tabs];
    return [['j k', ' scroll · '], ['g G', ' top / end · '], ...tabs];
  }

  // The panel as `height` rows of `width` cells (a border column on the left),
  // and its clickable spots (1-based, relative to the panel).
  function render(width: number, height: number, focused: boolean, border = true): { lines: string[]; hits: { row: number; x0: number; x1: number; id: string }[] } {
    const hits: { row: number; x0: number; x1: number; id: string }[] = [];
    const b: Line = border ? [{ t: '│', s: focused ? st.accent : st.line }] : [];
    const w = width - lineWidth(b) - 1; // a space after the border
    lead = lineWidth(b) + 1;
    // The tab bar, scrolled so the active tab shows.
    const parts = tabs.map((t, i) => {
      const flash = t.flash && t.flash > Date.now();
      const label = ` ${i + 1} ${mark(t)}${t.title.length > 24 ? t.title.slice(0, 23) + '…' : t.title} `;
      return { label, line: [{ t: label, s: i === active ? (focused ? st.accentB : st.titleB) + st.panelBg : flash ? st.warn : t.byRime ? st.accent : st.dim }] as Line, i };
    });
    let from = 0;
    while (from < active && parts.slice(from, active + 1).reduce((n, p) => n + strWidth(p.label) + 1, 0) > w) from++;
    const bar: Line = [];
    for (const p of parts.slice(from)) {
      if (lineWidth(bar) + strWidth(p.label) > w) break;
      hits.push({ row: 1, x0: lead + lineWidth(bar) + 1, x1: lead + lineWidth(bar) + strWidth(p.label), id: `side:tab:${p.i}` });
      bar.push(...p.line, { t: ' ', s: '' });
    }
    const t = cur();
    const fh = hintLines(foot(t), w, st);
    const rows = Math.max(1, height - 2 - (fh.lines.length + 1));
    shown = { w, rows };
    const content = t ? body(t, w, rows) : [[{ t: 'No tabs. ctrl-t opens a shell; ask Rime to open the files or the diff.', s: st.dim }] as Line];
    const lines: Line[] = [bar, [{ t: '─'.repeat(w), s: st.line }], ...content.slice(0, rows), ...new Array(Math.max(0, rows - content.length)).fill([]), [{ t: '─'.repeat(w), s: st.line }], ...fh.lines];
    fh.segs.forEach((segs, i) => hits.push(...segs.map((s) => ({ row: 2 + rows + 2 + i, x0: s.x0 + lead, x1: s.x1 + lead, id: s.id }))));
    if (t?.kind === 'files') for (let i = 0; i < Math.min(rows, content.length); i++) hits.push({ row: 3 + i, x0: lead + 1, x1: width, id: `side:row:${i}` });
    return { lines: lines.slice(0, height).map((l) => str([...b, { t: ' ', s: '' }, ...fit(l, w)], st)), hits };
  }

  // ---- keys (when the panel has focus) ----
  // 'blur' hands focus back to the chat; true when the key was used.
  function key(k: Key): boolean | 'blur' {
    const t = cur();
    if (asking !== null) {
      if (k.name === 'escape') return (asking = null), h.redraw(), true;
      return true;
    }
    if (!t) return k.name === 'escape' ? 'blur' : false;
    const char = k.name === 'char' && !k.ctrl ? k.ch ?? '' : '';
    if (t.kind === 'custom') {
      if (t.key?.(k)) return h.redraw(), true;
      return k.name === 'escape' ? 'blur' : false;
    }
    if (t.kind === 'shell') {
      if (t.state === 'running') {
        if (k.ctrl && k.name === 'c') return stop(t), true;
        if (char === 'j' || k.name === 'down') return (t.scroll = Math.max(0, t.scroll - 1)), h.redraw(), true;
        if (char === 'k' || k.name === 'up') return (t.scroll = Math.min(t.out.length, t.scroll + 1)), h.redraw(), true;
        if (char === 'G') return (t.scroll = 0), h.redraw(), true;
        if (char === 'g') return (t.scroll = t.out.length), h.redraw(), true;
        return k.name === 'escape' ? 'blur' : true;
      }
      if (k.name === 'escape') return t.input ? ((t.input = ''), h.redraw(), true) : 'blur';
      if (k.name === 'enter') {
        const cmd = t.input.trim() || t.cmd;
        if (!cmd) return true;
        if (t.input.trim()) t.history.push(t.input.trim());
        t.input = '';
        start(t, cmd);
        return true;
      }
      if (k.name === 'backspace') return (t.input = t.input.slice(0, -1)), h.redraw(), true;
      if (k.name === 'up') return (t.input = t.history.at(-1) ?? t.cmd), h.redraw(), true;
      if (k.ctrl && k.name === 'u') return (t.input = ''), h.redraw(), true;
      if (k.ctrl && k.name === 'w') return (t.input = t.input.replace(/\S+\s*$/, '')), h.redraw(), true;
      if (char) return (t.input += char), h.redraw(), true;
      if (k.name === 'space') return (t.input += ' '), h.redraw(), true;
      return false;
    }
    if (t.kind === 'files') {
      const rs = rowsOf(t);
      if (t.filtering) {
        if (k.name === 'escape') return (t.filter = ''), (t.filtering = false), h.redraw(), true;
        if (k.name === 'enter') return (t.filtering = false), h.redraw(), true;
        if (k.name === 'backspace') return (t.filter = t.filter.slice(0, -1)), (t.sel = 0), h.redraw(), true;
        if (char || k.name === 'space') return (t.filter += char || ' '), (t.sel = 0), h.redraw(), true;
        if (k.name !== 'up' && k.name !== 'down') return true;
      }
      const r = rs[t.sel];
      if (char === '/') return (t.filtering = true), h.redraw(), true;
      if (k.name === 'escape') return t.filter ? ((t.filter = ''), h.redraw(), true) : 'blur';
      if (char === 'j' || k.name === 'down') return (t.sel = Math.min(rs.length - 1, t.sel + 1)), h.redraw(), true;
      if (char === 'k' || k.name === 'up') return (t.sel = Math.max(0, t.sel - 1)), h.redraw(), true;
      if (char === 'g') return (t.sel = 0), h.redraw(), true;
      if (char === 'G') return (t.sel = rs.length - 1), h.redraw(), true;
      if (!r) return true;
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
        else h.open(r.path);
        return h.redraw(), true;
      }
      return true;
    }
    // diff and file viewer
    const page = 10;
    if (char === 'j' || k.name === 'down') t.scroll++;
    else if (char === 'k' || k.name === 'up') t.scroll = Math.max(0, t.scroll - 1);
    else if (k.name === 'space' || (k.ctrl && k.name === 'd')) t.scroll += page;
    else if (k.ctrl && k.name === 'u') t.scroll = Math.max(0, t.scroll - page);
    else if (char === 'g') t.scroll = 0;
    else if (char === 'G') t.scroll = t.lines.length;
    else return k.name === 'escape' ? 'blur' : true;
    h.redraw();
    return true;
  }

  // ---- tabs, from the outside ----
  return {
    tabs,
    get active() {
      return active;
    },
    get visible() {
      return visible && tabs.length > 0;
    },
    get ratio() {
      return ratio;
    },
    asking: () => asking !== null,
    show(on = !visible) {
      visible = on;
      h.redraw();
    },
    resize(by: number) {
      ratio = by === 0 ? 0.5 : Math.min(0.75, Math.max(0.25, ratio + by));
      h.redraw();
    },
    go(i: number) {
      if (tabs[i]) (active = i), (visible = true), (asking = null), h.redraw();
    },
    next: (d: number) => tabs.length && ((active = (active + d + tabs.length) % tabs.length), (asking = null), h.redraw()),
    // Closes the active tab; a running one asks first (call again to stop it).
    close(force = false) {
      const t = cur();
      if (!t) return;
      const running = (t.kind === 'shell' && t.state === 'running') || (t.kind === 'custom' && t.busy?.());
      if (running && !force && asking !== active) return void ((asking = active), h.redraw());
      asking = null;
      if (t.kind === 'shell') stop(t);
      if (t.kind === 'custom') t.close?.();
      closed.push(...tabs.splice(active, 1));
      active = Math.max(0, Math.min(active, tabs.length - 1));
      if (!tabs.length) visible = false; // closing the last tab un-splits
      h.redraw();
    },
    reopen() {
      const t = closed.pop();
      if (!t) return;
      if (t.kind === 'custom') return; // a plug-in tab is opened by its plug-in again
      if (t.kind === 'shell') t.state = t.state === 'running' ? 'stopped' : t.state;
      add(t);
    },
    shell: (cmd = '', byRime = false, focus = true) => {
      const t = add(shellTab(cmd, byRime), focus);
      if (cmd) start(t, cmd);
      return t;
    },
    // A command Rime runs itself: its output mirrored into a new tab as it comes.
    mirror(cmd: string) {
      const t = add({ ...shellTab(cmd, true), state: 'running' as const, mirror: true }, false);
      return { tab: tabs.indexOf(t) + 1, write: (s: string) => write(t, s), done: (code: number) => done(t, code) };
    },
    // One diff tab, updated in place.
    diff(text: string, focus = false) {
      const old = tabs.find((t): t is TextTab => t.kind === 'diff');
      if (old) {
        old.lines = diffLines(text);
        old.scroll = 0;
        if (focus) active = tabs.indexOf(old), (visible = true);
        else old.flash = Date.now() + 1500;
        setTimeout(h.redraw, 1600);
        return h.redraw();
      }
      add({ id: ++seq, kind: 'diff', title: 'diff', lines: diffLines(text), scroll: 0, byRime: true }, focus);
    },
    files(focus = true) {
      const old = tabs.findIndex((t) => t.kind === 'files');
      if (old >= 0) return void (focus && ((active = old), (visible = true), h.redraw()));
      add({ id: ++seq, kind: 'files', title: 'files', open: new Set(), sel: 0, filter: '', filtering: false, scroll: 0 }, focus);
    },
    // A read-only viewer at a line (reused when the file is already open).
    file(rel: string, line?: number, focus = true) {
      const lines = fileLines(rel);
      if (!lines) return false;
      const old = tabs.findIndex((t) => t.kind === 'file' && t.path === rel);
      const scroll = line ? Math.max(0, line - 6) : 0;
      if (old >= 0) Object.assign(tabs[old], { lines, mark: line, scroll }), focus && (active = old), (visible = true), h.redraw();
      else add({ id: ++seq, kind: 'file', title: path.basename(rel) + (line ? `:${line}` : ''), path: rel, lines, scroll, mark: line, byRime: !focus }, focus);
      return true;
    },
    custom: (t: Omit<CustomTab, 'id' | 'kind'>, focus = true) => add({ ...t, id: ++seq, kind: 'custom' } as CustomTab, focus),
    // Mouse: a tab in the bar, a row in the files tree; the wheel scrolls.
    click(id: string) {
      const m = /^side:(tab|row):(\d+)$/.exec(id);
      if (!m) return;
      if (m[1] === 'tab') return void ((active = +m[2]), h.redraw());
      const t = cur();
      if (t?.kind !== 'files') return;
      t.sel = t.scroll + +m[2];
      key({ name: 'enter' });
    },
    wheel(d: number) {
      const t = cur();
      if (!t) return;
      if (t.kind === 'shell') t.scroll = Math.max(0, Math.min(t.out.length, t.scroll - d));
      else if (t.kind === 'files') t.sel = Math.max(0, t.sel + d);
      else if (t.kind !== 'custom') t.scroll = Math.max(0, t.scroll + d);
      else t.wheel?.(d);
      h.redraw();
    },
    // A press inside the panel (1-based, relative to its first column): a plug-in
    // tab gets it in its own cells.
    press(x: number, y: number) {
      const t = cur();
      if (t?.kind !== 'custom' || y < 3) return;
      t.click?.(x - lead - 1, y - 3);
      h.redraw();
    },
    // What a plug-in tab draws over its cells after a frame (images), with where
    // its content starts on screen.
    overlay(col: number) {
      const t = cur();
      if (!visible || t?.kind !== 'custom' || !t.overlay) return null;
      return t.overlay(col + lead, 3, shown.w, shown.rows);
    },
    hideImages: () => tabs.map((t) => (t.kind === 'custom' ? (t.hide?.() ?? '') : '')).join(''),
    running: () => tabs.filter((t) => t.kind === 'shell' && t.state === 'running').length,
    killAll: () => tabs.forEach((t) => (t.kind === 'shell' ? stop(t) : t.kind === 'custom' ? t.close?.() : null)),
    key,
    render,
  };
}
export type Side = ReturnType<typeof createSide>;
