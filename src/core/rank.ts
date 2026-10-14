// Describe-it search (SPEC §16), plain JS with no model: time phrases become a
// date filter, file names and outcome words ("fixed", "crashed") are matched
// against the timeline, the rest goes to FTS5. Ported from the mockup's search()
// (reference/rime-conversations.html), behind one function so something smarter
// can replace it later.

export type Conv = { id: number; title: string; updated: number; model: string | null; timeline: { kind: string; text: string }[] };
export type Query = { words: string[]; files: string[]; kinds: Set<string>; range: [number, number, string] | null; file: string | null; model: string | null };
export type Ranked = { id: number; score: number; reason: string; hits: number[] };

const STOP = new Set('the a an one where we i it that this with and or of to in on for was were is are about from my our some when which what did do had have'.split(' '));
// Outcome words and the timeline kinds they point at.
const OUTCOME: Record<string, string[]> = {
  fixed: ['edit', 'commit'], fix: ['edit', 'commit'], crashed: ['error'], crash: ['error'], failed: ['error', 'test'], failing: ['error', 'test'], error: ['error'], broke: ['error'],
  tests: ['test'], test: ['test'], committed: ['commit'], commit: ['commit'], pinned: ['pin'], loaded: ['server'], unloaded: ['server'], attached: ['attach'],
};
const DAY = 86400000;
const TIMES = /\b(today|this morning|yesterday|last week|this week|last month|this month)\b/g;
export const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, '');

function range(q: string, now: number): [number, number, string] | null {
  const day = new Date(now).setHours(0, 0, 0, 0);
  const month = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();
  if (/\btoday\b|this morning/.test(q)) return [day, now, 'today'];
  if (/\byesterday\b/.test(q)) return [day - DAY, day, 'yesterday'];
  if (/last week/.test(q)) return [day - 13 * DAY, day - 6 * DAY, 'last week'];
  if (/this week/.test(q)) return [day - 6 * DAY, now, 'this week'];
  if (/last month/.test(q)) return [new Date(new Date(month).setMonth(new Date(month).getMonth() - 1)).getTime(), month, 'last month'];
  if (/this month/.test(q)) return [month, now, 'this month'];
  return null;
}

export function parse(raw: string, now = Date.now()): Query {
  let file: string | null = null, model: string | null = null;
  let rest = raw.toLowerCase().replace(/\bfile:(\S+)/, (_, f) => ((file = f), ' ')).replace(/\bmodel:(\S+)/, (_, m) => ((model = m), ' '));
  const r = range(rest, now);
  rest = rest.replace(TIMES, ' ');
  const words = rest.split(/[^\p{L}\p{N}_.:/-]+/u).map((w) => w.replace(/^[.:/-]+|[.:/-]+$/g, '')).filter((w) => w && !STOP.has(w));
  return { words, files: words.filter((w) => /\w\.\w+$/.test(w)), kinds: new Set(words.flatMap((w) => OUTCOME[w] ?? [])), range: r, file, model };
}

// `inText(word)`: the conversations whose messages hold the word (from FTS5).
export function rank(Q: Query, convs: Conv[], inText: (word: string) => Set<number>, now = Date.now()): Ranked[] {
  const text = new Map(Q.words.map((w) => [w, inText(w)]));
  const out: Ranked[] = [];
  for (const c of convs) {
    if (Q.model && !(c.model ?? '').toLowerCase().includes(Q.model)) continue;
    const tl = c.timeline.map((t) => t.text.toLowerCase());
    if (Q.file && !tl.some((t) => t.includes(Q.file!)) && !c.title.toLowerCase().includes(Q.file)) continue;
    if (Q.range && (c.updated < Q.range[0] || c.updated > Q.range[1])) continue;
    let score = 0, title = false;
    const hits = new Set<number>();
    for (const w of Q.words) {
      const s = stem(w);
      if (s.length < 2) continue;
      if (c.title.toLowerCase().split(/[^\p{L}\p{N}_]+/u).some((x) => x.startsWith(s))) (score += 3), (title = true);
      const i = tl.findIndex((t) => t.split(/[^\p{L}\p{N}_.]+/u).some((x) => x.startsWith(s)));
      if (i >= 0) (score += 2), hits.add(i);
      if (text.get(w)?.has(c.id)) score += 1;
    }
    for (const f of Q.files) {
      const i = tl.findIndex((t) => t.includes(f));
      if (i >= 0) (score += 3), hits.add(i);
    }
    c.timeline.forEach((t, i) => Q.kinds.has(t.kind) && ((score += 1), hits.add(i)));
    if (Q.file) (score += 3), tl.forEach((t, i) => t.includes(Q.file!) && hits.add(i));
    if (!Q.words.length && (Q.range || Q.file || Q.model)) score += 1;
    if (score <= 0) continue;
    score += Math.max(0, 2 - (now - c.updated) / (7 * DAY)); // recency boost
    const first = [...hits][0];
    const reason = (first !== undefined ? `timeline: ${c.timeline[first].text}` : title ? 'title' : 'messages') + (Q.range ? ` · ${Q.range[2]}` : '');
    out.push({ id: c.id, score, reason, hits: [...hits] });
  }
  return out.sort((a, b) => b.score - a.score);
}

// Suggestions under the search field: names from the timelines (files, commands,
// error words) that start like the last word typed, then the filters.
export function suggestions(q: string, convs: Conv[]): string[] {
  const last = q.toLowerCase().split(/\s+/).pop() ?? '';
  const bare = last.replace(/^file:/, '');
  const pool = new Set<string>();
  for (const c of convs) for (const t of c.timeline) for (const w of t.text.split(/[\s·(),"']+/)) if (/\w\.\w/.test(w) || /^(npm|git|node|pnpm|yarn|cargo|go|make|pytest|\w+Error)\b/.test(w)) pool.add(w.replace(/:\d+$/, ''));
  const words = bare.length >= 2 ? [...pool].filter((w) => w.toLowerCase().startsWith(bare) && w.toLowerCase() !== bare) : [];
  const filters = last ? ['file:', 'model:', 'failed', 'today', 'this week', 'last week'].filter((f) => f.startsWith(last) && f !== last) : [];
  return [...words.slice(0, 4).map((w) => (last.startsWith('file:') || /\.\w+$/.test(w) ? 'file:' : '') + w), ...filters].slice(0, 6);
}
