// The setup loader (docs/providers.md §3.3, reference/rime-setup.html): the ice
// cube starts as dark water and freezes pixel by pixel from the bottom row up as
// setup progresses, snow falls beside him, and he blinks once when he's ready.

import { PALETTE, SCENE, SPRITE, pixelCells } from '../core/header.ts';
import type { Line } from '../core/term.ts';
import type { ColorMode, RGB } from '../core/theme.ts';

const hex = (s: string): RGB => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)) as RGB;
const WATER = hex('#163047'), WATER2 = hex('#21445F'), SNOW = hex('#E6F3FA');
const { COLS, ROWS, SX, SY } = SCENE;
const W = SPRITE[0].length;

// Sprite pixels in freezing order: bottom row first, left to right.
const PIX = SPRITE.flatMap((row, y) => [...row].map((k, x) => ({ x, y, k })).filter((p) => p.k !== '.')).sort((a, b) => b.y - a.y || a.x - b.x);

export function createLoader(rnd = Math.random) {
  let flakes: { x: number; y: number }[] = [];
  const ground = new Array(COLS).fill(0);
  let last = 0;

  // Snow falls beside him (never over his face) and settles up to two deep.
  function tick(now: number, falling: boolean) {
    if (now - last < 180) return;
    last = now;
    flakes = flakes
      .map((f) => ({ ...f, y: f.y + 1 }))
      .filter((f) => {
        const onHim = f.x >= SX && f.x < SX + W;
        const below = f.y + 1;
        if (below >= ROWS - ground[f.x] || (onHim && below >= SY)) {
          if (!onHim) ground[f.x] = Math.min(2, ground[f.x] + 1);
          return false;
        }
        return true;
      });
    if (falling && rnd() < 0.5) {
      const side = [0, 1, 10, 11, 3, 6, 8];
      flakes.push({ x: side[Math.floor(rnd() * side.length)], y: -1 });
    }
  }

  function pixels(frozen: number, now: number, blink = false) {
    const g: (RGB | null)[][] = Array.from({ length: ROWS }, () => new Array(COLS).fill(null));
    const n = Math.round(Math.max(0, Math.min(1, frozen)) * PIX.length);
    PIX.forEach((p, i) => {
      let c: RGB;
      if (i < n) c = blink && p.k === 'D' && SPRITE[p.y - 1][p.x] !== 'D' ? PALETTE.A : PALETTE[p.k];
      else c = Math.sin(now / 260 + (p.x + p.y) * 0.9) > 0.35 ? WATER2 : WATER;
      g[SY + p.y][SX + p.x] = c;
    });
    ground.forEach((h, x) => {
      for (let k = 0; k < h; k++) g[ROWS - 1 - k][x] = SNOW;
    });
    for (const f of flakes) if (f.y >= 0 && f.y < ROWS && !g[f.y][f.x]) g[f.y][f.x] = SNOW;
    return g;
  }

  // The three lines of the cube, as styled cells.
  const cells = (frozen: number, now: number, mode: ColorMode, blink = false): Line[] =>
    pixelCells(pixels(frozen, now, blink), mode).map((l) => l.map((c) => ({ t: c.t, s: c.s })));

  return { tick, pixels, cells, ground };
}

export type Loader = ReturnType<typeof createLoader>;

// 24 cells of ▰▱ and a percentage.
export function bar(f: number, width = 24) {
  const fill = Math.round(Math.max(0, Math.min(1, f)) * width);
  return { fill: '▰'.repeat(fill), empty: '▱'.repeat(width - fill), pct: `${String(Math.round(f * 100)).padStart(3)}%` };
}
