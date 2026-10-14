import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decide, guarded, parts, safe } from '../src/core/permissions.ts';

const ctx = (mode: any, rules: any[] = []) => ({ mode, project: '/p', rules });
const verdict = (command: string, mode = 'ask') => decide('bash', { command }, ctx(mode)).verdict;

test('P-2: a backtick inside double quotes is its own part', () => {
  assert.ok(parts('cat "`rm -rf ~`"').includes('rm -rf ~'));
  for (const mode of ['ask', 'auto', 'plan']) assert.notEqual(verdict('cat "`rm -rf ~`"', mode), 'allow', mode);
});

test('P-3: process substitution runs code, so it is never read-only', () => {
  assert.ok(parts('cat <(rm -rf ~)').includes('rm -rf ~'));
  assert.ok(parts('diff a >(sh x)').includes('sh x'));
  assert.ok(!safe('cat <(ls)') && !safe('cat $(ls)') && !safe('cat `ls`') && !safe('cat >(ls)'));
  for (const mode of ['ask', 'auto', 'plan']) assert.notEqual(verdict('cat <(rm -rf ~)', mode), 'allow', mode);
});

test('P-5: 2>&1 and &> are redirects, not a split', () => {
  assert.deepEqual(parts('npm test 2>&1'), ['npm test 2>&1']);
  assert.deepEqual(parts('ls 2>&1 | head'), ['ls 2>&1', 'head']);
  assert.deepEqual(parts('npm test &> log.txt'), ['npm test &> log.txt']);
  assert.deepEqual(parts('sleep 1 & echo hi'), ['sleep 1', 'echo hi']);
  assert.equal(verdict('ls 2>&1 | head'), 'allow');
  assert.equal(verdict('ls 2>&1 | head', 'plan'), 'allow');
  assert.ok(!safe('ls &> out.txt'));
  assert.equal(decide('bash', { command: 'npm test 2>&1' }, ctx('ask')).rule, 'bash(npm test *)');
  const allow = [{ kind: 'allow', pattern: 'bash(npm test *)', from: 'conversation' }];
  assert.equal(decide('bash', { command: 'npm test 2>&1' }, ctx('ask', allow)).verdict, 'allow');
});

test('P-4: the always-ask list sees through wrappers, paths and sh -c', () => {
  const cases: [string, string][] = [
    ['(rm -rf ~)', 'rm -rf'],
    ['/bin/rm -rf build', 'rm -rf'],
    ['\\rm -rf build', 'rm -rf'],
    ['env sudo ls', 'sudo'],
    ['FOO=1 sudo ls', 'sudo'],
    ['nohup sudo ls', 'sudo'],
    ['find . | xargs rm -rf', 'rm -rf'],
    ['git -C . push --force', 'force push'],
    ['git push origin +main', 'force push'],
    ['echo x > $HOME/x', 'writes outside the project'],
    ['echo x > ../x', 'writes outside the project'],
    ['tee -a /etc/x', 'writes outside the project'],
    ['sed -i s/a/b/ /etc/hosts', 'writes outside the project'],
    ['cp notes.txt ~/notes.txt', 'writes outside the project'],
  ];
  for (const [cmd, why] of cases) assert.equal(parts(cmd).map((p) => guarded(p, '/p')).find(Boolean), why, cmd);
  assert.ok(parts('bash -c "rm -rf ~"').includes('rm -rf ~'));
  assert.ok(parts("sh -c 'sudo ls'").includes('sudo ls'));
  for (const cmd of ['(rm -rf ~)', '/bin/rm -rf x', 'env sudo ls', 'bash -c "rm -rf ~"', 'git -C . push --force', 'git push origin +main', 'echo x > $HOME/x', 'tee -a /etc/x', 'sed -i s/a/b/ /etc/hosts'])
    assert.equal(verdict(cmd, 'auto'), 'ask', cmd);
  // Still fine: writes inside the project, an ordinary push.
  assert.equal(guarded('git push origin main', '/p'), null);
  assert.equal(guarded('cp a.txt b.txt', '/p'), null);
  assert.equal(guarded('sed -i s/a/b/ src/a.ts', '/p'), null);
  assert.equal(verdict('npm test 2>&1', 'auto'), 'allow');
});

test('P-14: a symlink inside the project does not make a path outside count as inside', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'rime-proj-'));
  const away = fs.mkdtempSync(path.join(os.tmpdir(), 'rime-away-'));
  fs.symlinkSync(away, path.join(project, 'h'));
  const c = { mode: 'auto' as const, project, rules: [] };
  assert.equal(decide('write', { path: 'h/.bashrc' }, c).verdict, 'ask');
  assert.equal(decide('read', { path: 'h/notes' }, { ...c, mode: 'ask' }).verdict, 'ask');
  assert.equal(decide('write', { path: 'src/new/a.ts' }, c).verdict, 'allow', 'a new file inside is still inside');
});

