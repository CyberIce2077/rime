// Rime startup header: the ice cube top left with three info lines beside it.
// Snow falls on startup, piles up around him, settles on his head and stops.
// Clicking him makes him blink. Ported from reference/rime-header.js.

import os from 'node:os';
import { type ColorMode, type RGB, BOLD, RESET, blend, colorMode, sgr } from './theme.ts';

// Mascot palette, taken from Mascot v10 (clean head).
const PALETTE: Record<string, RGB> = {
  A: [0xa8, 0xd8, 0xec], // ice body
  C: [0xc9, 0xea, 0xf6], // lit left edge
  S: [0x94, 0xcb, 0xe3], // shaded right edge
  W: [0xff, 0xff, 0xff], // shine
  D: [0x07, 0x11, 0x1a], // eyes
};

// Compact mascot, 8 x 5 pixels. Ground snow covers his bottom row.
const SPRITE = ['.AAAAAA.', 'CWAAAAAS', 'CADAADAS', 'CADAADAS', 'CAAAAAAS'];

// Scene: 12 x 6 pixels = 3 terminal lines. Row 0 is open sky where his snow cap
// settles; the mascot sits at column 2, row 1.
export const SCENE = { COLS: 12, ROWS: 6, TOP: 1, SX: 2, SY: 1 };

type Rnd = () => number;
type Flake = { c: number; r: number; b?: boolean; cap?: boolean };
export type SnowState = { near: Flake[]; far: Flake[]; heights: number[]; cap: number[] };

// Picks where the snow ends up for one run, keeping the same overall shape:
// - ground: always one pixel in front of him (so his eyes stay clear), drifts of
//   one or two beside him, and the outer edges either bare or lightly dusted;
// - cap: a bumpy layer across the top of his head, at least three pixels wide.
export function snowShape(rnd: Rnd) {
  const pick = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const ground = [pick(0, 1), pick(1, 2), pick(1, 2), 1, 1, 1, 1, 1, 1, pick(1, 2), pick(1, 2), pick(0, 1)];
  const head = [3, 4, 5, 6, 7, 8];
  let cap: number[];
  do {
    cap = new Array(SCENE.COLS).fill(0);
    for (const c of head) cap[c] = rnd() < 0.7 ? 1 : 0;
  } while (cap.reduce((a, b) => a + b) < 3);
  return { ground, cap };
}

const randomSeed = () => 1 + Math.floor(Math.random() * 2147483646);
const seededRandom = (seed: number): Rnd => () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};

const SNOW = {
  bg: [0x07, 0x11, 0x1a] as RGB, // assumed terminal background for blending
  far: [216, 236, 247] as RGB, farAlpha: 0.32,
  near: [0xf2, 0xfb, 0xff] as RGB,
  blur: [232, 246, 252] as RGB, blurAlpha: 0.7,
  top: [0xff, 0xff, 0xff] as RGB, mid: [0xe3, 0xf3, 0xfa] as RGB, base: [0xc9, 0xe6, 0xf2] as RGB,
};

const TEXT = {
  title: [0xf2, 0xf8, 0xfb] as RGB,
  accent: [0x7f, 0xd4, 0xf5] as RGB,
  dim: [0x7e, 0x99, 0xab] as RGB,
};

