import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, titleOf } from '../src/core/db.ts';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rime-db-')), 'rime.db');

test('a conversation is saved as it happens and reopens as it was', async () => {
  const file = tmp();
  const db = await openDb(file);
  assert.equal(db.wal, true);
  assert.equal(db.last('/p').conv, null, 'the first run in a project starts fresh');
  const id = db.create('/p', 'SYSTEM PROMPT', 'gpubox/qwen3.8-27b');
  db.append(id, 'user', 'Fix the signup crash\nit throws on submit');
  const seq = db.append(id, 'assistant', [{ type: 'text', text: 'Looking' }], true);
  db.update(id, seq, [{ type: 'text', text: 'Looking at signup.ts' }], true); // a flush mid-stream
  db.unlock(id);
  db.close();

  // Quit mid-reply, then `rime` again: the same conversation, the reply marked interrupted.
  const again = await openDb(file);
  const { conv } = again.last('/p');
  assert.equal(conv?.id, id);
  assert.equal(conv?.title, 'Fix the signup crash');
  assert.equal(conv?.prefix, 'SYSTEM PROMPT');
  assert.deepEqual(again.messages(id).map((m) => [m.role, m.interrupted]), [['user', false], ['assistant', true]]);
  assert.deepEqual(again.messages(id)[1].content, [{ type: 'text', text: 'Looking at signup.ts' }]);
  assert.deepEqual(again.prompts('/p'), ['Fix the signup crash\nit throws on submit']);
  assert.deepEqual(again.prompts('/elsewhere'), []);
  assert.deepEqual(again.list('/p').map((c) => [c.title, c.n]), [['Fix the signup crash', 2]], 'the ← list');
  assert.equal(again.take(id)?.id, id);
  again.setUsage(id, seq, { usage: { input: 120, cached: 3000, written: 0, output: 12, promptMs: 180 }, local: true });
  assert.deepEqual(again.messages(id)[1].usage, { usage: { input: 120, cached: 3000, written: 0, output: 12, promptMs: 180 }, local: true }, 'what a reply cost comes back');
  again.close();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a conversation open in another live window is left alone', async () => {
  const file = tmp();
  const db = await openDb(file);
  const id = db.create('/p', 'S');
  db.append(id, 'user', 'hello');
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(file);
  raw.prepare('UPDATE conversations SET lock_pid = ? WHERE id = ?').run(process.ppid, id); // another Rime, still running
  assert.deepEqual(db.last('/p'), { conv: null, busy: true });
  raw.prepare('UPDATE conversations SET lock_pid = ? WHERE id = ?').run(2 ** 22 + 12345, id); // one that died
  assert.equal(db.last('/p').conv?.id, id, 'a stale lock is taken over');
  raw.close();
  db.close();
});

test('titles are the first line, trimmed by code', () => {
  assert.equal(titleOf('\n  Fix signup crash  \nmore'), 'Fix signup crash');
  assert.equal(titleOf('see  here'), 'see  here');
  assert.ok(titleOf('word '.repeat(30)).length <= 60);
});
