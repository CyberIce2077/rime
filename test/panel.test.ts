import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type SideHost, VIEWS, createSide } from '../src/plugins/panel/index.ts';
import { grep, nameHits } from '../src/plugins/panel/search.ts';
import { parseDiff, parseStatus } from '../src/plugins/panel/changes.ts';
import { stepsOf } from '../src/plugins/panel/plan.ts';
import { detect, problemsOf } from '../src/plugins/panel/checks.ts';
import { phrase } from '../src/core/settings.ts';
import { decide } from '../src/core/permissions.ts';
import { stripAnsi } from '../src/core/term.ts';
import { styles } from '../src/core/view.ts';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rime-side-')));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const char = (ch: string) => ({ name: 'char', ch });
const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });

function side(files: string[] = [], more: Partial<SideHost> = {}) {
  const root = tmp();
  for (const f of files) fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }), fs.writeFileSync(path.join(root, f), `// ${f}\nline 2\nexport function validate() {}\n`);
  const mentions: string[] = [];
  const s = createSide({
    st: styles('truecolor'), root, redraw: () => {}, env: () => process.env,
    mention: (ref, lines) => void mentions.push(lines ? `${ref}:${lines[0]}` : ref),
    toChat: () => {}, open: () => {}, files: () => files,
    diff: () => '', git: () => false, undone: () => {}, commitByRime: () => {},
    ...more,
  });
  const screen = (w = 100, h = 18, focused = true) => s.panel.render(w, h, focused).lines.map(stripAnsi);
  const keys = (...ks: (string | { name: string; ctrl?: boolean; shift?: boolean })[]) => ks.forEach((k) => s.panel.key(typeof k === 'string' ? (k.length === 1 ? char(k) : { name: k }) : k));
  return { s, root, mentions, screen, keys };
}

test('three views in a fixed order; numbers and tab pick them, esc gives the keys back', () => {
  const { s, screen, keys } = side();
  assert.deepEqual(s.panel.views.map((v) => v.id), [...VIEWS]);
  s.panel.show(true);
  assert.match(screen(60)[0], /1 changes\s+2 run\s+3 files\s+✕/);
  keys('2');
  assert.equal(s.panel.active, 'run');
  keys('tab');
  assert.equal(s.panel.active, 'files');
  keys({ name: 'tab', shift: true }, { name: 'tab', shift: true });
  assert.equal(s.panel.active, 'changes');
  assert.equal(s.panel.key({ name: 'escape' }), 'blur');
});

test('q closes the panel and gives the keys back; ctrl+g opens it again', () => {
  const { s, screen } = side();
  s.panel.go('run');
  assert.match(screen().join('\n'), /q close/);
  assert.equal(s.panel.key(char('q')), 'blur');
  assert.equal(s.panel.visible, false);
  s.panel.go('files');
  s.panel.key(char('/')); // typing a search: q is a letter
  s.panel.key(char('q'));
  assert.equal(s.panel.visible, true);
});

test('the tab bar shortens titles but keeps the active one whole', () => {
  const { s, screen } = side();
  s.panel.go('files');
  const bar = screen(22)[0];
  assert.match(bar, /3 files/);
  assert.doesNotMatch(bar, /changes/);
});

test('unfocused, the footer says only ctrl+g focus; ? lists the keys', () => {
  const { s, screen, keys } = side();
  s.panel.go('run');
  assert.match(screen(70, 18, false).join('\n'), /ctrl\+g focus/);
  keys('?');
  const out = screen().join('\n');
  assert.match(out, /ctrl\+g\s+back to the chat/);
  assert.match(out, /← →  tab\s+the next view/);
  assert.match(out, /1-3\s+jump to a view/);
});

test('← → move between views, around the ends; a view typing keeps them', () => {
  const { s, keys } = side();
  s.panel.go('changes');
  keys('right');
  assert.equal(s.panel.active, 'run');
  keys('left', 'left');
  assert.equal(s.panel.active, 'files', 'wraps around');
  keys('/'); // the search line takes the typing
  keys('left');
  assert.equal(s.panel.active, 'files', 'the arrow moved in the text instead');
});

test('a dragged tab takes the new place; numbers and the saved order follow', () => {
  let saved: string[] = [];
  const { s, keys } = side([], { reordered: (ids) => void (saved = ids) });
  s.panel.go('files');
  s.panel.move(2, 0); // files to the front
  assert.deepEqual(saved, ['files', 'changes', 'run']);
  assert.equal(s.panel.active, 'files', 'the view you were on stays');
  keys('2');
  assert.equal(s.panel.active, 'changes');
  const again = side([], { order: saved });
  assert.deepEqual(again.s.panel.views.map((v) => v.id), saved, 'the order comes back next time');
  const partial = side([], { order: ['log', 'run', 'review'] });
  assert.deepEqual(partial.s.panel.views.map((v) => v.id), ['run', 'changes', 'files'], 'old view names in a saved order are skipped');
});