// Snowfall simulation, ported from Mascot v10. Flakes are aimed at open slots,
// drift sideways now and then, and land on the ground or on his head. Faint
// background flakes fall behind him at half speed. Each run gets a fresh random
// seed, so both the fall and the settled piles differ every time. Pass a seed to
// replay a run exactly.
export function createSnow(seed = randomSeed()) {
  const { COLS, ROWS, TOP } = SCENE;
  const rnd = seededRandom(seed);
  const { ground: GROUND, cap: CAP } = snowShape(rnd);
  const h = new Array(COLS).fill(0), res = new Array(COLS).fill(0);
  const cap = new Array(COLS).fill(0), cres = new Array(COLS).fill(0);
  let near: Flake[] = [], far: Flake[] = [], tick = 0;

  const openSlots = () => {
    const o: { c: number; cap: boolean }[] = [];
    for (let c = 0; c < COLS; c++) {
      if (h[c] + res[c] < GROUND[c]) o.push({ c, cap: false });
      if (cap[c] + cres[c] < CAP[c]) o.push({ c, cap: true });
    }
    return o;
  };

  // Advances one tick. Returns true once every flake has settled.
  function step() {
    tick++;
    const nn: Flake[] = [];
    for (const f of near) {
      let c = f.c;
      if (rnd() < 0.12) {
        const n = c + (rnd() < 0.5 ? -1 : 1);
        if (n >= 0 && n < COLS) {
          if (!f.cap && h[n] + res[n] < GROUND[n]) { res[c]--; res[n]++; c = n; }
          else if (f.cap && cap[n] + cres[n] < CAP[n]) { cres[c]--; cres[n]++; c = n; }
        }
      }
      const land = f.cap ? TOP - cap[c] : ROWS - 1 - h[c];
      if (f.r + 1 >= land) {
        if (f.cap) { cap[c]++; cres[c]--; } else { h[c]++; res[c]--; }
      } else nn.push({ c, r: f.r + 1, b: f.b, cap: f.cap });
    }
    near = nn;
    far = far.map((f) => ({ c: f.c, r: tick % 2 === 0 ? f.r + 1 : f.r })).filter((f) => f.r < ROWS);
    const o = openSlots();
    const share = Math.min(1, o.length / COLS);
    if (o.length && rnd() < 0.12 + 0.6 * share) {
      const p = o[Math.floor(rnd() * o.length)];
      if (p.cap) cres[p.c]++; else res[p.c]++;
      near.push({ c: p.c, r: 0, b: rnd() < 0.3, cap: p.cap });
    }
    if (o.length && rnd() < 0.05 + 0.35 * share) far.push({ c: Math.floor(rnd() * COLS), r: 0 });
    return !o.length && !near.length && !far.length;
  }

  return { step, state: (): SnowState => ({ near, far, heights: h, cap }) };
}

// A finished scene with no falling flakes, for when there is no animation.
export function settledSnow(seed = randomSeed()): SnowState {
  const { ground, cap } = snowShape(seededRandom(seed));
  return { near: [], far: [], heights: ground, cap };
}

// How long his eyes stay shut on a blink.
const BLINK_MS = 160;

// Composites one frame into a grid of RGB triples (null = terminal background).
// While blinking, the top half of each eye fills with ice, leaving a closed-eye line.
export function scenePixels(state: SnowState, blinking = false) {
  const { COLS, ROWS, TOP, SX, SY } = SCENE;
  const g: (RGB | null)[][] = Array.from({ length: ROWS }, () => new Array(COLS).fill(null));
  for (const f of state.far) g[f.r][f.c] = blend(SNOW.far, SNOW.farAlpha, SNOW.bg);
  SPRITE.forEach((row, y) => [...row].forEach((k, x) => {
    const shut = blinking && k === 'D' && SPRITE[y - 1][x] !== 'D';
    if (PALETTE[k]) g[SY + y][SX + x] = shut ? PALETTE.A : PALETTE[k];
  }));
  for (const f of state.near) g[f.r][f.c] = f.b ? blend(SNOW.blur, SNOW.blurAlpha, g[f.r][f.c] || SNOW.bg) : SNOW.near;
  state.heights.forEach((v, c) => {
    for (let k = 0; k < v; k++) g[ROWS - 1 - k][c] = k === v - 1 ? SNOW.top : k === 0 ? SNOW.base : SNOW.mid;
  });
  state.cap.forEach((v, c) => {
    for (let k = 0; k < v; k++) g[TOP - 1 - k][c] = k === v - 1 ? SNOW.top : SNOW.mid;
  });
  return g;
}

// How the pixels are drawn. 'blocks': two pixel rows per line with half blocks
// (3 lines). 'cells': each pixel is two colored spaces (6 lines), for terminals
// that draw ▀/▄ from the font with an offset, which stripes the mascot.
export type MascotStyle = 'blocks' | 'cells';

