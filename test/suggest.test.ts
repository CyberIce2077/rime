import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { choicesOf, example, nextStep, offerOf } from '../src/core/suggest.ts';
import { optionsOf } from '../src/core/tools.ts';

test('a reply that offers something is answered with its first offer', () => {
  const cat = 'Here you go:\n\n```\n /\\_/\\\n```\n\nWant me to save it to a file, or make an animated one (multiple frames cycling in the terminal)?';
  assert.equal(offerOf(cat), 'yes, save it to a file');
  assert.equal(offerOf('Done. Should I add tests for it?'), 'yes, add tests for it');
  assert.equal(offerOf('Would you like me to also update the README?'), 'yes, update the README');
  assert.equal(offerOf('I can also add dark mode if you like?'), 'yes, add dark mode');
  assert.equal(offerOf('Which framework do you prefer?'), '', 'a real question: you answer it');
  assert.equal(offerOf('All done.'), null);
  assert.equal(
    offerOf('Want me to draft a corrected AVX2/AVX-512 nibble-deinterleave + fp8-expand sequence so the sketch is at least syntactically real?'),
    'yes, draft a corrected AVX2/AVX-512 nibble-deinterleave + fp8-expand sequence',
    'a long offer keeps only its action',
  );
  assert.equal(offerOf('Done.\n\nLet me know if you want me to add a dark mode.'), 'yes, add a dark mode');
  assert.equal(offerOf('If you like, I can wire it into the router.'), 'yes, wire it into the router');
  assert.equal(offerOf('Happy to write the migration too.'), 'yes, write the migration too');
  assert.equal(
    offerOf("Before I start writing: which chip is the target (M1? M4?) — it sets the numbers. I'll start on milestone 1 (packer + reference decoder) regardless, since it's machine-independent."),
    'yes, start on milestone 1',
  );
  assert.equal(offerOf("I'll wait for your answer."), null);
});

test('a review of a file suggests fixing it; a single command suggests running it', () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'rime-sug-'));
  const review = 'Things worth fixing:\n\n- psrldq takes an immediate\n- the pand mask is missing\n\nOverall it holds up.';
  assert.equal(nextStep(review, { wrote: [], ran: [], about: ['V32-notes.md'] }, p), 'fix these in V32-notes.md');
  assert.equal(nextStep(review, { wrote: [], ran: [] }, p), '', 'no file, no guess');
  assert.equal(nextStep('Install it first:\n\n```sh\n$ npm i express\n```\n\nThen start the server.', { wrote: [], ran: [] }, p), 'run npm i express');
});

test('the next step follows what just happened', () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'rime-sug-'));
  fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const none = { wrote: [], ran: [] };
  assert.equal(nextStep('Fixed. Want me to run the tests?', { wrote: ['a.ts'], ran: [{ cmd: 'npm test', ok: false }] }, p), 'fix the failing tests');
  assert.equal(nextStep('Here is the cat. Want me to save it to a file?', none, p), 'yes, save it to a file');
  assert.equal(nextStep('Which colour should the button be?', { wrote: ['index.html'], ran: [] }, p), '', "no suggestion when it's your call");
  assert.equal(nextStep('Created the page.', { wrote: ['index.html'], ran: [] }, p), 'open index.html in the browser');
  assert.equal(nextStep('Updated the parser.', { wrote: ['src/parse.ts'], ran: [] }, p), 'run the tests');
  assert.equal(nextStep('Hi! What are we working on?', none, p), '');
});

test('the empty prompt suggests what fits this project now', { skip: spawnSync('git', ['--version']).status !== 0 }, () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'rime-ex-'));
  assert.equal(example(p), 'build a small web page that says hello', 'an empty folder');
  spawnSync('git', ['init', '-q', p]);
  fs.mkdirSync(path.join(p, 'src'));
  fs.writeFileSync(path.join(p, 'src', 'app.ts'), 'const a = 1;\n// TODO: handle errors\n');
  fs.writeFileSync(path.join(p, 'README.md'), '# app\n');
  assert.equal(example(p), 'review my uncommitted changes (2 files)');
  const git = (...a: string[]) => spawnSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
  git('add', '-A');
  git('commit', '-qm', 'init');
  assert.equal(example(p), 'do the TODO in src/app.ts:2');
  fs.writeFileSync(path.join(p, 'src', 'app.ts'), 'const a = 1;\n');
  git('commit', '-qam', 'done');
  assert.equal(example(p), 'explain what src/app.ts does');
});

test('a reply that ends with (a)/(b) choices becomes a picker', () => {
  const reply = 'One question decides it: what does "still on GPU" mean for you?\n\n· **(a) Same file, your own CUDA kernel** — then MX-compat gives you the layout.\n· **(b) Same file consumed by existing stacks** (llama.cpp, vLLM) — then you write a conversion path.\n\n(b) is much less work. Which one did you have in mind?';
  assert.deepEqual(choicesOf(reply), {
    question: 'Which one did you have in mind?',
    options: [
      { label: 'Same file, your own CUDA kernel', detail: 'then MX-compat gives you the layout.' },
      { label: 'Same file consumed by existing stacks', detail: '(llama.cpp, vLLM) — then you write a conversion path.' },
    ],
  });
  assert.equal(choicesOf('(a) one\n(b) two\n\nDone.'), null, 'no question, no picker');
  assert.equal(choicesOf('Steps:\n(a) build\n(c) ship\n\nOk?'), null, 'letters in order only');
  assert.deepEqual(choicesOf('a) Postgres: robust\nb) SQLite: simple\n\nWhich?')!.options.map((o) => o.label), ['Postgres', 'SQLite']);
});

test("the ask tool's options are read however the model wrote them", () => {
  assert.deepEqual(optionsOf([{ label: 'A', detail: 'x' }, 'B']), [{ label: 'A', detail: 'x' }, { label: 'B' }]);
  assert.deepEqual(optionsOf('["A","B"]'), [{ label: 'A' }, { label: 'B' }]);
  assert.deepEqual(optionsOf('- A\n- B'), [{ label: 'A' }, { label: 'B' }]);
  assert.deepEqual(optionsOf([{ title: 'A', description: 'd' }]), [{ label: 'A', detail: 'd' }]);
});

test('S-1: a failing test names its file', () => {
  const ran = (out: string[]) => ({ wrote: [], ran: [{ cmd: 'npm test', ok: false, out }] });
  assert.equal(nextStep('Done.', ran(['> node --test', '✖ test/signup.test.ts (12ms)', "  TypeError: Cannot read properties of undefined"]), '/nowhere'), 'fix the failing test in signup.test.ts');
  assert.equal(nextStep('Done.', ran([' FAIL  src/auth.spec.ts', '  ● login › rejects']), '/nowhere'), 'fix the failing test in auth.spec.ts');
  assert.equal(nextStep('Done.', ran(['1 failed']), '/nowhere'), 'fix the failing tests');
});
