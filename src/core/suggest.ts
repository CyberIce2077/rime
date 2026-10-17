// Prompt suggestions (SPEC §5.4), all from code, with no AI call: what to say
// next after a reply, and what to try on an empty prompt. They follow what is
// actually happening: the reply's own offer, the tests, the files just changed,
// the project's uncommitted work and its TODOs.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { listFiles } from './attach.ts';

// What a turn did with its tools; `about`: the files it was about (attached by
// you, or read by the model).
export type Did = { wrote: string[]; ran: { cmd: string; ok: boolean; out?: string[] }[]; about?: string[] };

export const TESTS = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|\bvitest\b|\bjest\b|\bnode\s+--test\b|\bmake\s+test\b/;

// The reply's last sentence, without code blocks or markdown.
function lastSentence(text: string) {
  const plain = text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/[*_`]/g, '').trim();
  const line = plain.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
  return (/([^.!?]*[.!?]*)\s*$/.exec(line.replace(/\s+$/, ''))?.[1] ?? '').trim();
}

// An offer reads as the reply to say yes to: its first option, and only the
// action ("draft X so that Y" → "draft X"). Too long to read at a glance → "go ahead".
function shorten(offer: string) {
  offer = offer.replace(/^(also|go ahead and|just)\s+/i, '');
  offer = offer.split(/,?\s+or\s+|;\s*|\s+\(|\s+[—–]\s+|\s+-\s+/)[0];
  offer = offer.split(/,?\s+(?:so(?: that)?|which|because|since|to make sure)\s+/)[0].replace(/\s+(?:regardless|anyway|first|now|for now)$/i, '').replace(/[,.\s]+$/, '');
  if (!offer) return '';
  return offer.length > 90 ? 'yes, go ahead' : `yes, ${offer}`;
}

// Things Rime can no longer do (the browser and the design studio were removed:
// a terminal can't draw pages). Old prompts and offers about them are never
// suggested again.
export const STALE = /\bbrowser (?:tab|panel|pane|plug-?in)\b|\b(?:split[- ]?(?:screen|view|panel)|panel)(?:'s)? browser\b|\bbrowser (?:in|of|beside) (?:the |rime|split)|\bdesign (?:studio|tab|plug-?in)\b|^\/(?:browser|design)\b/i;

// "Want me to save it to a file, or make an animated one?" → "yes, save it to a
// file". "Let me know if you want me to add tests." → "yes, add tests". A real
// question ("Which framework do you prefer?") gets '' since only you can answer it;
// a reply with no offer and no question gets null.
export function offerOf(reply: string): string | null {
  const last = lastSentence(reply);
  if (!last) return null;
  const m =
    /\b(?:do you )?(?:want|would you like|should|shall|can|may) (?:me to |I )(.+?)\?$/i.exec(last) ??
    /\b(?:I can|I could) (?:also )?(.+?)(?:,? if you(?:'d)? (?:like|want)(?: me to)?)?[?.!]$/i.exec(last) ??
    /\blet me know if you(?:'d)? (?:want|like) me to (.+?)[.!?]?$/i.exec(last) ??
    /\bif you(?:'d)? (?:like|want),? I(?: can|'ll| will) (.+?)[.!?]?$/i.exec(last) ??
    /\b(?:I'm |I am )?happy to (.+?)(?:,? if you(?:'d)? (?:like|want))?[.!?]?$/i.exec(last) ??
    // "I'll start on milestone 1 regardless, since …": what it means to do next.
    /^(?:next,? |then,? |so,? |meanwhile,? )?I(?:'ll| will) (?!wait|need|leave|let you|be |keep|stop)(.+?)[.!]?$/i.exec(last);
  if (m) return shorten(m[1]) || '';
  return last.endsWith('?') ? '' : null;
}

// A reply that ends by asking you to pick, with its options as "(a) … (b) …"
// lines: the same picker as the ask tool. Labels are the bold part, or the text
// before a dash or colon.
export function choicesOf(reply: string): { question: string; options: { label: string; detail?: string }[] } | null {
  const question = lastSentence(reply);
  if (!question.endsWith('?')) return null;
  const options: { label: string; detail?: string }[] = [];
  for (const m of reply.replace(/```[\s\S]*?(```|$)/g, '').matchAll(/^\s*(?:[-*·•]\s+)?(?:\*\*)?\(?([a-f])\)\s*(.+)$/gm)) {
    if (m[1] !== 'abcdef'[options.length]) break;
    const line = m[2].replace(/^\*\*\s*/, '');
    const bold = /^(.+?)\*\*\s*(?:[—–:-]\s*)?(.*)$/.exec(line);
    const [label, detail] = bold ? [bold[1], bold[2]] : (line.split(/\s+[—–]\s+|:\s+|\s+-\s+/, 2) as [string, string?]);
    const clean = (t = '') => t.replace(/[*_`]/g, '').trim();
    options.push({ label: clean(label).replace(/[.,;]$/, ''), ...(clean(detail) ? { detail: clean(detail) } : {}) });
  }
  return options.length >= 2 ? { question, options } : null;
}

