// The context view: what the model has in front of it right now, piece by piece
// with what each costs in tokens, and how full the context window is. x drops a
// tool result or an attachment you no longer need (the cache after it is rebuilt
// once); enter shows a piece in full.

import { type Key, type Line } from '../../core/term.ts';
import { type Hint } from '../../core/view.ts';
import { fmtT } from '../token-kit/meter.ts';
import type { Block, Message } from '../../providers/types.ts';
import type { ToolDef } from '../../core/tools.ts';
import { type Kit, type View, char, cursor, row } from './kit.ts';

export type Piece = { label: string; kind: 'fixed' | 'you' | 'rime' | 'tool' | 'result' | 'file' | 'note'; tokens: number; at?: [number, number]; drop: boolean; text: string };

export const DROPPED = '[dropped by the user to save context]';
const tok = (s: string) => Math.ceil(s.length / 4);
const first = (s: string, n = 60) => s.replace(/\s+/g, ' ').trim().slice(0, n);

// The pieces of a conversation's context, in the order the model reads them.
export function piecesOf(system: string, tools: ToolDef[], messages: Message[]): Piece[] {
  const out: Piece[] = [];
  const agents = system.indexOf('\n\nAGENTS.md:\n');
  out.push({ label: 'system prompt', kind: 'fixed', tokens: tok(agents >= 0 ? system.slice(0, agents) : system), drop: false, text: agents >= 0 ? system.slice(0, agents) : system });
  if (agents >= 0) out.push({ label: 'AGENTS.md and the repo map', kind: 'fixed', tokens: tok(system.slice(agents)), drop: false, text: system.slice(agents) });
  out.push({ label: `tools (${tools.length})`, kind: 'fixed', tokens: tok(JSON.stringify(tools)), drop: false, text: tools.map((t) => `${t.name}: ${t.description}`).join('\n') });
  const calls = new Map<string, string>(); // tool_use id -> "bash npm test"
  messages.forEach((m, mi) => {
    if (m.role === 'system') return;
    const blocks: Block[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    blocks.forEach((b, bi) => {
      const at: [number, number] = [mi, bi];
      if (b.type === 'text') {
        const t = String(b.text ?? '');
        if (!t.trim()) return;
        // An attachment ([file notes.md] …, [text 1] …) or a file the code index added.
        const file = /^\[((?:file|text|folder) [^\]]+)\]/.exec(t)?.[1] ?? (/^\[Rime: from the code index, likely relevant: (.+?)\]/.exec(t) ? `file ${/likely relevant: (.+?)\]/.exec(t)![1]}` : null);
        if (file && bi > 0) return void out.push({ label: file, kind: 'file', tokens: tok(t), at, drop: true, text: t });
        if (t === DROPPED) return void out.push({ label: 'dropped', kind: 'note', tokens: tok(t), at, drop: false, text: t });
        if (t.startsWith('[Rime: the conversation so far')) return void out.push({ label: 'summary of the earlier conversation', kind: 'note', tokens: tok(t), at, drop: false, text: t });
        if (t.startsWith('[Rime: ')) return void out.push({ label: `note: ${first(t.slice(7))}`, kind: 'note', tokens: tok(t), at, drop: false, text: t });
        return void out.push({ label: `${m.role === 'user' ? 'you' : 'Rime'}: ${first(t)}`, kind: m.role === 'user' ? 'you' : 'rime', tokens: tok(t), at, drop: false, text: t });
      }
      if (b.type === 'thinking') return void out.push({ label: 'thinking', kind: 'rime', tokens: tok(String(b.thinking ?? '')), at, drop: false, text: String(b.thinking ?? '') });
      if (b.type === 'image') return void out.push({ label: 'image', kind: 'file', tokens: 1600, at, drop: false, text: '(an image)' });
      if (b.type === 'tool_use') {
        const i = (b.input ?? {}) as Record<string, unknown>;
        const what = `${b.name} ${first(String(i.command ?? i.path ?? i.query ?? i.action ?? i.question ?? ''), 50)}`.trim();
        calls.set(String(b.id), what);
        return void out.push({ label: `call ${what}`, kind: 'tool', tokens: tok(JSON.stringify(b.input ?? {})), at, drop: false, text: JSON.stringify(b.input ?? {}, null, 2) });
      }
      if (b.type === 'tool_result') {
        const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        return void out.push({ label: `result ${calls.get(String(b.tool_use_id)) ?? ''}`.trim(), kind: 'result', tokens: tok(t), at, drop: t !== DROPPED && t.length > 200, text: t });
      }
    });
  });
  return out;
}

