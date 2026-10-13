import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { blocksFor, chipChar, chipFor, folderTree, imageSize, label, parts, pastedPaths, textChip, thumbSize } from '../src/core/attach.ts';
import { offsetAt, prompt, styles } from '../src/core/view.ts';
import { stripAnsi } from '../src/core/term.ts';
import { toWire } from '../src/providers/openai.ts';

// A real (tiny) PNG, w×h, solid colour.
function png(w: number, h: number) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x7f)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rime-attach-'));
  fs.writeFileSync(path.join(dir, 'my shot.png'), png(1280, 800));
  fs.writeFileSync(path.join(dir, 'notes.md'), Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n'));
  fs.mkdirSync(path.join(dir, 'v32', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'v32', 'README.md'), '# v32\n');
  fs.writeFileSync(path.join(dir, 'v32', 'src', 'encode.ts'), 'export {}\n');
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3]));
  return dir;
}

const counter = () => {
  const n: Record<string, number> = {};
  return (k: string) => (n[k] = (n[k] ?? 0) + 1);
};

test('a dropped path pastes as quoted, backslash-escaped or file:// text, and becomes chips', () => {
  const dir = sandbox();
  const shot = path.join(dir, 'my shot.png');
  assert.deepEqual(pastedPaths(shot.replace(/ /g, '\\ ') + ' '), [shot], 'macOS Terminal escapes spaces');
  assert.deepEqual(pastedPaths(`'${shot}' "${path.join(dir, 'notes.md')}"`), [shot, path.join(dir, 'notes.md')]);
  assert.deepEqual(pastedPaths(`file://${encodeURI(shot)}`), [shot]);
  assert.equal(pastedPaths(`${shot} and some words`), null, 'only when every part is a path');
  assert.equal(pastedPaths('fix the /bin/ls output'), null);
  assert.equal(pastedPaths(path.join(dir, 'missing.png')), null);
});

test('chips: image, text file, folder, other file and long text', () => {
  const dir = sandbox();
  const n = counter();
  const img = chipFor(path.join(dir, 'my shot.png'), n, dir, () => {});
  assert.deepEqual([img.kind, img.w, img.h, img.tok], ['image', 1280, 800, 1366]);
  assert.equal(label(img), 'image 1 · 1280×800 · ~1.4k tok');
  assert.equal(label(img, true), '⚠ image 1 · 1280×800 · ~1.4k tok', 'a model that can\'t see');
  const file = chipFor(path.join(dir, 'notes.md'), n, dir, () => {});
  assert.equal(file.kind, 'file');
  assert.match(label(file), /^file · notes\.md · 250 lines · ~[\d.]+k? tok$/);
  assert.match(file.text!, /^    1  line 1\n[\s\S]*  200  line 200\n… 50 more lines$/, 'sent like a read');
  const folder = chipFor(path.join(dir, 'v32'), n, dir, () => {});
  assert.deepEqual(folder.tree!.map((l) => l.replace(/\s+[\d.]+ [KMG]?B$/, '')), ['v32/', '  README.md', '  src/', '    encode.ts']);
  assert.match(label(folder), /^folder · v32 · 2 files · ~\d+ tok$/);
  const bin = chipFor(path.join(dir, 'blob.bin'), n, dir, () => {});
  assert.equal(label(bin), 'bin · blob.bin · 5 B');
  const t = textChip(Array.from({ length: 148 }, (_, i) => `row ${i}`).join('\n'), n);
  assert.match(label(t), /^text 1 · 148 lines · ~[\d.]+k? tok$/);
});

test('a folder sent as its tree respects .gitignore when it is a repo', { skip: spawnSync('git', ['--version']).status !== 0 }, () => {
  const dir = sandbox();
  const repo = path.join(dir, 'v32');
  spawnSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'build/\n');
  fs.mkdirSync(path.join(repo, 'build'));
  fs.writeFileSync(path.join(repo, 'build', 'out.js'), '');
  const t = folderTree(repo);
  assert.ok(!t.lines.some((l) => l.includes('out.js')));
  assert.equal(t.files, 3); // .gitignore, README.md, src/encode.ts
});

