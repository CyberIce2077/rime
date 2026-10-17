// The files view: the project as a tree, / to search names (tab: the text inside
// files), and a read-only viewer that enter opens at a line. @ puts a file (or
// the lines on screen) in the chat prompt.

import fs from 'node:fs';
import path from 'node:path';
import { type Key, type Line, lineWidth } from '../../core/term.ts';
import { type Hint } from '../../core/view.ts';
import { type Kit, type View, char, cursor, extend, highlight, lineInput } from './kit.ts';
import { type TextHit, grep, nameHits } from './search.ts';

type Hit = { path: string; line?: number; text?: string; idx?: number[] };
type Viewer = { path: string; raw: string[]; scroll: number; mark?: number; find?: string; at?: number };

export function filesView(kit: Kit & { files(): string[]; recent?(): string[] }) {
  const { st } = kit;
  const open = new Set<string>(); // folders open in the tree
  const tree = cursor();
  let search: { mode: 'name' | 'text'; input: ReturnType<typeof lineInput>; editing: boolean; sel: number } | null = null;
  let viewer: Viewer | null = null;
  let find: ReturnType<typeof lineInput> | null = null; // / in the viewer
  let rows = 10;
  let grepCache = { q: '', hits: [] as TextHit[] };
  let hitRows: number[] = []; // search hits by content row, for clicks

  function treeRows(): { path: string; dir: boolean; depth: number }[] {
    const out: { path: string; dir: boolean; depth: number }[] = [];
    const seen = new Set<string>();
    for (const f of kit.files()) {
      const parts = f.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join('/'), dir = i < parts.length;
        if (seen.has(p)) continue;
        // Shown only when every folder above it is open.
        if (!parts.slice(0, i - 1).every((_, j) => open.has(parts.slice(0, j + 1).join('/')))) break;
        seen.add(p);
        out.push({ path: p, dir, depth: i - 1 });
      }
    }
    // Folders first within each folder, by name.
    const key = (r: { path: string; dir: boolean }) => r.path.split('/').map((s, i, a) => (i < a.length - 1 || r.dir ? '0' : '1') + s).join('/');
    return out.sort((a, b) => key(a).localeCompare(key(b)));
  }
  function hits(): Hit[] {
    const q = search?.input.value ?? '';
    if (!q) return [];
    if (search!.mode === 'name') return nameHits(q, kit.files(), kit.recent?.() ?? []);
    if (grepCache.q !== q) grepCache = { q, hits: grep(kit.root, q, kit.files()) };
    return grepCache.hits;
  }
  function read(rel: string): string[] | null {
    try {
      return fs.readFileSync(path.join(kit.root, rel), 'utf8').split('\n').slice(0, 20000);
    } catch {
      return null;
    }
  }
  const dim = (t: string) => ({ t, s: st.dim });

  function renderViewer(v: Viewer, w: number): Line[] {
    const room = rows - 1 - (find ? 1 : 0);
    v.scroll = Math.max(0, Math.min(v.scroll, Math.max(0, v.raw.length - room)));
    const nw = String(v.raw.length).length;
    const head: Line = [{ t: '≡ ', s: st.accent }, { t: v.path, s: st.titleB }, dim(v.mark ? `:${v.mark}` : '')];
    const body = v.raw.slice(v.scroll, v.scroll + room).map((l, i): Line => {
      const n = v.scroll + i;
      const line = highlight([dim(`${String(n + 1).padStart(nw)}  `), { t: l.replace(/\t/g, '  '), s: st.fg }], v.find, st);
      return (v.mark && n + 1 === v.mark) || (v.find && n === v.at) ? line.map((r) => ({ t: r.t, s: st.panelBg + r.s })) : line;
    });
    void w;
    return [head, ...body, ...new Array(Math.max(0, room - body.length)).fill([]), ...(find ? [find.line([{ t: '/', s: st.accentB }], 'find in this file', st)] : [])];
  }

  function renderSearch(w: number): Line[] {
    const s = search!, hs = hits(), q = s.input.value;
    s.sel = Math.max(0, Math.min(s.sel, hs.length - 1));
    const mode: Line = [{ t: ' names ', s: s.mode === 'name' ? st.accent + st.panelBg : st.dim }, { t: ' text ', s: s.mode === 'text' ? st.accent + st.panelBg : st.dim }];
    const count = q ? `  ${hs.length}${hs.length >= 200 ? '+' : ''} match${hs.length === 1 ? '' : 'es'}` : '';
    const head = s.editing ? s.input.line([{ t: '/ ', s: st.accentB }], s.mode === 'name' ? 'file names' : 'text in files', st) : [{ t: '/ ', s: st.accent }, { t: q, s: st.title }];
    const bar: Line = [...head, dim(count), { t: ' '.repeat(Math.max(1, w - lineWidth(head) - count.length - lineWidth(mode))), s: '' }, ...mode];
    if (!q) return [bar, [], [dim('Type to search file names. tab searches the text inside files.')]];
    if (!hs.length) return [bar, [], [dim(`Nothing matches "${q}".${s.mode === 'name' ? ' tab searches inside files.' : ''}`)]];
    // Text hits grouped by file, with line numbers; the selected one stays in view.
    const lines: { line: Line; hit?: number }[] = [];
    let last = '';
    hs.forEach((x, i) => {
      const on = i === s.sel;
      if (s.mode === 'name') {
        const dir = x.path.lastIndexOf('/') + 1;
        const name: Line = [...x.path].map((ch, j) => ({ t: ch, s: x.idx!.includes(j) ? st.accentB : j < dir ? st.dim : on ? st.title : st.fg }));
        return void lines.push({ line: [{ t: on ? '› ' : '  ', s: st.accent }, ...name], hit: i });
      }
      if (x.path !== last) lines.push({ line: [dim(x.path)] }), (last = x.path);
      lines.push({ line: [{ t: on ? '› ' : '  ', s: st.accent }, dim(String(x.line).padStart(5) + ' '), ...highlight([{ t: x.text!.trim(), s: on ? st.title : st.fg }], q, st)], hit: i });
    });
    const room = rows - 1;
    const at = lines.findIndex((l) => l.hit === s.sel);
    const from = Math.max(0, Math.min(at - Math.floor(room / 2), lines.length - room));
    hitRows = [-1, ...lines.slice(from, from + room).map((l) => l.hit ?? -1)];
    return [bar, ...lines.slice(from, from + room).map((l) => l.line)];
  }

  function findNext(v: Viewer, from: number, d = 1) {
    const q = v.find?.toLowerCase() ?? '';
    const ms = q ? v.raw.flatMap((l, i) => (l.toLowerCase().includes(q) ? [i] : [])) : [];
    if (!ms.length) return void (q && kit.toast(`no "${v.find}" here`));
    const i = d > 0 ? ms.find((m) => m >= from) ?? ms[0] : [...ms].reverse().find((m) => m <= from) ?? ms.at(-1)!;
    v.at = i;
    v.scroll = Math.max(0, i - 3);
  }

  const view: View = {
    id: 'files',
    title: 'files',
    badge: () => null,
    typing: () => !!find || !!search?.editing,
    shown() {
      grepCache = { q: '', hits: [] }; // files may have changed
    },
    render(w, r) {
      rows = r;
      hitRows = [];
      if (viewer) return renderViewer(viewer, w);
      if (search && (search.input.value || search.editing)) return renderSearch(w);
      const rs = treeRows();
      tree.clamp(rs.length, rows);
      if (!rs.length) return [[dim('No files here.')]];
      return rs.slice(tree.top, tree.top + rows).map((x, i): Line => {
        const on = tree.top + i === tree.at;
        const name = x.path.split('/').pop()!;
        return [{ t: on ? '› ' : '  ', s: st.accent }, { t: '  '.repeat(x.depth), s: '' }, ...(x.dir ? [{ t: open.has(x.path) ? '▾ ' : '▸ ', s: st.accent }, { t: name + '/', s: on ? st.accentB : st.title }] : [{ t: name, s: on ? st.accentB : st.fg }])];
      });
    },
    foot(): Hint[] {
      if (find) return [['enter', ' next · '], ['↑', ' previous · '], ['esc', ' done']];
      if (viewer) return [['↑ ↓', ' scroll · '], ['/', ' find · '], ['@', ' to the chat · '], ['esc', ' back']];
      if (search?.editing) return [['tab', search.mode === 'text' ? ' names · ' : ' text in files · '], ['↑ ↓', ' choose · '], ['enter', ' open · '], ['esc', ' clear']];
      if (search?.input.value) return [['↑ ↓', ' choose · '], ['enter', ' open · '], ['@', ' to the chat · '], ['/', ' edit · '], ['esc', ' clear']];
      return [['↑ ↓', ' move · '], ['enter', ' open or fold · '], ['/', ' search · '], ['@', ' to the chat']];
    },
    key(k: Key) {
      const c = char(k);
      if (viewer) {
        const v = viewer;
        if (find) {
          if (k.name === 'escape') return (find = null), (v.find = undefined), true;
          if (k.name === 'enter' || k.name === 'down') return findNext(v, (v.at ?? v.scroll) + 1), true;
          if (k.name === 'up') return findNext(v, (v.at ?? v.scroll) - 1, -1), true;
          if (find.edit(k)) (v.find = find.value || undefined), (v.at = undefined), findNext(v, v.scroll);
          return true;
        }
        const page = Math.max(1, rows - 3);
        if (k.name === 'escape') return v.find ? ((v.find = undefined), true) : ((viewer = null), true);
        if (k.name === 'down') v.scroll++;
        else if (k.name === 'up') v.scroll = Math.max(0, v.scroll - 1);
        else if (k.ctrl && k.name === 'd') v.scroll += page;
        else if (k.ctrl && k.name === 'u') v.scroll = Math.max(0, v.scroll - page);
        else if (c === '/') find = lineInput(v.find ?? '');
        else if (c === '@') kit.mention(v.path, [v.scroll + 1, Math.min(v.raw.length, v.scroll + rows - 1)]);
        return true;
      }
      if (search) {
        const s = search, hs = hits(), x = hs[s.sel];
        if (k.name === 'escape') {
          // esc clears the search; a second esc leaves it.
          if (s.input.value && s.editing) return (s.input.value = ''), (s.sel = 0), true;
          return (search = null), true;
        }
        if (k.name === 'down') return (s.sel = Math.min(hs.length - 1, s.sel + 1)), true;
        if (k.name === 'up') return (s.sel = Math.max(0, s.sel - 1)), true;
        if (k.name === 'enter') return x && api.openFile(x.path, x.line), true;
        if (s.editing) {
          if (k.name === 'tab') return (s.mode = s.mode === 'name' ? 'text' : 'name'), (s.sel = 0), true;
          if (s.input.edit(k)) s.sel = 0;
          return true;
        }
        if (c === '@' && x) return kit.mention(x.path, x.line ? [x.line, x.line] : undefined), true;
        if (c === '/') return (s.editing = true), true;
        return true;
      }
      const rs = treeRows(), r = rs[tree.at];
      if (k.name === 'escape') return 'back';
      if (c === '/') return (search = { mode: 'name', input: lineInput(), editing: true, sel: 0 }), true;
      if (tree.move(k, rs.length, Math.max(1, rows - 2))) return true;
      if (!r) return true;
      if (c === '@') return kit.mention(r.dir ? r.path + '/' : r.path), true;
      if (k.name === 'enter') {
        if (r.dir) open.has(r.path) ? open.delete(r.path) : open.add(r.path);
        else api.openFile(r.path);
        return true;
      }
      return true;
    },
    click(r) {
      if (viewer) return;
      if (search) {
        const n = hitRows[r];
        const x = n !== undefined && n >= 0 ? hits()[n] : undefined;
        if (x) api.openFile(x.path, x.line);
        return;
      }
      tree.at = tree.top + r;
      view.key({ name: 'enter' });
    },
    wheel(d) {
      if (viewer) viewer.scroll = Math.max(0, viewer.scroll + d);
      else if (search) search.sel = Math.max(0, search.sel + d);
      else tree.at = Math.max(0, tree.at + d);
    },
    read() {
      return viewer ? `${viewer.path}, lines ${viewer.scroll + 1}-${viewer.scroll + rows}` : search?.input.value ? `Searching ${search.mode === 'name' ? 'file names' : 'text'} for "${search.input.value}": ${hits().length} matches` : `${kit.files().length} files`;
    },
  };

  const api = {
    // A file in the viewer at a line (false when it can't be read).
    openFile(rel: string, line?: number) {
      const raw = read(rel);
      if (!raw) return false;
      viewer = { path: rel, raw, scroll: line ? Math.max(0, line - 6) : 0, mark: line };
      find = null;
      kit.redraw();
      return true;
    },
    // Opens searching (from the chat: "search the files for validate").
    search(mode: 'name' | 'text', q: string) {
      viewer = null;
      search = { mode, input: lineInput(q), editing: false, sel: 0 };
      kit.redraw();
    },
    tree() {
      viewer = null;
      search = null;
    },
    get viewing() {
      return viewer?.path;
    },
  };
  return extend(view, api);
}
export type FilesView = ReturnType<typeof filesView>;
