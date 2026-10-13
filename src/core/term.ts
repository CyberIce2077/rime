// Terminal text helpers: display width, styled word wrap, and input parsing.

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');

function cpWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

// ponytail: small east-asian/emoji width table, swap for a full wcwidth if misalignment shows up.
export const strWidth = (s: string) => {
  let w = 0;
  for (const ch of stripAnsi(s)) w += cpWidth(ch.codePointAt(0)!);
  return w;
};

// A run is text in one style; `s` is the SGR prefix ('' = default).
export type Run = { t: string; s: string };
export type Line = Run[];

export const lineWidth = (l: Line) => l.reduce((w, r) => w + strWidth(r.t), 0);
export const serialize = (l: Line, reset: string) => l.map((r) => (r.s ? r.s + r.t + reset : r.t)).join('');

// Pads or cuts a styled line to exactly `width` cells, adding an ellipsis when cut.
export function fit(l: Line, width: number, ellipsis = true): Line {
  const out: Line = [];
  let w = 0;
  const total = lineWidth(l);
  const limit = total > width && ellipsis ? width - 1 : width;
  for (const r of l) {
    let t = '';
    for (const ch of r.t) {
      const cw = cpWidth(ch.codePointAt(0)!);
      if (w + cw > limit) break;
      t += ch;
      w += cw;
    }
    if (t) out.push({ t, s: r.s });
    if (w >= limit && t.length < r.t.length) break;
  }
  if (total > width && ellipsis) {
    out.push({ t: '…', s: out.at(-1)?.s ?? '' });
    w++;
  }
  if (w < width) out.push({ t: ' '.repeat(width - w), s: '' });
  return out;
}

// Greedy word wrap of one styled paragraph (no newlines inside). Words longer
// than the width are broken by character.
export function wrap(runs: Line, width: number): Line[] {
  width = Math.max(1, width);
  const lines: Line[] = [[]];
  let w = 0;
  const push = (t: string, s: string) => {
    const cur = lines.at(-1)!;
    const last = cur.at(-1);
    if (last && last.s === s) last.t += t;
    else cur.push({ t, s });
  };
  for (const r of runs) {
    for (const tok of r.t.split(/(\s+)/)) {
      if (!tok) continue;
      const tw = strWidth(tok);
      if (/^\s+$/.test(tok)) {
        if (w + tw <= width) { push(tok, r.s); w += tw; }
        else { lines.push([]); w = 0; } // a break swallows the spaces
        continue;
      }
      if (w + tw > width && w > 0 && tw <= width) {
        const last = lines.at(-1)!.at(-1);
        if (last) last.t = last.t.replace(/\s+$/, ''); // no trailing spaces on the line we leave
        lines.push([]);
        w = 0;
      }
      if (tw <= width - w) { push(tok, r.s); w += tw; continue; }
      for (const ch of tok) {
        const cw = cpWidth(ch.codePointAt(0)!);
        if (w + cw > width) { lines.push([]); w = 0; }
        push(ch, r.s);
        w += cw;
      }
    }
  }
  return lines.map((l) => l.filter((r) => r.t));
}

// ---- Input ----

export type Key = { name: string; ch?: string; ctrl?: boolean; alt?: boolean; shift?: boolean };
export type InputEvent =
  | ({ type: 'key' } & Key)
  | { type: 'paste'; text: string }
  | { type: 'mouse'; button: number; x: number; y: number; release: boolean }
  | { type: 'cpr'; row: number; col: number };

const CSI_NAMES: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'tab' };
const TILDE_NAMES: Record<string, string> = { '1': 'home', '2': 'insert', '3': 'delete', '4': 'end', '5': 'pageup', '6': 'pagedown', '7': 'home', '8': 'end' };
const CODE_NAMES: Record<number, string> = { 13: 'enter', 27: 'escape', 9: 'tab', 127: 'backspace', 8: 'backspace', 32: 'space' };

const mods = (m: number) => ({ shift: !!((m - 1) & 1), alt: !!((m - 1) & 2), ctrl: !!((m - 1) & 4) });

