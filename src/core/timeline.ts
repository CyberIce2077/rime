// The timeline (SPEC §16): a short record of what happened in a conversation,
// written by code with no AI and no tokens. Search and the list read it.

import { TESTS } from './suggest.ts';

export type Event = { kind: string; text: string; ref?: string };
type Result = { summary: string; error?: boolean; output?: string[] };

// The first error in a command's output, with the file:line it points at.
// ponytail: a few common shapes (TypeError …, error:, FAIL, panic:); add more as logs show misses.
export function errorOf(lines: string[]): { text: string; ref?: string } | null {
  const i = lines.findIndex((l) => /\b[A-Z]\w*(?:Error|Exception)\b|\berror\b[:[]|^\s*FAIL\b|panic:/.test(l));
  if (i < 0) return null;
  const text = lines[i].trim().slice(0, 100);
  const at = /([\w./-]+\.\w+):(\d+)/.exec(lines.slice(i, i + 8).join('\n'));
  return at ? { text: text.includes(at[0]) ? text : `${text} · ${at[1]}:${at[2]}`, ref: at[1] } : { text };
}

// One tool call's entries: the file changed (`signup.ts +2 −1`), the command and
// how it ended (`npm test ✓`), a commit by its message, and the first error seen.
export function toolEvents(name: string, input: Record<string, any>, r: Result, file: string): Event[] {
  if (name === 'write' || name === 'edit') {
    if (r.error) return [];
    return [{ kind: 'edit', text: `${file} ${name === 'edit' ? r.summary : r.summary.startsWith('created') ? 'created' : 'rewritten'}`, ref: file }];
  }
  if (name !== 'bash') return [];
  const cmd = String(input.command ?? '').split('\n')[0].trim().slice(0, 80);
  const out: Event[] = [];
  if (!r.error && /\bgit\b.*\bcommit\b/.test(cmd)) out.push({ kind: 'commit', text: /-\w*m\s+(['"])(.+?)\1/.exec(cmd)?.[2] ?? cmd });
  else out.push({ kind: TESTS.test(cmd) ? 'test' : 'command', text: `${cmd} ${r.error ? '✗' : '✓'}` });
  const e = r.error ? errorOf(r.output ?? []) : null;
  if (e) out.push({ kind: 'error', ...e });
  return out;
}
