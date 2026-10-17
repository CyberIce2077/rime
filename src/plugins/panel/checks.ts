// The project's own checks (type check, lint, tests) and the file:line problems
// their output names. They run in the run view, at the top of its list.

import fs from 'node:fs';
import path from 'node:path';

export type Problem = { path: string; line: number; text: string };

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
