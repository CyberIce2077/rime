// Permissions (SPEC §17): Rime asks before every command and every edit. Modes
// (ask · auto-edit · plan, and auto from /permissions), allow / ask / deny rules
// where deny wins, a built-in list of read-only commands that never ask, and
// guard's always-ask list that holds even in auto. Chained commands are checked
// part by part, so an allow rule never covers `npm test && rm -rf ~`.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rimeDir } from './config.ts';

// god: nothing asks, not even guard's list (only your deny rules still block).
export type Mode = 'ask' | 'auto-edit' | 'plan' | 'auto' | 'god';
export const MODES: Mode[] = ['ask', 'auto-edit', 'plan']; // what shift+tab cycles
export const MODE_HELP: Record<Mode, string> = {
  ask: 'ask before commands and edits',
  'auto-edit': 'edits without asking · commands still ask',
  plan: 'plan · read-only',
  auto: 'auto · only risky commands ask; the rest run in a sandbox',
  god: 'god mode · runs everything without asking',
};

export type Kind = 'allow' | 'ask' | 'deny';
export type Rules = { allow?: string[]; ask?: string[]; deny?: string[] };
export type Rule = { kind: Kind; pattern: string; from: 'you' | 'project' | 'conversation' };

// Read-only commands that run without asking (like Codex's safe commands).
export const SAFE = ['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'find', 'git status', 'git diff', 'git log', 'git show'];

// The command a part really runs: `(`, `{`, `!`, `\` and shell keywords stripped,
// leading VAR=… and wrappers (env, nohup, xargs, …) with their flags skipped, and
// the program's folder dropped (`/bin/rm -rf x` → `rm -rf x`).
const WRAPPERS = /^(env|time|nohup|exec|command|builtin|nice|xargs|stdbuf|timeout|caffeinate|if|then|else|elif|do|while|until|!)$/;
export function normal(part: string) {
  const words = part.trim().replace(/^[({!\s]+|[)};\s]+$/g, '').split(/\s+/).filter(Boolean);
  for (;;) {
    const w = (words[0] ?? '').replace(/^\\/, '').replace(/^.*\//, '');
    if (/^\w+=/.test(words[0] ?? '')) words.shift();
    else if (WRAPPERS.test(w)) {
      words.shift();
      // ponytail: a wrapper's flags and numbers are skipped, not their values (`env -u X cmd`).
      while (/^(-|\d+[smhd]?$)/.test(words[0] ?? '')) words.shift();
    } else break;
  }
  if (words.length) words[0] = words[0].replace(/^\\/, '').replace(/^['"]|['"]$/g, '').replace(/^.*\//, '');
  return words.join(' ');
}

const unquote = (s: string) => s.replace(/^(['"])(.*)\1$/, '$2');

// Where a part writes: redirects, and the files of programs that change them.
function targets(p: string): string[] {
  const out = [...p.matchAll(/>>?\|?\s*(\S+)/g)].map((m) => m[1]);
  const words = p.split(/\s+/), prog = words[0], args = words.slice(1).filter((a) => !a.startsWith('-'));
  if (/^(cp|mv|install|ln)$/.test(prog)) out.push(args.at(-1) ?? '');
  else if (/^(tee|rm|rmdir|touch|mkdir|chmod|chown|chgrp|truncate|shred|unlink)$/.test(prog)) out.push(...args);
  else if (/^(sed|perl)$/.test(prog) && /\s-[a-zA-Z]*i/.test(p)) out.push(...args.slice(1));
  else if (prog === 'dd') out.push(...words.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)));
  return out.map(unquote).filter(Boolean);
}

// git's own options before the subcommand (`git -C . push`) don't hide a force push.
function forcePush(words: string[]) {
  if (words[0] !== 'git') return false;
  let i = 1;
  while (words[i]?.startsWith('-')) i += /^(-C|-c|--git-dir|--work-tree|--namespace)$/.test(words[i]) ? 2 : 1;
  if (words[i] !== 'push') return false;
  return words.slice(i + 1).some((w) => /^(--force(-with-lease|-if-includes)?(=.*)?|--mirror|-[a-zA-Z]*f[a-zA-Z]*)$/.test(w) || /^\+/.test(w));
}

// guard's always-ask list: asked even in auto mode, never covered by an allow rule.
export function guarded(part: string, project: string): string | null {
  const p = normal(part);
  const words = p.split(/\s+/);
  if (/^(sudo|doas)$/.test(words[0])) return 'sudo';
  if (words[0] === 'rm' && /\s-[a-z]*r[a-z]*f|\s-[a-z]*f[a-z]*r|\s-r\b.*\s-f\b|\s-f\b.*\s-r\b|--recursive.*--force|--force.*--recursive/i.test(p)) return 'rm -rf';
  if (forcePush(words)) return 'force push';
  if (/^(scp|rsync|sftp|ftp|nc|ncat|netcat)$/.test(words[0]) || (/^(curl|wget)$/.test(words[0]) && /\s(-T|--upload-file|-F|--form|--data-binary|-d|--data)\b/.test(p))) return 'sends files off this machine';
  if (targets(p).some((t) => outside(t, project))) return 'writes outside the project';
  if (targets(p).some((t) => settingsPath(t, project))) return "changes Rime's or git's settings";
  if (words[0] === 'git' && words.includes('config') && !words.some((w) => /^(--get\S*|--list|-l)$/.test(w))) return "changes git's settings";
  // curl -o / wget -O name where the download lands.
  const out = /^(curl|wget)$/.test(words[0]) ? /\s(?:-o|--output|-O|--output-document)[\s=]+(\S+)/.exec(p)?.[1] : undefined;
  if (out && out !== '-' && outside(unquote(out), project)) return 'writes outside the project';
  return null;
}

// Rime's and git's own settings inside the project (.rime/, .git/) and
// ~/.rime: writing there changes what Rime allows or what git runs (a
// core.fsmonitor command runs on every `git status`), so it always asks.
export function settingsPath(target: string, project: string) {
  if (target.startsWith('&') || target === '/dev/null') return false;
  const abs = real(path.resolve(project, expand(target))), root = real(project);
  return [path.join(root, '.rime'), path.join(root, '.git'), real(path.join(os.homedir(), '.rime'))].some((d) => abs === d || abs.startsWith(d + path.sep));
}

// A path outside the project. One that starts with a variable ($HOME/x) can't be
// known, so it counts as outside.
export function outside(target: string, project: string) {
  if (target === '/dev/null' || target.startsWith('&')) return false;
  if (target.startsWith('$')) return true;
  const abs = real(path.resolve(project, expand(target))), root = real(project);
  return abs !== root && !abs.startsWith(root + path.sep);
}
const expand = (p: string) => p.replace(/^~(?=\/|$)/, os.homedir());
// A path with its links followed, so `h/.bashrc` where h → ~ is seen as ~/.bashrc:
// the nearest folder that exists is resolved and the rest is added back.
export function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    const up = path.dirname(p);
    return up === p ? p : path.join(real(up), path.basename(p));
  }
}

// A command split into the parts that run: `a && b`, `a; b`, `a | b`, `a || b`,
// new lines, and what's inside $(…), <(…), >(…), backticks (also inside double
// quotes) and `sh -c '…'`. Quotes are respected; `2>&1` and `&>` are redirects.
export function parts(cmd: string): string[] {
  const out: string[] = [];
  let cur = '', q = '';
  const push = () => {
    if (cur.trim()) {
      out.push(cur.trim());
      const inner = /^(?:(?:ba|z|da|k)?sh\s+-\w*c\w*|eval)\s+(.+)$/.exec(normal(cur));
      if (inner) out.push(...parts(unquote(inner[1])));
    }
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
      } else if (q === '"' && c === '`') {
        const end = cmd.indexOf('`', i + 1);
        const stop = end < 0 ? cmd.length : end;
        out.push(...parts(cmd.slice(i + 1, stop)));
        cur += cmd.slice(i, stop + 1);
        i = stop;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') (q = c), (cur += c);
    else if (c === '\\' && i + 1 < cmd.length) (cur += c + cmd[i + 1]), i++;
    else if (two === '&&' || two === '||') push(), i++;
    else if (c === '&' && (cmd[i - 1] === '>' || cmd[i + 1] === '>')) cur += c;
    else if (c === ';' || c === '|' || c === '\n' || c === '&') push();
    else if (two === '$(' || two === '<(' || two === '>(') {
      const end = matchParen(cmd, i + 1);
      out.push(...parts(cmd.slice(i + 2, end)));
      cur += c + '(…)';
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

// Read-only on the built-in list: `find` only without -exec / -delete, no output
// redirect into a file, and nothing that runs code ($(…), <(…), >(…), backticks).
export function safe(part: string) {
  const p = part.trim();
  if (/\$\(|<\(|>\(|`/.test(p)) return false;
  if (/(^|[^>])>(?!&)|\btee\b/.test(p.replace(/\d*>&\d+|>&-|>\s*\/dev\/null/g, ''))) return false;
  if (/^find\b/.test(p) && /\s-(exec|execdir|delete|ok|fprint|fls)/.test(p)) return false;
  // Flags that run a program or write a file.
  if (/^rg\b/.test(p) && /\s--pre(-glob)?\b/.test(p)) return false;
  if (/^git\b/.test(p) && /\s(--output|--ext-diff|--textconv)\b/.test(p)) return false;
  return SAFE.some((s) => p === s || p.startsWith(s + ' '));
}

// A read-only command's path that's outside the project and wasn't dropped in.
// ponytail: every argument that isn't a flag counts as a path (a grep pattern like /api asks too).
function readsOutside(part: string, c: Ctx) {
  for (const w of part.trim().split(/\s+/).slice(1)) {
    const a = w.replace(/^['"]|['"]$/g, '');
    if (!a || a.startsWith('-') || !outside(a, c.project)) continue;
    if (!c.granted?.(path.resolve(c.project, expand(a)))) return a;
  }
  return '';
}

// `bash(npm test *)` matches `npm test` and `npm test -- --watch`; without the
// star only the exact command. `edit(src/**)`, `read(*.md)` are globs on paths
// relative to the project.
// A pattern that starts with / or ~ matches the absolute path (`read(~/.ssh/**)`).
export function matches(pattern: string, tool: string, value: string, abs?: string) {
  const m = /^(\w+)\((.*)\)$/.exec(pattern.trim());
  if (!m || m[1] !== tool) return false;
  let arg = m[2].trim();
  if (tool === 'bash') {
    // FOO=1 npm test is npm test, like commandName.
    (arg = arg.replace(/\s+/g, ' ')), (value = value.trim().replace(/\s+/g, ' ').replace(/^(\w+=\S*\s+)+/, ''));
    if (arg.endsWith(' *')) {
      const pre = arg.slice(0, -2);
      return value === pre || value.startsWith(pre + ' ');
    }
    return value === arg;
  }
  if (/^[/~]/.test(arg)) return !!abs && glob(expand(arg)).test(abs);
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
function ruleFor(rules: Rule[], tool: string, value: string, abs?: string): Rule | undefined {
  for (const kind of ['deny', 'ask', 'allow'] as const) {
    const r = rules.find((x) => x.kind === kind && matches(x.pattern, tool, value, abs));
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
  rules?: string[]; // every rule it adds, one per asking command of a chain
  label?: string; // how that choice names it, e.g. npm test
};

export type Ctx = { mode: Mode; project: string; rules: Rule[]; granted?: (p: string) => boolean };

export function decide(tool: string, input: Record<string, any>, c: Ctx): Decision {
  if (tool === 'rime') return { verdict: 'allow', why: "Rime's own settings" };
  // God mode runs every command and edit without asking. Your deny rules still hold.
  if (c.mode === 'god') {
    const abs = path.resolve(c.project, String(input.path ?? ''));
    const values = tool === 'bash' ? parts(String(input.command ?? '')) : [path.relative(c.project, abs)];
    const kind = tool === 'write' ? 'edit' : tool;
    const denied = values.map((v) => ruleFor(c.rules, kind, v, abs)).find((r) => r?.kind === 'deny');
    return denied ? { verdict: 'deny', why: `denied by ${denied.pattern}` } : { verdict: 'allow', why: 'god mode' };
  }
  if (tool === 'read') {
    const abs = path.resolve(c.project, String(input.path ?? ''));
    const r = ruleFor(c.rules, 'read', path.relative(c.project, abs), abs);
    if (r?.kind === 'deny') return { verdict: 'deny', why: `denied by ${r.pattern}` };
    if (!outside(abs, c.project) || c.granted?.(abs)) return { verdict: r?.kind === 'ask' ? 'ask' : 'allow', why: r?.kind === 'ask' ? `asks by ${r.pattern}` : 'reading inside the project' };
    return r?.kind === 'allow' ? { verdict: 'allow', why: `allowed by ${r.pattern}` } : { verdict: 'ask', why: 'reads outside the project', rule: `read(${abs})`, label: abs };
  }
  if (tool === 'write' || tool === 'edit') {
    const abs = path.resolve(c.project, String(input.path ?? ''));
    const relp = path.relative(c.project, abs);
    if (c.mode === 'plan') return { verdict: 'deny', why: 'plan mode is read-only' };
    const r = ruleFor(c.rules, 'edit', relp, abs);
    if (r?.kind === 'deny') return { verdict: 'deny', why: `denied by ${r.pattern}` };
    if (outside(abs, c.project)) return { verdict: 'ask', why: 'writes outside the project (always asks)' };
    if (settingsPath(abs, c.project)) return { verdict: 'ask', why: "changes Rime's or git's settings (always asks)" };
    if (r?.kind === 'ask') return { verdict: 'ask', why: `asks by ${r.pattern}` };
    if (c.mode === 'auto-edit' || c.mode === 'auto') return { verdict: 'allow', why: c.mode };
    if (r?.kind === 'allow') return { verdict: 'allow', why: `allowed by ${r.pattern}` };
    return { verdict: 'ask', why: 'edits ask in this mode' };
  }
  if (tool !== 'bash') return { verdict: 'ask', why: 'unknown tool' };
  const ps: PartState[] = parts(String(input.command ?? '')).map((text) => {
    const r = ruleFor(c.rules, 'bash', text);
    if (r?.kind === 'deny') return { text, state: 'deny', why: `denied by ${r.pattern}` };
    if (c.mode === 'plan' && !safe(text)) return { text, state: 'deny', why: 'plan mode is read-only' };
    const g = guarded(text, c.project);
    if (g) return { text, state: 'guard', why: `${g} always asks` };
    if (r?.kind === 'ask') return { text, state: 'ask', why: `asks by ${r.pattern}` };
    if (safe(text)) {
      const away = readsOutside(text, c);
      return away ? { text, state: 'ask', why: `reads ${away}, outside the project` } : { text, state: 'ok', why: 'read-only' };
    }
    if (r?.kind === 'allow') return { text, state: 'ok', why: `allowed by ${r.pattern}` };
    if (c.mode === 'auto') return { text, state: 'ok', why: 'auto mode' };
    return { text, state: 'ask', why: '' };
  });
  if (!ps.length) return { verdict: 'deny', why: 'empty command' };
  const denied = ps.find((p) => p.state === 'deny');
  if (denied) return { verdict: 'deny', why: denied.why, parts: ps };
  const asking = ps.filter((p) => p.state === 'ask' || p.state === 'guard');
  if (!asking.length) return { verdict: 'allow', why: ps.length > 1 ? 'every part is allowed' : ps[0].why, parts: ps };
  const names = [...new Set(asking.map((p) => commandName(p.text)).filter(Boolean))];
  const rules = names.map((n) => `bash(${n} *)`);
  return { verdict: 'ask', why: asking.find((p) => p.state === 'guard')?.why ?? 'commands ask in this mode', parts: ps, ...(names.length && !asking.some((p) => p.state === 'guard') ? { rule: rules[0], rules, label: names.join(' and ') } : {}) };
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
// A project's rules can come with a cloned repo, so its allow rules count only
// once you trusted this exact file (`trusted` is the hash you accepted). Its deny
// and ask rules only make Rime more careful, so they always count.
export function rulesHash(project: string) {
  try {
    return createHash('sha256').update(fs.readFileSync(path.join(project, '.rime', 'permissions.json'))).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}
export function trustedProjectRules(project: string, trusted?: string): Rules {
  const r = projectRules(project);
  return !r.allow?.length || trusted === rulesHash(project) ? r : { ...r, allow: [] };
}
export function addProjectRule(project: string, kind: Kind, pattern: string) {
  const r = projectRules(project);
  r[kind] = [...new Set([...(r[kind] ?? []), pattern])];
  rimeDir(project);
  fs.writeFileSync(path.join(project, '.rime', 'permissions.json'), JSON.stringify(r, null, 2) + '\n');
}
export function removeProjectRule(project: string, kind: Kind, pattern: string) {
  const r = projectRules(project);
  r[kind] = (r[kind] ?? []).filter((p) => p !== pattern);
  fs.writeFileSync(path.join(project, '.rime', 'permissions.json'), JSON.stringify(r, null, 2) + '\n');
}
