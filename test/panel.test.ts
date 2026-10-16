import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type SideHost, type ShellTab, type TextTab, createSide } from '../src/plugins/shell-panel/panel.ts';
import { addressLike, grep, nameHits } from '../src/plugins/shell-panel/search.ts';
import { phrase } from '../src/core/settings.ts';
import { decide } from '../src/core/permissions.ts';
import { stripAnsi } from '../src/core/term.ts';
import { styles } from '../src/core/view.ts';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rime-side-')));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const char = (ch: string) => ({ name: 'char', ch });
const type = (s: ReturnType<typeof createSide>, text: string) => { for (const ch of text) s.key(ch === ' ' ? { name: 'space' } : char(ch)); };

function side(files: string[] = [], more: Partial<SideHost> = {}) {
  const root = tmp();
  for (const f of files) fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }), fs.writeFileSync(path.join(root, f), `// ${f}\nline 2\nexport function validate() {}\n`);
  const browsed: [string, number | undefined][] = [];
  const s = createSide({ root, st: styles('truecolor'), redraw: () => {}, files: () => files, env: () => process.env, browse: (u, from) => void browsed.push([u, from]), ...more });
  const screen = (w = 60, h = 16, focused = true) => s.render(w, h, focused).lines.map(stripAnsi);
  return { s, root, browsed, screen };
}

test('shell tabs run a command, show its output and how it ended', async () => {
  const { s, screen } = side();
  const t = s.shell('echo one; echo two; exit 3');
  for (let i = 0; i < 40 && t.state === 'running'; i++) await wait(25);
  assert.equal(t.state, 'failed');
  assert.equal(t.code, 3);
  const out = screen().join('\n');
  assert.match(out, /1 \$ echo one; echo ✗/, 'number, icon, title, state');
  assert.match(out, /│ one\s*\n│ two/);
  assert.match(out, /\$ enter to type a command/);
});

