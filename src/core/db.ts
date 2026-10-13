// ~/.rime/rime.db: every conversation, saved the moment things happen (SPEC §16).
// There are no sessions to manage: `rime` reopens the project's last conversation.
// Each write is its own small transaction, so quitting never waits for a save.
// The list, search and timeline arrive in Phase 4b; the tables are here now.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Block, Price, Usage } from '../providers/types.ts';

export const DB_PATH = path.join(os.homedir(), '.rime', 'rime.db');

export type Conversation = { id: number; project: string; title: string; created: number; updated: number; model: string | null; tokens: number; cost: number; prefix: string | null; prefix_hash: string | null; lock_pid: number | null; rules: string | null };
// `usage`: what the reply cost (normalized usage, its price, local or not), so the
// meter and /usage come back when the conversation is reopened.
export type Stored = { seq: number; role: 'user' | 'assistant' | 'system'; content: string | Block[]; interrupted: boolean; usage?: { usage: Usage; price?: Price; local?: boolean } };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL, updated INTEGER NOT NULL, model TEXT,
  tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
  prefix_hash TEXT, prefix TEXT, lock_pid INTEGER
);
CREATE INDEX IF NOT EXISTS conversations_project ON conversations (project, updated);
CREATE TABLE IF NOT EXISTS messages (
  conversation INTEGER NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
  interrupted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (conversation, seq)
);
CREATE TABLE IF NOT EXISTS timeline (
  conversation INTEGER NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
  text TEXT NOT NULL, ref TEXT, PRIMARY KEY (conversation, seq)
);`;

// The project a folder belongs to: its git root, or the folder itself.
export function projectOf(cwd: string) {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : cwd;
}

// The title starts as the first line of the first message, trimmed by code.
export const titleOf = (text: string) => {
  const line = text.replace(/[-]/g, '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > 60 ? line.slice(0, 59).replace(/\s+\S*$/, '') + '…' : line;
};

const alive = (pid: number | null) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

// node:sqlite still prints an ExperimentalWarning when it loads; Rime owns the
// screen, so it's loaded quietly and only when needed.
async function sqlite() {
  const emit = process.emitWarning;
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    if (!String(w).includes('SQLite')) (emit as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try {
    return await import('node:sqlite');
  } finally {
    process.emitWarning = emit;
  }
}

export async function openDb(file = DB_PATH) {
  const { DatabaseSync } = await sqlite();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db: DatabaseSync = new DatabaseSync(file);
  // WAL lets other windows (and later the list and search) read while a reply is
  // written; on a filesystem without it, the default journal still works.
  const mode = String((db.prepare('PRAGMA journal_mode=WAL').get() as { journal_mode: string }).journal_mode);
  db.exec('PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;');
  db.exec(SCHEMA);
  // Added after the first version: "don't ask again" rules belong to a conversation.
  if (!(db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]).some((c) => c.name === 'rules')) db.exec('ALTER TABLE conversations ADD COLUMN rules TEXT');
  if (!(db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).some((c) => c.name === 'usage')) db.exec('ALTER TABLE messages ADD COLUMN usage TEXT');
  try {
    fs.chmodSync(file, 0o600);
  } catch {}

  const q = {
    last: db.prepare('SELECT * FROM conversations WHERE project = ? ORDER BY updated DESC, id DESC LIMIT 1'),
    list: db.prepare('SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation = c.id) AS n FROM conversations c WHERE c.project = ? ORDER BY c.pinned DESC, c.updated DESC, c.id DESC LIMIT ?'),
    listAll: db.prepare('SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation = c.id) AS n FROM conversations c ORDER BY c.pinned DESC, c.updated DESC, c.id DESC LIMIT ?'),
    create: db.prepare('INSERT INTO conversations (project, title, created, updated, model, prefix, prefix_hash, lock_pid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    lock: db.prepare('UPDATE conversations SET lock_pid = ? WHERE id = ?'),
    unlock: db.prepare('UPDATE conversations SET lock_pid = NULL WHERE id = ? AND lock_pid = ?'),
    get: db.prepare('SELECT * FROM conversations WHERE id = ?'),
    next: db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE conversation = ?'),
    add: db.prepare('INSERT INTO messages (conversation, seq, role, content, interrupted) VALUES (?, ?, ?, ?, ?)'),
    set: db.prepare('UPDATE messages SET content = ?, interrupted = ? WHERE conversation = ? AND seq = ?'),
    drop: db.prepare('DELETE FROM messages WHERE conversation = ? AND seq = ?'),
    touch: db.prepare('UPDATE conversations SET updated = ? WHERE id = ?'),
    title: db.prepare("UPDATE conversations SET title = ? WHERE id = ? AND title = ''"),
    usage: db.prepare('UPDATE conversations SET tokens = tokens + ?, cost = cost + ?, model = ? WHERE id = ?'),
    prefix: db.prepare('UPDATE conversations SET prefix = ?, prefix_hash = ? WHERE id = ?'),
    rules: db.prepare('UPDATE conversations SET rules = ? WHERE id = ?'),
    messages: db.prepare('SELECT seq, role, content, interrupted, usage FROM messages WHERE conversation = ? ORDER BY seq'),
    setUsage: db.prepare('UPDATE messages SET usage = ? WHERE conversation = ? AND seq = ?'),
    prompts: db.prepare("SELECT m.content FROM messages m JOIN conversations c ON c.id = m.conversation WHERE c.project = ? AND m.role = 'user' ORDER BY c.updated DESC, m.seq DESC LIMIT ?"),
  };

  return {
    wal: mode.toLowerCase() === 'wal',
    // The project's last conversation, if this window may take it: one that's open
    // in another live Rime window (its lock) is left alone.
    last(project: string): { conv: Conversation | null; busy: boolean } {
      const c = (q.last.get(project) as Conversation | undefined) ?? null;
      if (!c) return { conv: null, busy: false };
      if (c.lock_pid && c.lock_pid !== process.pid && alive(c.lock_pid)) return { conv: null, busy: true };
      q.lock.run(process.pid, c.id);
      return { conv: c, busy: false };
    },
    // This project's conversations (or every project's), pinned first, then
    // newest; `other` when another live Rime window has it open.
    list(project: string | null, limit = 200) {
      const rows = (project === null ? q.listAll.all(limit) : q.list.all(project, limit)) as (Conversation & { n: number })[];
      return rows.map((c) => ({ ...c, other: !!c.lock_pid && c.lock_pid !== process.pid && alive(c.lock_pid) }));
    },
    // Opens a conversation from the list, unless another live window has it.
    take(id: number): Conversation | null {
      const c = q.get.get(id) as Conversation | undefined;
      if (!c || (c.lock_pid && c.lock_pid !== process.pid && alive(c.lock_pid))) return null;
      q.lock.run(process.pid, id);
      return c;
    },
    create(project: string, prefix: string, model?: string, hash?: string) {
      const now = Date.now();
      return Number(q.create.run(project, '', now, now, model ?? null, prefix, hash ?? null, process.pid).lastInsertRowid);
    },
    get: (id: number) => q.get.get(id) as Conversation | undefined,
    unlock: (id: number) => void q.unlock.run(id, process.pid),
    // Appends one message (append-only, the exact blocks sent and received).
    append(conv: number, role: Stored['role'], content: string | Block[], interrupted = false) {
      const seq = Number((q.next.get(conv) as { seq: number }).seq);
      q.add.run(conv, seq, role, JSON.stringify(content), interrupted ? 1 : 0);
      q.touch.run(Date.now(), conv);
      if (role === 'user') q.title.run(titleOf(typeof content === 'string' ? content : String(content.find((b) => b.type === 'text')?.text ?? '')), conv);
      return seq;
    },
    // A streaming reply is stored as it grows (interrupted until it ends).
    update(conv: number, seq: number, content: string | Block[], interrupted: boolean) {
      q.set.run(JSON.stringify(content), interrupted ? 1 : 0, conv, seq);
      q.touch.run(Date.now(), conv);
    },
    remove: (conv: number, seq: number) => void q.drop.run(conv, seq),
    usage: (conv: number, tokens: number, cost: number, model: string) => void q.usage.run(tokens, cost, model, conv),
    setPrefix: (conv: number, prefix: string, hash?: string) => void q.prefix.run(prefix, hash ?? null, conv),
    setRules: (conv: number, rules: object) => void q.rules.run(JSON.stringify(rules), conv),
    messages: (conv: number): Stored[] =>
      (q.messages.all(conv) as { seq: number; role: Stored['role']; content: string; interrupted: number; usage: string | null }[]).map((r) => ({
        seq: r.seq,
        role: r.role,
        content: JSON.parse(r.content),
        interrupted: !!r.interrupted,
        ...(r.usage ? { usage: JSON.parse(r.usage) } : {}),
      })),
    setUsage: (conv: number, seq: number, u: NonNullable<Stored['usage']>) => void q.setUsage.run(JSON.stringify(u), conv, seq),
    // Your earlier prompts in this project, newest first (ghost text and ctrl+r).
    prompts(project: string, limit = 500) {
      const out: string[] = [];
      for (const r of q.prompts.all(project, limit) as { content: string }[]) {
        const c = JSON.parse(r.content) as string | Block[];
        const t = (typeof c === 'string' ? c : String(c.find((b) => b.type === 'text')?.text ?? '')).trim();
        if (t && t !== 'continue' && !out.includes(t)) out.push(t);
      }
      return out;
    },
    close: () => db.close(),
  };
}

export type Db = Awaited<ReturnType<typeof openDb>>;
