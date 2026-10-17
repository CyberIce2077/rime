// The git view: the branch, staged and unstaged files, and recent commits.
// s stages or unstages a file, enter shows its diff, c commits: type a message,
// or leave it empty and Rime writes one.

import { spawnSync } from 'node:child_process';
import { type Key, type Line } from '../../core/term.ts';
import { type Hint } from '../../core/view.ts';
import { type Kit, type View, char, cursor, diffStyle, extend, lineInput, row } from './kit.ts';

export type GitFile = { path: string; x: string; y: string }; // porcelain status letters: index, work tree
export type Status = { branch: string; ahead: number; behind: number; files: GitFile[]; log: { hash: string; subject: string }[] } | null;

// `git status --porcelain=v1 -b` and `git log --oneline` as one object; null
// outside a repository.
export function parseStatus(status: string, log: string): NonNullable<Status> {
  const lines = status.split('\n').filter(Boolean);
  const head = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3) : '';
  const branch = head.replace(/^No commits yet on /, '').split('...')[0].trim() || 'HEAD';
  const ahead = +(/ahead (\d+)/.exec(head)?.[1] ?? 0), behind = +(/behind (\d+)/.exec(head)?.[1] ?? 0);
  const files = lines.map((l) => ({ x: l[0], y: l[1], path: l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '') })).filter((f) => !f.path.startsWith('.rime/'));
  const commits = log.split('\n').filter(Boolean).map((l) => ({ hash: l.slice(0, l.indexOf(' ')), subject: l.slice(l.indexOf(' ') + 1) }));
  return { branch, ahead, behind, files, log: commits };
}

