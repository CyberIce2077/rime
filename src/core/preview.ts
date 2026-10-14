// The preview above the prompt (SPEC §5.3): exactly what goes to the AI for a
// chip, in the same frame as the / box, and the "what gets sent" line and list.

import { type Chip, fitTo, fmtK, isChip, parts, thumbSize, thumbnail } from './attach.ts';
import { pixelCells } from './header.ts';
import { type Line, fit, strWidth, wrap } from './term.ts';
import { type BoxRow, type Styles, footRows } from './view.ts';

const STRIP_MAX = 8;

// Full size, a file, folder or long text is a viewer: `room` rows of it from
// line `scroll` (wrapped to the width); `max` is the furthest it scrolls.
export function previewBox(c: Chip, width: number, o: { big: boolean; hovering: boolean; blind?: string; scroll?: number; room?: number }, st: Styles, redraw: () => void): { legend: Line; rows: BoxRow[]; max: number } {
  const inner = width - 4;
  const dim = (t: string) => ({ t, s: st.dim });
  const rows: BoxRow[] = [];
  const pixels = (file: string, w: number, h: number, cols: number, lines: number) => {
    const t = thumbSize(w, h, cols, lines);
    const px = thumbnail(file, t.cols, t.rows, redraw);
    if (px === undefined) return { cols: t.cols, lines: [[dim('making a preview…')]] as Line[] };
    if (px === null) return { cols: t.cols, lines: [[dim('(no preview here: Rime draws one with ffmpeg, or sips on macOS)')]] as Line[] };
    return { cols: t.cols, lines: pixelCells(px, st.mode).map((l) => l.map((x) => ({ t: x.t, s: x.s }))) };
  };
  let info: Line;
  let max = 0;
  const textual = c.kind === 'file' || c.kind === 'text' || c.kind === 'folder';
  if (o.big && textual) {
    // Each line wrapped; a numbered line's continuation lines up under its text.
    const src = c.kind === 'folder' ? c.tree! : c.text!.split('\n');
    const vis: { line: Line; n: number }[] = [];
    src.forEach((l, n) => {
      const pad = /^\s*\d+ {2}/.exec(l)?.[0].length ?? 0;
      wrap([{ t: l, s: st.fg }], inner).forEach((w, i) => vis.push({ line: i && pad ? [{ t: ' '.repeat(pad), s: '' }, ...w] : w, n }));
    });
    const room = Math.max(3, o.room ?? 30);
    max = Math.max(0, vis.length - room);
    const from = Math.max(0, Math.min(o.scroll ?? 0, max));
    const shown = vis.slice(from, from + room);
    rows.push(...shown.map((v) => ({ line: v.line })));
    // Where you are first: a long path would push it off the line.
    const where: Line = max ? [{ t: `lines ${shown[0].n + 1}–${shown.at(-1)!.n + 1} of ${src.length}`, s: st.accent }, dim(' · ')] : [];
    info =
      c.kind === 'file' ? [...where, { t: c.path!, s: st.title }, dim(`${max ? '' : ` · ${c.lines} lines`} · sent like a read: the first ${Math.min(c.lines!, 200)} lines · ~${fmtK(c.tok)} tokens`)]
      : c.kind === 'folder' ? [...where, { t: c.path!, s: st.title }, dim(` · sent as this tree · ~${fmtK(c.tok)} tokens`)]
      : [...where, { t: `${c.lines} lines`, s: st.title }, dim(` · sent in full · ~${fmtK(c.tok)} tokens`)];
  } else if (c.kind === 'image') {
    const p = pixels(c.path!, c.w!, c.h!, Math.min(inner, o.big ? inner : 56), o.big ? 20 : 8);
    rows.push(...p.lines.map((line) => ({ line })));
    const [a, b] = fitTo(c.w!, c.h!, 1568);
    info = [{ t: c.name, s: st.title }, dim(` · ${c.w}×${c.h} · sent as ${a}×${b} ${c.mime === 'image/jpeg' ? 'JPEG' : 'PNG'}${a < c.w! ? ' (scaled down)' : ''} · ~${fmtK(c.tok)} tokens`)];
  } else if (c.kind === 'video') {
    if (c.busy) rows.push({ line: [dim('reading frames…')] });
    else if (c.error || !c.frames?.length) rows.push({ line: [{ t: `Nothing from this video is sent: ${c.error ?? "Rime couldn't read it"}.`, s: st.warn }] });
    else {
      // The strip of frames that will be sent, with their times.
      const n = Math.min(c.frames.length, STRIP_MAX);
      const each = Math.max(4, Math.min(o.big ? 40 : 18, Math.floor((inner - (n - 1)) / n)));
      const shots = c.frames.slice(0, n).map((f) => pixels(f.path, c.fw!, c.fh!, each, o.big ? 8 : 3));
      const h = Math.max(...shots.map((s) => s.lines.length));
      for (let y = 0; y < h; y++) rows.push({ line: shots.flatMap((s, i) => [...(i ? [{ t: ' ', s: '' }] : []), ...fit(s.lines[y] ?? [], s.cols, false)]) });
      rows.push({ line: shots.flatMap((s, i) => [...(i ? [{ t: ' ', s: '' }] : []), ...fit([dim(`${c.frames![i].t.toFixed(1)}s`)], s.cols, false)]) });
    }
    info = [{ t: c.name, s: st.title }, dim(` · ${c.frames?.length ?? 0} frames, 1 per second (at most 8) · ${c.fw ?? 768}×${c.fh ?? 432} · no sound · ~${fmtK(c.tok)} tokens`)];
  } else if (c.kind === 'folder') {
    const max = o.big ? 40 : 10;
    const t = c.tree!;
    rows.push(...t.slice(0, max).map((l) => ({ line: [{ t: l, s: st.fg }] })));
    if (t.length > max) rows.push({ line: [dim(`  … ${t.length - max} more lines`)] });
    info = [{ t: c.path!, s: st.title }, dim(` · sent as this tree · the AI can then read files inside it · ~${fmtK(c.tok)} tokens`)];
  } else if (c.kind === 'path') {
    info = [{ t: c.path!, s: st.title }, dim(` · only its type and size are sent`)];
  } else {
    const ls = c.text!.split('\n');
    const head = o.big ? 30 : 6, tail = o.big ? 0 : 3;
    if (ls.length <= head + tail + 1) rows.push(...ls.map((l) => ({ line: [{ t: l, s: st.fg }] })));
    else {
      rows.push(...ls.slice(0, head).map((l) => ({ line: [{ t: l, s: st.fg }] })));
      rows.push({ line: [dim(`  … ${ls.length - head - tail} more lines …`)] });
      if (tail) rows.push(...ls.slice(-tail).map((l) => ({ line: [{ t: l, s: st.fg }] })));
    }
    info = c.kind === 'file'
      ? [{ t: c.path!, s: st.title }, dim(` · ${c.lines} lines · sent like a read: the first ${Math.min(c.lines!, 200)} lines · ~${fmtK(c.tok)} tokens`)]
      : [{ t: `${c.lines} lines`, s: st.title }, dim(` · sent in full · ~${fmtK(c.tok)} tokens`)];
  }
  rows.push({ line: info });
  if (o.blind) rows.push({ line: [{ t: o.blind, s: st.warn }] });
  if (o.big) rows.push(...footRows(max ? ['↑ ↓', ' or wheel scroll · ', 'ctrl+u ctrl+d', ' page · ', 'esc', ' closes'] : ['esc', ' or a click on the chip closes this'], st));
  else rows.push({ line: [], rule: 'full' }, { line: [dim(o.hovering ? 'move off the chip to close · click it for full size' : '← → move off the chip to close · backspace removes it · click it for full size')] });
  const legend: Line = [{ t: c.kind === 'folder' || c.kind === 'file' || c.kind === 'path' ? c.kind : `${c.kind} ${c.n}`, s: st.accent }, dim(' · preview')];
  return { legend, rows, max };
}

