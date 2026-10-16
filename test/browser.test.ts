import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocks, gfxMode, parseBar, readable } from '../src/plugins/browser/browser.ts';
import { decide } from '../src/core/permissions.ts';

const ctx = (mode: any, rules: any[] = []) => ({ mode, project: '/p', rules });

test('the browser opens pages on this computer freely; other sites ask, and a rule remembers', () => {
  assert.equal(decide('browser', { action: 'open', url: 'http://localhost:5173' }, ctx('ask')).verdict, 'allow');
  assert.equal(decide('browser', { action: 'open', url: 'file:///tmp/a.html' }, ctx('ask')).verdict, 'allow');
  const d = decide('browser', { action: 'open', url: 'https://example.com/x' }, ctx('ask'));
  assert.deepEqual([d.verdict, d.rule], ['ask', 'fetch(domain:example.com)']);
  assert.equal(decide('browser', { action: 'open', url: 'example.com' }, ctx('ask', [{ kind: 'allow', pattern: 'fetch(domain:example.com)', from: 'conversation' }])).verdict, 'allow');
  assert.equal(decide('browser', { action: 'open', url: 'https://example.com' }, ctx('auto')).verdict, 'allow');
  assert.equal(decide('browser', { action: 'click', ref: 'e3' }, ctx('plan')).verdict, 'deny', 'plan mode only reads');
  assert.equal(decide('browser', { action: 'snapshot' }, ctx('plan')).verdict, 'allow');
});

test('quadrant blocks: 2×2 pixels a cell, each the average of its patch', () => {
  // 4×4 pixels for one cell: a red top-left quarter, the rest blue; the red patch
  // has one darker pixel so the average shows.
  const data = Buffer.alloc(4 * 4 * 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 2 * 2; x++) data.set(x < 2 && y < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * 4 + x) * 4);
  data.set([155, 0, 0, 255], 0);
  const color = (rgb: number[], bg: boolean) => `${bg ? 'B' : 'F'}${rgb.join(',')};`;
  const [[cell]] = blocks({ width: 4, height: 4, data }, 1, 1, color);
  assert.equal(cell.t, '▘');
  assert.equal(cell.s, 'F230,0,0;B0,0,255;');
  // A flat picture is one space on its colour.
  const flat = Buffer.alloc(4 * 4 * 4, 7);
  assert.deepEqual(blocks({ width: 4, height: 4, data: flat }, 1, 1, color)[0][0], { t: ' ', s: 'B7,7,7;' });
});

test('no images in the terminal: the page\'s letters are real characters on the colour under them', () => {
  // 2 cells × 1 row: white over light grey, then black over black.
  const data = Buffer.from([255, 255, 255, 255, 0, 0, 0, 255, 200, 200, 200, 255, 0, 0, 0, 255]);
  const color = (rgb: number[], bg: boolean) => `${bg ? 'B' : 'F'}${rgb.join(',')};`;
  const [line] = blocks({ width: 2, height: 2, data }, 2, 1, color, new Map([[0, { ch: 'A', rgb: [30, 30, 30] }]]));
  assert.deepEqual(line[0], { t: 'A', s: 'F30,30,30;B228,228,228;' }, 'the letter, on the average of the page under it');
  assert.equal(line[1].t, ' ', 'a flat cell without text is its colour');
  assert.deepEqual(readable([20, 20, 20], [25, 25, 25]), [240, 240, 240], 'dark text on a dark cell turns light');
  assert.deepEqual(readable([20, 20, 20], [250, 250, 250]), [20, 20, 20], 'readable text keeps its colour');
});

test('pictures: Kitty and iTerm2 where the terminal says so, half-blocks elsewhere and in tmux', () => {
  assert.equal(gfxMode({ TERM: 'xterm-kitty' }), 'kitty');
  assert.equal(gfxMode({ TERM_PROGRAM: 'iTerm.app' }), 'iterm');
  assert.equal(gfxMode({ TERM_PROGRAM: 'iTerm.app', TMUX: '1' }), 'blocks');
  assert.equal(gfxMode({ TERM_PROGRAM: 'Apple_Terminal' }), 'blocks');
  assert.equal(gfxMode({ RIME_GFX: 'kitty' }), 'kitty');
});

test("a download's size and progress are read from Playwright's bar (the newest one in the text)", () => {
  assert.deepEqual(parseBar('Downloading Chromium 140.0 from https://x\n150.5 MiB [====      ] 20% 3.1s150.5 MiB [=====     ] 25% 2.9s'), { total: 157810688, pct: 25 });
  assert.equal(parseBar('Downloading FFmpeg from https://x'), null);
});

test("the rime tool's browser.open and tab.open {kind: browser} are checked like the browser's open", () => {
  assert.equal(decide('rime', { action: 'tab.open', args: { kind: 'browser', url: 'index.html' } }, ctx('ask')).verdict, 'allow', 'a local file');
  assert.equal(decide('rime', { action: 'tab.open', args: { kind: 'browser', url: 'https://example.com' } }, ctx('ask')).verdict, 'ask');
  assert.equal(decide('rime', { action: 'browser.open', args: { url: 'http://localhost:3000' } }, ctx('ask')).verdict, 'allow');
  assert.equal(decide('rime', { action: 'tab.open', args: { kind: 'files' } }, ctx('ask')).verdict, 'allow');
});
