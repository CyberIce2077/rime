import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocks, gfxMode, parseBar } from '../src/plugins/browser/browser.ts';
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

test('half-blocks: two pixels a cell, top as foreground', () => {
  // 2×4 pixels: a red top half, a blue bottom half.
  const data = Buffer.alloc(2 * 4 * 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) data.set(y < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * 2 + x) * 4);
  const lines = blocks({ width: 2, height: 4, data }, 2, 2, (rgb, bg) => `${bg ? 'B' : 'F'}${rgb.join(',')};`);
  assert.deepEqual(lines.map((l) => l[0].s), ['F255,0,0;B255,0,0;', 'F0,0,255;B0,0,255;']);
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
