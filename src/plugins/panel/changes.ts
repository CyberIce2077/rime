// The changes view: what changed since this window opened, live, hunk by hunk,
// under the branch line. y keeps a hunk (it leaves the list), u undoes it in the
// file, enter puts the line in the chat prompt so you can say what to change
// about it, and c commits: type a message, or leave it empty and Rime writes one.

import { spawnSync } from 'node:child_process';
import { type Key, type Line } from '../../core/term.ts';
import { type Hint } from '../../core/view.ts';
import { type Kit, type View, char, cursor, diffStyle, extend, lineInput } from './kit.ts';

export type Hunk = { head: string; lines: string[]; start: number; key: string };
export type FileDiff = { path: string; header: string[]; hunks: Hunk[]; binary: boolean };
export type GitFile = { path: string; x: string; y: string }; // porcelain status letters: index, work tree
export type Status = { branch: string; ahead: number; behind: number; files: GitFile[] };

// A unified diff (git diff) as files and hunks; each hunk keeps its file's header,
// so it can be applied (or undone) on its own.
export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let f: FileDiff | null = null, h: Hunk | null = null;
  for (const l of text.split('\n')) {
    if (l.startsWith('diff --git ')) {
      f = { path: /^diff --git a\/(.+?) b\//.exec(l)?.[1] ?? l.slice(11), header: [l], hunks: [], binary: false };
      files.push(f);
      h = null;
    } else if (!f) continue;
    else if (l.startsWith('@@')) {
      h = { head: l, lines: [], start: +(/\+(\d+)/.exec(l)?.[1] ?? 1), key: '' };
      f.hunks.push(h);
    } else if (h && /^[ +\-\\]/.test(l)) h.lines.push(l);
    else if (!h) {
      f.header.push(l);
      const to = /^\+\+\+ (?:b\/)?(.+)$/.exec(l)?.[1];
      if (to && to !== '/dev/null') f.path = to.trim();
      if (l.startsWith('Binary files')) f.binary = true;
    }
  }
  for (const x of files) for (const y of x.hunks) y.key = `${x.path}\n${y.lines.join('\n')}`;
  return files;
}

// `git status --porcelain=v1 -b` as the branch, how far it is from its upstream,
// and the changed files (Rime's own .rime/ left out).
export function parseStatus(status: string): Status {
  const lines = status.split('\n').filter(Boolean);
  const head = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3) : '';
  const branch = head.replace(/^No commits yet on /, '').split('...')[0].trim() || 'HEAD';
  const ahead = +(/ahead (\d+)/.exec(head)?.[1] ?? 0), behind = +(/behind (\d+)/.exec(head)?.[1] ?? 0);
  const files = lines.map((l) => ({ x: l[0], y: l[1], path: l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '') })).filter((f) => !f.path.startsWith('.rime/'));
  return { branch, ahead, behind, files };
}

type Row = { kind: 'file' | 'hunk' | 'line'; file: FileDiff; hunk?: Hunk; text: string; line?: number };

