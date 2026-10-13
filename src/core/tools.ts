// The core tools (SPEC §6.2): read, write, edit, bash, plus rime (Rime acting on
// itself, §15). The list is frozen for the session (it sits at the front of the
// cached prefix), and every output is capped (§6.3).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { stripAnsi } from './term.ts';

export type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };
export type ToolResult = { content: string; error?: boolean; summary: string; diff?: { sign: '+' | '-' | ' '; n: number; text: string }[]; output?: string[] };

// Keys are in a fixed order so the JSON is byte-identical every session.
export const TOOLS: ToolDef[] = [
  {
    name: 'read',
    description: 'Read a text file. Returns numbered lines, 200 at a time; use offset for more.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', description: 'first line, 1-based' }, limit: { type: 'integer' } }, required: ['path'] },
  },
  {
    name: 'write',
    description: 'Create a file, or replace one, with this content. Makes folders as needed.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'edit',
    description: 'Replace one exact piece of text in a file. old must appear exactly once; read the file first.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }, required: ['path', 'old', 'new'] },
  },
  {
    name: 'bash',
    description: 'Run a shell command in the project folder. Long output is cut to its start and end.',
    input_schema: { type: 'object', properties: { command: { type: 'string' }, reason: { type: 'string', description: 'why, in a few words; shown to the user' }, timeout: { type: 'integer', description: 'seconds, default 120' } }, required: ['command'] },
  },
  {
    name: 'rime',
    description: "Change Rime itself: settings, boxes, tabs, panel. action 'help' lists every action.",
    input_schema: { type: 'object', properties: { action: { type: 'string' }, args: { type: 'object' } }, required: ['action'] },
  },
];

export const READ_LINES = 200;
const LINE_MAX = 2000;
const HEAD = 50, TAIL = 100;

export const rel = (cwd: string, p: string) => {
  const r = path.relative(cwd, p);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p;
};
const fail = (content: string): ToolResult => ({ content, error: true, summary: content });

// read: a line range with line numbers and "N more lines".
export function read(cwd: string, input: { path: string; offset?: number; limit?: number }): ToolResult {
  const p = path.resolve(cwd, input.path ?? '');
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return fail(`${input.path}: no such file`);
  }
  if (st.isDirectory()) {
    const names = fs.readdirSync(p, { withFileTypes: true }).map((e) => e.name + (e.isDirectory() ? '/' : '')).sort();
    return { content: names.slice(0, READ_LINES).join('\n') + (names.length > READ_LINES ? `\n… ${names.length - READ_LINES} more` : ''), summary: `${names.length} entries` };
  }
  const b = fs.readFileSync(p);
  if (b.subarray(0, 8000).includes(0)) return { content: `${input.path} is a binary file (${st.size} bytes)`, summary: 'binary file' };
  const lines = b.toString('utf8').split('\n');
  const from = Math.max(1, input.offset ?? 1), n = Math.max(1, Math.min(input.limit ?? READ_LINES, 2000));
  const shown = lines.slice(from - 1, from - 1 + n).map((l, i) => `${String(from + i).padStart(5)}  ${l.length > LINE_MAX ? l.slice(0, LINE_MAX) + '…' : l}`);
  const more = lines.length - (from - 1 + shown.length);
  return { content: shown.join('\n') + (more > 0 ? `\n… ${more} more lines (offset ${from + shown.length})` : ''), summary: `${shown.length} line${shown.length === 1 ? '' : 's'}${more > 0 ? ` of ${lines.length}` : ''}` };
}

export function write(cwd: string, input: { path: string; content: string }): ToolResult {
  const p = path.resolve(cwd, input.path ?? '');
  const existed = fs.existsSync(p);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, input.content ?? '');
  const n = (input.content ?? '').split('\n').length;
  return { content: `${existed ? 'Replaced' : 'Created'} ${rel(cwd, p)} (${n} lines).`, summary: `${existed ? 'replaced' : 'created'} · ${n} lines` };
}

