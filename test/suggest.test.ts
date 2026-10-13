import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { example, nextStep, offerOf } from '../src/core/suggest.ts';

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
