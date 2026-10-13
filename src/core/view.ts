// Pure rendering: transcript items, boxes, the prompt and the status line,
// translated cell by cell from reference/rime-prototype.html.

import { type ColorMode, type RGB, GLACIER, PLACEHOLDER, RESET, SELECTION, sgr } from './theme.ts';
import { type Line, type Run, fit, lineWidth, serialize, strWidth, wrap } from './term.ts';
import type { Turn } from '../plugins/token-kit/meter.ts';
import { type Change, WHEN } from './settings.ts';
import { fmt$, fmtS, fmtT } from '../plugins/token-kit/meter.ts';

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
    selection: mode === 'none' ? '\x1b[7m' : sgr(SELECTION, true, mode) + c(G.title),
    // A chip in the prompt or a sent message; `chipOn` when the caret is on it.
    chip: mode === 'none' ? '' : sgr(G.water, true, mode) + c(G.accent),
    chipWarn: mode === 'none' ? '' : sgr(G.water, true, mode) + c(G.warn),
    chipOn: mode === 'none' ? '\x1b[4m' : sgr(G.water2, true, mode) + b + c(G.accent),
  };
}

const run = (t: string, s = ''): Run => ({ t, s });
export const str = (l: Line, st: Styles) => serialize(l, st.reset);

// ---- Transcript items ----

export type Item =
  | { kind: 'header'; lines: () => string[] }
  | { kind: 'user'; text: string; chips?: Record<string, string> } // chip char -> its label
  | { kind: 'reply'; text: string; done: boolean }
  | { kind: 'tool'; verb: string; rest?: string; extra?: Line }
  | { kind: 'cost'; turn: Turn }
  | { kind: 'note'; text: string; tone: 'warn' | 'dim' }
  | { kind: 'lines'; lines: Line[] } // already styled, e.g. "● gpubox is ready"
  | { kind: 'gear'; change: Change; note?: string }; // a setting Rime changed, with undo

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