// The text an edit would produce, or why it can't (used by the approval prompt too).
export function planEdit(cwd: string, input: { path: string; old: string; new: string }): { error: string } | { before: string; after: string; at: number } {
  const p = path.resolve(cwd, input.path ?? '');
  if (!fs.existsSync(p)) return { error: `${input.path}: no such file (use write to create it)` };
  const before = fs.readFileSync(p, 'utf8');
  if (!input.old) return { error: 'old is empty; to replace the whole file use write' };
  const count = before.split(input.old).length - 1;
  if (count === 0) return { error: `old text not found in ${input.path}; read the file and copy it exactly` };
  if (count > 1) return { error: `old text appears ${count} times in ${input.path}; include more lines around it` };
  const at = before.indexOf(input.old);
  return { before, after: before.slice(0, at) + input.new + before.slice(at + input.old.length), at };
}

// A small diff around the change: the old lines, then the new ones, with numbers.
export function diffOf(before: string, at: number, old: string, neu: string, max = 12) {
  const line = before.slice(0, at).split('\n').length;
  const o = old.split('\n'), n = neu.split('\n');
  const out: NonNullable<ToolResult['diff']> = [];
  o.slice(0, max).forEach((t, i) => out.push({ sign: '-', n: line + i, text: t }));
  if (o.length > max) out.push({ sign: ' ', n: 0, text: `… ${o.length - max} more removed` });
  n.slice(0, max).forEach((t, i) => out.push({ sign: '+', n: line + i, text: t }));
  if (n.length > max) out.push({ sign: ' ', n: 0, text: `… ${n.length - max} more added` });
  return out;
}

export function edit(cwd: string, input: { path: string; old: string; new: string }): ToolResult {
  const e = planEdit(cwd, input);
  if ('error' in e) return fail(e.error);
  fs.writeFileSync(path.resolve(cwd, input.path), e.after);
  const line = e.before.slice(0, e.at).split('\n').length;
  const removed = input.old.split('\n').length, added = input.new.split('\n').length;
  return { content: `Edited ${input.path} at line ${line}: ${removed} line${removed === 1 ? '' : 's'} → ${added}.`, summary: `+${added} −${removed}`, diff: diffOf(e.before, e.at, input.old, input.new) };
}

// Terminal output as text: no colours, and a line redrawn with \r keeps only its
// last state (progress bars).
export function clean(out: string) {
  return stripAnsi(out.replace(/\r\n/g, '\n')).split('\n').map((l) => l.split('\r').filter(Boolean).at(-1) ?? '').join('\n');
}

// Long output keeps its first 50 and last 100 lines, saying what was cut.
export function cap(text: string) {
  const lines = text.replace(/\n+$/, '').split('\n');
  if (lines.length <= HEAD + TAIL) return lines;
  return [...lines.slice(0, HEAD), `… ${lines.length - HEAD - TAIL} lines cut …`, ...lines.slice(-TAIL)];
}

export function bash(cwd: string, input: { command: string; timeout?: number }, signal?: AbortSignal): Promise<ToolResult> {
  return new Promise((resolve) => {
    const limit = Math.min(600, Math.max(1, input.timeout ?? 120)) * 1000;
    // Its own process group, so a stop or timeout ends everything it started.
    const p = spawn('sh', ['-c', input.command ?? ''], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' } });
    let out = '', why = '';
    const kill = (w: string) => {
      why = w;
      try {
        process.kill(-p.pid!, 'SIGKILL');
      } catch {}
    };
    const t = setTimeout(() => kill(`timed out after ${limit / 1000} s`), limit);
    const stop = () => kill('stopped');
    signal?.addEventListener('abort', stop, { once: true });
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => (out += e.message));
    p.on('close', (code) => {
      clearTimeout(t);
      signal?.removeEventListener('abort', stop);
      const lines = cap(clean(out));
      const status = why || (code === 0 ? 'exit 0' : `exit ${code}`);
      const body = lines.join('\n').trim();
      resolve({ content: `${status}${body ? '\n' + body : ''}`, error: code !== 0 || !!why, summary: status, output: body ? lines : [] });
    });
  });
}
