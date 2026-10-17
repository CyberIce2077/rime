// The run view: every command in one list. The project's checks (type check,
// lint, tests) sit at the top, ready to run; commands Rime runs stream in below
// them as they run, servers keep running (with their address), and n opens a
// shell of your own. The list is on top, the selected command's output below; a
// file:line in the output opens on a click. Commands are plain child processes,
// not a terminal, so an editor or a password prompt doesn't work here.

import { type ChildProcess, spawn } from 'node:child_process';
import { type Key, type Line } from '../../core/term.ts';
import { clean } from '../../core/tools.ts';
import { type Hint } from '../../core/view.ts';
import { type Problem, detect, problemsOf } from './checks.ts';
import { type Kit, type View, ago, char, extend, highlight, lineInput, row, secs } from './kit.ts';

export type Proc = {
  id: number;
  kind: 'check' | 'rime' | 'shell' | 'server'; // check: the project's own; rime: a command Rime ran; shell: yours; server: keeps running
  cmd: string;
  out: string[];
  state: 'idle' | 'running' | 'passed' | 'failed' | 'stopped';
  code?: number;
  child?: ChildProcess;
  started?: number;
  ended?: number;
  serve?: { script?: string; url?: string; port?: number };
  check?: { name: string; problems: Problem[] };
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
  let outShown: string[] = []; // the output lines on the last frame, for clicks
  let checksLoaded = false, watch = false;
  let watchTimer: NodeJS.Timeout | undefined;
  const partial = new WeakMap<Proc, string>();
  const cur = () => procs[sel] as Proc | undefined;

  const short = (cmd: string) => cmd.split(/\s+/).slice(0, 4).join(' ');
  const titleOf = (p: Proc) => (p.check ? p.check.name : p.kind === 'shell' && !p.cmd ? 'shell' : p.serve?.script ? `npm run ${p.serve.script}` : short(p.cmd));
  const mark = (p: Proc): Line[number] =>
    p.state === 'running' ? { t: p.kind === 'server' ? '●' : '⟳', s: p.kind === 'server' ? st.ok : st.accent }
    : p.state === 'passed' ? { t: '✓', s: st.ok } : p.state === 'failed' ? { t: '✗', s: st.del } : p.state === 'stopped' ? { t: '■', s: st.dim } : { t: p.check ? '○' : '$', s: st.dim };
  const took = (p: Proc) => (p.ended && p.started ? secs(p.ended - p.started) : '');
  const meta = (p: Proc) =>
    p.kind === 'server' && p.state === 'running' ? `${p.serve?.port ? `:${p.serve.port} · ` : ''}${ago(Date.now() - (p.started ?? Date.now()))}`
    : p.state === 'running' ? ago(Date.now() - (p.started ?? Date.now()))
    : p.check && p.state === 'failed' && p.check.problems.length ? `${p.check.problems.length} problem${p.check.problems.length === 1 ? '' : 's'} · ${took(p)}`
    : p.check && (p.state === 'passed' || p.state === 'failed') ? took(p)
    : p.state === 'failed' ? `exit ${p.code}` : p.state === 'idle' ? (p.check ? p.cmd : '') : p.state;
  const checks = () => procs.filter((p) => p.check);
  // The checks join the list once, at its top, waiting for r.
  function loadChecks() {
    if (checksLoaded) return;
    checksLoaded = true;
    const found = detect(kit.root).map((d): Proc => ({ id: ++seq, kind: 'check', cmd: d.cmd, out: [], state: 'idle', input: '', history: [], typing: false, scroll: 0, check: { name: d.name, problems: [] }}));
    procs.unshift(...found);
    if (found.length && procs.length > found.length) sel += found.length; // the selection stays on its command
  }

  function add(p: Omit<Proc, 'id' | 'out' | 'input' | 'history' | 'scroll'> & Partial<Proc>, focus = true) {
    const full: Proc = { id: ++seq, out: [], input: '', history: [], scroll: 0, ...p };
    procs.push(full);
    // Old finished commands make room; running ones always stay.
    while (procs.length > MAX_PROCS) {
      const i = procs.findIndex((x) => x.state !== 'running' && !x.check);
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
    const env = p.check ? { ...kit.env(), FORCE_COLOR: '0', CI: '1' } : kit.env();
    const c = spawn(bin, args, { cwd: kit.root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env });
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
    if (p.check) {
      p.check.problems = p.state === 'failed' ? problemsOf(p.out, kit.root) : [];
      // A failing check is selected, so its output is in view (unless you're typing).
      if (p.state === 'failed' && !cur()?.typing && cur()?.state !== 'failed') sel = procs.indexOf(p);
    }
    kit.redraw();
  }
  const runChecks = () => (loadChecks(), checks().forEach((p) => p.state !== 'running' && start(p, p.cmd)), kit.redraw());
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
      const bad = checks().filter((p) => p.state === 'failed').length;
      if (n) return { t: ` ●${n > 1 ? n : ''}`, s: procs.some((p) => p.state === 'running' && p.kind === 'server') ? st.ok : st.accent };
      if (bad) return { t: ` ✗${bad > 1 ? bad : ''}`, s: st.del };
      if (checks().length && checks().every((p) => p.state === 'passed')) return { t: ' ✓', s: st.ok };
      return procs.some((p) => p.state === 'failed') ? { t: ' ✗', s: st.del } : null;
    },
    shown: loadChecks,
    typing: () => !!find || !!cur()?.typing,
    render(w, rows) {
      loadChecks();
      outShown = [];
      if (!procs.length) return [[{ t: 'No commands yet.', s: st.dim }], [], [{ t: 'Commands Rime runs show here, with the servers', s: st.dim }], [{ t: 'it starts. n opens a shell of your own.', s: st.dim }]];
      sel = Math.max(0, Math.min(sel, procs.length - 1));
      // The list: at most a third of the rows, the selected one in view.
      const listRows = Math.min(procs.length, Math.max(1, Math.floor(rows / 3), Math.min(checks().length + 1, rows - 4)));
      const top = Math.max(0, Math.min(sel - listRows + 1, procs.length - listRows));
      (listN = listRows), (listTop = top);
      const list = procs.slice(top, top + listRows).map((p, i): Line => row(top + i === sel, [mark(p), { t: ` ${titleOf(p)}`, s: st.fg }], [{ t: meta(p), s: st.dim }], w, st));
      const p = cur()!;
      const foot: Line[] = find ? [find.line([{ t: '/', s: st.accentB }], 'find in the output', st)]
        : p.kind === 'shell' ? [[{ t: '$ ', s: st.ok }, ...(p.typing ? [{ t: p.input, s: st.title }, { t: '▏', s: st.accent }] : [{ t: 'enter to type a command', s: st.dim }])]] : [];
      const outRows = Math.max(1, rows - listRows - 1 - foot.length);
      shownRows = outRows;
      const end = Math.max(0, p.out.length - p.scroll);
      outShown = p.out.slice(Math.max(0, end - outRows), end);
      const out = outShown.map((l): Line => highlight([{ t: l, s: l.startsWith('$ ') ? st.titleB : st.fg }], findQ, st));
      if (!p.out.length && p.state === 'running') out.push([{ t: 'starting…', s: st.dim }]);
      if (!p.out.length && p.check && p.state === 'idle') out.push([{ t: 'r', s: st.accentB }, { t: ` runs ${p.check.name} · `, s: st.dim }, { t: 'a', s: st.accentB }, { t: ' runs them all', s: st.dim }]);
      const label = p.serve?.url ? ` ${p.serve.url} ` : p.check && watch ? ' watching: checks run when files change ' : '';
      const rule: Line = [{ t: '─'.repeat(2), s: st.line }, { t: label, s: st.ok }, { t: '─'.repeat(Math.max(0, w - 2 - label.length)), s: st.line }];
      return [...list, rule, ...out, ...new Array(Math.max(0, outRows - out.length)).fill([]), ...foot];
    },
    foot(): Hint[] {
      const p = cur();
      if (find) return [['enter', ' next · '], ['↑', ' previous · '], ['esc', ' done']];
      if (p?.typing) return [['', 'typing a command · ', st.warn], ['enter', ' run · '], ['ctrl+c', ' stop · '], ['esc', ' stop typing']];
      if (!p) return [['n', ' new shell']];
      const keys: Hint[] = [['↑ ↓', ' choose · ']];
      if (p.check) {
        if (p.state === 'running') keys.push(['x', ' stop · ']);
        else keys.push(['r', p.state === 'idle' ? ' run · ' : ' run again · ']);
        if (p.check.problems.length) keys.push(['enter', ' open the first problem · ']);
        keys.push(['a', ' run all checks · '], ['w', watch ? ' stop watching · ' : ' watch · ']);
        keys.push(['n', ' new shell']);
        return keys;
      }
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
      if (c === 'a') return checks().length ? runChecks() : kit.toast('no checks found: Rime looks for typecheck, lint and test scripts'), true;
      if (c === 'w') {
        if (!checks().length) return kit.toast('no checks found to watch'), true;
        watch = !watch;
        kit.toast(watch ? 'watching: checks run again when files change' : 'not watching');
        if (watch && checks().every((x) => x.state === 'idle')) runChecks();
        return true;
      }
      if (!p) return true;
      if (k.name === 'down') return (sel = Math.min(procs.length - 1, sel + 1)), true;
      if (k.name === 'up') return (sel = Math.max(0, sel - 1)), true;
      if (k.ctrl && (k.name === 'u' || k.name === 'd')) return view.wheel!(k.name === 'u' ? -shownRows : shownRows), true;
      if (k.ctrl && k.name === 'c' && p.state === 'running') return stop(p), true;
      if (k.name === 'enter' && p.kind === 'shell' && p.state !== 'running') return (p.typing = true), true;
      if (c === 'x') {
        if (p.state === 'running') return stop(p), true;
        if (!p.check) procs.splice(sel, 1);
        return true;
      }
      if (k.name === 'enter' && p.check?.problems.length) return kit.openFile(p.check.problems[0].path, p.check.problems[0].line), true;
      if (c === 'r' && p.cmd && p.state !== 'running') return start(p, p.cmd), true;
      if (c === 'o' && p.serve?.url) return kit.open(p.serve.url), kit.toast(`opened ${p.serve.url}`), true;
      if (c === '/') return (find = lineInput(findQ)), true;
      return true;
    },
    click(r) {
      if (r < listN) return void (sel = Math.min(procs.length - 1, listTop + r));
      // A file:line in the output opens in the files view.
      const hit = problemsOf([outShown[r - listN - 1] ?? ''], kit.root, 1)[0];
      if (hit) kit.openFile(hit.path, hit.line);
    },
    wheel(d) {
      const p = cur();
      if (p) p.scroll = Math.max(0, Math.min(p.out.length, p.scroll - d));
    },
    // Every command in a line, then the last n lines (default 60, at most 4,000
    // characters) of the selected one, so a server's errors can be read without
    // running it again.
    read(n = 60) {
      loadChecks();
      const p = cur();
      if (!p) return 'No commands have run in the panel, and no checks were found.';
      const list = procs.map((x, i) => `${i === sel ? '›' : ' '} ${x.check ? `check ${x.check.name} (${x.cmd})` : titleOf(x)} · ${x.state}${x.serve?.url ? ` · ${x.serve.url}` : ''}`).join('\n');
      const failing = checks().filter((x) => x.state === 'failed' && x !== p).map((x) => `\n\n${x.check!.name} failed:\n${x.check!.problems.length ? x.check!.problems.map((q) => q.text).join('\n') : x.out.slice(-40).join('\n')}`).join('');
      const text = p.out.slice(-n).join('\n');
      return `${list}\n\n${titleOf(p)}:\n${text.length > 4000 ? '…' + text.slice(-4000) : text || '(no output yet)'}${failing}`;
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
    // The checks: run them all, and with watch on, again when files change.
    checks: {
      get list() {
        return (loadChecks(), checks());
      },
      get watching() {
        return watch;
      },
      run: runChecks,
      changed() {
        if (!watch) return;
        clearTimeout(watchTimer);
        watchTimer = setTimeout(() => checks().forEach((x) => x.state !== 'running' && start(x, x.cmd)), 800);
      },
      // The first check that failed gets selected (for "run the tests").
      focus: () => void (loadChecks(), (sel = Math.max(0, procs.findIndex((x) => x.check)))),
    },
  };
  return extend(view, extra);
}
export type RunView = ReturnType<typeof runView>;
