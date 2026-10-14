import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCheckpoints } from '../src/plugins/diff-undo/checkpoints.ts';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rime-cp-')));
const put = (d: string, f: string, s: string) => (fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }), fs.writeFileSync(path.join(d, f), s));
const read = (d: string, f: string) => (fs.existsSync(path.join(d, f)) ? fs.readFileSync(path.join(d, f), 'utf8') : null);

test('in git: a checkpoint covers every change (bash too), /undo puts it back, the real index is untouched', () => {
  const d = tmp();
  const g = (...a: string[]) => execFileSync('git', a, { cwd: d, encoding: 'utf8' });
  g('init', '-q');
  put(d, 'a.txt', 'one\n');
  put(d, '.gitignore', 'build/\n');
  g('add', '.');
  g('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'i');
  put(d, 'notes.md', 'untracked before\n');
  const cp = createCheckpoints(d);
  assert.equal(cp.git, true);
  const c = cp.begin('make changes');
  assert.ok(!g('status', '--porcelain').includes('.rime'), "Rime's own folder stays out of git");
  put(d, 'a.txt', 'two\n'); // an edit
  put(d, 'new.txt', 'hi\n'); // a new file
  fs.rmSync(path.join(d, 'notes.md')); // a deletion, as a command would
  put(d, 'build/out.js', 'x'); // ignored
  put(d, '.rime/cache/x', 'y'); // Rime's own
  assert.deepEqual(cp.changes(c).sort((a, b) => a.file.localeCompare(b.file)), [{ how: 'changed', file: 'a.txt' }, { how: 'added', file: 'new.txt' }, { how: 'deleted', file: 'notes.md' }]);
  assert.match(cp.diff(c), /-one\n\+two/);
  const status = g('status', '--porcelain');
  cp.undo(c);
  assert.equal(read(d, 'a.txt'), 'one\n');
  assert.equal(read(d, 'new.txt'), null);
  assert.equal(read(d, 'notes.md'), 'untracked before\n');
  assert.equal(read(d, 'build/out.js'), 'x', 'ignored files are left alone');
  assert.equal(cp.list().length, 0);
  assert.notEqual(status, '', 'there were changes');
  assert.equal(g('diff', '--cached', '--name-only'), '', 'nothing was staged');
});

test('outside git: files Rime writes are copied before their first change', () => {
  const d = tmp();
  put(d, 'page.html', '<p>old</p>');
  const cp = createCheckpoints(d);
  assert.equal(cp.git, false);
  const c = cp.begin('edit the page');
  cp.touch(c, 'page.html');
  put(d, 'page.html', '<p>new</p>');
  cp.touch(c, 'page.html'); // the second change keeps the first copy
  cp.touch(c, 'extra.css');
  put(d, 'extra.css', 'p{}');
  assert.deepEqual(cp.changes(c), [{ file: 'page.html', how: 'changed' }, { file: 'extra.css', how: 'added' }]);
  assert.match(cp.diff(c), /-<p>old<\/p>/);
  cp.undo(c);
  assert.equal(read(d, 'page.html'), '<p>old</p>');
  assert.equal(read(d, 'extra.css'), null);
});