// Until Rime has tools (Phase 4), a model with none in the request may write
// its own tool calls as text: Qwen's `<tool_call><function=Bash><parameter=command>
// ls -la</parameter>…` or the JSON form. Returns the text before them (without a
// half-streamed tag) and a short description of each call.
export function splitToolCalls(text: string): { text: string; calls: string[] } {
  const i = text.indexOf('<tool_call>');
  if (i < 0) {
    const tail = text.slice(text.lastIndexOf('<'));
    return { text: tail.length < 11 && '<tool_call>'.startsWith(tail) ? text.slice(0, -tail.length) : text, calls: [] };
  }
  const calls = [...text.slice(i).matchAll(/<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g)].map(([, body]) => {
    let name = /<function=([^>\s]+)>/.exec(body)?.[1];
    let arg = /<parameter=[^>]*>\s*([\s\S]*?)\s*(?:<\/parameter>|$)/.exec(body)?.[1];
    if (!name) {
      try {
        const j = JSON.parse(body.trim());
        name = j.name;
        const a = typeof j.arguments === 'string' ? JSON.parse(j.arguments) : j.arguments;
        arg = Object.values(a ?? {}).find((v) => typeof v === 'string') as string | undefined;
      } catch {}
    }
    const one = (arg ?? '').split('\n')[0].trim();
    if (!one) return name ?? 'a tool';
    return `\`${one.length > 48 ? one.slice(0, 47) + '…' : one}${one.length <= 48 && (arg ?? '').includes('\n') ? ' …' : ''}\``;
  });
  return { text: text.slice(0, i).trimEnd(), calls };
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
      // Chips keep their look in the transcript (and their preview on hover).
      const body = (p: string): Line => [...p].map((ch) => (item.chips?.[ch] ? run(`[${item.chips[ch]}]`, st.chip) : run(ch, st.title)));
      const lines = item.text.split('\n').flatMap((p, i) =>
        wrap(i === 0 ? [run('› ', st.accentB), ...body(p)] : body(p), w));
      return all(lines);
    }
    case 'reply':
      return all(indent(markdown(splitToolCalls(item.text).text, st).flatMap((l) => wrap(l, Math.min(MSG, width - 2))), 2));
    case 'tool': // the screen cuts it to width
      return all([[run('● ', st.accent), run(item.verb, st.titleB), ...(item.rest ? [run(' ' + item.rest, st.dim)] : []), ...(item.extra || [])]]);
    case 'cost': {
      const c = item.turn;
      const head = `  ↳ ${fmtT(c.in)} in · ${fmtT(c.cached)} cached · ${fmtT(c.out)} out · `;
      if (c.local) {
        // Local: no dollars; prompt time and what the cache saved instead.
        const prompt = c.promptMs !== undefined ? `${fmtS(c.promptMs)} prompt` : '';
        return all([[run(head + 'local' + (prompt ? ` · ${prompt}` : ''), st.dim), ...(c.savedMs && c.savedMs >= 500 ? [run(' (cache saved ', st.dim), run(`~${fmtS(c.savedMs)}`, st.ok), run(')', st.dim)] : [])]]);
      }
      if (c.spent === undefined) return all([[run(head + 'price unknown', st.dim)]]);
      return all([[run(head + `${fmt$(c.spent)} · `, st.dim), run(`saved ${fmt$(c.saved)}`, st.ok)]]);
    }
    case 'lines':
      return item.lines.map((l) => str(l, st));
    case 'gear': {
      // ⚙ effort high (was medium) · from the next message · undo
      const c = item.change;
      const what = item.note ?? `${c.label} ${c.to} (was ${c.from}) · ${WHEN[c.applies]}`;
      return all([[run('⚙ ', st.accent), run(what, st.dim), ...(item.note ? [] : c.undone ? [run(' · undone', st.dim)] : [run(' · ', st.dim), run('undo', st.accent)])]]);
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

export type BoxRow = { line: Line; bg?: string; rule?: 'inner' | 'full'; hit?: string; segs?: Hit[] };

// A rounded frame with a legend in the top border, like the prototype's
// .cmds / .usage boxes. Rows get one cell of padding on each side. `hits` holds
// the clickable ranges per line (1-based columns): whole rows, footer keys
// (`segs`, relative to the row's text) and the ✕ on the frame (`closeId`).
export function box(legend: string | Line, rows: BoxRow[], width: number, st: Styles, color = st.accent, closeId?: string): { lines: string[]; hits: Hit[][] } {
  const inner = width - 2;
  const lg: Line = typeof legend === 'string' ? [run(legend, color)] : legend;
  const x = closeId ? [run(' ✕ ', st.dim), run('─', color)] : [];
  const top = [run('╭─ ', color), ...lg, run(' ' + '─'.repeat(Math.max(0, inner - lineWidth(lg) - 3 - lineWidth(x))), color), ...x, run('╮', color)];
  const lines: string[] = [str(fit(top, width, false), st)];
  const hits: Hit[][] = [closeId ? [{ x0: width - 4, x1: width - 2, id: closeId }] : []];
  for (const r of rows) {
    if (r.rule === 'full') lines.push(str([run('├', color), run('─'.repeat(inner), st.line), run('┤', color)], st));
    else if (r.rule === 'inner') lines.push(str([run('│ ', color), run('─'.repeat(inner - 2), st.line), run(' │', color)], st));
    else {
      const body = fit(r.line, inner - 2).map((x) => (r.bg ? { t: x.t, s: r.bg + x.s } : x));
      const pad = run(' ', r.bg || '');
      lines.push(str([run('│', color), pad, ...body, pad, run('│', color)], st));
    }
    hits.push([...(r.hit ? [{ x0: 1, x1: width, id: r.hit }] : []), ...(r.segs ?? []).filter((h) => h.x1 <= inner - 2).map((h) => ({ ...h, x0: h.x0 + 2, x1: h.x1 + 2 }))]);
  }
  lines.push(str([run('╰' + '─'.repeat(inner) + '╯', color)], st));
  hits.push([]);
  return { lines, hits };
}

// A name/help list row: `.n` is 13ch wide (22ch in /setup) including its "› "
// marker, then a 2ch gap.
export function listRow(name: string, help: string | Line, selected: boolean, st: Styles, hit?: string, nameWidth = 13): BoxRow {
  const n = fit([run(selected ? '› ' : '  ', selected ? st.accent : st.title), run(name, selected ? st.accent : st.title)], nameWidth, false);
  return { line: [...n, run('  '), ...(typeof help === 'string' ? [run(help, st.dim)] : help)], bg: selected ? st.panelBg : undefined, hit };
}

// A setting: dim label (26ch), then ‹ value › with the value centred in 17ch.
export function settingRow(label: string, value: string, selected: boolean, st: Styles, hit?: string): BoxRow {
  const pad = Math.max(0, 17 - strWidth(value));
  const v = ' '.repeat(Math.floor(pad / 2)) + value + ' '.repeat(Math.ceil(pad / 2));
  return {
    line: [...fit([run(label, st.dim)], 26, false), run('  '), run('‹', st.accent), run(v, st.title), run('›', st.accent)],
    bg: selected ? st.panelBg : undefined,
    hit,
  };
}

// The box foot: a rule, then dim text where `keys` (bold accent) and plain parts
// alternate, e.g. ['↑ ↓', ' choose · ', 'enter', ' next']. Every key is also
// clickable (SPEC §5.1): its hit id is `key:<key>`.
export function footRows(text: string | string[], st: Styles): BoxRow[] {
  const parts = typeof text === 'string' ? [text] : text;
  const segs: Hit[] = [];
  let x = 1;
  parts.forEach((t, i) => {
    const w = strWidth(t);
    if (parts.length > 1 && i % 2 === 0 && t) segs.push({ x0: x, x1: x + w - 1, id: `key:${t}` });
    x += w;
  });
  return [{ line: [], rule: 'full' }, { line: parts.map((t, i) => run(t, parts.length > 1 && i % 2 === 0 ? st.accentB : st.dim)), segs }];
}

// ---- Prompt ----

const PLACEHOLDER_TEXT = 'ask Rime to change some code, or / for commands';

// How wide a character is in the prompt: chips (private-use characters) show as
// their [label].
export type ChipWidth = (ch: string) => number | undefined;
const cellW = (ch: string, chipW?: ChipWidth) => chipW?.(ch) ?? strWidth(ch);

// Splits the buffer into rows of `tw` cells, remembering where each row starts.
export function layoutInput(buf: string, tw: number, chipW?: ChipWidth) {
  const rows: { start: number; text: string }[] = [];
  let pos = 0;
  for (const para of buf.split('\n')) {
    let cur = '', w = 0, start = pos;
    for (const ch of para) {
      const cw = Math.min(tw, cellW(ch, chipW));
      if (w + cw > tw && cur) { rows.push({ start, text: cur }); start = pos; cur = ''; w = 0; }
      cur += ch; w += cw; pos += ch.length;
    }
    rows.push({ start, text: cur });
    pos++; // the newline
  }
  return rows;
}

const rowWidth = (s: string, chipW?: ChipWidth) => [...s].reduce((w, ch) => w + cellW(ch, chipW), 0);

export function caretOf(rows: { start: number; text: string }[], cursor: number, chipW?: ChipWidth) {
  let r = 0;
  for (let i = 0; i < rows.length; i++) if (rows[i].start <= cursor) r = i;
  return { row: r, col: rowWidth(rows[r].text.slice(0, cursor - rows[r].start), chipW) };
}

// The buffer offset under a cell of a laid-out row (for clicks and drags).
export function offsetAt(row: { start: number; text: string }, col: number, chipW?: ChipWidth) {
  let w = 0, i = 0;
  for (const ch of row.text) {
    const cw = cellW(ch, chipW);
    if (w + cw / 2 > col) break;
    w += cw;
    i += ch.length;
  }
  return row.start + i;
}

export type PromptOpts = {
  placeholder?: string;
  masked?: boolean;
  sel?: [number, number]; // selected buffer range
  chip?: (ch: string) => { label: string; warn?: boolean } | undefined;
  near?: string; // the chip the caret is on
};

export type PromptView = { lines: string[]; cursor: { row: number; col: number }; rows: { start: number; text: string }[]; first: number; hits: Hit[] };

export function prompt(buf: string, cursor: number, width: number, maxRows: number, st: Styles, o: PromptOpts = {}): PromptView {
  const inner = width - 4, tw = Math.max(1, inner - 2);
  const border = st.dim; // .prompt:focus-within, and the prompt always has focus
  const placeholder = o.placeholder ?? PLACEHOLDER_TEXT;
  if (o.masked) buf = '•'.repeat([...buf].length), cursor = buf.length;
  const chipW: ChipWidth | undefined = o.chip ? (ch) => { const c = o.chip!(ch); return c ? strWidth(c.label) + 2 : undefined; } : undefined;
  const rows = layoutInput(buf, tw, chipW);
  const caret = caretOf(rows, cursor, chipW);
  // Keep the caret's row in view when the input is taller than allowed.
  const first = Math.max(0, Math.min(caret.row - maxRows + 1, rows.length - maxRows));
  const shown = rows.slice(first, first + maxRows);
  const lines = [str([run('╭' + '─'.repeat(width - 2) + '╮', border)], st)];
  shown.forEach((r, i) => {
    const lead = first + i === 0 ? run('› ', st.accentB) : run('  ');
    const text: Line = [];
    if (!buf) text.push(run(placeholder, st.placeholder));
    let at = r.start;
    for (const ch of r.text) {
      const selected = !!o.sel && at >= o.sel[0] && at < o.sel[1];
      const c = o.chip?.(ch);
      if (c) text.push(run(`[${c.label}]`, selected ? st.selection : ch === o.near ? st.chipOn : c.warn ? st.chipWarn : st.chip));
      else text.push(run(ch, selected ? st.selection : st.title));
      at += ch.length;
    }
    lines.push(str([run('│ ', border), ...fit([lead, ...text], inner, !buf), run(' │', border)], st));
  });
  // With more than one line the frame shows the count and the keys (clickable).
  const hits: Hit[] = [];
  const n = buf.split('\n').length;
  const foot: Line = n > 1 && !o.masked ? [run(` ${n} lines · `, st.dim), run('enter', st.accentB), run(' send · ', st.dim), run('ctrl+j', st.accentB), run(' new line ', st.dim)] : [];
  const fw = lineWidth(foot);
  if (fw && fw + 4 <= width) {
    let x = width - 1 - fw; // 1-based column where the foot starts
    for (const r of foot) {
      const w = strWidth(r.t);
      if (r.t === 'enter' || r.t === 'ctrl+j') hits.push({ x0: x, x1: x + w - 1, id: `key:${r.t}` });
      x += w;
    }
    lines.push(str([run('╰' + '─'.repeat(width - 3 - fw), border), ...foot, run('─╯', border)], st));
  } else lines.push(str([run('╰' + '─'.repeat(width - 2) + '╯', border)], st));
  return { lines, cursor: { row: 1 + caret.row - first, col: 4 + caret.col }, rows, first, hits };
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
