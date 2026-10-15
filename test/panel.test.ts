import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSide } from '../src/plugins/shell-panel/panel.ts';
import { stripAnsi } from '../src/core/term.ts';
import { styles } from '../src/core/view.ts';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rime-side-')));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function side(files: string[] = []) {
  const root = tmp();
  for (const f of files) fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }), fs.writeFileSync(path.join(root, f), `// ${f}\nline 2\n`);
  const opened: string[] = [];
  const s = createSide({ root, st: styles('truecolor'), redraw: () => {}, files: () => files, env: () => process.env, open: (p) => void opened.push(p), newTab: () => {} });
  const screen = (w = 60, h = 16) => s.render(w, h, true).lines.map(stripAnsi);
  return { s, root, opened, screen };
}

test('shell tabs run a command, show its output and how it ended', async () => {
  const { s, screen } = side();
  const t = s.shell('echo one; echo two; exit 3');
  for (let i = 0; i < 40 && t.state === 'running'; i++) await wait(25);
  assert.equal(t.state, 'failed');
  assert.equal(t.code, 3);
  const out = screen().join('\n');
  assert.match(out, /1 ✗ echo one; echo/);
  assert.match(out, /│ one\s*\n│ two/);
  assert.match(out, /✗ exit 3/);
});

test('a running tab asks before it closes; closing the last tab un-splits', async () => {
  const { s, screen } = side();
  s.shell('sleep 5');
  assert.equal(s.visible, true);
  s.close();
  assert.equal(s.tabs.length, 1, 'asked first');
  assert.match(screen().join('\n'), /still running · ctrl\+w q stop it and close/);
  s.close(true);
  assert.equal(s.tabs.length, 0);
  assert.equal(s.visible, false);
  s.reopen();
  assert.equal(s.tabs.length, 1, 'ctrl+w u brings it back (stopped)');
});

test("Rime's commands mirror into a tab that flashes in without taking the active tab", () => {
  const { s } = side();
  s.files();
  const m = s.mirror('npm test');
  assert.equal(m.tab, 2);
  assert.equal(s.active, 0, 'the files tab stays active');
  m.write('ok 1\nok 2\n');
  m.done(0);
  assert.equal(s.tabs[1].kind === 'shell' && s.tabs[1].state, 'passed');
});

test('the files tree folds, filters and opens a file', () => {
  const { s, opened, screen } = side(['src/a.ts', 'src/lib/b.ts', 'README.md']);
  s.files();
  assert.deepEqual(screen().slice(2, 4).map((l) => l.replace(/^│ /, '').trimEnd()), ['› ▸ src/', '  README.md']);
  s.key({ name: 'right' });
  assert.deepEqual(screen().slice(2, 6).map((l) => l.replace(/^│ /, '').trimEnd()), ['› ▾ src/', '    ▸ lib/', '    a.ts', '  README.md']);
  for (const ch of '/b.ts') s.key({ name: 'char', ch });
  s.key({ name: 'enter' });
  s.key({ name: 'enter' });
  assert.deepEqual(opened, ['src/lib/b.ts']);
});

test('a file opens in a viewer at its line; the diff tab is reused', () => {
  const { s, screen } = side(['src/a.ts']);
  assert.ok(s.file('src/a.ts', 2));
  assert.match(screen().join('\n'), /2 {2}line 2/);
  s.diff('+added\n-removed');
  s.diff('+again');
  assert.equal(s.tabs.filter((t) => t.kind === 'diff').length, 1);
});

test("a plug-in tab's keys and the panel's keys stay separate groups", () => {
  const { s, screen } = side();
  s.custom({ title: 'browser', render: () => [], foot: () => [['', 'keys go to the page · '], ['esc', ' stop typing']] });
  const foot = screen(100, 12).slice(-3).join(' ');
  assert.match(foot, /esc stop typing · ctrl\+w tabs/);
});
