import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENE, createSnow, renderHeader, scenePixels, settledSnow, snowShape } from '../src/core/header.ts';

test('5 to 20 blocks of snow, never over his eyes', () => {
  const totals = new Set<number>();
  for (let i = 1; i < 500; i++) {
    let s = (i * 48271 * 977) % 2147483647; // spread like real random seeds
    const { ground, cap } = snowShape(() => ((s = (s * 16807) % 2147483647), s / 2147483647));
    const total = [...ground, ...cap].reduce((a, b) => a + b);
    assert.ok(total >= 5 && total <= 20, `total ${total}`);
    totals.add(total);
    assert.ok(ground.slice(3, 9).every((v) => v <= 1), 'at most one block in front of him');
    assert.ok(ground.every((v) => v <= 2) && cap.every((v, c) => v <= (c >= 3 && c <= 8 ? 1 : 0)));
  }
  assert.equal(totals.size, 16, 'every count from 5 to 20 shows up');
});

test('snowfall settles into the shape it picked, and a seed replays it', () => {
  const run = (seed: number) => {
    const snow = createSnow(seed);
    let ticks = 0;
    while (!snow.step()) if (++ticks > 500) throw new Error('never settled');
    return { ticks, ...snow.state() };
  };
  const a = run(42), b = run(42);
  assert.deepEqual(a, b);
  const settled = settledSnow(42);
  assert.deepEqual(a.heights, settled.heights);
  assert.deepEqual(a.cap, settled.cap);
});

test('blinking fills the top half of each eye', () => {
  const st = settledSnow(7);
  const open = scenePixels(st), shut = scenePixels(st, true);
  const eye = [0x07, 0x11, 0x1a];
  assert.deepEqual(open[SCENE.SY + 2][SCENE.SX + 2], eye);
  assert.notDeepEqual(shut[SCENE.SY + 2][SCENE.SX + 2], eye);
  assert.deepEqual(shut[SCENE.SY + 3][SCENE.SX + 2], eye); // the closed-eye line
});

test('header is three lines with the info beside the cube', () => {
  const lines = renderHeader({ mode: 'none', version: '0.1.0', model: 'Sonnet 5.5', details: '1M context', cwd: '/x' }, settledSnow(3));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^ .{12} Rime v0\.1\.0$/);
  assert.match(lines[1], /Sonnet 5\.5 · 1M context$/);
  assert.match(lines[2], / \/x$/);
});


test('header says when no model is selected', () => {
  const lines = renderHeader({ mode: 'none', version: '0.1.0', cwd: '/x' }, settledSnow(3));
  assert.match(lines[1], /no model selected$/);
});

// Reads the half-block lines back into pixels, honouring SGR colours and reverse video.
function decode(lines: string[]) {
  const rows: (string | null)[][] = [];
  for (const line of lines) {
    const top: (string | null)[] = [], bot: (string | null)[] = [];
    let fg: string | null = null, bg: string | null = null, rev = false;
    for (const m of line.matchAll(/\x1b\[([\d;]*)m|([^\x1b])/g)) {
      if (m[1] !== undefined) {
        const p = m[1].split(';');
        if (p[0] === '0' || p[0] === '') { fg = bg = null; rev = false; }
        else if (p[0] === '7') rev = true;
        else if (p[0] === '4') continue;
        else if (p[0] === '38') fg = p.slice(2).join(',');
        else if (p[0] === '48') bg = p.slice(2).join(',');
        continue;
      }
      const fill = rev ? fg : bg, glyph = rev ? bg : fg;
      if (m[2] === '▀') { top.push(glyph); bot.push(fill); }
      else if (m[2] === '▄') { top.push(fill); bot.push(glyph); }
      else { top.push(fill); bot.push(fill); }
    }
    rows.push(top, bot);
  }
  return rows;
}

test('half blocks reproduce every pixel, eyes and blink included', () => {
  for (const seed of [1, 7, 42, 99]) {
    for (const blinking of [false, true]) {
      const st = settledSnow(seed);
      // Drop the leading space and the info text (bold title / accent / dim) after the scene.
      const pixels = renderHeader({ mode: 'truecolor', version: '0.1.0', cwd: '/x' }, st, blinking)
        .map((l) => l.slice(1).replace(/ \x1b\[(1|38;2;127;212;245|38;2;126;153;171)m.*$/, ''));
      const want = scenePixels(st, blinking).map((r) => r.map((p) => (p ? p.join(',') : null)));
      assert.deepEqual(decode(pixels), want);
    }
  }
});



test('every split cell is ▄ with an underline, so it fills the cell', () => {
  const lines = renderHeader({ mode: 'truecolor', version: '0.1.0', cwd: '/x' }, settledSnow(11));
  const scene = lines.map((l) => l.slice(1).replace(/ \x1b\[(1|38;2;127;212;245|38;2;126;153;171)m.*$/, '')).join('');
  assert.ok(!scene.includes('▀'), 'no ▀ in a settled scene');
  assert.equal(scene.split('▄').length - 1, scene.split('\x1b[4m▄').length - 1);
});
