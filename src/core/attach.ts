// Attachments in the prompt (SPEC §5.3): dropped or pasted files, folders,
// images, videos and long text become chips. A chip is one private-use character
// in the prompt buffer, so it edits as a single character; this module knows
// what each one is, how it looks, what it costs and what is sent for it.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rimeDir } from './config.ts';
import type { Block } from '../providers/types.ts';
import type { RGB } from './theme.ts';

export type Kind = 'image' | 'video' | 'text' | 'file' | 'folder' | 'path';
export type Chip = {
  kind: Kind;
  n: number; // image 1, image 2, …
  name: string;
  path?: string;
  tok: number;
  w?: number; h?: number; mime?: string; // image (and video size)
  dur?: number; frames?: { path: string; t: number }[]; fw?: number; fh?: number; busy?: boolean; error?: string; // video
  text?: string; lines?: number; // long text, text file
  tree?: string[]; files?: number; // folder
  size?: number; type?: string; // anything else
};

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO = /\.(mp4|mov|webm|mkv|m4v)$/i;
const FILE_LINES = 200; // a text file is sent like a read: its first 200 lines
const TREE_MAX = 200;
export const LONG_PASTE = { lines: 20, chars: 2000 };

// ---- chips in the buffer ----

export const isChip = (ch: string | undefined) => !!ch && ch.length === 1 && ch >= '\uE000' && ch <= '\uF8FF';
// Pasted text as typed: tabs become two spaces; control characters and Rime's own
// chip characters go. Escapes, not literal characters, so copies of the source keep them.
export const cleanPaste = (t: string) => t.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\x00-\x09\x0b-\x1f\x7f\uE000-\uF8FF]/g, '');
export function chipChar(i: number) {
  return String.fromCharCode(0xe000 + (i % 6400));
}

// ---- sizes and tokens ----

export function fitTo(w: number, h: number, max: number): [number, number] {
  const s = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}
