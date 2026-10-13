// Worker models Rime can run the main loop on. Prices are $ per million tokens
// (cache writes use the 5-minute TTL, 1.25x input).

export type Price = { in: number; read: number; write: number; out: number };
export type Model = { id: string; label: string; context: string; price: Price };

export const MODELS: Model[] = [
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', context: '1M', price: { in: 2, read: 0.2, write: 2.5, out: 10 } },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', context: '1M', price: { in: 4, read: 0.2, write: 5, out: 20 } },
];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export const DEFAULT_MODEL = MODELS[0];
export const DEFAULT_EFFORT: Effort = 'medium';

export const findModel = (idOrName: string) =>
  MODELS.find((m) => m.id === idOrName || m.label.toLowerCase().startsWith(idOrName.toLowerCase()));
