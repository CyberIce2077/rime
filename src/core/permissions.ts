// Permissions (SPEC §17): Rime asks before every command and every edit. Modes
// (ask · auto-edit · plan, and auto from /permissions), allow / ask / deny rules
// where deny wins, a built-in list of read-only commands that never ask, and
// guard's always-ask list that holds even in auto. Chained commands are checked
// part by part, so an allow rule never covers `npm test && rm -rf ~`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// god: nothing asks, not even guard's list (only your deny rules still block).
export type Mode = 'ask' | 'auto-edit' | 'plan' | 'auto' | 'god';
export const MODES: Mode[] = ['ask', 'auto-edit', 'plan']; // what shift+tab cycles
export const MODE_HELP: Record<Mode, string> = {
  ask: 'ask before commands and edits',
  'auto-edit': 'edits without asking · commands still ask',
  plan: 'plan · read-only',
  auto: 'auto · only risky commands ask',
  god: 'god mode · runs everything without asking',
};

export type Kind = 'allow' | 'ask' | 'deny';
export type Rules = { allow?: string[]; ask?: string[]; deny?: string[] };
export type Rule = { kind: Kind; pattern: string; from: 'you' | 'project' | 'conversation' };

// Read-only commands that run without asking (like Codex's safe commands).
export const SAFE = ['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'find', 'git status', 'git diff', 'git log', 'git show'];

// guard's always-ask list: asked even in auto mode, never covered by an allow rule.
export function guarded(part: string, project: string): string | null {
  const p = part.trim();
  if (/^sudo\b/.test(p)) return 'sudo';
  if (/^rm\b/.test(p) && /\s-[a-z]*r[a-z]*f|\s-[a-z]*f[a-z]*r|\s-r\b.*\s-f\b|\s-f\b.*\s-r\b|--recursive.*--force|--force.*--recursive/i.test(p)) return 'rm -rf';
  if (/^git\s+push\b/.test(p) && /\s(--force(-with-lease)?|-f)\b/.test(p)) return 'force push';
  if (/^(scp|rsync|sftp|ftp|nc|ncat|netcat)\b/.test(p) || (/^(curl|wget)\b/.test(p) && /\s(-T|--upload-file|-F|--form|--data-binary|-d|--data)\b/.test(p))) return 'sends files off this machine';
  // Writes outside the project: a redirect, tee, cp or mv to a path elsewhere.
  for (const m of p.matchAll(/(?:>>?|\btee\s+(?:-a\s+)?|\b(?:cp|mv)\s+(?:\S+\s+)+?)(\S+)\s*$|>>?\s*(\S+)/g)) {
    const target = (m[1] ?? m[2] ?? '').replace(/^['"]|['"]$/g, '');
    if (target && outside(target, project)) return 'writes outside the project';
  }
  return null;
}

export function outside(target: string, project: string) {
  if (target === '/dev/null' || target.startsWith('&')) return false;
  const abs = path.resolve(project, target.replace(/^~(?=\/|$)/, os.homedir()));
  return abs !== project && !abs.startsWith(project + path.sep);
}

// A command split into the parts that run: `a && b`, `a; b`, `a | b`, `a || b`,
// new lines, and what's inside $(…) and backticks. Quotes are respected.
export function parts(cmd: string): string[] {
  const out: string[] = [];
  let cur = '', q = '';
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = '';
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], two = cmd.slice(i, i + 2);
    if (q) {
      if (c === q) q = '';
      else if (q === '"' && two === '$(') {
        const end = matchParen(cmd, i + 1);
        out.push(...parts(cmd.slice(i + 2, end)));
        cur += cmd.slice(i, end + 1);
        i = end;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') (q = c), (cur += c);
    else if (c === '\\' && i + 1 < cmd.length) (cur += c + cmd[i + 1]), i++;
    else if (two === '&&' || two === '||') push(), i++;
    else if (c === ';' || c === '|' || c === '\n' || c === '&') push();
    else if (two === '$(') {
      const end = matchParen(cmd, i + 1);
      out.push(...parts(cmd.slice(i + 2, end)));
      cur += '$(…)';
      i = end;
    } else if (c === '`') {
      const end = cmd.indexOf('`', i + 1);
      const stop = end < 0 ? cmd.length : end;
      out.push(...parts(cmd.slice(i + 1, stop)));
      cur += '`…`';
      i = stop;
    } else cur += c;
  }
  push();
  return out;
}
function matchParen(s: string, open: number) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i;
  }
  return s.length;
}

// Read-only on the built-in list: `find` only without -exec / -delete, and no
// output redirect into a file.
export function safe(part: string) {
  const p = part.trim();
  if (/(^|[^>])>(?!&)|\btee\b/.test(p.replace(/2>&1|>\s*\/dev\/null/g, ''))) return false;
  if (/^find\b/.test(p) && /\s-(exec|execdir|delete|ok|fprint)/.test(p)) return false;
  return SAFE.some((s) => p === s || p.startsWith(s + ' '));
}

// `bash(npm test *)` matches `npm test` and `npm test -- --watch`; without the
// star only the exact command. `edit(src/**)`, `read(*.md)` are globs on paths
// relative to the project.
export function matches(pattern: string, tool: string, value: string) {
  const m = /^(\w+)\((.*)\)$/.exec(pattern.trim());
  if (!m || m[1] !== tool) return false;
  const arg = m[2].trim();
  if (tool === 'bash') {
    if (arg.endsWith(' *')) {
      const pre = arg.slice(0, -2);
      return value === pre || value.startsWith(pre + ' ');
    }
    return value === arg;
  }
  return glob(arg).test(value);
}
export const glob = (g: string) =>
  new RegExp('^' + g.split(/(\*\*\/?|\*|\?)/).map((t) => (t.startsWith('**') ? '.*' : t === '*' ? '[^/]*' : t === '?' ? '[^/]' : t.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('') + '$');

export function ruleList(user: Rules = {}, project: Rules = {}, conversation: Rules = {}): Rule[] {
  const out: Rule[] = [];
  for (const [from, r] of [['conversation', conversation], ['project', project], ['you', user]] as const) for (const kind of ['deny', 'ask', 'allow'] as const) for (const pattern of r[kind] ?? []) out.push({ kind, pattern, from });
  return out;
}
// deny wins over ask, which wins over allow.
function ruleFor(rules: Rule[], tool: string, value: string): Rule | undefined {
  for (const kind of ['deny', 'ask', 'allow'] as const) {
    const r = rules.find((x) => x.kind === kind && matches(x.pattern, tool, value));
    if (r) return r;
  }
}

// How "don't ask again" names a command: the program, plus its subcommand when
// the next word is one (`npm test`, `git commit`, `npm run build`), never a flag's
// value, a path or a URL (`curl -m 10 https://…` is just `curl`).
export function commandName(part: string) {
  const words = part.trim().split(/\s+/);
  let i = 0;
  while (i < words.length && /^\w+=/.test(words[i])) i++; // FOO=1 cmd
  const name = [words[i] ?? ''];
  const sub = (w?: string) => !!w && /^[a-z][a-z0-9_-]*$/.test(w);
  if (sub(words[i + 1])) {
    name.push(words[i + 1]);
    if (/^(run|exec|x|dlx)$/.test(words[i + 1]) && /^[\w:.-]+$/.test(words[i + 2] ?? '') && !/^-/.test(words[i + 2])) name.push(words[i + 2]);
  }
  return name.join(' ');
}

export type PartState = { text: string; state: 'ok' | 'ask' | 'guard' | 'deny'; why: string };
export type Decision = {
  verdict: 'allow' | 'ask' | 'deny';
  why: string; // why it runs without asking, why it asks, or why it's refused
  parts?: PartState[];
  rule?: string; // what "don't ask again" would add, e.g. bash(npm test *)
  label?: string; // how that choice names it, e.g. npm test
};

export type Ctx = { mode: Mode; project: string; rules: Rule[]; granted?: (p: string) => boolean };

export function decide(tool: string, input: Record<string, any>, c: Ctx): Decision {
  if (tool === 'rime') return { verdict: 'allow', why: "Rime's own settings" };
  // God mode runs every command and edit without asking. Your deny rules still hold.
  if (c.mode === 'god') {
    const values = tool === 'bash' ? parts(String(input.command ?? '')) : [path.relative(c.project, path.resolve(c.project, String(input.path ?? '')))];
    const kind = tool === 'write' ? 'edit' : tool;
    const denied = values.map((v) => ruleFor(c.rules, kind, v)).find((r) => r?.kind === 'deny');
    return denied ? { verdict: 'deny', why: `denied by ${denied.pattern}` } : { verdict: 'allow', why: 'god mode' };
  }
  if (tool === 'read') {
    const abs = path.resolve(c.project, String(input.path ?? ''));
    const r = ruleFor(c.rules, 'read', path.relative(c.project, abs));
    if (r?.kind === 'deny') return { verdict: 'deny', why: `denied by ${r.pattern}` };
    if (!outside(abs, c.project) || c.granted?.(abs)) return { verdict: r?.kind === 'ask' ? 'ask' : 'allow', why: r?.kind === 'ask' ? `asks by ${r.pattern}` : 'reading inside the project' };
    return r?.kind === 'allow' ? { verdict: 'allow', why: `allowed by ${r.pattern}` } : { verdict: 'ask', why: 'reads outside the project', rule: `read(${abs})`, label: abs };
  }
  if (tool === 'write' || tool === 'edit') {
    const abs = path.resolve(c.project, String(input.path ?? ''));
    const relp = path.relative(c.project, abs);
    if (c.mode === 'plan') return { verdict: 'deny', why: 'plan mode is read-only' };
    const r = ruleFor(c.rules, 'edit', relp);
    if (r?.kind === 'deny') return { verdict: 'deny', why: `denied by ${r.pattern}` };
    if (outside(abs, c.project)) return { verdict: 'ask', why: 'writes outside the project (always asks)' };
    if (r?.kind === 'ask') return { verdict: 'ask', why: `asks by ${r.pattern}` };
    if (c.mode === 'auto-edit' || c.mode === 'auto') return { verdict: 'allow', why: c.mode };
    if (r?.kind === 'allow') return { verdict: 'allow', why: `allowed by ${r.pattern}` };
    return { verdict: 'ask', why: 'edits ask in this mode' };
  }
  if (tool !== 'bash') return { verdict: 'ask', why: 'unknown tool' };
  const ps: PartState[] = parts(String(input.command ?? '')).map((text) => {
    const r = ruleFor(c.rules, 'bash', text);
    if (r?.kind === 'deny') return { text, state: 'deny', why: `denied by ${r.pattern}` };
    const g = guarded(text, c.project);
    if (g) return { text, state: 'guard', why: `${g} always asks` };
    if (r?.kind === 'ask') return { text, state: 'ask', why: `asks by ${r.pattern}` };
    if (safe(text)) return { text, state: 'ok', why: 'read-only' };
    if (c.mode === 'plan') return { text, state: 'deny', why: 'plan mode is read-only' };
    if (r?.kind === 'allow') return { text, state: 'ok', why: `allowed by ${r.pattern}` };
    if (c.mode === 'auto') return { text, state: 'ok', why: 'auto mode' };
    return { text, state: 'ask', why: '' };
  });
  if (!ps.length) return { verdict: 'deny', why: 'empty command' };
  const denied = ps.find((p) => p.state === 'deny');
  if (denied) return { verdict: 'deny', why: denied.why, parts: ps };
  const asking = ps.filter((p) => p.state === 'ask' || p.state === 'guard');
  if (!asking.length) return { verdict: 'allow', why: ps.length > 1 ? 'every part is allowed' : ps[0].why, parts: ps };
  const first = asking.find((p) => p.state === 'ask');
  const label = first ? commandName(first.text) : undefined;
  return { verdict: 'ask', why: asking.find((p) => p.state === 'guard')?.why ?? 'commands ask in this mode', parts: ps, ...(label && !asking.some((p) => p.state === 'guard') ? { rule: `bash(${label} *)`, label } : {}) };
}

// Project rules live in .rime/permissions.json (can be committed, so a team
// shares them); your rules in ~/.rime/config.
export function projectRules(project: string): Rules {
  try {
    return JSON.parse(fs.readFileSync(path.join(project, '.rime', 'permissions.json'), 'utf8'));
  } catch {
    return {};
  }
}
export function addProjectRule(project: string, kind: Kind, pattern: string) {
  const r = projectRules(project);
  r[kind] = [...new Set([...(r[kind] ?? []), pattern])];
  fs.mkdirSync(path.join(project, '.rime'), { recursive: true });
  fs.writeFileSync(path.join(project, '.rime', 'permissions.json'), JSON.stringify(r, null, 2) + '\n');
}
export function removeProjectRule(project: string, kind: Kind, pattern: string) {
  const r = projectRules(project);
  r[kind] = (r[kind] ?? []).filter((p) => p !== pattern);
  fs.writeFileSync(path.join(project, '.rime', 'permissions.json'), JSON.stringify(r, null, 2) + '\n');
}
