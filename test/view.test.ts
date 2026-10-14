import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caretOf, layoutInput, prompt, renderItem, splitToolCalls, styles } from '../src/core/view.ts';
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

test('a reply is indented two cells and uses the whole width', () => {
  const lines = renderItem({ kind: 'reply', text: 'word '.repeat(30).trim() + '\n- item', done: false }, 120, st);
  assert.ok(lines.every((l) => l.startsWith('  ')));
  assert.ok(lines.every((l) => strWidth(l) <= 120));
  assert.ok(strWidth(lines[0]) > 100);
  assert.equal(stripAnsi(lines.at(-1)!), '  · item');
});

test('tool calls written as text are caught until Rime has tools', () => {
  const qwen = 'Let me look.\n<tool_call>\n<function=Bash>\n<parameter=command>\nls -la src\n</parameter>\n</function>\n</tool_call>';
  assert.deepEqual(splitToolCalls(qwen), { text: 'Let me look.', calls: ['`ls -la src`'] });
  assert.deepEqual(splitToolCalls('<tool_call>\n{"name": "read", "arguments": {"path": "a.ts"}}\n</tool_call>').calls, ['`a.ts`']);
  assert.deepEqual(splitToolCalls('Checking <tool_c'), { text: 'Checking ', calls: [] }, 'a half-streamed tag stays hidden');
  assert.deepEqual(splitToolCalls('a < b'), { text: 'a < b', calls: [] });
  const r = renderItem({ kind: 'reply', text: qwen, done: true }, 80, st);
  assert.deepEqual(r.map(stripAnsi), ['  Let me look.']);
});

test('code blocks: no fences or background, spacing kept, long lines cut not re-flowed', () => {
  const lines = renderItem({ kind: 'reply', text: 'A cat:\n\n```\n   /\\_/\\\n  ( o.o )\n```\n\n```js\nconst x = 1;\n```', done: true }, 80, st).map(stripAnsi);
  assert.deepEqual(lines, ['  A cat:', '  ', '     /\\_/\\', '    ( o.o )', '  ', '  const x = 1;']);
  const long = renderItem({ kind: 'reply', text: '```\n' + 'x'.repeat(30) + '\n```', done: true }, 22, st).map(stripAnsi);
  assert.deepEqual(long, ['  ' + 'x'.repeat(20), '  ' + 'x'.repeat(10)]);
  const open = renderItem({ kind: 'reply', text: 'Here:\n```py\nprint("hi")', done: false }, 80, st).map(stripAnsi);
  assert.deepEqual(open, ['  Here:', '  print("hi")'], 'a block still streaming shows as code');
});

test('a "~~~" inside a ``` block (a cat\'s tail) does not end it', () => {
  const text = 'Cat:\n\n```\n ( o.o )\n   ~~~\n```\n\nAnd a bigger one:\n\n```\n |\\  _,,,\n```\n\nWant me to save it?';
  const st2 = styles('truecolor');
  const lines = renderItem({ kind: 'reply', text, done: true }, 80, st2);
  const at = (t: string) => lines.find((l) => stripAnsi(l).includes(t))!;
  assert.ok(at('~~~').includes(st2.accent), 'the tail is still code');
  assert.ok(!at('And a bigger one').includes(st2.accent), 'the prose after it is prose');
  assert.ok(at('_,,,').includes(st2.accent), 'the second block is code');
  assert.ok(!at('Want me').includes(st2.accent));
});

test('status parts pack into rows whole, and nothing is ever cut', async () => {
  const { packParts } = await import('../src/core/view.ts');
  const p = (t: string, id?: string) => ({ line: [{ t, s: '' }], ...(id ? { id } : {}) });
  const sep = { t: ' · ', s: '' };
  const text = (rows: { line: { t: string }[] }[]) => rows.map((r) => r.line.map((x) => x.t).join(''));
  // The first row is narrow (beside the meter); whole parts move down.
  assert.deepEqual(text(packParts([p('ctrl-w …'), p('v split'), p('h l focus'), p('q close')], 20, 40, sep)), ['ctrl-w … · v split', 'h l focus · q close']);
  // A part wider than any row wraps by words, nothing dropped.
  const long = text(packParts([p('one two three four five six seven eight')], 12, 16, sep));
  assert.equal(long.join(' ').replace(/\s+/g, ' '), 'one two three four five six seven eight');
  assert.ok(long.every((l, i) => l.length <= (i ? 16 : 12)));
  // Hits follow their part onto the row it landed on.
  const rows = packParts([p('aaaa', 'a'), p('bbbb', 'b')], 6, 20, sep);
  assert.deepEqual(rows.map((r) => r.hits.map((h) => `${h.id}:${h.x0}-${h.x1}`)), [['a:1-4'], ['b:1-4']]);
});
