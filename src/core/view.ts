// Pure rendering: transcript items, boxes, the prompt and the status line,
// translated cell by cell from reference/rime-prototype.html.

import { type ColorMode, type RGB, GLACIER, PLACEHOLDER, RESET, sgr } from './theme.ts';
import { type Line, type Run, fit, lineWidth, serialize, strWidth, wrap } from './term.ts';
import type { Turn } from '../plugins/token-kit/meter.ts';
import { fmt$, fmtT } from '../plugins/token-kit/meter.ts';

export type Styles = ReturnType<typeof styles>;

export function styles(mode: ColorMode) {
  const c = (rgb: RGB) => sgr(rgb, false, mode);
  const b = mode === 'none' ? '' : '\x1b[1m';
  const G = GLACIER;
  return {
    mode,
    reset: RESET(mode),
    fg: c(G.fg), title: c(G.title), titleB: b + c(G.title), accent: c(G.accent), accentB: b + c(G.accent),
    dim: c(G.dim), ok: c(G.ok), del: c(G.del), warn: c(G.warn), line: c(G.line),
    bold: b, placeholder: c(PLACEHOLDER), panelBg: sgr(G.panel, true, mode),
  };
}

const run = (t: string, s = ''): Run => ({ t, s });
export const str = (l: Line, st: Styles) => serialize(l, st.reset);

// ---- Transcript items ----

export type Item =
  | { kind: 'header'; lines: () => string[] }
  | { kind: 'user'; text: string }
  | { kind: 'reply'; text: string; done: boolean }
  | { kind: 'tool'; verb: string; rest?: string; extra?: Line }
  | { kind: 'cost'; turn: Turn }
  | { kind: 'note'; text: string; tone: 'warn' | 'dim' };

// Messages are capped at 76ch like the prototype's .msg.
const MSG = 76;

// One blank line between items; tool steps stack, and a cost line hugs its reply.
// (The prototype's half-line gaps round to a full line in a terminal.)
export const spaced = (prev: Item | undefined, next: Item) =>
  !!prev && prev.kind !== 'header' && next.kind !== 'cost' && !(prev.kind === 'tool' && next.kind === 'tool');

