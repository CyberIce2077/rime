import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIndex, symbolsOf } from '../src/plugins/code-index/index.ts';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rime-ix-')));
const put = (d: string, f: string, s: string) => (fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }), fs.writeFileSync(path.join(d, f), s));

test('declarations come out of TS, Python, Go and Rust', () => {
  assert.deepEqual(symbolsOf('a.ts', 'export async function validate(x) {\n  const inner = 1;\nexport class Form {}\ntype Id = string;').map((s) => `${s.kind} ${s.name}:${s.line}`), ['function validate:1', 'class Form:3', 'type Id:4']);
  assert.deepEqual(symbolsOf('a.py', 'def parse():\n  def inner(): pass\nclass Config:').map((s) => s.name), ['parse', 'Config']);
  assert.deepEqual(symbolsOf('a.go', 'func (s *Server) Start() {}\ntype Server struct{}').map((s) => s.name), ['Start', 'Server']);
  assert.deepEqual(symbolsOf('a.rs', 'pub fn main() {}\npub(crate) struct Cache;').map((s) => s.name), ['main', 'Cache']);
});

test('the index finds declarations first, then text, and follows changes', async () => {
  const d = tmp();
  put(d, 'src/signup.ts', ['import { db } from "./db";', '', 'export function validateEmail(s: string) {', '  return /@/.test(s);', '}', '', 'export async function signup(email: string) {', '  if (!validateEmail(email)) throw new Error("bad email");', '}'].join('\n'));
  put(d, 'src/db.ts', 'export const db = {};\n// email column is unique\n');
  put(d, 'logo.png', '\x00\x01binary');
  put(d, 'package-lock.json', '{}');
  const ix = await openIndex(d);
  try {
    assert.ok((await ix.refresh()) >= 2);
    assert.deepEqual(ix.files().sort(), ['src/db.ts', 'src/signup.ts'], 'binary files and lockfiles stay out');
    const hits = ix.search('validateEmail');
    assert.deepEqual([hits[0].path, hits[0].line, hits[0].symbol], ['src/signup.ts', 3, 'function validateEmail']);
    const text = ix.search('bad email');
    assert.equal(text[0].path, 'src/signup.ts');
    assert.equal(text[0].line, 8);
    assert.equal(await ix.refresh(), 0, 'nothing changed');
    put(d, 'src/db.ts', 'export const db = {};\nexport function migrate() {}\n');
    fs.utimesSync(path.join(d, 'src/db.ts'), new Date(), new Date(Date.now() + 5000));
    fs.rmSync(path.join(d, 'src/signup.ts'));
    assert.equal(await ix.refresh(), 2);
    assert.deepEqual(ix.search('migrate').map((h) => h.path), ['src/db.ts']);
    assert.deepEqual(ix.search('validateEmail'), [], 'a deleted file leaves the index');
    const map = ix.map(4000);
    assert.match(map, /^Repo map \(1 files/);
    assert.match(map, /src\/db\.ts: db, migrate/);
    assert.ok(ix.map(60).length <= 120, 'the map keeps to its budget');
  } finally {
    ix.close();
  }
});
