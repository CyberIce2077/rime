import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from '../src/core/config.ts';
import { keyOf } from '../src/providers/registry.ts';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rime-')), '.rime', 'config');

test('nothing connected and no model by default', () => {
  const c = loadConfig('/nonexistent/rime-config');
  assert.deepEqual(c.providers, {});
  assert.equal(c.model, undefined);
});

test('an old top-level apiKey becomes the anthropic provider', () => {
  const file = tmp();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ apiKey: 'sk-old' }));
  assert.deepEqual(loadConfig(file).providers.anthropic, { preset: 'anthropic', key: 'sk-old' });
});

test('Rime writes the file itself, mode 0600, and reads it back', () => {
  const file = tmp();
  const cfg = loadConfig(file);
  cfg.providers.gpubox = { preset: 'llamacpp', ssh: 'gpubox', tunnel: { remote: '127.0.0.1:8080' }, model: 'qwen3.8-27b', onQuit: 'keep' };
  cfg.model = 'gpubox/qwen3.8-27b';
  saveConfig(cfg, file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(loadConfig(file).providers.gpubox, cfg.providers.gpubox);
});

test('keys: the environment variable wins over the saved key', () => {
  assert.equal(keyOf({ preset: 'openrouter', key: 'saved' }, { OPENROUTER_API_KEY: 'env' }), 'env');
  assert.equal(keyOf({ preset: 'openrouter', key: 'saved' }, {}), 'saved');
  assert.equal(keyOf({ preset: 'llamacpp' }, {}), undefined);
});
