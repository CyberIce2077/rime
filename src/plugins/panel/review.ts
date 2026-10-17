// The review view: Rime's changes since this window opened, live, hunk by hunk.
// y keeps a hunk (it leaves the list), u undoes it in the file, enter puts the
// line in the chat prompt so you can say what to change about it.

import { spawnSync } from 'node:child_process';
import { type Key, type Line } from '../../core/term.ts';
import { type Hint } from '../../core/view.ts';
import { type Kit, type View, char, cursor, diffStyle, extend } from './kit.ts';

export type Hunk = { head: string; lines: string[]; start: number; key: string };
export type FileDiff = { path: string; header: string[]; hunks: Hunk[]; binary: boolean };

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

type Row = { kind: 'file' | 'hunk' | 'line'; file: FileDiff; hunk?: Hunk; text: string; line?: number };

export function reviewView(kit: Kit & { diff(): string; git(): boolean; undone(file: string, line: number, lines: string[]): void; toChat(): void }) {
  const { st } = kit;
  const kept = new Set<string>(); // hunks you kept: they leave the list until they change again
  const c = cursor();
  let files: FileDiff[] = [];
  let rows: Row[] = [];
  let shownRows = 10;

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

  const view: View = {
    id: 'review',
    title: 'review',
    badge() {
      const n = pending();
      return n ? { t: ` ${n}`, s: st.warn } : null;
    },
    shown: refresh,
    render(_w, r) {
      shownRows = r;
      if (!rows.length)
        return [[{ t: files.length ? 'Everything is reviewed.' : 'No changes yet.', s: st.dim }], [], [{ t: "Rime's edits show here, hunk by hunk.", s: st.dim }], [{ t: 'y keeps one, u undoes it, enter asks about a line.', s: st.dim }]];
      c.clamp(rows.length, r);
      const h = hunkAt();
      return rows.slice(c.top, c.top + r).map((x, i): Line => {
        const on = c.top + i === c.at, mine = x.hunk === h && x.kind !== 'file';
        const bar = { t: on ? '› ' : mine ? '▎ ' : '  ', s: st.accent };
        const bg = on ? st.panelBg : '';
        if (x.kind === 'file') return [bar, { t: '± ', s: st.accent + bg }, { t: x.file.path, s: st.titleB + bg }, { t: `  ${x.text}`, s: st.dim + bg }];
        if (x.kind === 'hunk') return [bar, { t: x.text, s: st.accent + bg }];
        const num = x.text.startsWith('-') ? '    ' : String(x.line).padStart(4);
        return [bar, { t: `${num} `, s: st.dim + bg }, { t: x.text.replace(/\t/g, '  '), s: diffStyle(x.text, st) + bg }];
      });
    },
    foot(): Hint[] {
      if (!rows.length) return [];
      return [['y', ' keep · '], ['u', ' undo · '], ['enter', ' ask about this line · '], ['← →', ' hunks · '], ['a', ' keep all']];
    },
    key(k: Key) {
      const ch = char(k);
      if (k.name === 'escape') return 'back';
      if (c.move(k, rows.length, Math.max(1, shownRows - 2))) return true;
      if (k.name === 'right') return jump(1), true;
      if (k.name === 'left') return jump(-1), true;
      const r = here();
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
      c.at = c.top + r;
    },
    wheel(d) {
      c.at = Math.max(0, Math.min(rows.length - 1, c.at + d));
    },
    read() {
      if (!rows.length) return 'No changes waiting for review.';
      return `${pending()} file(s) with changes the user hasn't reviewed: ${[...new Set(rows.map((r) => r.file.path))].join(', ')}`;
    },
  };
  return extend(view, { refresh, get pending() { return pending(); } });
}
export type ReviewView = ReturnType<typeof reviewView>;