test('the panel opens on the view with something to show', () => {
  const { s } = side(['a.ts']);
  assert.equal(s.best(), 'files', 'nothing anywhere: the files');
  s.run.mirror('npm run build').done(1);
  assert.equal(s.best(), 'run', 'a command that failed');
  s.panel.go('files');
  assert.equal(s.best(), 'run', 'the files with nothing open give way');
  s.files.openFile('a.ts');
  assert.equal(s.best(), 'files', 'a file you were reading stays');
});

test("run: Rime's commands stream in and show how they ended", () => {
  const { s, screen } = side();
  s.panel.go('run');
  const m = s.run.mirror('npm test');
  m.write('ok 1\nok 2\n');
  m.done(0);
  const out = screen().join('\n');
  assert.match(out, /npm test/);
  assert.match(out, /ok 2/);
  assert.equal(s.run.procs.at(-1)!.state, 'passed');
  assert.match(s.run.read!(10), /ok 1\nok 2/);
});

test('run: a server keeps running, shows its address, and stops with killAll', async () => {
  const { s } = side();
  const p = s.run.serve(`node -e "console.log('ready on http://localhost:4321'); setInterval(() => {}, 1000)"`);
  for (let i = 0; i < 80 && !p.serve?.url; i++) await wait(25);
  assert.equal(p.serve?.url, 'http://localhost:4321');
  assert.equal(s.run.servers(), 1);
  s.run.killAll();
  for (let i = 0; i < 80 && p.state === 'running'; i++) await wait(25);
  assert.notEqual(p.state, 'running');
});

test('run: n opens a shell of your own; enter types into it', async () => {
  const { s, keys } = side();
  s.panel.go('run');
  keys('n');
  assert.equal(s.panel.typing(), true, 'a new shell takes the typing');
  for (const ch of 'echo hi') s.panel.key(ch === ' ' ? { name: 'space' } : char(ch));
  keys('enter');
  const p = s.run.procs.at(-1)!;
  for (let i = 0; i < 80 && p.state !== 'passed'; i++) await wait(25);
  assert.ok(p.out.includes('hi'));
});

test('files: search finds names and text (rg searches the folder, not stdin)', () => {
  const files = ['src/signup.ts', 'src/auth/sign.ts', 'README.md'];
  const { root } = side(files);
  assert.equal(nameHits('signup', files)[0].path, 'src/signup.ts');
  const hits = grep(root, 'validate', files);
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map((h) => h.line), [3, 3, 3]);
  assert.equal(grep(root, 'validate', files, 200, false).length, 3, 'the plain fallback agrees');
});

test('files: the tree opens a file in the viewer; @ mentions it', () => {
  const { s, screen, keys, mentions } = side(['src/a.ts', 'b.ts']);
  s.panel.go('files');
  assert.ok(s.files.openFile('src/a.ts', 2));
  assert.match(screen().join('\n'), /export function validate/);
  keys('@');
  assert.ok(mentions[0]?.startsWith('src/a.ts'));
});

test('run: the checks wait at the top; r runs one, a failure is selected with its problems', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'x\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { lint: 'echo lint ok', test: 'echo "src/a.ts:1:1 broken" && exit 1' } }));
  const s = createSide({
    st: styles('truecolor'), root, redraw: () => {}, env: () => process.env, mention: () => {}, toChat: () => {}, open: () => {}, files: () => ['src/a.ts'],
    diff: () => '', git: () => false, undone: () => {}, commitByRime: () => {},
  });
  s.run.mirror('ls').done(0);
  s.panel.go('run');
  const out = s.panel.render(100, 18, true).lines.map(stripAnsi).join('\n');
  assert.match(out, /○ lint\s+npm run lint/);
  assert.match(out, /○ tests\s+npm test/);
  assert.equal(s.run.procs[s.run.sel].cmd, 'ls', 'the selection stays on its command');
  s.run.checks.run();
  const tests = s.run.checks.list.find((p) => p.check!.name === 'tests')!;
  for (let i = 0; i < 200 && s.run.checks.list.some((p) => p.state === 'running'); i++) await wait(25);
  assert.equal(tests.state, 'failed');
  assert.deepEqual(tests.check!.problems.map((p) => `${p.path}:${p.line}`), ['src/a.ts:1']);
  assert.equal(s.run.procs[s.run.sel], tests, 'the failure is selected');
  assert.match(stripAnsi(s.run.badge()!.t), /✗/);
  assert.match(s.run.read!(), /tests failed|broken/);
  s.panel.key({ name: 'enter' });
  assert.equal(s.panel.active, 'files', 'enter opens the first problem');
  assert.equal(s.files.viewing, 'src/a.ts');
});

test('changes: parseDiff splits files and hunks', () => {
  const d = parseDiff(['diff --git a/x.ts b/x.ts', 'index 1..2 100644', '--- a/x.ts', '+++ b/x.ts', '@@ -1,2 +1,2 @@', ' a', '-b', '+B', '@@ -10,1 +10,2 @@', ' j', '+k', ''].join('\n'));
  assert.equal(d.length, 1);
  assert.equal(d[0].path, 'x.ts');
  assert.equal(d[0].hunks.length, 2);
  assert.equal(d[0].hunks[1].start, 10);
});

