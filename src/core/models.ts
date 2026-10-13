// Worker models Rime can run the main loop on. Prices are $ per million tokens
// (cache writes use the 5-minute TTL, 1.25x input).

export type Price = { in: number; read: number; write: number; out: number };
export type Model = { id: string; label: string; context: string; price: Price };

// Empty for now: which models Rime offers is decided in a later step (2026-10-13).
export const MODELS: Model[] = [];

export const findModel = (idOrName: string) =>
  MODELS.find((m) => m.id === idOrName || m.label.toLowerCase().startsWith(idOrName.toLowerCase()));