// Anthropic's rule (pixels / 750 after scaling to 1568 px), a fair guess elsewhere.
export const imageTokens = (w: number, h: number, max = 1568) => {
  const [a, b] = fitTo(w, h, max);
  return Math.ceil((a * b) / 750);
};
export const textTokens = (s: string) => Math.ceil(s.length / 4);
export const fmtK = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));
const fmtSize = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${(b / 1e3).toFixed(1)} KB` : `${b} B`);
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// The chip's text: `image 1 · 1280×800 · ~1.4k tok` (shown in brackets).
export function label(c: Chip, blind = false): string {
  const warn = blind && (c.kind === 'image' || c.kind === 'video') ? '⚠ ' : '';
  const tok = `~${fmtK(c.tok)} tok`;
  if (c.kind === 'image') return `${warn}image ${c.n} · ${c.w}×${c.h} · ${tok}`;
  if (c.kind === 'video') {
    if (c.busy) return `video ${c.n} · ${c.name} · reading…`;
    if (c.error) return `video ${c.n} · ${c.name} · ${c.error}`;
    return `${warn}video ${c.n} · ${c.name} · ${clock(c.dur ?? 0)} → ${c.frames?.length ?? 0} frames · ${tok}`;
  }
  if (c.kind === 'text') return `text ${c.n} · ${c.lines} lines · ${tok}`;
  if (c.kind === 'file') return `file · ${c.name} · ${c.lines} lines · ${tok}`;
  if (c.kind === 'folder') return `folder · ${c.name} · ${c.files} file${c.files === 1 ? '' : 's'} · ${tok}`;
  return `${c.type} · ${c.name} · ${fmtSize(c.size ?? 0)}`;
}

// ---- reading what was pasted ----

// Width, height and type from an image file's header (PNG, JPEG, GIF, WebP).
export function imageSize(b: Buffer): { w: number; h: number; mime: string } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), mime: 'image/png' };
  if (b.length > 10 && b.toString('latin1', 0, 4) === 'GIF8') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8), mime: 'image/gif' };
  if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff, mime: 'image/webp' };
    if (kind === 'VP8L') return { w: 1 + (((b[22] & 0x3f) << 8) | b[21]), h: 1 + (((b[24] & 0xf) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)), mime: 'image/webp' };
    if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3), mime: 'image/webp' };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5), mime: 'image/jpeg' };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

// Dropping files on a terminal pastes their paths: quoted, backslash-escaped
// (`my\ file.png`, as macOS Terminal does) or file:// URLs. Returns the paths
// when every part of the paste is one that exists, otherwise null (plain text).
export function pastedPaths(text: string, cwd = process.cwd()): string[] | null {
  const t = text.trim();
  if (!t || t.length > 8000) return null;
  const escapes = process.platform !== 'win32';
  const toks: string[] = [];
  let cur = '', q = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === q) q = '';
      else cur += c;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '\\' && escapes && i + 1 < t.length) cur += t[++i];
    else if (/\s/.test(c)) {
      if (cur) toks.push(cur);
      cur = '';
    } else cur += c;
  }
  if (q) return null;
  if (cur) toks.push(cur);
  const paths = toks.map((p) => {
    if (p.startsWith('file://')) {
      try {
        return decodeURIComponent(new URL(p).pathname);
      } catch {
        return p;
      }
    }
    return p.replace(/^~(?=[/\\]|$)/, os.homedir());
  });
  // Relative paths count when they have a folder in them (`Downloads/my\ file.png`),
  // so a pasted word that happens to name a file stays text.
  const ok = paths.length > 0 && paths.every((p) => (path.isAbsolute(p) || /[/\\]/.test(p)) && fs.existsSync(path.resolve(cwd, p)));
  return ok ? paths.map((p) => path.resolve(cwd, p)) : null;
}

export const attachDir = (cwd: string) => {
  const d = rimeDir(cwd, 'attachments');
  return d;
};

const has = (cmd: string) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;
const ffmpegHint = () => `needs ffmpeg (${process.platform === 'darwin' ? 'brew install ffmpeg' : process.platform === 'win32' ? 'winget install ffmpeg' : 'sudo apt install ffmpeg'})`;

// Runs a program and collects its stdout as bytes.
function bytes(cmd: string, args: string[], timeout = 20000): Promise<{ code: number; out: Buffer }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('error', () => (clearTimeout(t), resolve({ code: 127, out: Buffer.alloc(0) })));
    p.on('close', (code) => (clearTimeout(t), resolve({ code: code ?? 1, out: Buffer.concat(chunks) })));
  });
}

// A folder's files, relative to it: through git when it's a repo (so .gitignore
// holds), otherwise a walk that skips .git and node_modules.
export function listFiles(dir: string, max = 20000): string[] {
  const g = spawnSync('git', ['-C', dir, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (g.status === 0) return g.stdout.split('\n').filter(Boolean).slice(0, max).sort();
  // ponytail: outside git, .gitignore isn't read; only .git and node_modules are skipped.
  const files: string[] = [];
  const walk = (rel: string) => {
    if (files.length >= max) return;
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '.rime') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else files.push(r);
    }
  };
  try {
    walk('');
  } catch {}
  return files.sort();
}

// Fuzzy match for the @ picker: the query's letters in order; runs and word
// starts score higher. Tries each place the first letter appears and keeps the
// best. Returns the matched positions, or null.
export function fuzzy(q: string, s: string): { score: number; marks: number[] } | null {
  const ql = q.toLowerCase(), sl = s.toLowerCase();
  let best: { score: number; marks: number[] } | null = null;
  for (let from = sl.indexOf(ql[0]); from >= 0; from = sl.indexOf(ql[0], from + 1)) {
    let i = 0, score = 0, last = -2; // -2: the first letter never counts as a run
    const marks: number[] = [];
    for (let j = from; j < sl.length && i < ql.length; j++) {
      if (sl[j] !== ql[i]) continue;
      score += last === j - 1 ? 3 : 1;
      if (j === 0 || '/._-'.includes(sl[j - 1])) score += 2;
      marks.push(j);
      last = j;
      i++;
    }
    if (i === ql.length && (!best || score > best.score + s.length * 0.01)) best = { score: score - s.length * 0.01, marks };
  }
  return best;
}

// The tree a folder is sent as: names and sizes, .gitignore respected (through
// git when it's a repo), at most 200 entries.
export function folderTree(dir: string) {
  const files = listFiles(dir, 5000);
  const lines = [`${path.basename(dir)}/`];
  const seen = new Set<string>();
  let more = 0;
  for (const f of files) {
    const parts = f.split('/');
    const add: string[] = [];
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (!seen.has(d)) {
        seen.add(d);
        add.push(`${'  '.repeat(i)}${parts[i - 1]}/`);
      }
    }
    let size = 0;
    try {
      size = fs.statSync(path.join(dir, f)).size;
    } catch {}
    add.push(`${'  '.repeat(parts.length)}${parts.at(-1)}  ${fmtSize(size)}`);
    if (lines.length + add.length > TREE_MAX) more++;
    else lines.push(...add);
  }
  if (more) lines.push(`  … ${more} more files`);
  return { lines, files: files.length };
}

const isText = (b: Buffer) => !b.subarray(0, 8000).includes(0);

// What a file's chip sends: the first 200 lines with line numbers.
function readLike(text: string) {
  const all = text.split('\n');
  const shown = all.slice(0, FILE_LINES).map((l, i) => `${String(i + 1).padStart(5)}  ${l}`);
  if (all.length > FILE_LINES) shown.push(`… ${all.length - FILE_LINES} more lines`);
  return { lines: all.length, body: shown.join('\n') };
}

// A chip for one existing path. Videos fill in their frames in the background
// (`onUpdate` redraws).
export function chipFor(p: string, n: (k: Kind) => number, cwd: string, onUpdate: () => void, lines?: [number, number]): Chip {
  const name = path.basename(p);
  if (lines) {
    // @src/signup.ts:30-60: only those lines, with their real numbers.
    const all = fs.readFileSync(p, 'utf8').split('\n');
    const [a, b] = [Math.max(1, lines[0]), Math.min(all.length, lines[1])];
    const body = all.slice(a - 1, b).map((l, i) => `${String(a + i).padStart(5)}  ${l}`).join('\n');
    return { kind: 'file', n: n('file'), name: `${name}:${a}-${b}`, path: p, lines: b - a + 1, text: body, tok: textTokens(body) };
  }
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    const t = folderTree(p);
    return { kind: 'folder', n: n('folder'), name, path: p, tree: t.lines, files: t.files, tok: textTokens(t.lines.join('\n')) + 40 };
  }
  if (IMAGE.test(p)) {
    const fd = fs.openSync(p, 'r');
    const head = Buffer.alloc(Math.min(st.size, 256 * 1024));
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    const s = imageSize(head);
    if (s) return { kind: 'image', n: n('image'), name, path: p, ...s, tok: imageTokens(s.w, s.h) };
  }
  if (VIDEO.test(p)) {
    const c: Chip = { kind: 'video', n: n('video'), name, path: p, busy: true, tok: 0 };
    readVideo(c, cwd).finally(onUpdate);
    return c;
  }
  if (/\.pdf$/i.test(p) && has('pdftotext')) {
    // ponytail: PDFs go as extracted text; document blocks for providers that take them come later.
    const r = spawnSync('pdftotext', ['-layout', p, '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
    if (r.status === 0) {
      const f = readLike(r.stdout);
      return { kind: 'file', n: n('file'), name, path: p, lines: f.lines, text: f.body, tok: textTokens(f.body) };
    }
  }
  if (st.size < 32 << 20) {
    const b = fs.readFileSync(p);
    if (isText(b)) {
      const f = readLike(b.toString('utf8'));
      return { kind: 'file', n: n('file'), name, path: p, lines: f.lines, text: f.body, tok: textTokens(f.body) };
    }
  }
  return { kind: 'path', n: n('path'), name, path: p, size: st.size, type: path.extname(p).slice(1).toLowerCase() || 'file', tok: 20 };
}

export function textChip(text: string, n: (k: Kind) => number): Chip {
  return { kind: 'text', n: n('text'), name: 'pasted text', text, lines: text.split('\n').length, tok: textTokens(text) };
}

// Video goes as frames (models take images, not video): 1 per second, at most 8
// spread over the clip, 768 px on the long edge, no sound. Needs ffmpeg.
async function readVideo(c: Chip, cwd: string) {
  if (!has('ffmpeg') || !has('ffprobe')) return Object.assign(c, { busy: false, error: ffmpegHint() });
  const pr = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration:stream=width,height', '-of', 'json', c.path!], { encoding: 'utf8' });
  let info: any = {};
  try {
    info = JSON.parse(pr.stdout);
  } catch {}
  const dur = Number(info.format?.duration) || 0, w = info.streams?.[0]?.width, h = info.streams?.[0]?.height;
  if (!w || !h) return Object.assign(c, { busy: false, error: "can't read it" });
  const n = Math.max(1, Math.min(8, Math.floor(dur) || 1));
  const [fw, fh] = fitTo(w, h, 768);
  const dir = path.join(attachDir(cwd), crypto.createHash('sha256').update(`${c.path}:${fs.statSync(c.path!).mtimeMs}`).digest('hex').slice(0, 16));
  fs.mkdirSync(dir, { recursive: true });
  const frames: Chip['frames'] = [];
  for (let i = 0; i < n; i++) {
    const t = (dur * (i + 0.5)) / n;
    const out = path.join(dir, `frame-${i + 1}.jpg`);
    if (!fs.existsSync(out)) await bytes('ffmpeg', ['-v', 'error', '-ss', t.toFixed(2), '-i', c.path!, '-frames:v', '1', '-vf', `scale=${fw}:${fh}`, '-q:v', '4', '-y', out]);
    if (fs.existsSync(out)) frames.push({ path: out, t });
  }
  Object.assign(c, { busy: false, dur, w, h, fw, fh, frames, tok: frames.length * imageTokens(fw, fh, 768), ...(frames.length ? {} : { error: "can't read it" }) });
}

// ctrl+v, or a paste that arrives empty: the image on the clipboard, saved to
// .rime/attachments/<hash>.png. Null when there is none.
export async function clipboardImage(cwd: string): Promise<string | null> {
  const dir = attachDir(cwd);
  const tmp = path.join(dir, `clipboard-${process.pid}.png`);
  fs.rmSync(tmp, { force: true });
  if (process.platform === 'darwin') {
    await bytes('osascript', ['-e', `set f to open for access POSIX file "${tmp}" with write permission`, '-e', 'write (the clipboard as «class PNGf») to f', '-e', 'close access f']);
  } else if (process.platform === 'win32') {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $i=[Windows.Forms.Clipboard]::GetImage(); if ($i) { $i.Save('${tmp}', [System.Drawing.Imaging.ImageFormat]::Png) }`;
    await bytes('powershell', ['-NoProfile', '-STA', '-Command', ps]);
  } else {
    let r = await bytes('wl-paste', ['--type', 'image/png']);
    if (r.code !== 0 || !r.out.length) r = await bytes('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']);
    if (r.code === 0 && r.out.length) fs.writeFileSync(tmp, r.out);
  }
  if (!fs.existsSync(tmp) || !fs.statSync(tmp).size) return fs.rmSync(tmp, { force: true }), null;
  const b = fs.readFileSync(tmp);
  if (!imageSize(b)) return fs.rmSync(tmp, { force: true }), null;
  const file = path.join(dir, `${crypto.createHash('sha256').update(b).digest('hex').slice(0, 16)}.png`);
  fs.renameSync(tmp, file);
  return file;
}

