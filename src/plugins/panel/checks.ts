// The checks view: the project's own type check, lint and tests, each a row with
// how it went, and the problems they print as file:line rows that open in the
// files view. r runs them; w watches: they run again when files change.

import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { type Key, type Line } from '../../core/term.ts';
import { clean } from '../../core/tools.ts';
import { type Hint } from '../../core/view.ts';
import { type Kit, type View, char, cursor, extend, row, secs } from './kit.ts';

export type Problem = { path: string; line: number; text: string };
export type Check = { name: string; cmd: string; state: 'idle' | 'running' | 'passed' | 'failed'; out: string[]; ms?: number; problems: Problem[]; child?: ChildProcess };

// The checks a project has: package.json scripts (types, lint, tests), else
// Cargo, Go or pytest.
export function detect(root: string): { name: string; cmd: string }[] {
  const has = (f: string) => fs.existsSync(path.join(root, f));
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const s: Record<string, string> = pkg.scripts ?? {};
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    const run = (k: string) => (pm === 'npm' ? (k === 'test' ? 'npm test' : `npm run ${k}`) : `${pm} ${k === 'test' ? 'test' : `run ${k}`}`);
    const out: { name: string; cmd: string }[] = [];
    const types = ['typecheck', 'type-check', 'check-types', 'tsc', 'types'].find((k) => s[k]);
    if (types) out.push({ name: 'types', cmd: run(types) });
    else if (has('tsconfig.json') && fs.existsSync(path.join(root, 'node_modules', '.bin', 'tsc'))) out.push({ name: 'types', cmd: 'npx tsc --noEmit' });
    if (s.lint) out.push({ name: 'lint', cmd: run('lint') });
    if (s.test && !/no test specified/.test(s.test)) out.push({ name: 'tests', cmd: run('test') });
    if (out.length) return out;
  } catch {}
  if (has('Cargo.toml')) return [{ name: 'check', cmd: 'cargo check' }, { name: 'tests', cmd: 'cargo test' }];
  if (has('go.mod')) return [{ name: 'vet', cmd: 'go vet ./...' }, { name: 'tests', cmd: 'go test ./...' }];
  if (has('pyproject.toml') || has('pytest.ini') || has('setup.py')) return [{ name: 'tests', cmd: 'python3 -m pytest -q' }];
  return [];
}

