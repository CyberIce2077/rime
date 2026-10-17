// The log view: every tool call in this conversation, in order, with exactly
// what went in and what came back to the model. enter opens one in full.

import { type Key, type Line } from '../../core/term.ts';
import { type Hint } from '../../core/view.ts';
import type { Block, Message } from '../../providers/types.ts';
import { type Kit, type View, cursor, row } from './kit.ts';

export type Entry = { id: string; name: string; input: Record<string, unknown>; result?: string; error?: boolean };

// The calls and their results from the message list; a call without a result
// yet is still running (or waiting for an answer).
export function entriesOf(messages: Message[]): Entry[] {
  const out: Entry[] = [], byId = new Map<string, Entry>();
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content as Block[]) {
      if (b.type === 'tool_use') {
        const e: Entry = { id: String(b.id), name: String(b.name), input: (b.input ?? {}) as Record<string, unknown> };
        out.push(e);
        byId.set(e.id, e);
      } else if (b.type === 'tool_result') {
        const e = byId.get(String(b.tool_use_id));
        if (e) (e.result = typeof b.content === 'string' ? b.content : JSON.stringify(b.content)), (e.error = !!b.is_error);
      }
    }
  }
  return out;
}

const what = (e: Entry) => String(e.input.command ?? e.input.path ?? e.input.query ?? e.input.question ?? e.input.action ?? '').split('\n')[0];

export function logView(kit: Kit & { entries(): Entry[] }) {
  const { st } = kit;
  const c = cursor();
  let full: { lines: Line[]; scroll: number } | null = null;
  let shownRows = 10;
  let follow = true; // the cursor stays on the newest call until you move up

  function detail(e: Entry): Line[] {
    const lines: Line[] = [[{ t: `${e.name} `, s: st.titleB }, { t: what(e), s: st.title }], []];
    const input = e.name === 'bash' ? String(e.input.command ?? '') : e.name === 'write' ? `${e.input.path}\n${e.input.content ?? ''}` : e.name === 'edit' ? `${e.input.path}\n- ${String(e.input.old ?? '').split('\n').join('\n- ')}\n+ ${String(e.input.new ?? '').split('\n').join('\n+ ')}` : JSON.stringify(e.input, null, 2);
    lines.push([{ t: 'in', s: st.dim }], ...input.split('\n').map((l): Line => [{ t: `  ${l}`, s: l.startsWith('+ ') ? st.ok : l.startsWith('- ') ? st.del : st.fg }]), []);
    lines.push([{ t: e.result === undefined ? 'running…' : e.error ? 'out (error)' : 'out', s: e.error ? st.warn : st.dim }], ...(e.result ?? '').split('\n').map((l): Line => [{ t: `  ${l}`, s: st.fg }]));
    return lines;
  }

  const view: View = {
    id: 'log',
    title: 'log',
    badge: () => null,
    render(w, rows) {
      shownRows = rows;
      if (full) {
        full.scroll = Math.max(0, Math.min(full.scroll, Math.max(0, full.lines.length - rows)));
        return full.lines.slice(full.scroll, full.scroll + rows);
      }
      const es = kit.entries();
      if (!es.length) return [[{ t: 'No tool calls yet.', s: st.dim }], [], [{ t: "Each tool call Rime makes, and what came back.", s: st.dim }]];
      // Newest at the bottom, like the chat; it follows new calls unless you moved up.
      if (follow) c.at = es.length - 1;
      c.clamp(es.length, rows);
      return es.slice(c.top, c.top + rows).map((e, i): Line => {
        const on = c.top + i === c.at;
        const mark = e.result === undefined ? { t: '⟳ ', s: st.accent } : e.error ? { t: '✗ ', s: st.del } : { t: '✓ ', s: st.ok };
        const size = e.result !== undefined ? `${e.result.split('\n').length} lines` : '';
        return row(on, [mark, { t: e.name, s: st.titleB }, { t: ` ${what(e)}`, s: st.fg }], [{ t: size, s: st.dim }], w, st);
      });
    },
    foot(): Hint[] {
      return full ? [['↑ ↓', ' scroll · '], ['esc', ' back']] : [['↑ ↓', ' move · '], ['enter', ' open']];
    },
    key(k: Key) {
      if (full) {
        if (k.name === 'escape') return (full = null), true;
        const page = Math.max(1, shownRows - 2);
        if (k.name === 'down') full.scroll++;
        else if (k.name === 'up') full.scroll = Math.max(0, full.scroll - 1);
        else if (k.ctrl && k.name === 'd') full.scroll += page;
        else if (k.ctrl && k.name === 'u') full.scroll = Math.max(0, full.scroll - page);
        return true;
      }
      if (k.name === 'escape') return 'back';
      const es = kit.entries();
      if (c.move(k, es.length, Math.max(1, shownRows - 2))) return (follow = c.at >= es.length - 1), true;
      if (k.name === 'enter' && es[c.at]) full = { lines: detail(es[c.at]), scroll: 0 };
      return true;
    },
    click(r) {
      c.at = c.top + r;
      follow = false;
    },
    wheel(d) {
      if (full) full.scroll = Math.max(0, full.scroll + d);
      else (c.at = Math.max(0, c.at + d)), (follow = false);
    },
  };
  return view;
}