// ---- what is sent ----

// The image as sent: scaled down to what the model uses (1568 px on the long edge)
// so no tokens are paid for pixels it drops. sips on macOS, ffmpeg elsewhere;
// otherwise the original.
async function scaled(c: Chip, cwd: string): Promise<{ file: string; mime: string }> {
  const [a, b] = fitTo(c.w!, c.h!, 1568);
  if (a >= c.w! || c.mime === 'image/gif') return { file: c.path!, mime: c.mime! };
  const out = path.join(attachDir(cwd), `${crypto.createHash('sha256').update(`${c.path}:${fs.statSync(c.path!).mtimeMs}`).digest('hex').slice(0, 16)}-${a}.png`);
  if (!fs.existsSync(out)) {
    if (process.platform === 'darwin') await bytes('sips', ['-s', 'format', 'png', '-Z', String(Math.max(a, b)), c.path!, '--out', out]);
    else if (has('ffmpeg')) await bytes('ffmpeg', ['-v', 'error', '-i', c.path!, '-vf', `scale=${a}:${b}`, '-y', out]);
  }
  return fs.existsSync(out) ? { file: out, mime: 'image/png' } : { file: c.path!, mime: c.mime! };
}

const image = (file: string, mime: string): Block => ({ type: 'image', source: { type: 'base64', media_type: mime, data: fs.readFileSync(file).toString('base64') } });

