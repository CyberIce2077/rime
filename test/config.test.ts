import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/core/config.ts';

test('no model unless the config file names a known one', () => {
  const none = loadConfig({}, '/nonexistent/rime-config');
  assert.equal(none.model, undefined);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rime-')), 'config');
  fs.writeFileSync(file, JSON.stringify({ apiKey: 'k', model: 'unknown' }));
  const set = loadConfig({ ANTHROPIC_API_KEY: 'env' }, file);
  assert.equal(set.model, undefined, 'unknown models are ignored');
  assert.equal(set.apiKey, 'env');
});