test('image sizes come from the file header', () => {
  assert.deepEqual(imageSize(png(3, 2)), { w: 3, h: 2, mime: 'image/png' });
  const gif = Buffer.from('GIF89a\x40\x01\xf0\x00\x00\x00', 'latin1');
  assert.deepEqual(imageSize(gif), { w: 320, h: 240, mime: 'image/gif' });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03]);
  assert.deepEqual(imageSize(jpg), { w: 640, h: 480, mime: 'image/jpeg' });
  assert.equal(imageSize(Buffer.from('hello world, not an image')), null);
  assert.deepEqual(thumbSize(1280, 800, 56, 8), { cols: 26, rows: 16 });
});

test('the next message: what gets sent, and the content blocks', async () => {
  const dir = sandbox();
  const n = counter();
  const chips = new Map([[chipChar(0), chipFor(path.join(dir, 'my shot.png'), n, dir, () => {})], [chipChar(1), chipFor(path.join(dir, 'v32'), n, dir, () => {})]]);
  const buf = `the signup page crashes, see ${chipChar(0)} and fix it\n${chipChar(1)}`;
  const ps = parts(buf, chips);
  assert.deepEqual(ps.map((p) => p.what.split(' · ')[0]), ['your text', 'image 1', `folder ${path.join(dir, 'v32')}`]);
  const blocks = await blocksFor(buf, chips, dir);
  assert.equal(blocks[0].text, 'the signup page crashes, see [image 1] and fix it\n[folder v32]');
  assert.equal(blocks[1].text, '[image 1] my shot.png, 1280×800:');
  assert.equal(blocks[2].type, 'image');
  assert.equal((blocks[2].source as any).media_type, 'image/png');
  assert.match(String(blocks.at(-1)!.text), /^\[folder v32\] .*\(2 files; read files inside it if you need them\)\nv32\/\n  README\.md/);
  const blind = await blocksFor(buf, chips, dir, false);
  assert.ok(!blind.some((b) => b.type === 'image'), "a model that can't see gets no images");
  // The OpenAI wire sends them as image_url parts, in order.
  const wire = toWire('SYS', [{ role: 'user', content: blocks }]);
  const content = (wire[1] as any).content;
  assert.deepEqual(content.map((c: any) => c.type), ['text', 'text', 'image_url', 'text']);
  assert.match(content[2].image_url.url, /^data:image\/png;base64,/);
});

test('video goes as up to 8 frames, 1 per second', { skip: spawnSync('ffmpeg', ['-version']).status !== 0, timeout: 30000 }, async () => {
  const dir = sandbox();
  const v = path.join(dir, 'demo.mp4');
  spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=3', '-y', v]);
  let c!: ReturnType<typeof chipFor>;
  await new Promise<void>((done) => (c = chipFor(v, counter(), dir, done)));
  assert.equal(c.frames!.length, 3);
  assert.deepEqual([c.fw, c.fh], [320, 240]);
  assert.match(label(c), /^video 1 · demo\.mp4 · 0:03 → 3 frames · ~\d+ tok$/);
});

test('the prompt draws chips, the selection, and the line count in its frame', () => {
  const st = styles('none');
  const ch = chipChar(0);
  const chip = (c: string) => (c === ch ? { label: 'image 1 · 1280×800 · ~1.4k tok' } : undefined);
  const p = prompt(`see ${ch}\nfix it\nnow`, 0, 60, 10, st, { chip, sel: [0, 3] });
  const lines = p.lines.map(stripAnsi);
  assert.equal(lines[1], '│ › see [image 1 · 1280×800 · ~1.4k tok]                   │');
  assert.match(lines.at(-1)!, /╰─+ 3 lines · enter send · ctrl\+j new line ─╯$/);
  assert.equal(lines.at(-1)!.length, 60);
  assert.deepEqual(p.hits.map((h) => h.id), ['key:enter', 'key:ctrl+j']);
  // A click on the chip lands on it; a click after it, past it.
  const w = (c: string) => (c === ch ? 33 : undefined);
  assert.equal(offsetAt(p.rows[0], 10, w), 4);
  assert.equal(offsetAt(p.rows[0], 30, w), 5);
});
