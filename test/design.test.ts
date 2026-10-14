import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVersions, designFile, pickName, slug, starter } from '../src/plugins/design/design.ts';

test('a design is named from its description and starts as a plain page', () => {
  assert.equal(slug('Landing page for a notes app!'), 'landing-page-for-a');
  assert.equal(designFile('landing'), 'design/landing.html');
  assert.match(starter('landing page for <notes>'), /<h1>Landing page for notes<\/h1>/);
});

test('every change is a version; stepping back puts it in the file; a change there branches', () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rime-design-')));
  fs.mkdirSync(path.join(d, 'design'));
  const file = path.join(d, 'design', 'landing.html');
  const v = createVersions(d, 'landing');
  for (const html of ['<h1>one</h1>', '<h1>two</h1>', '<h1>three</h1>']) fs.writeFileSync(file, html), v.record(html);
  assert.deepEqual(v.state(), { count: 3, current: 3 });
  assert.equal(v.record('<h1>three</h1>'), 3, 'the same page is not a new version');
  v.show(1);
  assert.equal(fs.readFileSync(file, 'utf8'), '<h1>one</h1>');
  assert.equal(v.record('<h1>one</h1>'), 1, 'showing a version (the watcher fires) adds nothing');
  assert.equal(v.record('<h1>one, bigger</h1>'), 4, 'a change on an older version is a new branch');
  assert.equal(v.show(9), null);
});

test('a picked element gets a name for the prompt', () => {
  const e = (o: Partial<{ tag: string; text: string; id: string; cls: string; alt: string }>) => pickName({ tag: 'div', text: '', id: '', cls: '', alt: '', ...o });
  assert.equal(e({ tag: 'h1', text: 'Notes that find themselves' }), 'Headline');
  assert.equal(e({ tag: 'button', text: 'Start free trial now' }), 'Button "Start free trial"');
  assert.equal(e({ tag: 'section', id: 'pricing-table' }), 'Pricing');
  assert.equal(e({ tag: 'div', cls: 'hero dark' }), 'Hero');
  assert.equal(e({ tag: 'img', alt: 'App screenshot' }), 'Image "App screenshot"');
});
