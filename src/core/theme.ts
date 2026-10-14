// Glacier, the only MVP theme (SPEC §4.2), plus the SGR helpers every screen uses.

export type RGB = [number, number, number];
export type ColorMode = 'truecolor' | '256' | 'none';

const hex = (s: string): RGB => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)) as RGB;

export const GLACIER = {
  page: hex('#050C12'),
  bg: hex('#07111A'),
  panel: hex('#0E1C27'),
  line: hex('#1C3242'),
  fg: hex('#D8E9F2'),
  title: hex('#F2F8FB'),
  accent: hex('#7FD4F5'),
  dim: hex('#7E99AB'),
  ok: hex('#8FE3C8'),
  del: hex('#F2A3B3'),
  warn: hex('#F5D58A'),
  water: hex('#163047'), // chips (rime-prompt.html)
  water2: hex('#21445F'),
};

export const blend = (fg: RGB, a: number, under: RGB): RGB =>
  fg.map((v, i) => Math.round(v * a + under[i] * (1 - a))) as RGB;

// The prompt placeholder is dim at 70% opacity in the prototype.
export const PLACEHOLDER = blend(GLACIER.dim, 0.7, GLACIER.bg);

// Mouse selection highlight.
export const SELECTION = hex('#1E4A66'); // rime-prompt.html

export function colorMode(stream?: { isTTY?: boolean }): ColorMode {
  if (process.env.NO_COLOR || !(stream && stream.isTTY)) return 'none';
  const ct = (process.env.COLORTERM || '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 'truecolor';
  return '256';
}

export function to256([r, g, b]: RGB): number {
  const q = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

export function sgr(rgb: RGB, bg: boolean, mode: ColorMode): string {
  if (mode === 'none') return '';
  const layer = bg ? 48 : 38;
  return mode === 'truecolor' ? `\x1b[${layer};2;${rgb.join(';')}m` : `\x1b[${layer};5;${to256(rgb)}m`;
}

export const RESET = (mode: ColorMode) => (mode === 'none' ? '' : '\x1b[0m');
export const BOLD = (mode: ColorMode) => (mode === 'none' ? '' : '\x1b[1m');
