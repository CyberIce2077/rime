// code-index (SPEC Phase 5, token-saving-plan.md §2): the project in
// .rime/index.db, kept up to date by file times. Files are stored as 40-line FTS5
// chunks (rowid = file id × 100000 + chunk, so a file's chunks go in one range
// delete) and their declarations as symbols from a regex extractor (TS/JS,
// Python, Go, Rust). It backs the `search` tool, the frozen repo map, pre-attached
// code and `@symbol`.

import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { listFiles } from '../../core/attach.ts';
import { rimeDir } from '../../core/config.ts';
import { sqlite } from '../../core/db.ts';

const CHUNK = 40, SPAN = 100000;
const MAX_FILES = 20000, MAX_SIZE = 512 * 1024;
const SKIP = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum)$|\.min\.(js|css)$|\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|mp4|mov|wasm|so|dylib|bin|gguf)$/i;

export type Symbol = { path: string; name: string; kind: string; line: number };
export type Hit = { path: string; line: number; text: string; symbol?: string };

// Declarations, one regex per language family. Methods and nested helpers are
// left out on purpose: the map and search want the names other files use.
const DECL: [RegExp, RegExp][] = [
  [/\.(m?[jt]sx?|cjs)$/, /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?(function\*?|class|interface|type|enum|const|let)\s+([A-Za-z_$][\w$]*)/],
  [/\.py$/, /^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/],
  [/\.go$/, /^(func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/],
  [/\.rs$/, /^\s*(?:pub(?:\([^)]*\))?\s+)?(fn|struct|enum|trait|type|mod|const|static)\s+([A-Za-z_]\w*)/],
];
export function symbolsOf(file: string, text: string): Omit<Symbol, 'path'>[] {
  const re = DECL.find(([ext]) => ext.test(file))?.[1];
  if (!re) return [];
  const out: Omit<Symbol, 'path'>[] = [];
  text.split('\n').forEach((l, i) => {
    const m = re.exec(l);
    if (m) out.push({ kind: m[1].replace('*', ''), name: m[2], line: i + 1 });
  });
  return out;
}

