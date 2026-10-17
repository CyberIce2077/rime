// The plan view: the model's steps for a longer task (rime plan), done, now and
// next. You can tick a step, drop it, move it or add one before Rime gets there;
// Rime hears about your changes with your next message.

import { type Key, type Line } from '../../core/term.ts';
import { type Hint } from '../../core/view.ts';
import { type Kit, type View, char, cursor, extend, lineInput } from './kit.ts';

export type Step = { text: string; state: 'done' | 'now' | 'next' };

// The steps from the rime tool's args, tolerant of how a model writes them:
// [{text, state}], ["a", "b"], or {steps: …}.
export function stepsOf(v: unknown): Step[] | null {
  const list = Array.isArray(v) ? v : v && typeof v === 'object' && Array.isArray((v as { steps?: unknown }).steps) ? (v as { steps: unknown[] }).steps : null;
  if (!list) return null;
  return list
    .map((x): Step | null => {
      if (typeof x === 'string') return { text: x, state: 'next' };
      if (!x || typeof x !== 'object') return null;
      const o = x as Record<string, unknown>;
      const text = String(o.text ?? o.step ?? o.title ?? '').trim();
      const s = String(o.state ?? o.status ?? 'next').toLowerCase();
      return text ? { text, state: /done|complete|finished/.test(s) ? 'done' : /now|doing|progress|current|active/.test(s) ? 'now' : 'next' } : null;
    })
    .filter((x): x is Step => !!x)
    .slice(0, 30);
}

export function planView(kit: Kit & { changed(steps: Step[]): void }) {
  const { st } = kit;
  let steps: Step[] = [];
  const c = cursor();
  let adding: ReturnType<typeof lineInput> | null = null;
  let shownRows = 10;
  const changed = () => kit.changed(steps.map((s) => ({ ...s })));

  const view: View = {
    id: 'plan',
    title: 'plan',
    badge() {
      if (!steps.length) return null;
      const done = steps.filter((s) => s.state === 'done').length;
      return { t: ` ${done}/${steps.length}`, s: done === steps.length ? st.ok : st.accent };
    },
    typing: () => !!adding,
    render(w, rows) {
      shownRows = rows;
      const room = rows - (adding ? 2 : 0);
      if (!steps.length && !adding) return [[{ t: 'No plan yet.', s: st.dim }], [], [{ t: 'Rime keeps its plan here for longer tasks.', s: st.dim }], [{ t: 'a adds a step of your own.', s: st.dim }]];
      c.clamp(steps.length, room);
      const out = steps.slice(c.top, c.top + room).map((s, i): Line => {
        const on = c.top + i === c.at;
        const [icon, style] = s.state === 'done' ? ['✓', st.ok] : s.state === 'now' ? ['▸', st.accentB] : ['○', st.dim];
        return [{ t: on ? '› ' : '  ', s: st.accent }, { t: `${icon} `, s: style }, { t: s.text, s: s.state === 'done' ? st.dim : s.state === 'now' ? st.titleB : on ? st.title : st.fg }];
      });
      void w;
      return adding ? [...out, ...new Array(Math.max(0, room - out.length)).fill([]), [], adding.line([{ t: '+ ', s: st.accentB }], 'a step to add', st)] : out;
    },
    foot(): Hint[] {
      if (adding) return [['enter', ' add · '], ['esc', ' cancel']];
      if (!steps.length) return [['a', ' add a step']];
      return [['enter', ' done / not done · '], ['x', ' drop · '], ['k j', ' move up, down · '], ['a', ' add']];
    },
    key(k: Key) {
      const ch = char(k);
      if (adding) {
        if (k.name === 'escape') return (adding = null), true;
        if (k.name === 'enter') {
          const t = adding.value.trim();
          adding = null;
          if (t) steps.splice(steps.length ? c.at + 1 : 0, 0, { text: t, state: 'next' }), (c.at = steps.length > 1 ? c.at + 1 : 0), changed();
          return true;
        }
        adding.edit(k);
        return true;
      }
      if (k.name === 'escape') return 'back';
      if (ch === 'a') return (adding = lineInput()), true;
      if (c.move(k, steps.length, Math.max(1, shownRows - 2))) return true;
      const s = steps[c.at];
      if (!s) return true;
      if (k.name === 'enter') return (s.state = s.state === 'done' ? 'next' : 'done'), changed(), true;
      if (ch === 'x') return steps.splice(c.at, 1), changed(), true;
      if ((ch === 'k' && c.at > 0) || (ch === 'j' && c.at < steps.length - 1)) {
        const to = c.at + (ch === 'k' ? -1 : 1);
        [steps[c.at], steps[to]] = [steps[to], steps[c.at]];
        c.at = to;
        changed();
      }
      return true;
    },
    click(r) {
      c.at = c.top + r;
    },
    read() {
      return steps.length ? steps.map((s, i) => `${i + 1}. [${s.state}] ${s.text}`).join('\n') : 'No plan.';
    },
  };
  return extend(view, {
    get steps() {
      return steps;
    },
    // From the model (rime plan) or a reopened conversation: it replaces the list.
    set(next: Step[]) {
      steps = next;
      kit.redraw();
    },
  });
}
export type PlanView = ReturnType<typeof planView>;