// Short names used inside the message text: [image 1], [file notes.md].
export const ref = (c: Chip) => (c.kind === 'image' || c.kind === 'video' || c.kind === 'text' ? `[${c.kind} ${c.n}]` : `[${c.kind} ${c.name}]`);

// The parts of the next message, exactly as they go (the "what gets sent" list).
export function parts(buf: string, chips: Map<string, Chip>) {
  const text = [...buf].filter((ch) => !isChip(ch)).join('').trim();
  const out: { what: string; tok: number; chip?: string }[] = [];
  if (text) out.push({ what: `your text · ${text.split('\n').length} line${text.includes('\n') ? 's' : ''}`, tok: textTokens(text) });
  for (const ch of new Set([...buf].filter(isChip))) {
    const c = chips.get(ch);
    if (!c) continue;
    const what =
      c.kind === 'image' ? `image ${c.n} · ${c.name} → ${fitTo(c.w!, c.h!, 1568).join('×')} ${c.mime === 'image/jpeg' ? 'JPEG' : 'PNG'}`
      : c.kind === 'video' ? (c.error ? `video ${c.n} · nothing (${c.error})` : `video ${c.n} · ${c.frames?.length ?? 0} frames at ${c.fw}×${c.fh} JPEG, no sound`)
      : c.kind === 'folder' ? `folder ${c.path} · tree of ${c.files} file${c.files === 1 ? '' : 's'} (the AI can read inside it)`
      : c.kind === 'file' ? `file ${c.path} · first ${Math.min(c.lines!, FILE_LINES)} lines with line numbers`
      : c.kind === 'text' ? `text ${c.n} · ${c.lines} lines, in full`
      : `path ${c.path} · type and size only`;
    out.push({ what, tok: c.kind === 'video' && c.error ? 0 : c.tok, chip: ch });
  }
  return out;
}

