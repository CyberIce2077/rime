// The run view: every command in one list. Commands Rime runs stream in here as
// they run, servers keep running (with their address), and n opens a shell of
// your own. The list is on top, the selected command's output below. Commands
// are plain child processes, not a terminal, so an editor or a password prompt
// doesn't work here.

import { type ChildProcess, spawn } from 'node:child_process';
import { type Key, type Line } from '../../core/term.ts';
import { clean } from '../../core/tools.ts';
import { type Hint } from '../../core/view.ts';
import { type Kit, type View, ago, char, extend, highlight, lineInput, row } from './kit.ts';

export type Proc = {
  id: number;
  kind: 'rime' | 'shell' | 'server'; // rime: a command Rime ran; shell: yours; server: keeps running
  cmd: string;
  out: string[];
  state: 'idle' | 'running' | 'passed' | 'failed' | 'stopped';
  code?: number;
  child?: ChildProcess;
  started?: number;
  ended?: number;
  serve?: { script?: string; url?: string; port?: number };
  argv?: [string, string[]]; // how it runs when not `sh -c` (auto mode's sandbox)
  input: string;
  history: string[];
  typing: boolean;
  scroll: number; // lines up from the end of the output
};

const ADDRESS = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d+)[^\s'")]*/;
const MAX_OUT = 5000; // lines kept per command
const MAX_PROCS = 30; // finished commands beyond this are forgotten, oldest first

export function runView(kit: Kit & { open(url: string): void; asks?(): boolean }) {
  const { st } = kit;
  const procs: Proc[] = [];
  let sel = 0, seq = 0;
  let find: ReturnType<typeof lineInput> | null = null;
  let findQ = '';
  let shownRows = 10;
  let listN = 0, listTop = 0; // the list's rows on the last frame
  const partial = new WeakMap<Proc, string>();
  const cur = () => procs[sel] as Proc | undefined;

  const short = (cmd: string) => cmd.split(/\s+/).slice(0, 4).join(' ');
  const titleOf = (p: Proc) => (p.kind === 'shell' && !p.cmd ? 'shell' : p.serve?.script ? `npm run ${p.serve.script}` : short(p.cmd));
  const mark = (p: Proc): Line[number] =>
    p.state === 'running' ? { t: p.kind === 'server' ? '●' : '⟳', s: p.kind === 'server' ? st.ok : st.accent }
    : p.state === 'passed' ? { t: '✓', s: st.ok } : p.state === 'failed' ? { t: '✗', s: st.del } : p.state === 'stopped' ? { t: '■', s: st.dim } : { t: '$', s: st.dim };
  const meta = (p: Proc) =>
    p.kind === 'server' && p.state === 'running' ? `${p.serve?.port ? `:${p.serve.port} · ` : ''}${ago(Date.now() - (p.started ?? Date.now()))}`
    : p.state === 'running' ? ago(Date.now() - (p.started ?? Date.now())) : p.state === 'failed' ? `exit ${p.code}` : p.state === 'idle' ? '' : p.state;

  function add(p: Omit<Proc, 'id' | 'out' | 'input' | 'history' | 'scroll'> & Partial<Proc>, focus = true) {
    const full: Proc = { id: ++seq, out: [], input: '', history: [], scroll: 0, ...p };
    procs.push(full);
    // Old finished commands make room; running ones always stay.
    while (procs.length > MAX_PROCS) {
      const i = procs.findIndex((x) => x.state !== 'running');
      if (i < 0) break;
      procs.splice(i, 1);
    }
    if (focus) sel = procs.indexOf(full);
    kit.redraw();
    return full;
  }
  function start(p: Proc, cmd: string) {
    if (cmd !== p.cmd) p.argv = undefined;
    p.cmd = cmd;
    p.out.push(...(p.out.length ? [''] : []), `$ ${cmd}`);
    p.state = 'running';
    p.scroll = 0;
    p.code = undefined;
    p.started = Date.now();
    if (p.serve) (p.serve.url = undefined), (p.serve.port = undefined);
    const [bin, args] = p.argv ?? ['sh', ['-c', cmd]];
    const c = spawn(bin, args, { cwd: kit.root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: kit.env() });
    p.child = c;
    const take = (d: Buffer) => p.child === c && write(p, d.toString('utf8'));
    c.stdout!.on('data', take);
    c.stderr!.on('data', take);
    c.on('error', (e) => write(p, e.message + '\n'));
    c.on('close', (code, sig) => p.child === c && done(p, sig ? 130 : (code ?? 1)));
  }
  function write(p: Proc, chunk: string) {
    const text = (partial.get(p) ?? '') + clean(chunk);
    const parts = text.split('\n');
    partial.set(p, parts.pop()!);
    p.out.push(...parts);
    if (p.out.length > MAX_OUT) p.out.splice(0, p.out.length - MAX_OUT);
    // A server's address: the port goes in its row.
    if (p.serve)
      for (const l of parts) {
        const m = ADDRESS.exec(l);
        if (m) (p.serve.url = m[0].replace(/\/$/, '').replace(/0\.0\.0\.0|127\.0\.0\.1|\[::1?\]/, 'localhost')), (p.serve.port = +m[1]);
      }
    kit.redraw();
  }
  function done(p: Proc, code: number) {
    const rest = partial.get(p);
    if (rest) p.out.push(rest), partial.set(p, '');
    p.child = undefined;
    p.code = code;
    p.ended = Date.now();
    p.state = p.state === 'stopped' || p.serve ? 'stopped' : code === 0 ? 'passed' : 'failed'; // a server that ended isn't "passed"
    kit.redraw();
  }
  const stop = (p: Proc) => {
    if (!p.child?.pid) return;
    p.state = 'stopped';
    try {
      process.kill(-p.child.pid, 'SIGKILL');
    } catch {
      p.child.kill('SIGKILL');
    }
    p.out.push('(stopped)');
  };

  // The lines with the found text; the view jumps to the next one.
  function findNext(d = 1) {
    const p = cur();
    if (!p || !findQ) return;
    const ms = p.out.flatMap((l, i) => (l.toLowerCase().includes(findQ.toLowerCase()) ? [i] : []));
    if (!ms.length) return kit.toast(`no "${findQ}" here`);
    const at = p.out.length - p.scroll - Math.ceil(shownRows / 2);
    const i = d > 0 ? ms.find((m) => m > at) ?? ms[0] : [...ms].reverse().find((m) => m < at) ?? ms.at(-1)!;
    p.scroll = Math.max(0, p.out.length - i - Math.ceil(shownRows / 2));
  }

  const view: View = {
    id: 'run',
    title: 'run',
    badge() {
      const n = procs.filter((p) => p.state === 'running').length;
      return n ? { t: ` ●${n > 1 ? n : ''}`, s: procs.some((p) => p.state === 'running' && p.kind === 'server') ? st.ok : st.accent } : procs.some((p) => p.state === 'failed') ? { t: ' ✗', s: st.del } : null;
    },
    typing: () => !!find || !!cur()?.typing,
    render(w, rows) {
      if (!procs.length) return [[{ t: 'No commands yet.', s: st.dim }], [], [{ t: 'Commands Rime runs show here. n opens a shell.', s: st.dim }]];
      sel = Math.max(0, Math.min(sel, procs.length - 1));
      // The list: at most a third of the rows, the selected one in view.
      const listRows = Math.min(procs.length, Math.max(1, Math.floor(rows / 3)));
      const top = Math.max(0, Math.min(sel - listRows + 1, procs.length - listRows));
      (listN = listRows), (listTop = top);
      const list = procs.slice(top, top + listRows).map((p, i): Line => row(top + i === sel, [mark(p), { t: ` ${titleOf(p)}`, s: st.fg }], [{ t: meta(p), s: st.dim }], w, st));
      const p = cur()!;
      const foot: Line[] = find ? [find.line([{ t: '/', s: st.accentB }], 'find in the output', st)]
        : p.kind === 'shell' ? [[{ t: '$ ', s: st.ok }, ...(p.typing ? [{ t: p.input, s: st.title }, { t: '▏', s: st.accent }] : [{ t: 'enter to type a command', s: st.dim }])]] : [];
      const outRows = Math.max(1, rows - listRows - 1 - foot.length);
      shownRows = outRows;
      const end = Math.max(0, p.out.length - p.scroll);
      const out = p.out.slice(Math.max(0, end - outRows), end).map((l): Line => highlight([{ t: l, s: l.startsWith('$ ') ? st.titleB : st.fg }], findQ, st));
      if (!p.out.length && p.state === 'running') out.push([{ t: 'starting…', s: st.dim }]);
      const label = p.serve?.url ? ` ${p.serve.url} ` : '';
      const rule: Line = [{ t: '─'.repeat(2), s: st.line }, { t: label, s: st.ok }, { t: '─'.repeat(Math.max(0, w - 2 - label.length)), s: st.line }];
      return [...list, rule, ...out, ...new Array(Math.max(0, outRows - out.length)).fill([]), ...foot];
    },
    foot(): Hint[] {
      const p = cur();
      if (find) return [['enter', ' next · '], ['↑', ' previous · '], ['esc', ' done']];
      if (p?.typing) return [['', 'typing a command · ', st.warn], ['enter', ' run · '], ['ctrl+c', ' stop · '], ['esc', ' stop typing']];
      if (!p) return [['n', ' new shell']];
      const keys: Hint[] = [['↑ ↓', ' choose · ']];
      if (p.kind === 'shell' && p.state !== 'running') keys.push(['enter', ' type · ']);
      if (p.state === 'running') keys.push(['x', ' stop · ']);
      else if (p.cmd) keys.push(['r', p.kind === 'server' ? ' start · ' : ' rerun · '], ['x', ' remove · ']);
      if (p.serve?.url && p.state === 'running') keys.push(['o', ' open in your browser · ']);
      keys.push(['n', ' new shell · '], ['/', ' find']);
      return keys;
    },
    key(k: Key) {
      const p = cur();
      if (find) {
        if (k.name === 'escape') return (find = null), (findQ = ''), true;
        if (k.name === 'enter' || k.name === 'down') return findNext(1), true;
        if (k.name === 'up') return findNext(-1), true;
        if (find.edit(k)) (findQ = find.value), findNext(1);
        return true;
      }
      if (p?.typing) {
        // Typing: every key goes to the $ line, ctrl+c and ctrl+w too.
        if (k.name === 'escape') return (p.typing = false), true;
        if (k.ctrl && k.name === 'c') return p.state === 'running' ? stop(p) : (p.input = ''), true;
        if (k.name === 'enter') {
          const cmd = p.input.trim() || p.cmd;
          if (!cmd || p.state === 'running') return true;
          if (p.input.trim()) p.history.push(p.input.trim());
          p.input = '';
          start(p, cmd);
          return true;
        }
        if (k.name === 'up') return (p.input = p.history.at(-1) ?? p.cmd), true;
        const box = lineInput(p.input);
        if (box.edit(k)) p.input = box.value;
        return true;
      }
      const c = char(k);
      if (k.name === 'escape') return 'back';
      if (c === 'n') return void extra.shell(), true;
      if (!p) return true;
      if (k.name === 'down') return (sel = Math.min(procs.length - 1, sel + 1)), true;
      if (k.name === 'up') return (sel = Math.max(0, sel - 1)), true;
      if (k.ctrl && (k.name === 'u' || k.name === 'd')) return view.wheel!(k.name === 'u' ? -shownRows : shownRows), true;
      if (k.ctrl && k.name === 'c' && p.state === 'running') return stop(p), true;
      if (k.name === 'enter' && p.kind === 'shell' && p.state !== 'running') return (p.typing = true), true;
      if (c === 'x') {
        if (p.state === 'running') return stop(p), true;
        procs.splice(sel, 1);
        return true;
      }
      if (c === 'r' && p.cmd && p.state !== 'running') return start(p, p.cmd), true;
      if (c === 'o' && p.serve?.url) return kit.open(p.serve.url), kit.toast(`opened ${p.serve.url}`), true;
      if (c === '/') return (find = lineInput(findQ)), true;
      return true;
    },
    click(r) {
      if (r < listN) sel = Math.min(procs.length - 1, listTop + r);
    },
    wheel(d) {
      const p = cur();
      if (p) p.scroll = Math.max(0, Math.min(p.out.length, p.scroll - d));
    },
    // Every command in a line, then the last n lines (default 60, at most 4,000
    // characters) of the selected one, so a server's errors can be read without
    // running it again.
    read(n = 60) {
      const p = cur();
      if (!p) return 'No commands have run in the panel.';
      const list = procs.map((x, i) => `${i === sel ? '›' : ' '} ${titleOf(x)} · ${x.state}${x.serve?.url ? ` · ${x.serve.url}` : ''}`).join('\n');
      const text = p.out.slice(-n).join('\n');
      return `${list}\n\n${titleOf(p)}:\n${text.length > 4000 ? '…' + text.slice(-4000) : text || '(no output yet)'}`;
    },
  };

  const extra = {
    procs,
    get sel() {
      return sel;
    },
    select: (p: Proc) => void ((sel = Math.max(0, procs.indexOf(p))), kit.redraw()),
    // A shell of your own: empty, it waits for you to type.
    shell(cmd = '') {
      const p = add({ kind: 'shell', cmd, state: 'idle', typing: !cmd });
      if (cmd) start(p, cmd);
      return p;
    },
    // A command that keeps running (a dev server): no timeout; x or quitting stops it.
    serve(cmd: string, o: { script?: string; byRime?: boolean; focus?: boolean; argv?: [string, string[]] } = {}) {
      const p = add({ kind: 'server', cmd, state: 'idle', typing: false, serve: { script: o.script }, argv: o.argv }, o.focus ?? true);
      start(p, cmd);
      return p;
    },
    // A command Rime runs itself: its output copied in as it comes.
    mirror(cmd: string) {
      const p = add({ kind: 'rime', cmd, state: 'running', typing: false, started: Date.now(), out: [`$ ${cmd}`] }, !procs.some((x) => x.typing));
      return { proc: p, write: (s: string) => write(p, s), done: (code: number) => done(p, code) };
    },
    running: () => procs.filter((p) => p.state === 'running').length,
    servers: () => procs.filter((p) => p.kind === 'server' && p.state === 'running').length,
    killAll: () => procs.forEach(stop),
    titleOf,
  };
  return extend(view, extra);
}
export type RunView = ReturnType<typeof runView>;