// A single shell command the reply tells you to run ("```sh\nnpm i express\n```").
function command(reply: string) {
  const blocks = [...reply.matchAll(/```(sh|bash|zsh|shell|console)\n([\s\S]*?)```/g)];
  if (blocks.length !== 1) return '';
  const lines = blocks[0][2].split('\n').map((l) => l.trim().replace(/^\$\s*/, '')).filter((l) => l && !l.startsWith('#'));
  return lines.length === 1 && lines[0].length <= 60 ? lines[0] : '';
}

// A reply that lists findings: several bullet or numbered points.
const findings = (reply: string) => reply.split('\n').filter((l) => /^\s*(?:[-*·•]|\d+[.)])\s+\S/.test(l)).length >= 2;

export function hasTests(project: string) {
  try {
    return !!JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).scripts?.test;
  } catch {
    return ['pytest.ini', 'go.mod', 'Cargo.toml', 'pyproject.toml'].some((f) => fs.existsSync(path.join(project, f)));
  }
}

// Files with uncommitted changes, or null outside git.
export function changed(project: string): string[] | null {
  const r = spawnSync('git', ['-C', project, 'status', '--porcelain'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split('\n').filter(Boolean).map((l) => l.slice(3).trim()).filter((f) => !f.startsWith('.rime/'));
}

// After a reply: the next step, or '' when the obvious next thing is yours to say.
export function nextStep(reply: string, did: Did, project: string): string {
  const failed = [...did.ran].reverse().find((r) => TESTS.test(r.cmd));
  if (failed && !failed.ok) {
    const file = (failed.out ?? []).join('\n').match(/[\w./-]+\.(?:test|spec)\.\w+|[\w./-]*test_\w+\.py|[\w./-]+_test\.(?:go|py)/)?.[0];
    return file ? `fix the failing test in ${path.basename(file)}` : 'fix the failing tests';
  }
  const offer = offerOf(reply);
  if (offer && !STALE.test(offer)) return offer;
  if (offer === '') return ''; // it asked a question only you can answer
  if (did.wrote.length && !failed && hasTests(project)) return 'run the tests';
  if ((did.wrote.length || failed?.ok) && changed(project)?.length) return 'commit this';
  if (!did.wrote.length) {
    // A review of a file: apply what it found.
    const file = did.about?.at(-1);
    if (file && findings(reply)) return `fix these in ${file}`;
    const cmd = command(reply);
    if (cmd) return `run ${cmd}`;
  }
  return '';
}

const CODE = /\.(ts|tsx|js|jsx|mjs|py|go|rs|rb|java|c|h|cpp|cs|swift|kt|php|vue|svelte|html|css|scss|sh)$/;
const NOISE = /(^|\/)(dist|build|out|vendor|node_modules|coverage|\.next|target)\//;

// The project's code files, most recently edited first.
function recent(project: string, limit = 40) {
  return listFiles(project, 5000)
    .filter((f) => CODE.test(f) && !NOISE.test(f) && !/\.(min|lock)\./.test(f))
    .map((f) => {
      try {
        return [f, fs.statSync(path.join(project, f)).mtimeMs] as const;
      } catch {
        return [f, 0] as const;
      }
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([f]) => f);
}

// A TODO or FIXME in a recently edited file: `src/app.ts:42`.
function todo(project: string, files: string[]) {
  for (const f of files.slice(0, 15)) {
    let text = '';
    try {
      const st = fs.statSync(path.join(project, f));
      if (st.size > 400_000) continue;
      text = fs.readFileSync(path.join(project, f), 'utf8');
    } catch {
      continue;
    }
    const i = text.split('\n').findIndex((l) => /\b(TODO|FIXME)\b/.test(l));
    if (i >= 0) return `${f}:${i + 1}`;
  }
  return null;
}

// On an empty prompt: the most useful thing to try in this project right now.
export function example(project: string): string {
  const dirty = changed(project);
  if (dirty?.length) return dirty.length === 1 ? `review my changes to ${dirty[0]}` : `review my uncommitted changes (${dirty.length} files)`;
  const files = recent(project);
  if (!files.length) return listFiles(project, 50).length ? 'explain what is in this folder' : 'build a small web page that says hello';
  const t = todo(project, files);
  if (t) return `do the TODO in ${t}`;
  const readme = listFiles(project, 200).some((f) => /^readme/i.test(f));
  if (!readme) return 'write a README for this project';
  if (files.length > 3) return 'explain how this project is organised';
  return `explain what ${files[0]} does`;
}