export function mascotStyle(env = process.env): MascotStyle {
  if (env.RIME_MASCOT === 'cells' || env.RIME_MASCOT === 'blocks') return env.RIME_MASCOT;
  return env.TERM_PROGRAM === 'Apple_Terminal' ? 'cells' : 'blocks';
}

function cellLines(g: (RGB | null)[][], mode: ColorMode) {
  return g.map((row) => row.map((p) => {
    if (mode === 'none') return p && p !== PALETTE.D ? '██' : '  ';
    return p ? sgr(p, true, mode) + '  ' : RESET(mode) + '  ';
  }).join('') + RESET(mode));
}

// Two pixel rows per terminal line using half blocks.
function pixelLines(g: (RGB | null)[][], mode: ColorMode) {
  const out: string[] = [];
  for (let y = 0; y < g.length; y += 2) {
    let line = '';
    for (let x = 0; x < g[y].length; x++) {
      const top = g[y][x], bot = g[y + 1][x];
      if (mode === 'none') {
        // Monochrome: everything solid except the eyes and empty sky.
        const on = (p: RGB | null) => p && p !== PALETTE.D;
        line += on(top) && on(bot) ? '█' : on(top) ? '▀' : on(bot) ? '▄' : ' ';
      } else if (!top && !bot) line += RESET(mode) + ' ';
      else if (top && !bot) line += RESET(mode) + sgr(top, false, mode) + '▀';
      else if (!top && bot) line += RESET(mode) + sgr(bot, false, mode) + '▄';
      else line += sgr(top!, false, mode) + sgr(bot!, true, mode) + '▀';
    }
    out.push(line + RESET(mode));
  }
  return out;
}

export function tildify(dir: string) {
  const home = os.homedir();
  return home && (dir === home || dir.startsWith(home + '/')) ? '~' + dir.slice(home.length) : dir;
}

export type HeaderOpts = {
  version?: string;
  model?: string;
  details?: string;
  cwd?: string;
  seed?: number;
  mode?: ColorMode;
  stream?: NodeJS.WriteStream;
  input?: NodeJS.ReadStream;
  interactive?: boolean;
  interval?: number;
  onKey?: (s: string) => void;
  style?: MascotStyle;
  // Rime addition: when the app owns the screen, it repaints on each frame instead
  // of the header writing to the terminal itself.
  onFrame?: () => void;
};

function infoLines(opts: HeaderOpts, mode: ColorMode) {
  const { version = '0.1.0', model = 'Opus 5.5', details = '1M context · high effort', cwd = process.cwd() } = opts;
  const c = (rgb: RGB) => sgr(rgb, false, mode);
  const R = RESET(mode);
  return [
    `${BOLD(mode)}${c(TEXT.title)}Rime${R} ${c(TEXT.dim)}v${version}${R}`,
    `${c(TEXT.accent)}${model}${R} ${c(TEXT.dim)}· ${details}${R}`,
    `${c(TEXT.dim)}${tildify(cwd)}${R}`,
  ];
}

// The header lines for one snow state (the settled scene by default): three with
// half blocks, six with cells, the info lines beside his body.
export function renderHeader(opts: HeaderOpts = {}, state = settledSnow(opts.seed), blinking = false) {
  const mode = opts.mode || colorMode(opts.stream || process.stdout);
  const info = infoLines(opts, mode);
  const g = scenePixels(state, blinking);
  if ((opts.style || mascotStyle()) === 'blocks') return pixelLines(g, mode).map((a, i) => ` ${a} ${info[i]}`);
  return cellLines(g, mode).map((a, i) => ` ${a} ${info[i - 2] ?? ''}`.trimEnd());
}

// Where his body is: 1-based columns (one leading space, then the scene) and
// line offsets from the header's first line.
export function cubeArea(style: MascotStyle) {
  const w = style === 'cells' ? 2 : 1;
  return {
    x0: 2 + w * SCENE.SX, x1: 1 + w * (SCENE.SX + SPRITE[0].length),
    y0: style === 'cells' ? SCENE.SY : 0, y1: style === 'cells' ? SCENE.SY + SPRITE.length - 1 : 2,
  };
}

export type Header = { blink(): void; close(): void; redraw(): void; lines(): string[] };