export function gitView(kit: Kit & { commitByRime(): void }) {
  const { st } = kit;
  let status: Status = null;
  let shownDiff: { title: string; lines: string[]; scroll: number } | null = null;
  let message: ReturnType<typeof lineInput> | null = null;
  const c = cursor();
  let shownRows = 10;

  // Read-only git, hardened like Rime's own read-only commands.
  const git = (args: string[], input?: string) => spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: kit.root, encoding: 'utf8', env: kit.env(), input, maxBuffer: 64e6 });
  function refresh() {
    const s = git(['status', '--porcelain=v1', '-b', '--untracked-files=all']);
    if (s.status !== 0) return void (status = null);
    const l = git(['log', '--oneline', '-n', '8']);
    status = parseStatus(s.stdout, l.status === 0 ? l.stdout : '');
  }

  type Row = { kind: 'staged' | 'changed' | 'commit' | 'label'; file?: GitFile; commit?: { hash: string; subject: string }; text?: string };
  function rowsOf(): Row[] {
    if (!status) return [];
    const staged = status.files.filter((f) => f.x !== ' ' && f.x !== '?');
    const changed = status.files.filter((f) => f.y !== ' ' || f.x === '?');
    return [
      ...(staged.length ? [{ kind: 'label', text: 'staged' } as Row, ...staged.map((f): Row => ({ kind: 'staged', file: f }))] : []),
      ...(changed.length ? [{ kind: 'label', text: 'changes' } as Row, ...changed.map((f): Row => ({ kind: 'changed', file: f }))] : []),
      ...(status.log.length ? [{ kind: 'label', text: 'recent commits' } as Row, ...status.log.map((x): Row => ({ kind: 'commit', commit: x }))] : []),
    ];
  }
  const letter = (f: GitFile, staged: boolean) => {
    const l = staged ? f.x : f.x === '?' ? '?' : f.y;
    return { t: `${{ M: 'M', A: 'A', D: 'D', R: 'R', '?': 'U', C: 'C', U: '!' }[l] ?? l} `, s: l === 'D' ? st.del : l === '?' || l === 'A' ? st.ok : st.warn };
  };
  function commit(msg: string) {
    if (!status?.files.some((f) => f.x !== ' ' && f.x !== '?')) return kit.toast('nothing is staged · s stages a file');
    const r = git(['commit', '-q', '-F', '-'], msg);
    if (r.status !== 0) return kit.toast(`commit failed: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
    kit.toast('committed');
    refresh();
  }

  const view: View = {
    id: 'git',
    title: 'git',
    badge() {
      const n = status?.files.length ?? 0;
      return n ? { t: ` ${n}`, s: st.warn } : null;
    },
    typing: () => !!message,
    shown: refresh,
    render(w, rows) {
      shownRows = rows;
      if (!status) return [[{ t: 'Not a git repository.', s: st.dim }]];
      if (shownDiff) {
        const d = shownDiff;
        d.scroll = Math.max(0, Math.min(d.scroll, Math.max(0, d.lines.length - rows + 1)));
        return [[{ t: d.title, s: st.titleB }], ...d.lines.slice(d.scroll, d.scroll + rows - 1).map((l): Line => [{ t: l, s: diffStyle(l, st) }])];
      }
      const head: Line = [{ t: '⎇ ', s: st.accent }, { t: status.branch, s: st.titleB }, { t: `${status.ahead ? `  ↑${status.ahead}` : ''}${status.behind ? `  ↓${status.behind}` : ''}${status.files.length ? '' : '  clean'}`, s: st.dim }];
      const rs = rowsOf();
      const room = rows - 1 - (message ? 2 : 0);
      c.clamp(rs.length, room);
      if (rs[c.at]?.kind === 'label') c.at = Math.min(rs.length - 1, c.at + 1);
      const body = rs.slice(c.top, c.top + room).map((r, i): Line => {
        const on = c.top + i === c.at;
        if (r.kind === 'label') return [{ t: r.text!, s: st.dim }];
        if (r.commit) return row(on, [{ t: r.commit.hash, s: st.accent }, { t: ` ${r.commit.subject}`, s: st.fg }], [], w, st);
        return row(on, [letter(r.file!, r.kind === 'staged'), { t: r.file!.path, s: st.fg }], [], w, st);
      });
      return [head, ...body, ...(message ? [...new Array(Math.max(0, room - body.length)).fill([]), [], message.line([{ t: 'commit › ', s: st.accentB }], 'a message, or empty and Rime writes one', st)] : [])];
    },
    foot(): Hint[] {
      if (!status) return [];
      if (message) return [['enter', ' commit · '], ['esc', ' cancel']];
      if (shownDiff) return [['↑ ↓', ' scroll · '], ['esc', ' back']];
      const r = rowsOf()[c.at];
      return [...(r?.file ? [['s', r.kind === 'staged' ? ' unstage · ' : ' stage · '] as Hint] : []), ['enter', ' diff · '], ['c', ' commit · '], ['r', ' refresh']];
    },
    key(k: Key) {
      const ch = char(k);
      if (message) {
        if (k.name === 'escape') return (message = null), true;
        if (k.name === 'enter') {
          const m = message.value.trim();
          message = null;
          if (m) commit(m);
          else if (!status?.files.some((f) => f.x !== ' ' && f.x !== '?')) kit.toast('nothing is staged · s stages a file');
          else kit.commitByRime();
          return true;
        }
        message.edit(k);
        return true;
      }
      if (shownDiff) {
        if (k.name === 'escape') return (shownDiff = null), true;
        const page = Math.max(1, shownRows - 3);
        if (k.name === 'down') shownDiff.scroll++;
        else if (k.name === 'up') shownDiff.scroll = Math.max(0, shownDiff.scroll - 1);
        else if (k.ctrl && k.name === 'd') shownDiff.scroll += page;
        else if (k.ctrl && k.name === 'u') shownDiff.scroll = Math.max(0, shownDiff.scroll - page);
        return true;
      }
      if (k.name === 'escape') return 'back';
      if (!status) return true;
      if (ch === 'r') return refresh(), true;
      if (ch === 'c') return (message = lineInput()), true;
      const rs = rowsOf();
      if (c.move(k, rs.length, Math.max(1, shownRows - 3))) {
        // Labels are skipped in the direction you move.
        while (rs[c.at]?.kind === 'label' && c.at < rs.length - 1 && k.name !== 'up') c.at++;
        while (rs[c.at]?.kind === 'label' && c.at > 0 && k.name === 'up') c.at--;
        return true;
      }
      const r = rs[c.at];
      if (!r) return true;
      if (ch === 's' && r.file) {
        const res = r.kind === 'staged' ? git(['restore', '--staged', '--', r.file.path]) : git(['add', '--', r.file.path]);
        if (res.status !== 0) kit.toast((res.stderr || '').trim().split('\n')[0] || 'git failed');
        refresh();
        return true;
      }
      if (k.name === 'enter') {
        const d = r.commit ? git(['show', '--stat', '--patch', '--no-color', r.commit.hash]) : r.kind === 'staged' ? git(['diff', '--cached', '--no-color', '--', r.file!.path]) : r.file!.x === '?' ? git(['diff', '--no-color', '--no-index', '--', '/dev/null', r.file!.path]) : git(['diff', '--no-color', '--', r.file!.path]);
        shownDiff = { title: r.commit ? `${r.commit.hash} ${r.commit.subject}` : r.file!.path, lines: d.stdout.split('\n'), scroll: 0 };
        return true;
      }
      if (ch === '@' && r.file) return kit.mention(r.file.path), true;
      return true;
    },
    click(r) {
      c.at = c.top + r - 1;
    },
    wheel(d) {
      if (shownDiff) shownDiff.scroll = Math.max(0, shownDiff.scroll + d);
      else c.at = Math.max(0, c.at + d);
    },
    read() {
      refresh();
      if (!status) return 'Not a git repository.';
      return `On ${status.branch}${status.ahead ? `, ${status.ahead} ahead` : ''}${status.behind ? `, ${status.behind} behind` : ''}. ${status.files.length ? status.files.map((f) => `${f.x}${f.y} ${f.path}`).join(', ') : 'Clean.'}`;
    },
  };
  return extend(view, { refresh, get status() { return status; } });
}
export type GitView = ReturnType<typeof gitView>;
