import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { compare, install, installed, latest, newest } from '../src/plugins/updater/update.ts';

test('versions compare numerically, a pre-release before its release', () => {
  assert.ok(compare('1.10.0', '1.9.2') > 0);
  assert.ok(compare('0.0.2', '0.0.10') < 0);
  assert.ok(compare('1.0.0-beta.1', '1.0.0') < 0);
  assert.equal(compare('v1.2.3', '1.2.3'), 0);
});

test('npm: the latest version with its change lines, null when offline', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/rime-cli/latest') return res.end(JSON.stringify({ version: '0.1.0', rime: { changes: ['Compaction', 'Undo', 'Search', 'extra'] } }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.deepEqual(await latest('rime-cli', url), { version: '0.1.0', changes: ['Compaction', 'Undo', 'Search'] });
    assert.equal(await latest('nope', url), null);
    assert.equal(await latest('rime-cli', 'http://127.0.0.1:9', 500), null);
  } finally {
    server.close();
  }
});

test('install puts a version in its own folder; the launcher picks the newest above the running one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rime-v-'));
  // A fake npm: makes the package's entry file where npm would.
  const npm = path.join(dir, 'fake-npm.sh');
  fs.writeFileSync(npm, '#!/bin/sh\nwhile [ "$1" != "--prefix" ]; do shift; done\nmkdir -p "$2/node_modules/rime-cli/dist" && echo "x" > "$2/node_modules/rime-cli/dist/rime.js"\n', { mode: 0o755 });
  const versions = path.join(dir, 'versions');
  for (const v of ['0.0.2', '0.1.0', '0.0.3', '0.0.4']) assert.deepEqual(await install('rime-cli', v, versions, npm), { ok: true });
  assert.deepEqual(installed('rime-cli', versions).map((x) => x.version), ['0.1.0', '0.0.4', '0.0.3'], 'only the newest three are kept');
  assert.equal(newest('rime-cli', '0.0.1', versions)?.version, '0.1.0');
  assert.equal(newest('rime-cli', '0.1.0', versions), null, 'nothing newer than what runs');
  fs.mkdirSync(path.join(versions, '0.2.0'), { recursive: true }); // a half-done install
  assert.equal(newest('rime-cli', '0.0.1', versions)?.version, '0.1.0', 'a folder without the entry file is skipped');
  const bad = path.join(dir, 'bad-npm.sh');
  fs.writeFileSync(bad, '#!/bin/sh\necho "E404 not found" >&2\nexit 1\n', { mode: 0o755 });
  assert.deepEqual(await install('rime-cli', '9.9.9', versions, bad), { ok: false, error: 'E404 not found' });
});
