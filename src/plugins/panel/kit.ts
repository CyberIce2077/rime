// What the panel's views share: the View shape, a one-line input, a list with a
// cursor that stays in view, and diff colours.

import { type Key, type Line, type Run, fit, lineWidth } from '../../core/term.ts';
import { type Hint, type Styles } from '../../core/view.ts';

// One view of the panel (review, plan, checks, run, git, files, context, log).
// It draws `rows` content rows, takes the keys the panel doesn't use, and names
// its own keys for the footer. 'back' means esc had nothing left to close here,
// so the chat gets the keys again.
export interface View {
  id: string;
  title: string;
  badge(): Run | null; // after the title in the tab bar: ` 3`, ` ✗2`, ` ●`
  render(w: number, rows: number): Line[];
  key(k: Key): boolean | 'back';
  foot(): Hint[];
  typing?(): boolean; // every key goes to the view (an input line, a shell)
  click?(row: number): void; // a content row, 0-based
  wheel?(d: number): void;
  shown?(): void; // became the view on screen
  read?(n?: number): string; // its text for the model (rime panel.read)
}

// What every view can ask of the panel and the app.
export type Kit = {
  st: Styles;
  root: string;
  redraw(): void;
  toast(msg: string): void;
  mention(ref: string, lines?: [number, number]): void; // a chip in the chat prompt
  openFile(path: string, line?: number): boolean; // the files view's viewer
  env(): NodeJS.ProcessEnv;
};

export const char = (k: Key) => (k.name === 'char' && !k.ctrl && !k.alt ? k.ch ?? '' : '');

// A one-line input drawn by the view that owns it (a commit message, a step, a
// search). edit() takes the editing keys and says whether it used one.
export function lineInput(value = '') {
  const s = {
    value,
    edit(k: Key) {
      if (k.name === 'backspace') s.value = s.value.slice(0, -1);
      else if (k.ctrl && k.name === 'u') s.value = '';
      else if (k.ctrl && k.name === 'w') s.value = s.value.replace(/\S+\s*$/, '');
      else if (k.name === 'space') s.value += ' ';
      else if (char(k)) s.value += char(k);
      else return false;
      return true;
    },
    line(label: Line, placeholder: string, st: Styles): Line {
      return [...label, { t: s.value, s: st.title }, { t: '▏', s: st.accent }, ...(s.value ? [] : [{ t: placeholder, s: st.placeholder }])];
    },
  };
  return s;
}
export type LineInput = ReturnType<typeof lineInput>;

// A cursor in a list of `n` rows and the first row shown, kept so the cursor is
// always in view. move() takes ↑ ↓ and ctrl+u / ctrl+d.
export function cursor() {
  const c = {
    at: 0,
    top: 0,
    clamp(n: number, rows: number) {
      c.at = Math.max(0, Math.min(c.at, n - 1));
      if (c.at < c.top) c.top = c.at;
      if (c.at >= c.top + rows) c.top = c.at - rows + 1;
      c.top = Math.max(0, Math.min(c.top, Math.max(0, n - rows)));
    },
    move(k: Key, n: number, page: number) {
      if (k.name === 'down') c.at = Math.min(n - 1, c.at + 1);
      else if (k.name === 'up') c.at = Math.max(0, c.at - 1);
      else if (k.ctrl && k.name === 'd') c.at = Math.min(n - 1, c.at + page);
      else if (k.ctrl && k.name === 'u') c.at = Math.max(0, c.at - page);
      else return false;
      return true;
    },
  };
  return c;
}

// A unified diff line in colour.
export const diffStyle = (l: string, st: Styles) =>
  l.startsWith('+++') || l.startsWith('---') ? st.titleB : l.startsWith('+') ? st.ok : l.startsWith('-') ? st.del : l.startsWith('@@') ? st.accent : st.fg;

// Text found by / highlighted in a line.
export function highlight(l: Line, q: string | undefined, st: Styles): Line {
  if (!q) return l;
  const text = l.map((r) => r.t).join(''), lo = text.toLowerCase(), ql = q.toLowerCase();
  const on = new Array(text.length).fill(false);
  for (let i = lo.indexOf(ql); i >= 0; i = lo.indexOf(ql, i + 1)) for (let j = i; j < i + ql.length; j++) on[j] = true;
  if (!on.includes(true)) return l;
  const out: Line = [];
  let x = 0;
  for (const r of l)
    for (const ch of r.t) {
      const s = on[x] ? st.selection : r.s;
      x += ch.length;
      if (out.at(-1)?.s === s) out.at(-1)!.t += ch;
      else out.push({ t: ch, s });
    }
  return out;
}

// A row with a marker for the cursor, its text, and a right-aligned part.
export function row(on: boolean, left: Line, right: Line, w: number, st: Styles): Line {
  const rw = lineWidth(right);
  const l: Line = [{ t: on ? '› ' : '  ', s: st.accent }, ...fit(left.map((r) => (on ? { t: r.t, s: r.s === st.fg ? st.title : r.s } : r)), Math.max(4, w - 2 - (rw ? rw + 1 : 0)))];
  if (!rw) return l;
  return [...l, { t: ' '.repeat(Math.max(1, w - lineWidth(l) - rw)), s: '' }, ...right];
}

export const ago = (ms: number) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s` : ms < 3600000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 3600000)}h`);
export const secs = (ms: number) => (ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`);

// A view with its own extras for the app. Unlike Object.assign this keeps
// getters live (Object.assign would copy their value once).
export const extend = <V extends View, E extends object>(view: V, extra: E): V & E => Object.defineProperties(view, Object.getOwnPropertyDescriptors(extra)) as V & E;