// Plays the snowfall in place and resolves once the snow has stopped, leaving the
// settled header on screen. Resolves to { blink(), close() }: clicks on him keep
// making him blink until close() is called.
//
// Clicks need mouse reporting, which puts stdin in raw mode and stops normal
// click-drag text selection (Shift+drag still selects in most terminals). Pass
// { interactive: false } to skip it, or feed your own mouse events to blink().
// Prints the settled header with no animation when output is not a color
// terminal or RIME_NO_ANIMATION is set.
//
// Rime additions: `opts.ready` receives the controller right away, so the app can
// read `lines()` while snow is still falling; `redraw()` repaints after the info
// lines change (e.g. /model).
export function playHeader(opts: HeaderOpts & { ready?: (h: Header) => void } = {}): Promise<Header> {
  const stream = opts.stream || process.stdout;
  const input = opts.input || process.stdin;
  const mode = opts.mode || colorMode(stream);
  const still = mode === 'none' || !!process.env.RIME_NO_ANIMATION;
  const interactive = opts.interactive !== false && mode !== 'none' && !!input.isTTY;

  const snow = still ? null : createSnow(opts.seed);
  const settled = still ? settledSnow(opts.seed) : null;
  const state = () => (snow ? snow.state() : settled!);
  let blinkUntil = 0;
  let headerRow = 0; // screen row of the first header line, once the terminal reports it
  let falling = !still;
  let first = true;
  let timer: NodeJS.Timeout | undefined;

  const style = opts.style || mascotStyle();
  const lines = () => renderHeader({ ...opts, mode, style }, state(), Date.now() < blinkUntil);

  const draw = () => {
    const ls = lines();
    if (opts.onFrame) opts.onFrame();
    else if (first) {
      stream.write(ls.join('\n') + '\n');
      first = false;
    } else if (falling || !headerRow) {
      // Cursor is still right below the header: step back up and redraw.
      stream.write(`\x1b[${ls.length}A` + ls.map((l) => '\r\x1b[2K' + l).join('\n') + '\n');
    } else {
      // Something may have printed since; redraw at the header's own row.
      stream.write('\x1b7' + ls.map((l, i) => `\x1b[${headerRow + i};1H\x1b[2K${l}`).join('') + '\x1b8');
    }
  };

  const blink = () => {
    if (mode === 'none') return;
    blinkUntil = Date.now() + BLINK_MS;
    draw();
    setTimeout(draw, BLINK_MS + 10);
  };

  let closed = false;
  const onData = (buf: Buffer) => {
    const s = buf.toString('utf8');
    if (s === '\x03') { close(); process.exit(130); }
    const cpr = /\x1b\[(\d+);(\d+)R/.exec(s);
    if (cpr && !headerRow) headerRow = Number(cpr[1]) - lines().length;
    const cube = cubeArea(style);
    for (const m of s.matchAll(/\x1b\[<(\d+);(\d+);(\d+)M/g)) {
      const [button, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const onCube = x >= cube.x0 && x <= cube.x1 && y >= headerRow + cube.y0 && y <= headerRow + cube.y1;
      if (button === 0 && headerRow > 0 && onCube) blink();
    }
    if (opts.onKey) opts.onKey(s);
  };

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    if (interactive) {
      stream.write('\x1b[?1006l\x1b[?1000l');
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
    }
    if (!opts.onFrame) stream.write('\x1b[?25h');
  }

  if (!still && !opts.onFrame) stream.write('\x1b[?25l');
  draw();
  if (interactive) {
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    stream.write('\x1b[6n'); // ask where the cursor is, to locate the header
    stream.write('\x1b[?1000h\x1b[?1006h'); // report mouse clicks
  }
  process.once('exit', close);

  const controller: Header = { blink, close, redraw: draw, lines };
  opts.ready?.(controller);
  if (still) return Promise.resolve(controller);
  return new Promise((resolve) => {
    timer = setInterval(() => {
      const done = snow!.step();
      draw();
      if (done) {
        clearInterval(timer);
        falling = false;
        if (!opts.onFrame) stream.write('\x1b[?25h');
        resolve(controller);
      }
    }, opts.interval || 120);
  });
}
