// The panel beside the chat (split view): eight views in an order that only
// changes when you drag a tab, so a number always means the same thing. ctrl+g
// moves the keys between the chat and the panel. In the panel: ← → or tab move
// between views, 1-8 jump to one, ↑ ↓ and enter work inside it, esc steps back
// (and finally to the chat), z zooms, q closes, ? lists the keys. Each view adds at most a
// few letters of its own, shown in the footer.

import { type Key, type Line, fit, lineWidth } from '../../core/term.ts';
import { type Hint, type Styles, hintLines, str } from '../../core/view.ts';
import { type View, char } from './kit.ts';

export type Hit = { row: number; x0: number; x1: number; id: string };

export function createPanel(st: Styles, all: View[], redraw: () => void, o: { order?: string[]; reordered?(ids: string[]): void } = {}) {
  // Your order first (views it doesn't name keep theirs, after it).
  const views = [...all].sort((a, b) => rank(a.id) - rank(b.id));
  function rank(id: string) {
    const i = o.order?.indexOf(id) ?? -1;
    return i < 0 ? 100 + all.findIndex((v) => v.id === id) : i;
  }
  let active = 0;
  let visible = false;
  let zoomed = false;
  let sheet = false;
  let ratio = 0.45; // the panel's share of the width
  let toastMsg = '';
  let toastTimer: NodeJS.Timeout | undefined;
  let shown = { rows: 0, top: 3 }; // content rows of the last frame, and the row they start on

  const cur = () => views[active];
  const indexOf = (id: string) => views.findIndex((v) => v.id === id);

  // The tab bar: number and title, the active one highlighted, and each view's
  // badge. When they don't fit, the ✕ goes, then titles shorten to three letters,
  // then to the number; the active one always keeps its title.
  function tabBar(w: number, border: boolean, hits: Hit[], lead: number): Line {
    const label = (v: View, i: number, short: 0 | 1 | 2): Line => {
      const on = i === active, bg = on ? st.panelBg : '';
      const b = v.badge();
      const title = on || short === 0 ? v.title : short === 1 ? v.title.slice(0, 3) : '';
      return [
        { t: on ? ` ${i + 1}` : `${i + 1}`, s: (on ? st.accentB : st.dim) + bg },
        ...(title ? [{ t: ` ${title}`, s: (on ? st.titleB : st.dim) + bg }] : []),
        ...(b ? [{ t: b.t, s: b.s + bg }] : []),
        ...(on ? [{ t: ' ', s: bg }] : []),
      ];
    };
    const width = (ps: Line[]) => ps.reduce((n, p) => n + lineWidth(p), 0) + ps.length - 1;
    let parts: Line[] = [], close = false;
    for (const [short, x] of [[0, true], [0, false], [1, true], [1, false], [2, true]] as const) {
      parts = views.map((v, i) => label(v, i, short));
      close = border && x;
      if (width(parts) <= w - (close ? 2 : 0)) break;
    }
    const bar: Line = [];
    parts.forEach((p, i) => {
      const x0 = lineWidth(bar) + (i ? 1 : 0);
      if (x0 + lineWidth(p) > w - (close ? 2 : 0)) return;
      if (i) bar.push({ t: ' ', s: '' });
      hits.push({ row: 1, x0: lead + x0 + 1, x1: lead + x0 + lineWidth(p), id: `panel:view:${i}` });
      bar.push(...p);
    });
    if (close) hits.push({ row: 1, x0: lead + w, x1: lead + w, id: 'panel:hide' });
    return [...bar, { t: ' '.repeat(Math.max(0, w - lineWidth(bar) - (close ? 1 : 0))), s: '' }, ...(close ? [{ t: '✕', s: st.dim }] : [])];
  }

  // The ? sheet: this view's keys, then the panel's.
  const PANEL_KEYS: [string, string][] = [
    ['ctrl+g', 'back to the chat'],
    ['← →  tab', 'the next view, the one before'],
    ['1-8', 'jump to a view (drag a tab to reorder)'],
    ['↑ ↓  enter', 'move, open'],
    ['ctrl+u ctrl+d', 'page up, down'],
    ['esc', 'back one step, then the chat'],
    ['z', 'zoom the panel'],
    ['q', 'close the panel (ctrl+g opens it again)'],
    ['?', 'these keys'],
  ];
  function sheetLines(): Line[] {
    const r = ([k, x]: [string, string]): Line => [{ t: k.padEnd(15), s: st.accentB }, { t: x, s: st.fg }];
    const mine = cur().foot().filter(([k]) => k).map(([k, x]): [string, string] => [k, x.replace(/ · $/, '').trim()]);
    return [...(mine.length ? [[{ t: cur().title, s: st.titleB }] as Line, ...mine.map(r), []] : []), [{ t: 'panel', s: st.titleB }], ...PANEL_KEYS.map(r)];
  }

  // The panel as `height` rows of `width` cells, and where its clickable spots are
  // (1-based, relative to the panel).
  function render(width: number, height: number, focused: boolean, border = true): { lines: string[]; hits: Hit[] } {
    const hits: Hit[] = [];
    const b: Line = border ? [{ t: '│', s: focused ? st.accent : st.line }] : [];
    const lead = lineWidth(b) + 1;
    const w = width - lead;
    const v = cur();
    const bar = tabBar(w, border, hits, lead);
    const say: Hint[] = toastMsg ? [['', `${toastMsg} · `, st.ok]] : [];
    const foot: Hint[] = !focused ? [...say, ['ctrl+g', ' focus']] : sheet ? [['', 'any key closes this']] : v.typing?.() ? [...say, ...v.foot(), ['ctrl+g', ' chat']] : [...say, ...end(v.foot()), ['?', ' keys · '], ['q', ' close']];
    const fh = hintLines(foot, w, st);
    const rows = Math.max(1, height - 3 - fh.lines.length);
    shown = { rows, top: 3 };
    let content: Line[] = sheet ? sheetLines() : v.render(w, rows);
    content = [...content.slice(0, rows), ...new Array(Math.max(0, rows - content.length)).fill([])];
    if (!sheet) for (let i = 0; i < rows; i++) hits.push({ row: 3 + i, x0: lead + 1, x1: width, id: `panel:row:${i}` });
    const rule: Line = [{ t: '─'.repeat(w), s: st.line }];
    const dim = (l: Line): Line => (focused ? l : l.map((r) => ({ t: r.t, s: r.s + st.faint })));
    const lines: Line[] = [bar, rule, ...content.map(dim), rule, ...fh.lines];
    fh.segs.forEach((segs, i) => hits.push(...segs.map((s) => ({ row: 4 + rows + i, x0: s.x0 + lead, x1: s.x1 + lead, id: focused ? s.id : 'panel:focus' }))));
    return { lines: lines.slice(0, height).map((l) => str([...b, { t: ' ', s: '' }, ...fit(l, w)], st)), hits };
  }
  // A view's keys before the panel's: its last group has to end.
  const end = (h: Hint[]): Hint[] => h.map(([k, l, s], i) => [k, i === h.length - 1 && !l.endsWith(' · ') ? `${l} · ` : l, s]);

  // Keys while the panel has focus (ctrl+g never reaches here). 'blur' gives the
  // keys back to the chat.
  function key(k: Key): boolean | 'blur' {
    if (sheet) return (sheet = false), redraw(), true;
    const v = cur();
    if (!v.typing?.()) {
      const c = char(k);
      if (/^[1-9]$/.test(c) && views[+c - 1]) return api.go(+c - 1), true;
      const back = k.name === 'left' || (k.name === 'tab' && k.shift);
      if (k.name === 'tab' || k.name === 'left' || k.name === 'right') return api.go((active + (back ? views.length - 1 : 1)) % views.length), true;
      if (c === 'z') return (zoomed = !zoomed), redraw(), true;
      if (c === 'q') return api.show(false), 'blur';
      if (c === '?') return (sheet = true), redraw(), true;
    }
    const r = v.key(k);
    redraw();
    if (r === 'back') return 'blur';
    return true;
  }

  const api = {
    views,
    get active() {
      return cur().id;
    },
    get visible() {
      return visible;
    },
    get ratio() {
      return ratio;
    },
    get zoomed() {
      return zoomed && visible;
    },
    get rows() {
      return shown.rows;
    },
    view: <T extends View>(id: string) => views[indexOf(id)] as T,
    typing: () => visible && !!cur().typing?.(),
    show(on = !visible) {
      visible = on;
      if (!on) (zoomed = false), (sheet = false);
      redraw();
    },
    zoom(on: boolean) {
      zoomed = on;
      redraw();
    },
    // Dragging the divider: the panel's share of the width, a quarter to three quarters.
    setRatio(r: number) {
      ratio = Math.min(0.75, Math.max(0.25, r));
      redraw();
    },
    // A view by number or id; it shows the panel.
    go(i: number | string) {
      const n = typeof i === 'string' ? indexOf(i) : i;
      if (!views[n]) return false;
      active = n;
      visible = true;
      sheet = false;
      views[n].shown?.();
      redraw();
      return true;
    },
    // Dragging a tab onto another: it takes that place; the numbers follow.
    move(from: number, to: number) {
      if (from === to || !views[from] || !views[to]) return;
      const cur = views[active];
      views.splice(to, 0, ...views.splice(from, 1));
      active = views.indexOf(cur);
      o.reordered?.(views.map((v) => v.id));
      redraw();
    },
    toast(msg: string) {
      toastMsg = msg;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => ((toastMsg = ''), redraw()), 2500);
      redraw();
    },
    // Mouse: a view in the tab bar, a content row, the ✕.
    click(id: string) {
      if (id === 'panel:hide') return api.show(false);
      const m = /^panel:(view|row):(\d+)$/.exec(id);
      if (!m) return;
      if (m[1] === 'view') return void api.go(+m[2]);
      if (sheet) return void (sheet = false);
      cur().click?.(+m[2]);
      redraw();
    },
    wheel(d: number) {
      cur().wheel?.(d);
      redraw();
    },
    key,
    render,
  };
  return api;
}
export type Panel = ReturnType<typeof createPanel>;
