import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENE, createSnow, cubeArea, mascotStyle, renderHeader, scenePixels, settledSnow, snowShape } from '../src/core/header.ts';

test('snow shape keeps the eyes clear and a cap of at least 3', () => {
  for (let seed = 1; seed < 200; seed++) {
    let s = seed;
    const { ground, cap } = snowShape(() => ((s = (s * 16807) % 2147483647), s / 2147483647));
    assert.ok(ground.slice(3, 9).every((v) => v === 1), 'one pixel in front of him');
    assert.ok(cap.reduce((a, b) => a + b) >= 3);
  }
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
  assert.ok(a.ticks * 120 >= 1500 && a.ticks * 120 <= 15000, `runs ${a.ticks * 120}ms`);
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
  const lines = renderHeader({ mode: 'none', style: 'blocks', version: '0.1.0', model: 'Sonnet 5.5', details: '1M context · medium effort', cwd: '/x' }, settledSnow(3));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^ .{12} Rime v0\.1\.0$/);
  assert.match(lines[1], /Sonnet 5\.5 · 1M context · medium effort$/);
  assert.match(lines[2], / \/x$/);
});

test('cells style draws every pixel as two full cells, info beside his body', () => {
  const lines = renderHeader({ mode: 'none', style: 'cells', version: '0.1.0', model: 'Sonnet 5.5', details: 'd', cwd: '/x' }, settledSnow(3));
  assert.equal(lines.length, 6);
  assert.match(lines[2], /^ .{24} Rime v0\.1\.0$/);
  assert.match(lines[4], / \/x$/);
  assert.ok(!lines.some((l) => /[▀▄]/.test(l)), 'no half blocks');
  assert.deepEqual(cubeArea('cells'), { x0: 6, x1: 21, y0: 1, y1: 5 });
});

test('Apple Terminal gets cells, others half blocks, RIME_MASCOT overrides', () => {
  assert.equal(mascotStyle({ TERM_PROGRAM: 'Apple_Terminal' }), 'cells');
  assert.equal(mascotStyle({ TERM_PROGRAM: 'iTerm.app' }), 'blocks');
  assert.equal(mascotStyle({ TERM_PROGRAM: 'Apple_Terminal', RIME_MASCOT: 'blocks' }), 'blocks');
});