// The user message's content blocks: the text (chips become [image 1] and so
// on), then each attachment. Images are left out when the model can't see.
export async function blocksFor(buf: string, chips: Map<string, Chip>, cwd: string, see = true): Promise<Block[]> {
  const text = [...buf].map((ch) => (isChip(ch) && chips.get(ch) ? ref(chips.get(ch)!) : ch)).join('').trim();
  const out: Block[] = [{ type: 'text', text }];
  for (const ch of new Set([...buf].filter(isChip))) {
    const c = chips.get(ch);
    if (!c) continue;
    const head = (s: string) => out.push({ type: 'text', text: `${ref(c)} ${s}` });
    if (c.kind === 'image') {
      if (!see) head(`${c.path} (not sent: this model can't see images)`);
      else {
        const s = await scaled(c, cwd);
        head(`${c.name}, ${c.w}×${c.h}:`);
        out.push(image(s.file, s.mime));
      }
    } else if (c.kind === 'video') {
      if (!see || c.busy || c.error || !c.frames?.length) head(`${c.path} (not sent: ${c.busy ? 'its frames were still being read' : (c.error ?? "this model can't see images")})`);
      else {
        head(`${c.name}, ${clock(c.dur ?? 0)}, ${c.frames.length} frames at ${c.frames.map((f) => `${f.t.toFixed(1)}s`).join(', ')} (no sound):`);
        for (const f of c.frames) out.push(image(f.path, 'image/jpeg'));
      }
    } else if (c.kind === 'text') head(`\n${c.text}`);
    else if (c.kind === 'file') head(`${c.path} (${c.lines} lines)\n${c.text}`);
    else if (c.kind === 'folder') head(`${c.path} (${c.files} file${c.files === 1 ? '' : 's'}; read files inside it if you need them)\n${c.tree!.join('\n')}`);
    else head(`${c.path} · ${c.type} · ${fmtSize(c.size ?? 0)}`);
  }
  return out;
}

