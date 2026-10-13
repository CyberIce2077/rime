import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from '../src/core/config.ts';
import { createSettings, phrase } from '../src/core/settings.ts';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rime-settings-')), 'config');

test('a setting changes live, is saved, and can be undone', () => {
  const file = tmp();
  const cfg = loadConfig(file);
  cfg.providers.gpubox = { preset: 'llamacpp', ssh: 'gpubox', onQuit: 'keep' };
  const s = createSettings(cfg, file);
  const seen: unknown[] = [];
  s.subscribe((c) => seen.push(c?.key ?? 'reload'));
  const c = s.set('effort', 'high')!;
  assert.deepEqual([c.label, c.from, c.to, c.applies], ['effort', 'default', 'high', 'next-message']);
  assert.equal(cfg.effort, 'high');
  assert.equal(loadConfig(file).effort, 'high', 'written to the config');
  assert.equal(s.set('effort', 'high'), null, 'no change, no line');
  assert.equal(s.set('effort', 'enormous'), null, 'only known values');
  s.set('server.gpubox.wake', 'no');
  assert.deepEqual(cfg.providers.gpubox.skip, ['wake']);
  s.set('server.gpubox.onQuit', 'power off');
  assert.equal(cfg.providers.gpubox.onQuit, 'poweroff');
  s.undo(c);
  assert.equal(cfg.effort, undefined);
  assert.equal(c.undone, true);
  assert.deepEqual(s.recent().map((x) => x.key), ['server.gpubox.onQuit', 'server.gpubox.wake', 'effort']);
  assert.deepEqual(seen, ['effort', 'server.gpubox.wake', 'server.gpubox.onQuit', 'reload']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('another Rime window writing the config is picked up', { timeout: 5000 }, async () => {
  const file = tmp();
  const cfg = loadConfig(file);
  const s = createSettings(cfg, file);
  s.set('reasoning', 'off');
  const stop = s.watch();
  const got = new Promise((r) => s.subscribe(r));
  await new Promise((r) => setTimeout(r, 300)); // macOS file events take a moment to start
  const other = loadConfig(file);
  other.effort = 'max';
  saveConfig(other, file);
  await got;
  stop();
  assert.equal(cfg.effort, 'max');
  assert.equal(cfg.reasoning, false);
});

test('short, exact requests run with no API call', () => {
  assert.deepEqual(phrase('effort high'), { key: 'effort', value: 'high' });
  assert.deepEqual(phrase('Set effort to max.'), { key: 'effort', value: 'max' });
  assert.deepEqual(phrase('reasoning off'), { key: 'reasoning', value: 'off' });
  assert.deepEqual(phrase('turn on reasoning'), { key: 'reasoning', value: 'on' });
  assert.equal(phrase('what effort should I use for this?'), null);
  assert.equal(phrase('effort high and fix the bug'), null);
});