// The dim line under the prompt: `+ 2 attachments · ~3.4k tokens to send ▸`.
export function sendLine(buf: string, chips: Map<string, Chip>, open: boolean, st: Styles, warn?: string): Line {
  const ps = parts(buf, chips);
  if (!ps.length) return [];
  const att = new Set([...buf].filter(isChip)).size;
  const tot = ps.reduce((a, p) => a + p.tok, 0);
  return [
    { t: ` ${att ? `+ ${att} attachment${att > 1 ? 's' : ''} · ` : ''}~${fmtK(tot)} tokens to send ${open ? '▾' : '▸'}`, s: st.dim },
    ...(warn ? [{ t: ` · ${warn}`, s: st.warn }] : []),
  ];
}

const LEAD = 'Nothing else is sent. Point at a chip to see it. · ';

// Every part of the next message, exactly as it will be sent.
export function sendList(buf: string, chips: Map<string, Chip>, width: number, st: Styles): { legend: Line; rows: BoxRow[] } {
  const ps = parts(buf, chips);
  const inner = width - 4;
  const tot = ps.reduce((a, p) => a + p.tok, 0);
  const row = (what: string, tok: string, s: string): BoxRow => {
    const t = `~${tok} tok`;
    return { line: [...fit([{ t: what, s }], inner - strWidth(t) - 2), { t: '  ' + t, s: st.dim }] };
  };
  return {
    legend: [{ t: 'next message', s: st.accent }, { t: ' · exactly what the AI gets', s: st.dim }],
    rows: [
      ...ps.map((p) => row(p.what, fmtK(p.tok), st.fg)),
      row('total', fmtK(tot), st.title),
      { line: [], rule: 'full' },
      { line: [{ t: LEAD, s: st.dim }, { t: 'esc', s: st.accentB }, { t: ' close', s: st.dim }], segs: [{ x0: LEAD.length + 1, x1: LEAD.length + 3, id: 'key:esc' }] },
    ],
  };
}