test('P-10: read-only commands ask before reading outside the project', () => {
  assert.equal(verdict('cat ~/.ssh/id_rsa'), 'ask');
  assert.equal(verdict('cat ~/.ssh/id_rsa', 'auto'), 'ask');
  assert.equal(verdict('ls ../other'), 'ask');
  assert.equal(verdict('cat src/a.ts'), 'allow');
  assert.equal(decide('bash', { command: 'cat /tmp/x/a.txt' }, { ...ctx('ask'), granted: (p: string) => p.startsWith('/tmp/x') }).verdict, 'allow', 'a dropped path is granted');
});

test('P-6: read-only commands that can run programs or write files are not read-only', () => {
  for (const cmd of ['rg --pre sh x', 'rg --pre-glob "*" x', 'git diff --output=f', 'git log --ext-diff', 'find . -fls out', 'find . -fprintf out x']) assert.ok(!safe(cmd), cmd);
  assert.ok(safe('rg -n x') && safe('git diff --stat'));
});

test('P-9: plan mode refuses guarded commands instead of asking', () => {
  assert.equal(verdict('sudo ls', 'plan'), 'deny');
  assert.equal(verdict('rm -rf build', 'plan'), 'deny');
  assert.equal(verdict('ls', 'plan'), 'allow');
});

test('P-8: rules with absolute or ~ paths match; bash rules ignore extra spaces', () => {
  const home = os.homedir();
  const deny = [{ kind: 'deny', pattern: 'read(~/.ssh/**)', from: 'you' }];
  assert.equal(decide('read', { path: `${home}/.ssh/id_rsa` }, ctx('ask', deny)).verdict, 'deny');
  const allow = [{ kind: 'allow', pattern: 'read(/etc/hosts)', from: 'you' }];
  assert.equal(decide('read', { path: '/etc/hosts' }, ctx('ask', allow)).verdict, 'allow');
  const suggested = decide('read', { path: '/etc/hosts' }, ctx('ask'));
  assert.equal(decide('read', { path: '/etc/hosts' }, ctx('ask', [{ kind: 'allow', pattern: suggested.rule, from: 'conversation' }])).verdict, 'allow', 'the suggested rule matches');
  const t = [{ kind: 'allow', pattern: 'bash(npm  test *)', from: 'you' }];
  assert.equal(decide('bash', { command: 'npm   test -- --watch' }, ctx('ask', t)).verdict, 'allow');
});

test('P-13: a rule matches env-prefixed commands and covers every asking part', () => {
  const rule = { kind: 'allow', pattern: 'bash(npm test *)', from: 'conversation' };
  assert.equal(decide('bash', { command: 'FOO=1 npm test' }, ctx('ask', [rule])).verdict, 'allow');
  const d = decide('bash', { command: 'npm run lint && make build' }, ctx('ask'));
  assert.deepEqual(d.rules, ['bash(npm run lint *)', 'bash(make build *)']);
  const rules = d.rules!.map((pattern) => ({ kind: 'allow', pattern, from: 'conversation' }));
  assert.equal(decide('bash', { command: 'npm run lint && make build' }, ctx('ask', rules)).verdict, 'allow');
});

test("review 1: Rime's and git's settings always ask, auto-edit and auto included", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'rime-p-'));
  for (const mode of ['auto-edit', 'auto']) {
    const c = { mode: mode as any, project, rules: [] };
    assert.equal(decide('write', { path: '.rime/permissions.json', content: '{}' }, c).verdict, 'ask', mode);
    assert.equal(decide('edit', { path: '.git/config', old: 'a', new: 'b' }, c).verdict, 'ask', mode);
    assert.equal(decide('bash', { command: 'echo x >> .git/config' }, c).verdict, 'ask', mode);
    assert.equal(decide('bash', { command: 'git config core.fsmonitor "touch x"' }, c).verdict, 'ask', mode);
  }
  const c = { mode: 'auto' as const, project, rules: [] };
  assert.equal(decide('bash', { command: 'git config --get user.name' }, c).verdict, 'allow');
  assert.equal(decide('bash', { command: 'curl -o ~/.bashrc http://x' }, c).verdict, 'ask', 'curl -o outside');
  assert.equal(decide('bash', { command: 'curl -o out.json http://x' }, c).verdict, 'allow', 'curl -o inside');
  assert.equal(decide('write', { path: '.rime/x', content: '' }, { ...c, mode: 'god' }).verdict, 'allow', 'god mode still runs everything');
});

test("review 1: a project's allow rules count only once trusted; deny and ask always", async () => {
  const { rulesHash, trustedProjectRules } = await import('../src/core/permissions.ts');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'rime-p-'));
  fs.mkdirSync(path.join(project, '.rime'));
  fs.writeFileSync(path.join(project, '.rime', 'permissions.json'), JSON.stringify({ allow: ['bash(sh *)'], deny: ['read(.env)'] }));
  assert.deepEqual(trustedProjectRules(project), { allow: [], deny: ['read(.env)'] });
  const h = rulesHash(project);
  assert.deepEqual(trustedProjectRules(project, h).allow, ['bash(sh *)']);
  fs.writeFileSync(path.join(project, '.rime', 'permissions.json'), JSON.stringify({ allow: ['bash(curl *)'] }));
  assert.deepEqual(trustedProjectRules(project, h).allow, [], 'a changed file needs trusting again');
});