// A key from a unicode code point plus modifiers (kitty CSI u, xterm modifyOtherKeys).
function codeKey(code: number, m: number): InputEvent {
  const md = mods(m);
  const name = CODE_NAMES[code];
  if (name) return { type: 'key', name, ...md };
  const ch = String.fromCodePoint(code);
  if (md.ctrl) return { type: 'key', name: ch.toLowerCase(), ...md };
  return { type: 'key', name: 'char', ch: md.shift ? ch.toUpperCase() : ch, ...md };
}

// Splits one chunk of raw stdin into events. Keeps state for bracketed pastes
// that span chunks.
export function createParser() {
  let paste: string | null = null;

  return function parse(data: string): InputEvent[] {
    const out: InputEvent[] = [];
    let i = 0;
    if (paste !== null) {
      const end = data.indexOf('\x1b[201~');
      if (end < 0) { paste += data; return out; }
      out.push({ type: 'paste', text: paste + data.slice(0, end) });
      paste = null;
      i = end + 6;
    }
    while (i < data.length) {
      const c = data[i];
      if (c === '\x1b') {
        const rest = data.slice(i);
        if (rest.startsWith('\x1b[200~')) {
          const end = rest.indexOf('\x1b[201~');
          if (end < 0) { paste = rest.slice(6); return out; }
          out.push({ type: 'paste', text: rest.slice(6, end) });
          i += end + 6;
          continue;
        }
        let m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
        if (m) {
          out.push({ type: 'mouse', button: +m[1], x: +m[2], y: +m[3], release: m[4] === 'm' });
          i += m[0].length;
          continue;
        }
        m = /^\x1b\[(\d+);(\d+)R/.exec(rest);
        if (m) { out.push({ type: 'cpr', row: +m[1], col: +m[2] }); i += m[0].length; continue; }
        m = /^\x1b\[27;(\d+);(\d+)~/.exec(rest); // xterm modifyOtherKeys
        if (m) { out.push(codeKey(+m[2], +m[1])); i += m[0].length; continue; }
        m = /^\x1b\[(\d+)(?::\d+)*(?:;(\d+)(?::\d+)?)?u/.exec(rest); // kitty CSI u
        if (m) { out.push(codeKey(+m[1], +(m[2] || 1))); i += m[0].length; continue; }
        m = /^\x1b\[(\d+)(?:;(\d+))?~/.exec(rest);
        if (m) { out.push({ type: 'key', name: TILDE_NAMES[m[1]] || 'unknown', ...mods(+(m[2] || 1)) }); i += m[0].length; continue; }
        m = /^\x1b(?:\[(?:1;)?(\d+)?|O)([A-DHFZ])/.exec(rest);
        if (m) {
          const k: InputEvent = { type: 'key', name: CSI_NAMES[m[2]], ...mods(+(m[1] || 1)) };
          if (m[2] === 'Z') k.shift = true;
          out.push(k);
          i += m[0].length;
          continue;
        }
        m = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(rest); // any other CSI: ignore
        if (m) { i += m[0].length; continue; }
        if (rest.length === 1 || rest[1] === '\x1b') { out.push({ type: 'key', name: 'escape' }); i++; continue; }
        // Alt + key.
        const [ev] = parse(rest[1]);
        if (ev && ev.type === 'key') out.push({ ...ev, alt: true });
        i += 2;
        continue;
      }
      if (c === '\r') out.push({ type: 'key', name: 'enter' });
      else if (c === '\n') out.push({ type: 'key', name: 'j', ctrl: true }); // ctrl+j
      else if (c === '\t') out.push({ type: 'key', name: 'tab' });
      else if (c === '\x7f' || c === '\b') out.push({ type: 'key', name: 'backspace' });
      else if (c < ' ') out.push({ type: 'key', name: String.fromCharCode(c.charCodeAt(0) + 96), ctrl: true });
      else {
        const cp = data.codePointAt(i)!;
        const ch = String.fromCodePoint(cp);
        out.push({ type: 'key', name: 'char', ch });
        i += ch.length;
        continue;
      }
      i++;
    }
    return out;
  };
}

// Cuts an ANSI-styled string to `width` visible cells, keeping escape codes.
export function truncAnsi(s: string, width: number): string {
  let out = '', w = 0, i = 0;
  const re = new RegExp(ANSI.source, 'y');
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (m) { out += m[0]; i += m[0].length; continue; }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    const cw = cpWidth(ch.codePointAt(0)!);
    if (w + cw > width) { i += ch.length; continue; } // skip text, keep later resets
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out;
}