export function contextView(kit: Kit & { pieces(): Piece[]; window(): number | undefined; sent(): { prompt: number; cached: number } | null; drop(at: [number, number]): void }) {
  const { st } = kit;
  const c = cursor();
  let bySize = false;
  let sure = -1; // x pressed once on this row
  let full: { label: string; lines: string[]; scroll: number } | null = null;
  let shownRows = 10;

  const list = () => {
    const ps = kit.pieces().map((p, i) => ({ ...p, i }));
    return bySize ? [...ps].sort((a, b) => b.tokens - a.tokens) : ps;
  };
  const total = () => kit.pieces().reduce((n, p) => n + p.tokens, 0);

  const view: View = {
    id: 'context',
    title: 'context',
    badge() {
      const win = kit.window(), used = kit.sent()?.prompt ?? total();
      if (!win || !used || !kit.pieces().some((p) => p.kind !== 'fixed')) return null;
      const pct = Math.round((used / win) * 100);
      return { t: ` ${pct}%`, s: pct >= 80 ? st.warn : st.dim };
    },
    render(w, rows) {
      shownRows = rows;
      if (full) {
        full.scroll = Math.max(0, Math.min(full.scroll, Math.max(0, full.lines.length - rows + 1)));
        return [[{ t: full.label, s: st.titleB }], ...full.lines.slice(full.scroll, full.scroll + rows - 1).map((l): Line => [{ t: l, s: st.fg }])];
      }
      const ps = list(), win = kit.window(), sent = kit.sent();
      const used = sent?.prompt ?? total();
      const head: Line[] = [];
      if (win) {
        const n = Math.max(4, Math.min(24, w - 30)), on = Math.round((Math.min(used, win) / win) * n);
        head.push([{ t: '▰'.repeat(on), s: used / win >= 0.8 ? st.warn : st.accent }, { t: '▱'.repeat(n - on), s: st.line }, { t: ` ${fmtT(used)} of ${fmtT(win)} · ${Math.round((used / win) * 100)}%`, s: st.title }]);
      } else head.push([{ t: `${fmtT(used)} tokens`, s: st.title }]);
      head.push([{ t: sent ? `last request: ${fmtT(sent.cached)} read from the cache` : 'nothing sent yet in this conversation', s: st.dim }, { t: bySize ? ' · biggest first' : '', s: st.dim }]);
      const room = rows - head.length;
      c.clamp(ps.length, room);
      const body = ps.slice(c.top, c.top + room).map((p, i): Line => {
        const on = c.top + i === c.at;
        const s = p.kind === 'fixed' ? st.dim : p.kind === 'you' ? st.title : p.kind === 'result' || p.kind === 'file' ? st.fg : st.dim;
        return row(on, [{ t: p.label, s: sure === p.i && on ? st.warn : s }], [{ t: fmtT(p.tokens), s: p.tokens > 2000 ? st.warn : st.dim }], w, st);
      });
      return [...head, ...body];
    },
    foot(): Hint[] {
      if (full) return [['↑ ↓', ' scroll · '], ['esc', ' back']];
      const p = list()[c.at];
      if (sure >= 0 && p && sure === p.i) return [['', 'drop it? the cache after it is rebuilt once · ', st.warn], ['x', ' drop · '], ['esc', ' keep']];
      return [['enter', ' show · '], ...(p?.drop ? [['x', ' drop · '] as Hint] : []), ['s', bySize ? ' in order' : ' biggest first']];
    },
    key(k: Key) {
      const ch = char(k);
      if (full) {
        if (k.name === 'escape') return (full = null), true;
        const page = Math.max(1, shownRows - 3);
        if (k.name === 'down') full.scroll++;
        else if (k.name === 'up') full.scroll = Math.max(0, full.scroll - 1);
        else if (k.ctrl && k.name === 'd') full.scroll += page;
        else if (k.ctrl && k.name === 'u') full.scroll = Math.max(0, full.scroll - page);
        return true;
      }
      const ps = list(), p = ps[c.at];
      if (k.name === 'escape') return sure >= 0 ? ((sure = -1), true) : 'back';
      if (ch !== 'x') sure = -1;
      if (ch === 's') return (bySize = !bySize), (c.at = 0), true;
      if (c.move(k, ps.length, Math.max(1, shownRows - 4))) return true;
      if (!p) return true;
      if (k.name === 'enter') return (full = { label: `${p.label} · ${fmtT(p.tokens)} tokens`, lines: p.text.split('\n'), scroll: 0 }), true;
      if (ch === 'x' && p.drop && p.at) {
        if (sure !== p.i) return (sure = p.i), true;
        sure = -1;
        kit.drop(p.at);
        kit.toast(`dropped ${fmtT(p.tokens)} tokens`);
      }
      return true;
    },
    click(r) {
      c.at = c.top + r - 2;
    },
    wheel(d) {
      if (full) full.scroll = Math.max(0, full.scroll + d);
      else c.at = Math.max(0, c.at + d);
    },
    read() {
      const win = kit.window(), used = kit.sent()?.prompt ?? total();
      const big = [...kit.pieces()].sort((a, b) => b.tokens - a.tokens).slice(0, 8);
      return `${fmtT(used)} tokens in context${win ? ` of ${fmtT(win)}` : ''}. Biggest: ${big.map((p) => `${p.label} ${fmtT(p.tokens)}`).join('; ')}`;
    },
  };
  return view;
}