// file:line in a check's output (src/a.ts:12:5, src/a.ts(12,5), file:///…/a.ts:12),
// kept only when the file is in the project.
export function problemsOf(out: string[], root: string, max = 50): Problem[] {
  const seen = new Set<string>(), found: Problem[] = [];
  const re = /(?:file:\/\/)?((?:[A-Za-z]:)?[\w@~.\-/\\]*[\w-]\.[A-Za-z]{1,5})(?::(\d+)(?::\d+)?|\((\d+),\d+\))/g;
  for (const l of out) {
    for (const m of l.matchAll(re)) {
      let p = m[1];
      if (path.isAbsolute(p)) p = path.relative(root, p);
      p = p.replace(/^\.\//, '');
      if (p.startsWith('..') || /node_modules|node:internal/.test(p) || !fs.existsSync(path.join(root, p))) continue;
      const line = +(m[2] ?? m[3]);
      const key = `${p}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ path: p, line, text: l.trim().slice(0, 300) });
      if (found.length >= max) return found;
    }
  }
  return found;
}

export function checksView(kit: Kit & { watchChanged?(on: boolean): void }) {
  const { st } = kit;
  let checks: Check[] = [];
  let watch = false;
  let open = -1; // the check whose output is shown
  let timer: NodeJS.Timeout | undefined;
  const c = cursor();
  let shownRows = 10;

  // Rows: each check, and under the open one its problems (or its last lines).
  type Row = { check: number; problem?: Problem; text?: string };
  function rowsOf(): Row[] {
    const out: Row[] = [];
    checks.forEach((ch, i) => {
      out.push({ check: i });
      if (i !== open) return;
      if (ch.problems.length) for (const p of ch.problems) out.push({ check: i, problem: p });
      else for (const t of ch.out.slice(-30)) out.push({ check: i, text: t });
    });
    return out;
  }
  function load() {
    if (checks.length) return;
    checks = detect(kit.root).map((d) => ({ ...d, state: 'idle', out: [], problems: [] }));
  }
  function run(ch: Check) {
    if (ch.child) return;
    ch.state = 'running';
    ch.out = [];
    ch.problems = [];
    const t0 = Date.now();
    const p = spawn('sh', ['-c', ch.cmd], { cwd: kit.root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...kit.env(), FORCE_COLOR: '0', CI: '1' } });
    ch.child = p;
    let rest = '';
    const take = (d: Buffer) => {
      const parts = (rest + clean(d.toString('utf8'))).split('\n');
      rest = parts.pop()!;
      ch.out.push(...parts);
      if (ch.out.length > 2000) ch.out.splice(0, ch.out.length - 2000);
    };
    p.stdout!.on('data', take);
    p.stderr!.on('data', take);
    p.on('error', (e) => ch.out.push(e.message));
    p.on('close', (code) => {
      if (rest) ch.out.push(rest);
      ch.child = undefined;
      ch.ms = Date.now() - t0;
      ch.state = code === 0 ? 'passed' : 'failed';
      ch.problems = code === 0 ? [] : problemsOf(ch.out, kit.root);
      // A failure opens itself, so its problems are in view.
      if (code !== 0 && (open < 0 || checks[open]?.state === 'passed')) open = checks.indexOf(ch);
      kit.redraw();
    });
    kit.redraw();
  }
  const runAll = () => (load(), checks.forEach(run), kit.redraw());

  const view: View = {
    id: 'checks',
    title: 'checks',
    badge() {
      const bad = checks.filter((x) => x.state === 'failed').length;
      if (checks.some((x) => x.state === 'running')) return { t: ' ⟳', s: st.accent };
      if (bad) return { t: ` ✗${bad > 1 ? bad : ''}`, s: st.del };
      if (checks.length && checks.every((x) => x.state === 'passed')) return { t: ' ✓', s: st.ok };
      return null;
    },
    shown: load,
    render(w, rows) {
      shownRows = rows;
      load();
      if (!checks.length) return [[{ t: 'No checks found.', s: st.dim }], [], [{ t: 'Rime looks for typecheck, lint and test', s: st.dim }], [{ t: 'scripts, or a Cargo, Go or pytest project.', s: st.dim }]];
      const rs = rowsOf();
      c.clamp(rs.length, rows - 1);
      const head: Line = [{ t: watch ? '● watching: they run again when files change' : '○ not watching · w runs them when files change', s: watch ? st.ok : st.dim }];
      return [head, ...rs.slice(c.top, c.top + rows - 1).map((r, i): Line => {
        const on = c.top + i === c.at, ch = checks[r.check];
        if (r.problem) return row(on, [{ t: '  ', s: '' }, { t: `${r.problem.path}:${r.problem.line}`, s: st.accent }, { t: `  ${r.problem.text.replace(r.problem.path, '').replace(/^[\s:(\d,)]+/, '')}`, s: st.fg }], [], w, st);
        if (r.text !== undefined) return [{ t: '    ', s: '' }, { t: r.text, s: st.dim }];
        const [icon, s] = ch.state === 'passed' ? ['✓', st.ok] : ch.state === 'failed' ? ['✗', st.del] : ch.state === 'running' ? ['⟳', st.accent] : ['○', st.dim];
        const right = ch.state === 'running' ? 'running' : ch.ms !== undefined ? `${ch.state === 'failed' && ch.problems.length ? `${ch.problems.length} problem${ch.problems.length === 1 ? '' : 's'} · ` : ''}${secs(ch.ms)}` : '';
        return row(on, [{ t: `${icon} `, s }, { t: ch.name, s: st.titleB }, { t: `  ${ch.cmd}`, s: st.dim }], [{ t: right, s: st.dim }], w, st);
      })];
    },
    foot(): Hint[] {
      if (!checks.length) return [];
      const r = rowsOf()[c.at];
      return [['r', checks.some((x) => x.state !== 'idle') ? ' run again · ' : ' run · '], ['enter', r?.problem ? ' open the file · ' : ' output · '], ...(r?.problem ? [['@', ' to the chat · '] as Hint] : []), ['w', watch ? ' stop watching' : ' watch']];
    },
    key(k: Key) {
      const ch = char(k);
      if (k.name === 'escape') return open >= 0 ? ((open = -1), true) : 'back';
      if (ch === 'r') return runAll(), true;
      if (ch === 'w') {
        watch = !watch;
        kit.watchChanged?.(watch);
        kit.toast(watch ? 'watching: checks run again when files change' : 'not watching');
        if (watch && checks.every((x) => x.state === 'idle')) runAll();
        return true;
      }
      const rs = rowsOf();
      if (c.move(k, rs.length, Math.max(1, shownRows - 3))) return true;
      const r = rs[c.at];
      if (!r) return true;
      if (r.problem && k.name === 'enter') return kit.openFile(r.problem.path, r.problem.line), true;
      if (r.problem && ch === '@') return kit.mention(r.problem.path, [r.problem.line, r.problem.line]), true;
      if (k.name === 'enter' && !r.problem && r.text === undefined) return (open = open === r.check ? -1 : r.check), true;
      return true;
    },
    click(r) {
      c.at = c.top + r - 1;
    },
    wheel(d) {
      c.at = Math.max(0, c.at + d);
    },
    read() {
      load();
      if (!checks.length) return 'No checks found in this project.';
      return checks
        .map((x) => `${x.name} (${x.cmd}): ${x.state}${x.ms !== undefined ? ` in ${secs(x.ms)}` : ''}${x.state === 'failed' ? '\n' + (x.problems.length ? x.problems.map((p) => `  ${p.text}`).join('\n') : x.out.slice(-40).join('\n')) : ''}`)
        .join('\n');
    },
  };
  return extend(view, {
    get checks() {
      return checks;
    },
    get watching() {
      return watch;
    },
    run: runAll,
    // Files changed (Rime's edits, or on disk): with watch on, they run again soon.
    changed() {
      if (!watch) return;
      clearTimeout(timer);
      timer = setTimeout(() => checks.forEach((x) => (x.child ? null : run(x))), 800);
    },
    stop() {
      for (const x of checks) {
        if (!x.child?.pid) continue;
        try {
          process.kill(-x.child.pid, 'SIGKILL');
        } catch {
          x.child.kill('SIGKILL');
        }
      }
    },
  });
}
export type ChecksView = ReturnType<typeof checksView>;
