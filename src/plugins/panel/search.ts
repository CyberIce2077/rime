// The files view's search: file names by fuzzy match, or text in
// files (ripgrep when it's on the PATH, otherwise a plain JS walk). No index, no
// model.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Letters of `q` in order in `p`: runs score more, a match that starts in the
// file name more, shorter paths a little more. null when a letter is missing.
export function fuzzy(q: string, p: string): { score: number; idx: number[] } | null {
  const s = p.toLowerCase();
  q = q.toLowerCase();
  let i = 0, last = -2, score = 0;
  const idx: number[] = [];
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] !== q[i]) continue;
    idx.push(j);
    score += j === last + 1 ? 3 : 1;
    last = j;
    i++;
  }
  if (i < q.length) return null;
  if (idx[0] >= p.lastIndexOf('/') + 1) score += 6;
  return { score: score - p.length * 0.02, idx };
}

// File names for a query; `first` (recent and edited files) rank above the rest.
export function nameHits(q: string, files: string[], first: string[] = [], max = 200) {
  return files
    .map((p) => ({ path: p, f: fuzzy(q, p) }))
    .filter((x): x is { path: string; f: { score: number; idx: number[] } } => !!x.f)
    .map((x) => ({ path: x.path, idx: x.f.idx, score: x.f.score + (first.includes(x.path) ? 4 : 0) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, max);
}

export type TextHit = { path: string; line: number; text: string };
let rg: boolean | null = null;
const hasRg = () => (rg ??= spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0);

// Text in files: plain substring, case-insensitive unless the query has a capital.
export function grep(root: string, q: string, files: string[], max = 200, useRg = hasRg()): TextHit[] {
  if (!q) return [];
  if (useRg) {
    // The '.' matters: with no path and stdin a pipe, rg searches stdin and finds nothing.
    const r =spawnSync('rg', ['--line-number', '--no-heading', '--color', 'never', '--fixed-strings', '--smart-case', '--max-columns', '300', '--max-count', '50', '--', q, '.'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000, maxBuffer: 8 << 20 });
    if (r.status === 0 || r.status === 1) {
      const out: TextHit[] = [];
      for (const l of r.stdout.split('\n')) {
        const m = /^(.+?):(\d+):(.*)$/.exec(l);
        if (m) out.push({ path: m[1].replace(/^\.\//, ''), line: +m[2], text: m[3] });
        if (out.length >= max) break;
      }
      return out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    }
  }
  const cs = /[A-Z]/.test(q), needle = cs ? q : q.toLowerCase(), out: TextHit[] = [];
  for (const p of files) {
    let text: string;
    try {
      if (fs.statSync(path.join(root, p)).size > 1 << 20) continue;
      text = fs.readFileSync(path.join(root, p), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue; // binary
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!(cs ? lines[i] : lines[i].toLowerCase()).includes(needle)) continue;
      out.push({ path: p, line: i + 1, text: lines[i].slice(0, 300) });
      if (out.length >= max) return out;
    }
  }
  return out;
}