// Light markdown for replies: headings, bold, `code`, lists, fences.
export function markdown(text: string, st: Styles): Line[] {
  const out: Line[] = [];
  let fence = false;
  for (const raw of text.split('\n')) {
    if (/^\s*```/.test(raw)) { fence = !fence; out.push([run(raw, st.dim)]); continue; }
    if (fence) { out.push([run(raw, st.fg)]); continue; }
    const h = /^#{1,6}\s+(.*)$/.exec(raw);
    if (h) { out.push([run(h[1], st.titleB)]); continue; }
    const li = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    const q = /^>\s?(.*)$/.exec(raw);
    const line: Line = [];
    let body = raw;
    if (li) { line.push(run(li[1]), run('· ', st.dim)); body = li[2]; }
    else if (q) { line.push(run('│ ', st.dim)); body = q[1]; }
    for (const part of body.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
      if (!part) continue;
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) line.push(run(part.slice(2, -2), st.bold + st.title));
      else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) line.push(run(part.slice(1, -1), st.title));
      else line.push(run(part, q ? st.dim : st.fg));
    }
    out.push(line);
  }
  return out;
}

const indent = (lines: Line[], n: number) => lines.map((l) => [run(' '.repeat(n)), ...l]);

// Renders one item to terminal lines.
export function renderItem(item: Item, width: number, st: Styles): string[] {
  const all = (lines: Line[]) => lines.map((l) => str(l, st));
  switch (item.kind) {
    case 'header':
      return ['', ...item.lines(), ''];
    case 'user': {
      const w = Math.min(MSG, width);
      const lines = item.text.split('\n').flatMap((p, i) =>
        wrap(i === 0 ? [run('› ', st.accentB), run(p, st.title)] : [run(p, st.title)], w));
      return all(lines);
    }
    case 'reply':
      return all(indent(markdown(item.text, st).flatMap((l) => wrap(l, Math.min(MSG, width - 2))), 2));
    case 'tool': // the screen cuts it to width
      return all([[run('● ', st.accent), run(item.verb, st.titleB), ...(item.rest ? [run(' ' + item.rest, st.dim)] : []), ...(item.extra || [])]]);
    case 'cost': {
      const c = item.turn;
      return all([[
        run(`  ↳ ${fmtT(c.in)} in · ${fmtT(c.cached)} cached · ${fmtT(c.out)} out · ${fmt$(c.spent)} · `, st.dim),
        run(`saved ${fmt$(c.saved)}`, st.ok),
      ]]);
    }
    case 'note': {
      const w = Math.min(MSG, width - 2);
      const lines = item.text.split('\n').flatMap((p, i) =>
        wrap(i === 0 ? [run('! ', item.tone === 'warn' ? st.warn : st.dim), run(p, st.dim)] : [run(p, st.dim)], w));
      return all(indent(lines, 2));
    }
  }
}

// ---- Boxes ----

export type BoxRow = { line: Line; bg?: string; rule?: 'inner' | 'full'; hit?: string };

// A rounded frame with a legend in the top border, like the prototype's
// .cmds / .usage boxes. Rows get one cell of padding on each side.
export function box(legend: string, rows: BoxRow[], width: number, st: Styles, color = st.accent): { lines: string[]; hits: (string | undefined)[] } {
  const inner = width - 2;
  const top = [run('╭─', color), run(` ${legend} `, color), run('─'.repeat(Math.max(0, inner - strWidth(legend) - 3)) + '╮', color)];
  const lines: string[] = [str(fit(top, width, false), st)];
  const hits: (string | undefined)[] = [undefined];
  for (const r of rows) {
    if (r.rule === 'full') lines.push(str([run('├', color), run('─'.repeat(inner), st.line), run('┤', color)], st));
    else if (r.rule === 'inner') lines.push(str([run('│ ', color), run('─'.repeat(inner - 2), st.line), run(' │', color)], st));
    else {
      const body = fit(r.line, inner - 2).map((x) => (r.bg ? { t: x.t, s: r.bg + x.s } : x));
      const pad = run(' ', r.bg || '');
      lines.push(str([run('│', color), pad, ...body, pad, run('│', color)], st));
    }
    hits.push(r.hit);
  }
  lines.push(str([run('╰' + '─'.repeat(inner) + '╯', color)], st));
  hits.push(undefined);
  return { lines, hits };
}

// A name/help list row: `.n` is 13ch wide including its "› " marker, then 2ch gap.
export function listRow(name: string, help: string, selected: boolean, st: Styles, hit?: string): BoxRow {
  const n = fit([run(selected ? '› ' : '  ', selected ? st.accent : st.title), run(name, selected ? st.accent : st.title)], 13, false);
  return { line: [...n, run('  '), run(help, st.dim)], bg: selected ? st.panelBg : undefined, hit };
}

export const footRows = (text: string, st: Styles): BoxRow[] => [{ line: [], rule: 'full' }, { line: [run(text, st.dim)] }];

// ---- Prompt ----

export type PromptView = { lines: string[]; cursor: { row: number; col: number } };

const PLACEHOLDER_TEXT = 'ask Rime to change some code, or / for commands';

// Splits the buffer into rows of `tw` cells, remembering where each row starts.
export function layoutInput(buf: string, tw: number) {
  const rows: { start: number; text: string }[] = [];
  let pos = 0;
  for (const para of buf.split('\n')) {
    let cur = '', w = 0, start = pos;
    for (const ch of para) {
      const cw = strWidth(ch);
      if (w + cw > tw) { rows.push({ start, text: cur }); start = pos; cur = ''; w = 0; }
      cur += ch; w += cw; pos += ch.length;
    }
    rows.push({ start, text: cur });
    pos++; // the newline
  }
  return rows;
}

export function caretOf(rows: { start: number; text: string }[], cursor: number) {
  let r = 0;
  for (let i = 0; i < rows.length; i++) if (rows[i].start <= cursor) r = i;
  return { row: r, col: strWidth(rows[r].text.slice(0, cursor - rows[r].start)) };
}

export function prompt(buf: string, cursor: number, width: number, maxRows: number, st: Styles): PromptView {
  const inner = width - 4, tw = Math.max(1, inner - 2);
  const border = st.dim; // .prompt:focus-within, and the prompt always has focus
  const rows = layoutInput(buf, tw);
  const caret = caretOf(rows, cursor);
  // Keep the caret's row in view when the input is taller than allowed.
  const first = Math.max(0, Math.min(caret.row - maxRows + 1, rows.length - maxRows));
  const shown = rows.slice(first, first + maxRows);
  const lines = [str([run('╭' + '─'.repeat(width - 2) + '╮', border)], st)];
  shown.forEach((r, i) => {
    const lead = first + i === 0 ? run('› ', st.accentB) : run('  ');
    const text = buf ? run(r.text, st.title) : run(PLACEHOLDER_TEXT, st.placeholder);
    lines.push(str([run('│ ', border), ...fit([lead, text], inner, !buf), run(' │', border)], st));
  });
  lines.push(str([run('╰' + '─'.repeat(width - 2) + '╯', border)], st));
  return { lines, cursor: { row: 1 + caret.row - first, col: 4 + caret.col } };
}

// ---- Status line ----

export type Hit = { x0: number; x1: number; id: string };

// Left: key hints; right: the cost meter. Returns hit ranges (1-based columns).
export function status(left: Line, meter: Line, width: number, st: Styles, leftHits: Hit[]): { line: string; hits: Hit[] } {
  const mw = lineWidth(meter);
  const room = width - mw - 2;
  const l = room > 0 ? fit(left, room) : [];
  const line = room > 0 ? [...l, run('  '), ...meter] : fit(meter, width);
  const x0 = width - Math.min(mw, width) + 1;
  return {
    line: str(line, st),
    hits: [...leftHits.filter((h) => h.x1 <= room), { x0, x1: width, id: 'meter' }],
  };
}