// The other way, to show a saved message: your text, with each attached file,
// folder or long text back as a chip (with its contents, so it previews) instead
// of pasted into the message. `mark` gives each chip its character.
export function fromBlocks(blocks: Block[], mark: (c: Chip) => string): string {
  const texts = blocks.filter((b) => b.type === 'text').map((b) => String(b.text));
  let text = texts[0] ?? '';
  for (const t of texts.slice(1)) {
    const m = /^\[(text|file|folder) ([^\]]+)\] ?(.*)\n([\s\S]*)$/.exec(t);
    if (!m || !text.includes(`[${m[1]} ${m[2]}]`)) {
      text += '\n' + t;
      continue;
    }
    const [, kind, name, head, body] = m;
    const lines = body.split('\n');
    const c: Chip =
      kind === 'text' ? { kind, n: Number(name) || 0, name: `text ${name}`, text: body, lines: lines.length, tok: textTokens(body) }
      : kind === 'file' ? { kind, n: 0, name, path: head.replace(/ \(\d+ lines\)$/, ''), text: body, lines: Number(/\((\d+) lines\)$/.exec(head)?.[1]) || lines.length, tok: textTokens(body) }
      : { kind: 'folder', n: 0, name, path: head.replace(/ \(.*$/, ''), tree: lines, files: Number(/\((\d+) files/.exec(head)?.[1]) || lines.length, tok: textTokens(body) + 40 };
    text = text.split(`[${kind} ${name}]`).join(mark(c));
  }
  return text;
}

// ---- thumbnails for the preview ----

const thumbs = new Map<string, RGB[][] | null | 'busy'>();

// A small picture of an image file as pixels (`cols` wide, `rows` tall; two
// pixel rows per text line), for ▄ half-block previews. Made with ffmpeg, or
// sips on macOS. Null when neither can read it; undefined while it's being made.
export function thumbnail(file: string, cols: number, rows: number, onReady: () => void): RGB[][] | null | undefined {
  const key = `${file}:${cols}x${rows}`;
  const t = thumbs.get(key);
  if (t === 'busy') return undefined;
  if (t !== undefined) return t;
  thumbs.set(key, 'busy');
  (async () => {
    let px: Buffer | null = null;
    if (has('ffmpeg')) {
      const r = await bytes('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `scale=${cols}:${rows}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      if (r.code === 0 && r.out.length >= cols * rows * 3) px = r.out;
    } else if (process.platform === 'darwin') {
      const tmp = path.join(os.tmpdir(), `rime-thumb-${process.pid}-${cols}x${rows}.bmp`);
      await bytes('sips', ['-s', 'format', 'bmp', '-z', String(rows), String(cols), file, '--out', tmp]);
      px = fs.existsSync(tmp) ? bmpPixels(fs.readFileSync(tmp), cols, rows) : null;
      fs.rmSync(tmp, { force: true });
    }
    thumbs.set(key, px ? Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x) => [px![(y * cols + x) * 3], px![(y * cols + x) * 3 + 1], px![(y * cols + x) * 3 + 2]] as RGB)) : null);
    onReady();
  })();
  return undefined;
}

// 24/32-bit BMP (what sips writes) to packed RGB rows, top to bottom.
export function bmpPixels(b: Buffer, cols: number, rows: number): Buffer | null {
  if (b.toString('latin1', 0, 2) !== 'BM') return null;
  const off = b.readUInt32LE(10), w = b.readInt32LE(18), h = b.readInt32LE(22), bpp = b.readUInt16LE(28);
  if ((bpp !== 24 && bpp !== 32) || w !== cols || Math.abs(h) !== rows) return null;
  const stride = Math.ceil((bpp * w) / 32) * 4, out = Buffer.alloc(w * rows * 3);
  for (let y = 0; y < rows; y++) {
    const row = off + (h > 0 ? rows - 1 - y : y) * stride;
    for (let x = 0; x < w; x++) {
      const p = row + x * (bpp / 8);
      out[(y * w + x) * 3] = b[p + 2];
      out[(y * w + x) * 3 + 1] = b[p + 1];
      out[(y * w + x) * 3 + 2] = b[p];
    }
  }
  return out;
}

// Thumbnail size for an image in at most `maxCols` × `maxLines` cells, keeping
// its shape (a half-block pixel is about square).
export function thumbSize(w: number, h: number, maxCols: number, maxLines: number) {
  let cols = Math.min(maxCols, Math.round((maxLines * 2 * w) / h));
  let rows = Math.round((cols * h) / w);
  if (rows > maxLines * 2) (rows = maxLines * 2), (cols = Math.max(1, Math.round((rows * w) / h)));
  return { cols: Math.max(1, cols), rows: Math.max(2, rows + (rows % 2)) };
}
