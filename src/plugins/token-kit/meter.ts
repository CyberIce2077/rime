// Live cost meter: tokens, dollars, and what Rime saved versus a naive loop
// (SPEC §4.4). Usage arrives normalized across providers (docs/providers.md §2.1).
// Local models cost $0, so for them the meter counts the time the cache saved.

import type { Price, Usage } from '../../providers/types.ts';

export type Turn = {
  in: number;
  cached: number;
  out: number;
  spent?: number; // undefined when the price is unknown
  saved: number;
  local?: boolean;
  promptMs?: number;
  savedMs?: number; // local: time the cache saved
};

const usd = (tokens: number, perM: number) => (tokens * perM) / 1e6;

export const fmtT = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
export const fmt$ = (d: number): string => {
  if (d < 0) return '-' + fmt$(-d);
  return d < 0.01 && d >= 0.0005 ? '$' + d.toFixed(3) : '$' + d.toFixed(2);
};
export const fmtS = (ms: number) => (ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);

export function createMeter() {
  const t = { uncached: 0, read: 0, write: 0, out: 0 };
  const cost = { uncached: 0, read: 0, write: 0, out: 0 };
  const saved = { cache: 0, ms: 0 };
  let unpriced = false;

  return {
    tokens: t,
    cost,
    saved,
    unpriced: () => unpriced,
    // Records one response and returns its cost line.
    charge(u: Usage, p: Price | undefined, local = false): Turn {
      t.uncached += u.input; t.read += u.cached; t.write += u.written; t.out += u.output;
      const turn: Turn = { in: u.input + u.cached + u.written, cached: u.cached, out: u.output, saved: 0, local, promptMs: u.promptMs };
      if (local && u.promptMs && u.input > 0) {
        // The cached part would have taken as long per token as the part that ran.
        turn.savedMs = u.cached * (u.promptMs / u.input);
        saved.ms += turn.savedMs;
      }
      if (!p) {
        unpriced = true;
        return turn;
      }
      const c = { uncached: usd(u.input, p.in), read: usd(u.cached, p.read), write: usd(u.written, p.write), out: usd(u.output, p.out) };
      cost.uncached += c.uncached; cost.read += c.read; cost.write += c.write; cost.out += c.out;
      // Caching saves the difference on reads and pays a premium on writes.
      turn.saved = usd(u.cached, p.in - p.read) - usd(u.written, p.write - p.in);
      saved.cache += turn.saved;
      turn.spent = c.uncached + c.read + c.write + c.out;
      return turn;
    },
    totalTokens: () => t.uncached + t.read + t.write + t.out,
    spent: () => cost.uncached + cost.read + cost.write + cost.out,
    savedTotal: () => saved.cache,
    pct() {
      const sp = this.spent(), sv = this.savedTotal();
      return Math.round((sv / (sp + sv)) * 100) || 0;
    },
  };
}

export type Meter = ReturnType<typeof createMeter>;
