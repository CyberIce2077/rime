// The model's plan for a longer task (rime plan): steps done, now and next. It
// shows above the chat prompt while it has steps left.

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