export function changesView(kit: Kit & { diff(): string; git(): boolean; undone(file: string, line: number, lines: string[]): void; toChat(): void; commitByRime(): void }) {
  const { st } = kit;
  const kept = new Set<string>(); // hunks you kept: they leave the list until they change again
  const c = cursor();
  let files: FileDiff[] = [];
  let rows: Row[] = [];
  let status: Status | null = null;
  let message: ReturnType<typeof lineInput> | null = null;
  let shownRows = 10;

  const git = (args: string[], input?: string) => spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: kit.root, encoding: 'utf8', env: kit.env(), input, maxBuffer: 64e6 });

  function build() {
    rows = [];
    for (const f of files) {
      const hs = f.hunks.filter((h) => !kept.has(h.key));
      if (!hs.length && !f.binary) continue;
      const add = hs.reduce((n, h) => n + h.lines.filter((l) => l.startsWith('+')).length, 0);
      const del = hs.reduce((n, h) => n + h.lines.filter((l) => l.startsWith('-')).length, 0);
      rows.push({ kind: 'file', file: f, hunk: hs[0], text: f.binary ? 'binary' : `+${add} −${del}` });
      for (const h of hs) {
        rows.push({ kind: 'hunk', file: f, hunk: h, text: h.head.replace(/^(@@[^@]*@@).*$/, '$1') });
        let n = h.start;
        for (const l of h.lines) {
          rows.push({ kind: 'line', file: f, hunk: h, text: l, line: n });
          if (!l.startsWith('-') && !l.startsWith('\\')) n++;
        }
      }
    }
  }
  function refresh() {
    try {
      files = parseDiff(kit.diff());
    } catch {
      files = [];
    }
    // Kept hunks that no longer exist are forgotten.
    const live = new Set(files.flatMap((f) => f.hunks.map((h) => h.key)));
    for (const k of kept) if (!live.has(k)) kept.delete(k);
    build();
    const s = kit.git() ? git(['status', '--porcelain=v1', '-b', '--untracked-files=all']) : null;
    status = s?.status === 0 ? parseStatus(s.stdout) : null;
    kit.redraw();
  }
  const pending = () => new Set(rows.map((r) => r.file.path)).size;
  const here = () => rows[c.at];
  // The hunk under the cursor (a file row means its first hunk).
  const hunkAt = () => here()?.hunk;
  function jump(d: 1 | -1) {
    const h = hunkAt();
    for (let i = c.at + d; i >= 0 && i < rows.length; i += d) if (rows[i].kind === 'hunk' && rows[i].hunk !== h) return void (c.at = i);
  }
  function undo() {
    const r = here(), h = r?.hunk;
    if (!r || !h) return;
    if (!kit.git()) return kit.toast('u needs a git repository here · /undo puts back the whole last change');
    const patch = [...r.file.header, h.head, ...h.lines, ''].join('\n');
    const p = spawnSync('git', ['apply', '-R', '--whitespace=nowarn', '-'], { cwd: kit.root, input: patch, encoding: 'utf8', env: kit.env() });
    if (p.status !== 0) return kit.toast(`couldn't undo it: ${(p.stderr || 'the file changed').trim().split('\n')[0]}`);
    kit.undone(r.file.path, h.start, h.lines);
    kit.toast(`undid a change in ${r.file.path}`);
    refresh();
  }
  // Every change in the work tree goes in the commit (not Rime's own .rime/).
  function commit(msg: string) {
    if (!status?.files.length) return kit.toast('nothing to commit');
    const a = git(['add', '-A', '--', '.', ':(exclude).rime']);
    if (a.status !== 0) return kit.toast(`couldn't stage: ${(a.stderr || '').trim().split('\n')[0]}`);
    if (!msg) return kit.commitByRime();
    const r = git(['commit', '-q', '-F', '-'], msg);
    if (r.status !== 0) return kit.toast(`commit failed: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
    kit.toast('committed');
    refresh();
  }

  const letter = (f: GitFile) => (f.x === '?' ? 'U' : f.x !== ' ' ? f.x : f.y);
  // ⎇ main ↑1 · 3 files changed
  function branchLine(): Line | null {
    if (!status) return null;
    const n = status.files.length;
    const far = `${status.ahead ? ` ↑${status.ahead}` : ''}${status.behind ? ` ↓${status.behind}` : ''}`;
    return [{ t: '⎇ ', s: st.accent }, { t: status.branch, s: st.titleB }, { t: `${far} · ${n ? `${n} file${n === 1 ? '' : 's'} changed` : 'clean'}`, s: st.dim }];
  }

  const view: View = {
    id: 'changes',
    title: 'changes',
    badge() {
      const n = pending();
      return n ? { t: ` ${n}`, s: st.warn } : null;
    },
    typing: () => !!message,
    shown: refresh,
    render(_w, r) {
      const head = branchLine();
      const top: Line[] = head ? [head, []] : [];
      const input: Line[] = message ? [[], message.line([{ t: `commit ${status?.files.length ?? 0} › `, s: st.accentB }], 'a message, or empty and Rime writes one', st)] : [];
      const room = Math.max(1, r - top.length - input.length);
      shownRows = room;
      if (!rows.length) {
        // Nothing of Rime's to review: what isn't committed yet, so c has no surprises.
        const loose = status?.files ?? [];
        const empty: Line[] = [
          [{ t: files.length ? 'Everything Rime changed is reviewed.' : 'Nothing from Rime yet.', s: st.dim }],
          [{ t: 'Its edits land here, hunk by hunk.', s: st.dim }],
          ...(loose.length ? [[], [{ t: 'not committed', s: st.dim }] as Line, ...loose.slice(0, Math.max(1, room - 4)).map((f): Line => [{ t: `  ${letter(f)} `, s: f.x === '?' || f.x === 'A' ? st.ok : f.y === 'D' || f.x === 'D' ? st.del : st.warn }, { t: f.path, s: st.fg }])] : []),
        ];
        return [...top, ...empty, ...new Array(Math.max(0, room - empty.length)).fill([]), ...input];
      }
      c.clamp(rows.length, room);
      const h = hunkAt();
      const body = rows.slice(c.top, c.top + room).map((x, i): Line => {
        const on = c.top + i === c.at, mine = x.hunk === h && x.kind !== 'file';
        const bar = { t: on ? '› ' : mine ? '▎ ' : '  ', s: st.accent };
        const bg = on ? st.panelBg : '';
        if (x.kind === 'file') return [bar, { t: '± ', s: st.accent + bg }, { t: x.file.path, s: st.titleB + bg }, { t: `  ${x.text}`, s: st.dim + bg }];
        if (x.kind === 'hunk') return [bar, { t: x.text, s: st.accent + bg }];
        const num = x.text.startsWith('-') ? '    ' : String(x.line).padStart(4);
        return [bar, { t: `${num} `, s: st.dim + bg }, { t: x.text.replace(/\t/g, '  '), s: diffStyle(x.text, st) + bg }];
      });
      return [...top, ...body, ...new Array(Math.max(0, room - body.length)).fill([]), ...input];
    },
    foot(): Hint[] {
      if (message) return [['enter', ' commit · '], ['esc', ' cancel']];
      const commitKey: Hint[] = status?.files.length ? [['c', ' commit']] : [];
      if (!rows.length) return commitKey;
      return [['y', ' keep · '], ['u', ' undo · '], ['enter', ' ask about this line · '], ['n p', ' next, previous hunk · '], ['a', ' keep all' + (commitKey.length ? ' · ' : '')], ...commitKey];
    },
    key(k: Key) {
      const ch = char(k);
      if (message) {
        if (k.name === 'escape') return (message = null), true;
        if (k.name === 'enter') {
          const m = message.value.trim();
          message = null;
          commit(m);
          return true;
        }
        message.edit(k);
        return true;
      }
      if (k.name === 'escape') return 'back';
      if (ch === 'c') return status?.files.length ? (message = lineInput()) : kit.toast(status ? 'nothing to commit' : 'not a git repository'), true;
      if (c.move(k, rows.length, Math.max(1, shownRows - 2))) return true;
      const r = here();
      if (ch === 'n') return jump(1), true;
      if (ch === 'p') return jump(-1), true;
      if (!r) return true;
      if (ch === 'y' && r.hunk) {
        kept.add(r.hunk.key);
        build();
        return true;
      }
      if (ch === 'a') {
        for (const f of files) for (const h of f.hunks) kept.add(h.key);
        build();
        kit.toast('kept every change');
        return true;
      }
      if (ch === 'u') return undo(), true;
      const line = r.line ?? r.hunk?.start ?? 1;
      if (k.name === 'enter' || ch === '@') {
        kit.mention(r.file.path, [line, line]);
        if (k.name === 'enter') kit.toChat();
        return true;
      }
      if (ch === 'o') return kit.openFile(r.file.path, line), true;
      return true;
    },
    click(r) {
      const at = c.top + r - (status ? 2 : 0);
      if (at >= 0 && at < rows.length) c.at = at;
    },
    wheel(d) {
      c.at = Math.max(0, Math.min(rows.length - 1, c.at + d));
    },
    read() {
      const b = status ? `On ${status.branch}${status.ahead ? `, ${status.ahead} ahead` : ''}${status.behind ? `, ${status.behind} behind` : ''}; ${status.files.length ? status.files.map((f) => `${f.x}${f.y} ${f.path}`).join(', ') : 'clean'}.\n` : '';
      if (!rows.length) return `${b}No changes waiting for review.`;
      return `${b}${pending()} file(s) with changes the user hasn't reviewed: ${[...new Set(rows.map((r) => r.file.path))].join(', ')}`;
    },
  };
  return extend(view, {
    refresh,
    get pending() {
      return pending();
    },
    get status() {
      return status;
    },
  });
}
export type ChangesView = ReturnType<typeof changesView>;
