import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/core/db.ts';
import { errorOf, toolEvents } from '../src/core/timeline.ts';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rime-tl-')), 'rime.db');

test('C-1: timeline entries are written and read back in order', async () => {
  const db = await openDb(tmp());
  const id = db.create('/p', 'S');
  db.event(id, 'edit', 'signup.ts +2 −1', 'signup.ts');
  db.event(id, 'test', 'npm test ✓');
  assert.deepEqual(db.timeline(id).map((e) => [e.kind, e.text, e.ref]), [['edit', 'signup.ts +2 −1', 'signup.ts'], ['test', 'npm test ✓', null]]);
  assert.equal(db.list('/p')[0].last, 'npm test ✓', 'the list row carries the last entry');
  db.delete(id);
  assert.deepEqual(db.timeline(id), []);
  db.close();
});

test('C-1: tool calls become timeline entries by code', () => {
  assert.deepEqual(toolEvents('edit', { path: 'src/signup.ts' }, { summary: '+2 −1' }, 'src/signup.ts'), [{ kind: 'edit', text: 'src/signup.ts +2 −1', ref: 'src/signup.ts' }]);
  assert.deepEqual(toolEvents('write', { path: 'a.ts' }, { summary: 'created · 3 lines' }, 'a.ts'), [{ kind: 'edit', text: 'a.ts created', ref: 'a.ts' }]);
  assert.deepEqual(toolEvents('edit', { path: 'a.ts' }, { summary: 'nope', error: true }, 'a.ts'), [], 'a failed edit changed nothing');
  assert.deepEqual(toolEvents('bash', { command: 'npm test' }, { summary: 'exit 0' }, ''), [{ kind: 'test', text: 'npm test ✓' }]);
  assert.deepEqual(toolEvents('bash', { command: 'git commit -am "Fix signup crash"' }, { summary: 'exit 0' }, ''), [{ kind: 'commit', text: 'Fix signup crash' }]);
  const failed = toolEvents('bash', { command: 'npm test' }, { summary: 'exit 1', error: true, output: ['> test', "TypeError: Cannot read properties of undefined (reading 'email')", '    at submit (src/signup.ts:41:7)'] }, '');
  assert.deepEqual(failed, [
    { kind: 'test', text: 'npm test ✗' },
    { kind: 'error', text: "TypeError: Cannot read properties of undefined (reading 'email') · src/signup.ts:41", ref: 'src/signup.ts' },
  ]);
  assert.equal(toolEvents('read', { path: 'a.ts' }, { summary: '3 lines' }, 'a.ts').length, 0);
  assert.equal(errorOf(['all good']), null);
});

test('C-2: search is FTS5 with bm25 over titles, the timeline and messages, with prefixes', async () => {
  const file = tmp();
  let db = await openDb(file);
  const a = db.create('/p', 'S');
  db.append(a, 'user', 'Fix signup crash\nit throws on submit');
  db.append(a, 'assistant', [{ type: 'text', text: 'The email field is undefined.' }]);
  const b = db.create('/p', 'S');
  db.append(b, 'user', 'Add dark mode');
  db.event(b, 'edit', 'src/theme.ts +3 −1', 'src/theme.ts');
  const c = db.create('/p', 'S');
  db.append(c, 'user', 'Tidy the logs');
  db.append(c, 'assistant', [{ type: 'text', text: 'Nothing will crash now.' }]);
  const other = db.create('/q', 'S');
  db.append(other, 'user', 'crash in another project');

  const ids = (q: string, project: string | null = '/p') => db.search(project, q).map((r) => r.id);
  assert.deepEqual(ids('crash'), [a, c], 'a title match ranks above a match in the text');
  assert.deepEqual(ids('sign'), [a], 'prefix matching');
  assert.deepEqual(ids('theme'), [b], 'the timeline is searched');
  assert.deepEqual(ids('email'), [a], 'replies are searched');
  assert.deepEqual(ids('dark signup'), [], 'every word has to match somewhere in the conversation');
  assert.deepEqual(ids('signup undefined'), [a], 'words may match in different places');
  assert.deepEqual(ids('crash', null).sort(), [a, c, other].sort(), 'all projects');
  assert.deepEqual(ids('"('), [], 'odd input is not an FTS syntax error');

  db.rename(a, 'Login bug');
  assert.deepEqual(ids('login'), [a]);
  db.delete(c);
  assert.deepEqual(ids('tidy'), []);
  db.close();

  // A database from before search existed is indexed when it's opened.
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('DROP TABLE search');
  raw.close();
  db = await openDb(file);
  assert.deepEqual(ids('theme'), [b]);
  db.close();
});