export async function openIndex(root: string) {
  const { DatabaseSync } = await sqlite();
  const db: DatabaseSync = new DatabaseSync(path.join(rimeDir(root), 'index.db'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY, path TEXT UNIQUE, mtime INTEGER, size INTEGER);
    CREATE TABLE IF NOT EXISTS symbols (path TEXT, name TEXT, kind TEXT, line INTEGER);
    CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS symbols_path ON symbols(path);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(text, tokenize = "unicode61 tokenchars '_'");`);
  const q = {
    file: db.prepare('SELECT id, mtime, size FROM files WHERE path = ?'),
    addFile: db.prepare('INSERT INTO files (path, mtime, size) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size RETURNING id'),
    dropFile: db.prepare('DELETE FROM files WHERE path = ?'),
    dropChunks: db.prepare('DELETE FROM chunks WHERE rowid >= ? AND rowid < ?'),
    addChunk: db.prepare('INSERT INTO chunks (rowid, text) VALUES (?, ?)'),
    dropSymbols: db.prepare('DELETE FROM symbols WHERE path = ?'),
    addSymbol: db.prepare('INSERT INTO symbols (path, name, kind, line) VALUES (?, ?, ?, ?)'),
    paths: db.prepare('SELECT path FROM files'),
    byId: db.prepare('SELECT path FROM files WHERE id = ?'),
  };
  const tx = (f: () => void) => {
    db.exec('BEGIN');
    try {
      f();
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  // One file in (or out, when it's gone or not text). True when it changed.
  function put(rel: string, force = false): boolean {
    const p = path.join(root, rel);
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      return drop(rel);
    }
    const old = q.file.get(rel) as { id: number; mtime: number; size: number } | undefined;
    if (!force && old && old.mtime === Math.floor(st.mtimeMs) && old.size === st.size) return false;
    if (!st.isFile() || st.size > MAX_SIZE || SKIP.test(rel)) return drop(rel);
    const buf = fs.readFileSync(p);
    if (buf.subarray(0, 8000).includes(0)) return drop(rel);
    const text = buf.toString('utf8');
    tx(() => {
      const { id } = q.addFile.get(rel, Math.floor(st.mtimeMs), st.size) as { id: number };
      q.dropChunks.run(id * SPAN, (id + 1) * SPAN);
      const lines = text.split('\n');
      for (let c = 0; c * CHUNK < lines.length && c < SPAN; c++) q.addChunk.run(id * SPAN + c, `${rel}\n${lines.slice(c * CHUNK, (c + 1) * CHUNK).join('\n')}`);
      q.dropSymbols.run(rel);
      for (const s of symbolsOf(rel, text)) q.addSymbol.run(rel, s.name, s.kind, s.line);
    });
    return true;
  }
  function drop(rel: string): boolean {
    const old = q.file.get(rel) as { id: number } | undefined;
    if (!old) return false;
    tx(() => {
      q.dropChunks.run(old.id * SPAN, (old.id + 1) * SPAN);
      q.dropSymbols.run(rel);
      q.dropFile.run(rel);
    });
    return true;
  }

  // Brings the index in line with the folder: new and changed files in, gone ones
  // out. Unchanged files cost one stat. `step` yields every so many files, so a
  // first build runs in the background without freezing the screen.
  async function refresh(step = Infinity) {
    const now = listFiles(root, MAX_FILES).filter((f) => !f.startsWith('.rime/'));
    const keep = new Set(now);
    let changed = 0, n = 0;
    for (const { path: p } of q.paths.all() as { path: string }[]) if (!keep.has(p)) changed += +drop(p);
    for (const f of now) {
      changed += +put(f);
      if (++n % step === 0) await new Promise((r) => setImmediate(r));
    }
    return changed;
  }

  // Words for FTS5: each as a quoted prefix, all of them required.
  const words = (query: string) => query.toLowerCase().match(/[\p{L}\p{N}_]+/gu)?.filter((w) => w.length > 1) ?? [];

  function search(query: string, limit = 20): Hit[] {
    const out: Hit[] = [];
    const seen = new Set<string>();
    const add = (h: Hit) => {
      const k = `${h.path}:${h.line}`;
      if (seen.has(k) || out.length >= limit) return;
      seen.add(k);
      out.push(h);
    };
    // Declarations first: an exact name, then names that start with it.
    const name = query.trim();
    if (/^[\w$.]+$/.test(name)) {
      const syms = db.prepare('SELECT path, name, kind, line FROM symbols WHERE name = ? COLLATE NOCASE OR name LIKE ? ORDER BY name = ? DESC, length(name) LIMIT 10').all(name.split('.').pop()!, `${name.split('.').pop()}%`, name) as Symbol[];
      for (const s of syms) add({ path: s.path, line: s.line, text: lineOf(s.path, s.line), symbol: `${s.kind} ${s.name}` });
    }
    const w = words(query);
    if (!w.length) return out;
    const rows = db.prepare('SELECT rowid AS id, text FROM chunks WHERE chunks MATCH ? ORDER BY bm25(chunks) LIMIT 60').all(w.map((x) => `"${x}"*`).join(' ')) as { id: number; text: string }[];
    const perFile = new Map<string, number>();
    for (const r of rows) {
      const [p, ...lines] = r.text.split('\n');
      if ((perFile.get(p) ?? 0) >= 3) continue;
      // The line in the chunk with the most of the words.
      let best = -1, score = 0;
      lines.forEach((l, i) => {
        const s = w.filter((x) => l.toLowerCase().includes(x)).length;
        if (s > score) (best = i), (score = s);
      });
      if (best < 0) continue;
      perFile.set(p, (perFile.get(p) ?? 0) + 1);
      add({ path: p, line: (r.id % SPAN) * CHUNK + best + 1, text: lines[best].trim() });
    }
    return out;
  }
  function lineOf(rel: string, line: number) {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8').split('\n')[line - 1]?.trim() ?? '';
    } catch {
      return '';
    }
  }

  const symbols = (name: string, limit = 8) => db.prepare('SELECT path, name, kind, line FROM symbols WHERE name LIKE ? ORDER BY length(name), path LIMIT ?').all(`${name}%`, limit) as Symbol[];
  const exact = (name: string) => db.prepare('SELECT path, name, kind, line FROM symbols WHERE name = ? LIMIT 3').all(name) as Symbol[];
  const has = (rel: string) => !!q.file.get(rel);
  const files = () => (q.paths.all() as { path: string }[]).map((r) => r.path);

  // The repo map for the system prompt: folders with their file counts, then the
  // files with the most declarations and their names, within `budget` characters
  // (~4 per token). Built once per conversation, so it stays in the cached prefix.
  function map(budget = 4000): string {
    const all = files().sort();
    if (!all.length) return '';
    const per = new Map<string, Symbol[]>();
    for (const s of db.prepare('SELECT path, name, kind, line FROM symbols ORDER BY path, line').all() as Symbol[]) (per.get(s.path) ?? per.set(s.path, []).get(s.path)!).push(s);
    const dirs = new Map<string, number>();
    for (const f of all) {
      const d = f.includes('/') ? f.split('/').slice(0, Math.min(2, f.split('/').length - 1)).join('/') + '/' : './';
      dirs.set(d, (dirs.get(d) ?? 0) + 1);
    }
    const lines = [`Repo map (${all.length} files; the search tool finds the rest):`, [...dirs].map(([d, n]) => `${d} ${n}`).join(' · ')];
    const ranked = [...per].sort((a, b) => b[1].length - a[1].length || a[0].split('/').length - b[0].split('/').length || a[0].localeCompare(b[0]));
    let size = lines.join('\n').length;
    for (const [p, ss] of ranked) {
      const l = `${p}: ${[...new Set(ss.map((s) => s.name))].slice(0, 10).join(', ')}`;
      if (size + l.length + 1 > budget) break;
      lines.push(l);
      size += l.length + 1;
    }
    return lines.join('\n');
  }

  return { put, drop, refresh, search, symbols, exact, has, files, map, close: () => db.close() };
}
export type CodeIndex = Awaited<ReturnType<typeof openIndex>>;
