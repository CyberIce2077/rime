import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caretOf, layoutInput, prompt, renderItem, styles } from '../src/core/view.ts';
import { stripAnsi, strWidth } from '../src/core/term.ts';

const st = styles('none');

test('input layout wraps rows and places the caret', () => {
  const rows = layoutInput('abcdef\nxy', 4);
  assert.deepEqual(rows, [{ start: 0, text: 'abcd' }, { start: 4, text: 'ef' }, { start: 7, text: 'xy' }]);
  assert.deepEqual(caretOf(rows, 4), { row: 1, col: 0 });
  assert.deepEqual(caretOf(rows, 9), { row: 2, col: 2 });
});

test('prompt box is full width with the caret after "› "', () => {
  const p = prompt('', 0, 40, 5, st);
  assert.equal(p.lines.length, 3);
  assert.ok(p.lines.every((l) => strWidth(l) === 40));
  assert.match(stripAnsi(p.lines[1]), /^│ › ask Rime/);
  assert.deepEqual(p.cursor, { row: 1, col: 4 });
});

test('a reply is indented two cells and wrapped at 76', () => {
  const lines = renderItem({ kind: 'reply', text: 'word '.repeat(30).trim() + '\n- item', done: false }, 120, st);
  assert.ok(lines.every((l) => l.startsWith('  ')));
  assert.ok(lines.every((l) => strWidth(l) <= 78));
  assert.equal(stripAnsi(lines.at(-1)!), '  · item');
});
