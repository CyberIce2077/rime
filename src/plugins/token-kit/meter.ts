// Live cost meter: tokens, dollars, and what Rime saved versus a naive loop
// (SPEC §4.4). Counts come from the API's usage block on each response.

import type { Price } from '../../core/models.ts';

export type Usage = {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
};

export type Turn = { in: number; cached: number; out: number; spent: number; saved: number };

const usd = (tokens: number, perM: number) => (tokens * perM) / 1e6;

export const fmtT = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
export const fmt$ = (d: number): string => {
  if (d < 0) return '-' + fmt$(-d);
  return d < 0.01 && d >= 0.0005 ? '$' + d.toFixed(3) : '$' + d.toFixed(2);
};

export function createMeter() {
  const t = { uncached: 0, read: 0, write: 0, out: 0 };
  const cost = { uncached: 0, read: 0, write: 0, out: 0 };
  const saved = { cache: 0 };

  return {
    tokens: t,
    cost,
    saved,
    // Records one API response and returns its cost line.
    charge(u: Usage, p: Price): Turn {
      const unc = u.input_tokens || 0, read = u.cache_read_input_tokens || 0;
      const write = u.cache_creation_input_tokens || 0, out = u.output_tokens || 0;
      t.uncached += unc; t.read += read; t.write += write; t.out += out;
      const c = { uncached: usd(unc, p.in), read: usd(read, p.read), write: usd(write, p.write), out: usd(out, p.out) };
      cost.uncached += c.uncached; cost.read += c.read; cost.write += c.write; cost.out += c.out;
      // Caching saves the difference on reads and pays a premium on writes.
      const sv = usd(read, p.in - p.read) - usd(write, p.write - p.in);
      saved.cache += sv;
      return { in: unc + read + write, cached: read, out, spent: c.uncached + c.read + c.write + c.out, saved: sv };
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