test('a running tab asks before it closes; closing the last tab un-splits', async () => {
  const { s, screen } = side();
  s.shell('sleep 5');
  assert.equal(s.visible, true);
  s.close();
  assert.equal(s.tabs.length, 1, 'asked first');
  assert.match(screen().join('\n'), /is running · x stop it and close · esc keep it/);
  s.close(true);
  assert.equal(s.tabs.length, 0);
  assert.equal(s.visible, false);
  s.reopen();
  assert.equal(s.tabs.length, 1, ':reopen brings it back (stopped)');
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

test('the files tree folds and opens a file in a viewer', () => {
  const { s, screen } = side(['src/a.ts', 'src/lib/b.ts', 'README.md']);
  s.files();
  assert.deepEqual(screen().slice(2, 4).map((l) => l.replace(/^│ /, '').trimEnd()), ['› ▸ src/', '  README.md']);
  s.key({ name: 'right' });
  assert.deepEqual(screen().slice(2, 6).map((l) => l.replace(/^│ /, '').trimEnd()), ['› ▾ src/', '    ▸ lib/', '    a.ts', '  README.md']);
  s.key({ name: 'down' });
  s.key({ name: 'down' });
  s.key({ name: 'enter' });
  assert.equal((s.tabs[s.active] as TextTab).path, 'src/a.ts');
});

test('a file opens in a viewer at its line; the diff tab is reused', () => {
  const { s, screen } = side(['src/a.ts']);
  assert.ok(s.file('src/a.ts', 2));
  assert.match(screen().join('\n'), /2 {2}line 2/);
  assert.match(screen()[0], /1 ≡ a\.ts:2/);
  s.diff('+added\n-removed');
  s.diff('+again');
  assert.equal(s.tabs.filter((t) => t.kind === 'diff').length, 1);
});

test("a plug-in tab's keys and the panel's keys stay separate groups", () => {
  const { s, screen } = side();
  s.custom({ title: 'browser', icon: '◐', render: () => [], foot: () => [['', 'keys go to the page · '], ['esc', ' stop typing']] });
  const foot = screen(100, 12).slice(-3).join(' ');
  assert.match(foot, /esc stop typing · space tabs · : command · \? keys/);
});

test('panel keys are single keys: no ctrl+w prefix', () => {
  const { s, screen } = side(['a.ts']);
  s.files();
  s.shell('true');
  s.diff('+x', true);
  assert.equal(s.active, 2);
  assert.equal(s.key({ name: 'w', ctrl: true }), true, 'ctrl+w is just unused here');
  s.key(char('1'));
  assert.equal(s.active, 0);
  s.key({ name: 'tab' });
  assert.equal(s.active, 1);
  s.key({ name: 'tab', shift: true });
  assert.equal(s.active, 0);
  s.key({ name: 'space' });
  assert.match(screen().join('\n'), /┌ go to/, 'space opens the switcher');
  s.key({ name: 'escape' });
  s.key(char('n'));
  assert.match(screen().join('\n'), /› ▤ file/, 'n opens it on the "new" rows');
  s.key({ name: 'escape' });
  s.key(char('z'));
  assert.equal(s.zoomed, true);
  s.key(char('z'));
  assert.equal(s.zoomed, false);
  s.key(char('?'));
  assert.match(screen().join('\n'), /This tab · files[\s\S]*Panel[\s\S]*ctrl\+g\s+to the chat/);
  s.key(char('q'));
  assert.doesNotMatch(screen().join('\n'), /This tab · files/, 'any key closes the sheet');
  s.key(char('x'));
  assert.equal(s.tabs.length, 2, 'x closes a tab that is done');
  assert.equal(s.key({ name: 'escape' }), 'blur', 'esc from the panel goes to the chat');
});

test('x on a running tab asks; x again stops it, esc keeps it', () => {
  const { s } = side();
  s.shell('sleep 5');
  s.key(char('x'));
  assert.equal(s.asking(), true);
  s.key({ name: 'escape' });
  assert.equal(s.tabs.length, 1, 'esc kept it');
  s.key(char('x'));
  s.key(char('x'));
  assert.equal(s.tabs.length, 0);
});

test('a typing shell tab gets every key, ctrl+w and ctrl+c too; esc steps back one level at a time', async () => {
  const { s, screen } = side();
  const t = s.shell();
  assert.equal(t.typing, true, 'an empty shell starts typing');
  type(s, 'echo hi there');
  s.key({ name: 'w', ctrl: true });
  assert.equal(t.input, 'echo hi ', 'ctrl+w deletes a word in the shell');
  type(s, 'x1z');
  assert.equal(t.input, 'echo hi x1z', 'panel letters type while typing');
  assert.equal(s.tabs.length, 1);
  assert.match(screen().join('\n'), /typing into shell/);
  s.key({ name: 'enter' });
  for (let i = 0; i < 40 && t.state === 'running'; i++) await wait(25);
  assert.equal(t.state, 'passed');
  assert.equal(t.typing, true, 'still typing after the command ran');
  s.key(char('s'));
  s.key({ name: 'c', ctrl: true });
  assert.equal(t.input, '', 'ctrl+c clears the line when nothing runs');
  // Focus moving to the chat (ctrl+g, handled by the app) leaves the tab as it
  // is, so the next ctrl+g lands back typing in the same tab.
  assert.equal(s.typing(), true);
  assert.equal(s.key({ name: 'escape' }), true);
  assert.equal(t.typing, false, 'esc stops typing first');
  assert.equal(s.key({ name: 'escape' }), 'blur', 'then goes to the chat');
  s.key({ name: 'enter' });
  assert.equal(t.typing, true, 'enter starts typing again');
});

test('a running shell stops on ctrl+c while typing', async () => {
  const { s } = side();
  const t = s.shell('sleep 5');
  s.key({ name: 'enter' });
  assert.equal(t.typing, true);
  s.key({ name: 'c', ctrl: true });
  for (let i = 0; i < 40 && t.state === 'running'; i++) await wait(25);
  assert.equal(t.state, 'stopped');
});

test('the unfocused panel shows only ctrl+g focus; Rime asking shows on the focused panel line', () => {
  const a = side();
  a.s.files();
  assert.match(a.screen(60, 12, false).at(-1)!, /^│ ctrl\+g focus\s*$/);
  const b = side([], { asks: () => true });
  b.s.files();
  assert.match(b.screen().at(-1)!, /● Rime is asking · ctrl\+g answer/);
});

test('panel hints wrap whole groups at 40, 60 and 100 columns', () => {
  const { s, screen } = side();
  s.shell('npm test');
  for (const w of [40, 60, 100]) {
    const lines = screen(w, 14);
    const rule = lines.findLastIndex((l) => /^│ ─+$/.test(l));
    const foot = lines.slice(rule + 1).map((l) => l.replace(/^│ /, '').trimEnd());
    for (const g of ['enter type a command', 'ctrl+c stop', '/ find', 'space tabs', ': command', '? keys']) assert.ok(foot.some((l) => l.includes(g)), `${g} whole at ${w}: ${foot.join(' / ')}`);
    for (const l of foot) assert.ok(l.length <= w - 2, `fits at ${w}`);
  }
});

test('/ in the panel opens search in the tab, not a chat command', () => {
  const { s, screen } = side(['src/signup.ts']);
  s.files();
  s.key(char('/'));
  assert.equal(s.typing(), true, 'the search field takes the letters');
  assert.match(screen().join('\n'), /Type to search file names/);
});

test(':run with plan mode is refused; :run in ask mode runs without a prompt', async () => {
  let plan = true;
  const { s, screen } = side([], { plan: () => plan });
  s.files();
  s.key(char(':'));
  type(s, 'run echo hi');
  s.key({ name: 'enter' });
  assert.equal(s.tabs.length, 1, 'refused');
  assert.match(screen().join('\n'), /plan mode: :run is off/);
  plan = false;
  s.key(char(':'));
  type(s, 'run echo hi');
  s.key({ name: 'enter' });
  const t = s.tabs[1] as ShellTab;
  assert.equal(t.cmd, 'echo hi', 'ran at once: commands you type yourself run as yourself');
  for (let i = 0; i < 40 && t.state === 'running'; i++) await wait(25);
  assert.equal(t.state, 'passed');
  // A command Rime runs still asks.
  assert.equal(decide('bash', { command: 'npm test' }, { mode: 'ask', project: '/p', rules: [] } as never).verdict, 'ask');
});

test(': commands complete, and the panel keeps its own (:size, :rename, :hide)', () => {
  const { s, screen } = side(['a.ts']);
  s.files();
  s.key(char(':'));
  type(s, 'si');
  assert.match(screen().join('\n'), /:size <percent or even>\s+move the divider/);
  s.key({ name: 'tab' });
  type(s, '60');
  s.key({ name: 'enter' });
  assert.equal(s.ratio, 0.6);
  s.key(char(':'));
  type(s, 'rename tree');
  s.key({ name: 'enter' });
  assert.match(screen()[0], /1 ▤ tree/);
  s.key(char(':'));
  type(s, 'hide');
  s.key({ name: 'enter' });
  assert.equal(s.visible, false);
});

test('files search: names rank signup.ts first, text mode has line numbers, enter opens at the line', () => {
  const files = ['src/sign/up/index.ts', 'src/signup.ts', 'README.md'];
  assert.deepEqual(nameHits('signup', files).map((x) => x.path), ['src/signup.ts', 'src/sign/up/index.ts']);
  const { s, screen } = side(files);
  s.files();
  s.key(char('/'));
  type(s, 'signup');
  assert.match(screen().join('\n'), /› ≡ src\/signup\.ts/);
  // tab: text in files. "validate" is on line 3 of every file.
  s.key({ name: 'tab' });
  for (let i = 0; i < 6; i++) s.key({ name: 'backspace' });
  type(s, 'validate');
  assert.match(screen(80, 20).join('\n'), /3 matches[\s\S]*\n│ [\w/.]+\s*\n│ ›\s+3 export function validate/, 'grouped by file, with the line');
  s.key({ name: 'enter' });
  const t = s.tabs[s.active] as TextTab;
  assert.equal(t.kind, 'file');
  assert.equal(t.mark, 3, 'opened at the line');
  assert.deepEqual(grep(tmp(), '', files), [], 'an empty query finds nothing');
});

test('find in the file viewer and the shell output', async () => {
  const { s, screen } = side(['a.ts']);
  s.file('a.ts');
  s.key(char('/'));
  type(s, 'validate');
  const t = s.tabs[0] as TextTab;
  assert.equal(t.at, 2, 'jumps to the line');
  s.key({ name: 'escape' });
  assert.equal(t.find, undefined);
  const sh = s.shell('printf "a\\nneedle\\nb\\n"');
  for (let i = 0; i < 40 && sh.state === 'running'; i++) await wait(25);
  s.key(char('/'));
  type(s, 'needle');
  assert.equal(sh.find, 'needle');
  assert.match(screen().join('\n'), /needle/);
});

test('enter on a diff hunk opens the file viewer there', () => {
  const { s } = side(['src/a.ts']);
  s.diff('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +2,3 @@\n line\n+new\n', true);
  s.key({ name: 'enter' });
  const t = s.tabs[s.active] as TextTab;
  assert.equal(t.path, 'src/a.ts');
  assert.equal(t.mark, 2);
});

test('a server tab outlives the bash timeout, shows its port, and o opens a linked browser tab', async () => {
  const ready: string[] = [];
  const { s, browsed, screen } = side([], { ready: (t) => void ready.push(t.serve!.url!) });
  const t = s.serve('echo "  ➜  Local:   http://localhost:5173/"; sleep 5', { script: 'dev' });
  for (let i = 0; i < 40 && !t.serve?.port; i++) await wait(25);
  assert.equal(t.serve?.port, 5173);
  assert.match(screen()[0], /1 ● dev :5173/);
  assert.deepEqual(ready, ['http://localhost:5173']);
  s.key(char('o'));
  assert.deepEqual(browsed, [['localhost:5173', t.id]], 'linked to the server tab');
  assert.equal(s.servers(), 1);
  assert.match(s.read(0) ?? '', /Local:/, 'tab.read sees its output');
  s.key(char('x'));
  assert.equal(s.asking(), true, 'a running server asks before it closes');
  s.key(char('x'));
  assert.equal(s.servers(), 0);
});

test('switcher: an address-like query offers "open in browser" first', () => {
  const { s, screen, browsed } = side(['src/locale.ts'], { scripts: () => ({ dev: 'vite' }) });
  s.files();
  s.key({ name: 'space' });
  type(s, 'localhost:3000');
  assert.match(screen(70, 20).join('\n'), /› ◐ browser\s+open localhost:3000/);
  s.key({ name: 'enter' });
  assert.deepEqual(browsed, [['localhost:3000', undefined]]);
  assert.equal(addressLike('README.md'), false, 'a file name is not an address');
  assert.equal(addressLike('example.com'), true);
  // Empty: open tabs, then new rows with the dev script as a server.
  s.key({ name: 'space' });
  assert.match(screen(70, 24).join('\n'), /open[\s\S]*1 files[\s\S]*new[\s\S]*● server\s+npm run dev/);
});

test('the tab bar keeps the active tab and shows +N when tabs do not fit', () => {
  const { s, screen } = side();
  for (let i = 0; i < 9; i++) s.mirror(`npm run task-number-${i}`);
  s.go(8);
  const bar = screen(50, 10)[0];
  assert.match(bar, /9 \$/, 'the active tab shows');
  assert.match(bar, /\+\d/, 'the rest are counted');
  assert.match(bar, /space ≡/);
});

test('plain words from the chat (no API call)', () => {
  assert.deepEqual(phrase('open split'), { key: 'panel', value: 'show' });
  assert.deepEqual(phrase('hide the panel'), { key: 'panel', value: 'hide' });
  assert.deepEqual(phrase('go to localhost:3000'), { key: 'open', value: 'localhost:3000' });
  assert.deepEqual(phrase('open index.html in the browser'), { key: 'open', value: 'index.html' });
  assert.deepEqual(phrase('run npm test'), { key: 'run', value: 'npm test' });
  assert.deepEqual(phrase('start the server'), { key: 'serve', value: '' });
  assert.deepEqual(phrase('search the files for validate'), { key: 'search', value: 'text:validate' });
  assert.deepEqual(phrase('find signup.ts'), { key: 'search', value: 'name:signup.ts' });
  assert.deepEqual(phrase('open design studio on my pricing page'), { key: 'design', value: 'pricing' });
  assert.deepEqual(phrase('open the codebase'), { key: 'tab', value: 'files' }, 'the old phrases still win');
  assert.equal(phrase('run the linter and fix what it finds'), null, 'loose requests go to the model');
});