test('changes: y keeps a hunk, u undoes one in the file, c commits', () => {
  const root = tmp();
  git(root, 'init', '-q');
  fs.writeFileSync(path.join(root, 'a.txt'), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'one');
  const lines = fs.readFileSync(path.join(root, 'a.txt'), 'utf8').split('\n');
  lines[1] = 'CHANGED 2';
  lines[17] = 'CHANGED 18';
  fs.writeFileSync(path.join(root, 'a.txt'), lines.join('\n'));
  const undone: string[] = [];
  const s = createSide({
    st: styles('truecolor'), root, redraw: () => {}, mention: () => {}, toChat: () => {}, open: () => {}, files: () => ['a.txt'],
    env: () => ({ ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }),
    diff: () => git(root, 'diff', '--no-color').stdout, git: () => true, undone: (f, l) => void undone.push(`${f}:${l}`),
    commitByRime: () => {},
  });
  s.panel.go('changes');
  assert.equal(s.changes.pending, 1);
  assert.match(stripAnsi(s.panel.render(80, 18, true).lines.join('\n')), /⎇ \S+ · 1 file changed/);
  s.panel.key(char('y')); // the file row: keeps its first hunk
  s.panel.key(char('n')); // the next hunk
  s.panel.key(char('u'));
  const after = fs.readFileSync(path.join(root, 'a.txt'), 'utf8');
  assert.match(after, /CHANGED 2/, 'the kept hunk stays');
  assert.doesNotMatch(after, /CHANGED 18/, 'the undone hunk is back as it was');
  assert.equal(undone.length, 1);
  s.panel.key(char('c'));
  for (const ch of 'two') s.panel.key(char(ch));
  s.panel.key({ name: 'enter' });
  assert.match(git(root, 'log', '--oneline', '-1').stdout, /two/);
  assert.equal(git(root, 'status', '--porcelain').stdout, '', 'everything went in');
});

test('plan: steps from however the model writes them', () => {
  assert.deepEqual(stepsOf(['a', { text: 'b', status: 'in progress' }, { step: 'c', state: 'complete' }]), [{ text: 'a', state: 'next' }, { text: 'b', state: 'now' }, { text: 'c', state: 'done' }]);
  assert.equal(stepsOf('nope'), null);
});

test('checks: finds the scripts and the problems they print', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc', lint: 'eslint .', test: 'node --test' } }));
  assert.deepEqual(detect(root).map((c) => `${c.name}: ${c.cmd}`), ['types: npm run typecheck', 'lint: npm run lint', 'tests: npm test']);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/a.ts'), '');
  const p = problemsOf(['src/a.ts(3,5): error TS2304: nope', `${root}/src/a.ts:9:1 bad`, 'node_modules/x/y.js:1:1 skip', 'gone.ts:1:1 missing'], root);
  assert.deepEqual(p.map((x) => `${x.path}:${x.line}`), ['src/a.ts:3', 'src/a.ts:9']);
});

test('changes: git status parses into the branch line', () => {
  const s = parseStatus('## main...origin/main [ahead 2]\nM  src/a.ts\n M b.ts\n?? new.ts\n?? .rime/x\n');
  assert.equal(s.branch, 'main');
  assert.equal(s.ahead, 2);
  assert.deepEqual(s.files.map((f) => f.path), ['src/a.ts', 'b.ts', 'new.ts']);
});

test('plain words from the chat (no API call)', () => {
  assert.deepEqual(phrase('open split'), { key: 'panel', value: 'show' });
  assert.deepEqual(phrase('hide the panel'), { key: 'panel', value: 'hide' });
  assert.deepEqual(phrase('show the diff'), { key: 'panel', value: 'changes' });
  assert.deepEqual(phrase('open the codebase'), { key: 'panel', value: 'files' });
  assert.deepEqual(phrase('show the checks'), { key: 'panel', value: 'run' });
  assert.equal(phrase('show the plan'), null, 'the plan is above the prompt: that goes to the model');
  assert.deepEqual(phrase('run the tests'), { key: 'checks', value: 'run' });
  assert.deepEqual(phrase('run npm test'), { key: 'run', value: 'npm test' });
  assert.deepEqual(phrase('start the server'), { key: 'serve', value: '' });
  assert.deepEqual(phrase('search the files for validate'), { key: 'search', value: 'text:validate' });
  assert.deepEqual(phrase('find signup.ts'), { key: 'search', value: 'name:signup.ts' });
  assert.equal(phrase('go to localhost:3000'), null, 'no browser: that goes to the model');
  assert.equal(phrase('run the linter and fix what it finds'), null, 'loose requests go to the model');
});

test('the rime tool runs without asking; it has no browser', () => {
  const c = { mode: 'ask' as const, project: '/p', rules: [] };
  assert.equal(decide('rime', { action: 'panel.show', args: { view: 'checks' } }, c).verdict, 'allow');
  assert.equal(decide('rime', { action: 'browser.open', args: { url: 'https://x.com' } }, c).verdict, 'allow', 'it only answers that there is none');
});
