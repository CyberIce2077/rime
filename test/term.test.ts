import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createParser, fit, lineWidth, sliceCols, strWidth, truncAnsi, wrap } from '../src/core/term.ts';

test('width counts wide characters and skips escapes', () => {
  assert.equal(strWidth('\x1b[1mab\x1b[0m'), 2);
  assert.equal(strWidth('日本'), 4);
  assert.equal(strWidth('↑↓ · ›'), 6);
});

test('wrap breaks on words, keeps styles, and cuts long words', () => {
  const lines = wrap([{ t: 'hello ', s: 'A' }, { t: 'big world', s: 'B' }], 9);
  assert.deepEqual(lines.map((l) => l.map((r) => r.t).join('')), ['hello big', 'world']);
  assert.equal(lines[0][1].s, 'B');
  assert.deepEqual(wrap([{ t: 'abcdefghij', s: '' }], 4).map((l) => l[0].t), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrap([{ t: '  indented', s: '' }], 20)[0][0].t, '  indented');
});

test('fit pads and ellipsizes to an exact width', () => {
  assert.equal(lineWidth(fit([{ t: 'abc', s: '' }], 6)), 6);
  const cut = fit([{ t: 'abcdefgh', s: '' }], 5);
  assert.equal(cut.map((r) => r.t).join(''), 'abcd…');
});

test('truncAnsi keeps escape codes', () => {
  assert.equal(truncAnsi('\x1b[1mabcdef\x1b[0m', 3), '\x1b[1mabc\x1b[0m');
});

test('parser decodes keys, modified enter, mouse, paste and cursor reports', () => {
  const p = createParser();
  const names = (s: string) => p(s).map((e) => (e.type === 'key' ? e.name + (e.shift ? '+shift' : '') + (e.ctrl ? '+ctrl' : '') : e.type));
  assert.deepEqual(names('a\r\x7f\x03'), ['char', 'enter', 'backspace', 'c+ctrl']);
  assert.deepEqual(names('\x1b[13;2u\x1b[27;2;13~\x1b[27u\x1b'), ['enter+shift', 'enter+shift', 'escape', 'escape']);
  assert.deepEqual(names('\x1b[A\x1bOB\x1b[1;5D\x1b[3~'), ['up', 'down', 'left+ctrl', 'delete']);
  assert.deepEqual(p('\x1b[<0;6;4M'), [{ type: 'mouse', button: 0, x: 6, y: 4, release: false }]);
  assert.deepEqual(p('\x1b[12;1R'), [{ type: 'cpr', row: 12, col: 1 }]);
  assert.deepEqual(p('\x1b[200~one\r\n'), []);
  assert.deepEqual(p('two\x1b[201~x'), [{ type: 'paste', text: 'one\r\ntwo' }, { type: 'key', name: 'char', ch: 'x' }]);
});

test('space is one key however the terminal sends it', () => {
  const p = createParser();
  const space = { type: 'key', name: 'space', ch: ' ' };
  assert.deepEqual(p(' '), [space]);
  assert.deepEqual(p('\x1b[32u'), [{ ...space, shift: false, alt: false, ctrl: false }]);
});

test('sliceCols cuts plain text by screen column', () => {
  assert.equal(sliceCols('\x1b[1mhello\x1b[0m world', 2, 4), 'ell');
  assert.equal(sliceCols('日本語', 3, 4), '本');
  assert.equal(sliceCols('abc', 2, 99), 'bc');
});

test('wrap with a hanging indent: later lines get their own width', async () => {
  const { wrap } = await import('../src/core/term.ts');
  const lines = wrap([{ t: '/setup  connect your server, this computer, or a provider', s: '' }], 30, 20).map((l) => l.map((r) => r.t).join(''));
  assert.equal(lines[0], '/setup  connect your server,');
  assert.ok(lines.slice(1).every((l) => l.length <= 20), JSON.stringify(lines));
});
