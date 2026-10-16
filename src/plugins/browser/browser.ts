// browser plug-in (SPEC §9.1, Phase 11; ported from reference/rime-browser-poc):
// a real page in a split-view tab, and one `browser` tool the model drives it
// with. Off until you turn it on: /browser installs Playwright into
// ~/.rime/plugins/browser (not into Rime, which keeps no runtime dependencies)
// and uses your installed Chrome, or downloads Chromium when there's none.
//
// Frames come from Chrome's screencast and are drawn as images with the Kitty
// graphics protocol or iTerm2 inline images where the terminal has them
// (RIME_GFX=kitty|iterm|blocks forces one). Anywhere else (Apple's Terminal, which
// shows no images) the page is quadrant blocks (2×2 pixels a cell) with its text
// as real characters on top: the picture is taken with the text hidden, and each
// letter is drawn in its own colour in the cell where the page puts it, so text
// stays sharp and only pictures are blocky. Clicks on the page go to the page; keys too once you've clicked
// into it.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { type Key, type Line, strWidth, wrap } from '../../core/term.ts';
import type { RGB } from '../../core/theme.ts';
import type { Hint, Styles } from '../../core/view.ts';
import type { CustomTab } from '../shell-panel/panel.ts';

export const DIR = path.join(process.env.RIME_PLUGINS_DIR ?? path.join(os.homedir(), '.rime', 'plugins'), 'browser');
const PACKAGES = ['playwright-core@1.56.1', 'pngjs@7.0.0'];
const CELL = { w: 9, h: 18 }; // pixels per cell when the terminal doesn't say
// Drawn as characters: a cell is about one letter of 16px text wide, so a page's
// words fit their cells.
const TEXT_CELL = { w: 8, h: 16 };

export const installed = () => fs.existsSync(path.join(DIR, 'node_modules', 'playwright-core', 'package.json'));
const choice = (): { channel?: string } => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, 'choice.json'), 'utf8'));
  } catch {
    return {};
  }
};

// Your installed Chrome, so nothing else has to be downloaded.
export function chrome(): boolean {
  const places =
    process.platform === 'darwin' ? ['/Applications/Google Chrome.app']
    : process.platform === 'win32' ? [path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')]
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
  return places.some((p) => fs.existsSync(p));
}

// How an install is going: the step, and for a download its size and how much
// has arrived (bytes); `done`/`total` are missing while npm works.
export type Progress = { step: string; done?: number; total?: number };

// Playwright's installer only draws its live progress bar on a terminal (it asks
// stdout, then draws on stderr); this preload makes both pipes look like one, with
// cursor moves as no-ops, so the bar arrives as text: "150.5 MiB [=====   ] 31% 13.0s".
const PRELOAD = 'for (const o of [process.stdout, process.stderr]) Object.assign(o, { isTTY: true, columns: 120, clearLine: () => true, cursorTo: () => true, moveCursor: () => true });\n';
export const parseBar = (text: string): { total: number; pct: number } | null => {
  const m = [...text.matchAll(/([\d.]+) MiB \[[= ]*\] +(\d+)%/g)].at(-1);
  return m ? { total: parseFloat(m[1]) * 1024 * 1024, pct: +m[2] } : null;
};

// npm install into the plug-in's folder, then Chromium unless Chrome is used.
// `signal` stops it (the child is killed; a half-downloaded Chromium is retried
// from scratch next time).
export function install(useChrome: boolean, onProgress: (p: Progress) => void, signal?: AbortSignal, npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'): Promise<{ ok: boolean; error?: string; stopped?: boolean }> {
  fs.mkdirSync(DIR, { recursive: true });
  const run = (cmd: string, args: string[], onOut?: (s: string) => void) =>
    new Promise<{ ok: boolean; error?: string; stopped?: boolean }>((resolve) => {
      if (signal?.aborted) return resolve({ ok: false, stopped: true });
      let err = '';
      const p = spawn(cmd, args, { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });
      const stop = () => p.kill('SIGTERM');
      signal?.addEventListener('abort', stop, { once: true });
      p.stdout.on('data', (d) => onOut?.(d.toString('utf8')));
      p.stderr.on('data', (d) => ((err = (err + d).slice(-4000)), onOut?.(d.toString('utf8'))));
      p.on('error', (e) => resolve({ ok: false, error: e.message }));
      p.on('close', (code) => {
        signal?.removeEventListener('abort', stop);
        resolve(signal?.aborted ? { ok: false, stopped: true } : code === 0 ? { ok: true } : { ok: false, error: err.split(/[\r\n]+/).filter((l) => l.trim() && !/MiB \[/.test(l)).at(-1)?.trim() || `exit ${code}` });
      });
    });
  return (async () => {
    if (!installed()) {
      onProgress({ step: 'Installing Playwright (npm)' });
      const a = await run(npm, ['install', '--prefix', DIR, '--no-audit', '--no-fund', '--loglevel=error', ...PACKAGES]);
      if (!a.ok) return a;
    }
    if (!useChrome) {
      const preload = path.join(DIR, 'tty-preload.cjs');
      fs.writeFileSync(preload, PRELOAD);
      let step = 'Downloading Chromium', buf = '';
      onProgress({ step });
      const b = await run(process.execPath, ['--require', preload, path.join(DIR, 'node_modules', 'playwright-core', 'cli.js'), 'install', 'chromium'], (s) => {
        buf = (buf + s).slice(-4000);
        // "Downloading Chromium 140.0.7339.16 (playwright build v1187) from …", then FFmpeg and the headless shell.
        const name = [...buf.matchAll(/Downloading ([^\n(]+?)(?: \(playwright[^)]*\))? from/g)].at(-1)?.[1];
        if (name) step = `Downloading ${name.replace(/ [\d.]+$/, '')}`;
        const bar = parseBar(buf);
        onProgress(bar ? { step, total: bar.total, done: (bar.total * bar.pct) / 100 } : { step });
      });
      if (!b.ok) return b;
    }
    fs.writeFileSync(path.join(DIR, 'choice.json'), JSON.stringify(useChrome ? { channel: 'chrome' } : {}));
    return { ok: true };
  })();
}

// Which picture the terminal can show.
export function gfxMode(env = process.env): 'kitty' | 'iterm' | 'blocks' {
  const forced = env.RIME_GFX;
  if (forced === 'kitty' || forced === 'iterm' || forced === 'blocks') return forced;
  if (env.TMUX) return 'blocks'; // images need tmux passthrough
  const term = env.TERM ?? '', prog = env.TERM_PROGRAM ?? '';
  if (term === 'xterm-kitty' || env.KITTY_WINDOW_ID || prog === 'ghostty' || term === 'xterm-ghostty') return 'kitty';
  if (prog === 'iTerm.app' || prog === 'WezTerm' || env.WEZTERM_PANE) return 'iterm';
  return 'blocks';
}

// The page's text by cell: a letter and its colour.
export type TextCell = { ch: string; rgb: RGB };

// The page as quadrant cells (▘▝▖▗▌▐▚▞▀▄…): 2×2 pixels a cell in two colours.
// Each pixel is the average of its patch of the picture (so a bigger picture is
// smoother, not sharper); the two most different pixels seed the cell's colours
// and the other two join the nearer one. A cell with text shows the letter
// instead, on the average colour of the page under it.
const QUAD = ' ▗▖▄▝▐▞▟▘▚▌▙▀▜▛█'; // bit 8 top-left, 4 top-right, 2 bottom-left, 1 bottom-right
export function blocks(png: { width: number; height: number; data: Uint8Array | Buffer }, cols: number, rows: number, color: (rgb: RGB, bg: boolean) => string, text?: Map<number, TextCell>): Line[] {
  const { width: W, height: H, data } = png;
  // The average colour of the picture under pixel (x, y) of a cols*2 × rows*2 grid.
  const px = (x: number, y: number): RGB => {
    const x0 = Math.floor((x * W) / (cols * 2)), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * W) / (cols * 2)));
    const y0 = Math.floor((y * H) / (rows * 2)), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * H) / (rows * 2)));
    let r = 0, g = 0, b = 0, n = 0;
    for (let sy = y0; sy < Math.min(y1, H); sy++)
      for (let sx = x0; sx < Math.min(x1, W); sx++) {
        const i = (sy * W + sx) * 4;
        (r += data[i]), (g += data[i + 1]), (b += data[i + 2]), n++;
      }
    return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [0, 0, 0];
  };
  const dist = (a: RGB, b: RGB) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const avg = (ps: RGB[]): RGB => [0, 1, 2].map((k) => Math.round(ps.reduce((s, p) => s + p[k], 0) / ps.length)) as RGB;
  const out: Line[] = [];
  for (let r = 0; r < rows; r++) {
    const line: Line = [];
    for (let c = 0; c < cols; c++) {
      const q = [px(c * 2, r * 2), px(c * 2 + 1, r * 2), px(c * 2, r * 2 + 1), px(c * 2 + 1, r * 2 + 1)];
      const t = text?.get(r * cols + c);
      if (t === undefined) {
        // The two pixels furthest apart are the cell's two colours.
        let a = 0, b = 0, far = -1;
        for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) if (dist(q[i], q[j]) > far) (far = dist(q[i], q[j])), (a = i), (b = j);
        if (far === 0) line.push({ t: ' ', s: color(q[0], true) });
        else {
          let mask = 0;
          const fg: RGB[] = [], bg: RGB[] = [];
          q.forEach((p, i) => (dist(p, q[a]) <= dist(p, q[b]) ? (mask |= 8 >> i, fg.push(p)) : bg.push(p)));
          line.push({ t: QUAD[mask], s: color(avg(fg), false) + color(avg(bg), true) });
        }
      } else if (t.ch) {
        const bg = avg(q);
        line.push({ t: t.ch, s: color(readable(t.rgb, bg), false) + color(bg, true) });
        if (strWidth(t.ch) === 2) c++; // a wide letter takes the next cell too
      }
    }
    out.push(line);
  }
  return out;
}
// Text drawn the page's colour, unless that colour can't be read on the cell
// (gradient or clipped text, a colour that only works over an image).
const lum = ([r, g, b]: RGB) => 0.299 * r + 0.587 * g + 0.114 * b;
export const readable = (fg: RGB, bg: RGB): RGB => (Math.abs(lum(fg) - lum(bg)) >= 60 ? fg : lum(bg) > 128 ? [20, 20, 20] : [240, 240, 240]);

// Hides the page's text in the picture (the layout stays the same: only the
// letters aren't painted); `color` still reads the text's own colour.
const HIDE_TEXT = `(() => {
  const add = () => {
    if (document.getElementById('rime-text-off')) return;
    const s = document.createElement('style');
    s.id = 'rime-text-off';
    s.textContent = '*, *::before, *::after, ::placeholder { -webkit-text-fill-color: transparent !important; text-shadow: none !important; }';
    (document.head || document.documentElement).appendChild(s);
  };
  if (document.documentElement) add();
  document.addEventListener('DOMContentLoaded', add);
})()`;

// The letters on screen, each at its cell (cell width and height in CSS pixels):
// text nodes, and what's typed in (or the placeholder of) form fields.
type Cells = [number, number, string, string, number][]; // x, y, letter, colour, word
function textOnScreen([cw, ch, cols, rows]: [number, number, number, number]): Cells {
  const out: Cells = [];
  let word = 0;
  const put = (x: number, y: number, c: string, color: string) => {
    const cx = Math.floor(x / cw), cy = Math.floor(y / ch);
    if (cx >= 0 && cy >= 0 && cx < cols && cy < rows) out.push([cx, cy, c, color, word]);
  };
  const vw = innerWidth, vh = innerHeight;
  const seen = (r: DOMRect) => r.width > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  const range = document.createRange();
  const walk = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n && out.length < 12000; n = walk.nextNode()) {
    const text = n.nodeValue ?? '';
    const el = n.parentElement;
    if (!el || !text.trim() || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|OPTION)$/.test(el.tagName)) continue;
    range.selectNodeContents(n);
    if (!seen(range.getBoundingClientRect())) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const shown = cs.textTransform === 'uppercase' ? text.toUpperCase() : cs.textTransform === 'lowercase' ? text.toLowerCase() : text;
    // Each word starts in the cell where the page puts it (a space after the
    // word before, on the same row) and its letters follow one per cell, so no
    // letter is lost to a narrow font.
    let last = { y: -1, x: -1 };
    for (const w of shown.matchAll(/\S+/g)) {
      range.setStart(n, w.index!);
      range.setEnd(n, w.index! + [...w[0]][0].length);
      const b = range.getBoundingClientRect();
      if (!b.width) continue;
      // Covered by something else (a dialog, a sticky bar): not drawn.
      const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      if (top && top !== el && !el.contains(top) && !top.contains(el)) continue;
      const y = Math.floor((b.top + b.height / 2) / ch);
      let x = Math.round(b.left / cw);
      if (y === last.y) x = Math.max(x, last.x + 2);
      word++;
      for (const c of w[0]) put(x++ * cw + cw / 2, y * ch + ch / 2, c, cs.color);
      last = { y, x: x - 1 };
    }
  }
  for (const f of document.querySelectorAll('input, textarea, select')) {
    const e = f as HTMLInputElement, r = e.getBoundingClientRect();
    if (!seen(r) || /^(hidden|checkbox|radio|range|color|file|image)$/.test(e.type)) continue;
    const cs = getComputedStyle(e);
    const shown = e.tagName === 'SELECT' ? (e as unknown as HTMLSelectElement).selectedOptions[0]?.text ?? '' : e.type === 'password' ? '•'.repeat(e.value.length) : e.value || e.placeholder || (/^(submit|button|reset)$/.test(e.type) ? e.value : '');
    const color = e.value ? cs.color : 'rgb(140, 140, 140)';
    word++;
    let x = r.left + parseFloat(cs.paddingLeft || '0') + parseFloat(cs.borderLeftWidth || '0');
    for (const c of shown.split('\n')[0]) {
      if (x + cw / 2 > r.right) break;
      if (c.trim()) put(x + cw / 2, r.top + r.height / 2, c, color);
      x += cw;
    }
  }
  return out;
}

const KEYS: Record<string, string> = { enter: 'Enter', backspace: 'Backspace', tab: 'Tab', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', delete: 'Delete', home: 'Home', end: 'End', space: ' ' };
export const withScheme = (url: string) => (/^[a-z]+:\/\//i.test(url) ? url : (/^(localhost|127\.|\d+\.\d+\.\d+\.\d+)/.test(url) ? 'http://' : 'https://') + url);

export type BrowserHost = { st: Styles; color: (rgb: RGB, bg: boolean) => string; redraw(): void; onClose(): void; log(line: string): void };

// One Chrome per Rime window, shared by the browser and design tabs (a page each).
type PW = { chromium: { launch(o: object): Promise<any> } };
let shared: Promise<any> | null = null;
const libs = () => {
  const req = createRequire(path.join(DIR, 'package.json'));
  return { pw: req('playwright-core') as PW, PNG: req('pngjs').PNG };
};
// A failed start isn't kept: the next try launches again.
const chromeNow = () => (shared ??= libs().pw.chromium.launch({ headless: true, ...(choice().channel ? { channel: choice().channel } : {}) }).catch((e: Error) => ((shared = null), Promise.reject(e))));
export const closeChrome = () => {
  void shared?.then((b) => b.close()).catch(() => {});
  shared = null;
};
// Which browser the plug-in runs: your Chrome, or the Chromium it downloaded.
export const usesChrome = () => choice().channel === 'chrome';
// Takes it all away: the Chromium it downloaded (Playwright's own uninstall, which
// keeps browsers other Playwright installs still use) and ~/.rime/plugins/browser.
export async function uninstall(): Promise<{ ok: boolean; error?: string }> {
  closeChrome();
  if (installed() && !usesChrome())
    await new Promise<void>((resolve) => {
      const p = spawn(process.execPath, [path.join(DIR, 'node_modules', 'playwright-core', 'cli.js'), 'uninstall'], { stdio: 'ignore' });
      p.on('close', () => resolve());
      p.on('error', () => resolve());
    });
  try {
    fs.rmSync(DIR, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// A page drawn into a tab: Chrome's screencast, sized to the tab (or to a fixed
// CSS width, scaled down: the design tab's viewports), as half-blocks or images.
export async function openEngine(h: BrowserHost) {
  const { PNG } = libs();
  const gfx = gfxMode();
  const browser = await chromeNow();
  let size = { cols: 60, rows: 20 };
  let css: number | null = null; // a fixed page width in CSS pixels
  const cell = gfx === 'blocks' ? TEXT_CELL : CELL;
  const viewport = () => (css ? { width: css, height: Math.max(200, Math.round((css * size.rows * cell.h) / (size.cols * cell.w))) } : { width: size.cols * cell.w, height: size.rows * cell.h });
  const page = await browser.newPage({ viewport: viewport() });
  const cdp = await page.context().newCDPSession(page);
  const logs: string[] = [];
  let frame: string | null = null, decoded: { width: number; height: number; data: Buffer } | null = null, fresh = false;
  let closed = false;
  page.on('console', (m: { type(): string; text(): string }) => {
    logs.push(`${m.type()}: ${m.text()}`);
    if (logs.length > 100) logs.shift();
  });
  page.on('pageerror', (e: Error) => logs.push(`page error: ${e.message}`));
  page.on('framenavigated', () => h.redraw());
  // No images in this terminal: the text is drawn as characters, not pixels.
  let text: Map<number, TextCell> | undefined;
  let reading = false, again = false;
  const parse = (c: string): RGB | null => {
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(c);
    return m && (m[4] === undefined || +m[4] > 0.1) ? [+m[1], +m[2], +m[3]] : null;
  };
  // Read where the letters are now; one read at a time, the last frame wins.
  const readText = () => {
    if (reading) return void (again = true);
    reading = true;
    const v = viewport();
    void page
      .evaluate(textOnScreen, [v.width / size.cols, v.height / size.rows, size.cols, size.rows])
      .then((cells: Cells) => {
        // Words in page order; one that runs into a word already drawn ends in …
        // (a page too wide for its columns), and one with no room is left out.
        const next = new Map<number, TextCell>();
        let w = -1, cut = false, prev = -1;
        for (const [x, y, ch, color, word] of cells) {
          if (word !== w) (w = word), (cut = false), (prev = -1);
          if (cut) continue;
          const key = y * size.cols + x;
          if (next.has(key) || (strWidth(ch) === 2 && (x + 1 >= size.cols || next.has(key + 1)))) {
            cut = true;
            if (prev >= 0 && next.get(prev)!.ch) next.set(prev, { ...next.get(prev)!, ch: '…' });
            continue;
          }
          next.set(key, { ch, rgb: parse(color) ?? [20, 20, 20] });
          if (strWidth(ch) === 2) next.set(key + 1, { ch: '', rgb: [0, 0, 0] });
          prev = key;
        }
        text = next;
        h.redraw();
      })
      .catch(() => {})
      .finally(() => {
        reading = false;
        if (again) (again = false), readText();
      });
  };
  if (gfx === 'blocks') {
    await page.addInitScript(HIDE_TEXT);
    await page.evaluate(HIDE_TEXT).catch(() => {});
  }
  cdp.on('Page.screencastFrame', ({ data, sessionId }: { data: string; sessionId: number }) => {
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    frame = data;
    decoded = null;
    fresh = true;
    if (gfx === 'blocks') readText();
    h.redraw();
  });
  const cast = async () => {
    await cdp.send('Page.stopScreencast').catch(() => {});
    await cdp.send('Page.startScreencast', {
      format: gfx === 'iterm' ? 'jpeg' : 'png',
      quality: 80,
      // Quadrants: 2×2 pixels a cell, each the average of a 2×2 patch of the picture.
      ...(gfx === 'blocks' ? { maxWidth: size.cols * 4, maxHeight: size.rows * 8 } : { maxWidth: size.cols * CELL.w, maxHeight: size.rows * CELL.h }),
    });
  };
  await cast();
  // A layout change resizes the page and restarts the screencast (debounced).
  let resizing: NodeJS.Timeout | undefined;
  const refit = () => {
    clearTimeout(resizing);
    resizing = setTimeout(() => void page.setViewportSize(viewport()).then(cast).catch(() => {}), 150);
  };
  return {
    page,
    gfx,
    logs,
    url: () => (closed ? '' : page.url()),
    // Drawn as characters, a page wider than its columns can hold (the design
    // tab's 1280 desktop in a narrow panel): the columns it needs to be read.
    cramped: () => (gfx === 'blocks' && css && css / size.cols > TEXT_CELL.w * 1.25 ? Math.ceil(css / TEXT_CELL.w) : 0),
    // The picture in `rows` rows of `w` cells (quadrant blocks), or nothing when an
    // image protocol draws it (overlay).
    draw(w: number, rows: number): Line[] {
      if (w !== size.cols || rows !== size.rows) (size = { cols: w, rows }), refit();
      if (gfx !== 'blocks') return frame ? [] : [[{ t: 'loading…', s: h.st.dim }]];
      if (!frame) return [[{ t: 'loading…', s: h.st.dim }]];
      decoded ??= PNG.sync.read(Buffer.from(frame, 'base64'));
      return blocks(decoded!, w, rows, h.color, text);
    },
    // Kitty and iTerm2 draw the picture after the text at (col, row); Kitty keeps
    // image 1, so a new frame replaces the last. null: no picture; '': unchanged.
    overlay(col: number, row: number, w: number, rows: number): string | null {
      if (gfx === 'blocks' || !frame) return null;
      if (!fresh && gfx === 'kitty') return ''; // iTerm2 images are cells, so they're drawn again
      fresh = false;
      const at = `\x1b[${row};${col}H`;
      // ponytail: iTerm2 gets the whole frame again after every repaint (correct, not cheap).
      if (gfx === 'iterm') return `${at}\x1b]1337;File=inline=1;width=${w};height=${rows};preserveAspectRatio=0;size=${Math.floor((frame.length * 3) / 4)}:${frame}\x07`;
      let s = at;
      for (let i = 0; i < frame.length; i += 4096) {
        const more = i + 4096 < frame.length ? 1 : 0;
        s += `\x1b_G${i === 0 ? `a=T,f=100,i=1,p=1,q=2,C=1,c=${w},r=${rows},m=${more}` : `m=${more}`};${frame.slice(i, i + 4096)}\x1b\\`;
      }
      return s;
    },
    hide: () => (gfx === 'kitty' ? '\x1b_Ga=d,d=I,i=1,q=2\x1b\\' : ''),
    width(px: number | null) {
      css = px;
      refit();
    },
    // A cell of the picture as a point on the page.
    toPage(x: number, y: number) {
      const v = viewport();
      return { x: ((x + 0.5) * v.width) / size.cols, y: ((y + 0.5) * v.height) / size.rows };
    },
    close() {
      closed = true;
      void page.close().catch(() => {});
    },
  };
}
export type Engine = Awaited<ReturnType<typeof openEngine>>;

// The browser tab and the model's actions on it. One per Rime window
// (docs/split-v2.md §4.5): the address on top, the page, and a status row with
// its state and console errors.
export async function openBrowser(h: BrowserHost) {
  const e = await openEngine(h);
  const { page, logs } = e;
  let typing = false, driving = false, consoleView = false, loading = false;
  let status: number | null = null;
  page.on('request', (r: any) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) (loading = true), h.redraw();
  });
  page.on('response', (r: any) => {
    if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) status = r.status();
  });
  page.on('load', () => ((loading = false), h.redraw()));
  page.on('requestfailed', (r: any) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) (loading = false), (status = 0), h.redraw();
  });
  const where = () => e.url().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const errors = () => logs.filter((l) => /^(error|page error)/.test(l)).length;
  const go = (url: string) => void page.goto(withScheme(url), { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((x: Error) => h.log(`Couldn't open ${url}: ${x.message.split('\n')[0]}`));
  const blank = () => !e.url() || e.url() === 'about:blank';
  const tab: Omit<CustomTab, 'id' | 'kind'> = {
    title: 'browser',
    icon: '◐',
    byRime: true,
    render(w, rows) {
      const { st } = h;
      tab.title = blank() ? 'browser' : where();
      const bar: Line = [
        { t: '◐ ', s: st.dim }, { t: blank() ? 'no page' : where(), s: st.title },
        ...(driving ? [{ t: '  ● Rime is using this page', s: st.warn }] : typing ? [{ t: '  typing into the page', s: st.warn }] : []),
      ];
      const state: Line = [{ t: loading ? 'loading' : status === null ? '' : status === 0 ? 'no answer' : String(status), s: status && status >= 400 ? st.del : st.dim }, { t: `${status !== null || loading ? ' · ' : ''}console: ${errors()} error${errors() === 1 ? '' : 's'}`, s: errors() ? st.warn : st.dim }, ...(consoleView ? [{ t: ' · showing the console · c page', s: st.dim }] : [])];
      // No page yet: say how to open one, not a white page.
      if (blank()) {
        const help: Line[] = [[{ t: 'No page open yet.', s: st.title }], [], [{ t: 'g', s: st.accentB }, { t: '  type an address: localhost:5173, example.com, or a file like index.html', s: st.dim }], [{ t: ':open <url>', s: st.accentB }, { t: '  the same, from the panel line', s: st.dim }], [{ t: ':browser use chrome', s: st.accentB }, { t: ' · ', s: st.dim }, { t: ':browser use chromium', s: st.accentB }, { t: '  switch browsers', s: st.dim }], [], [{ t: 'Or ask Rime to open a page.', s: st.dim }], [{ t: `Using ${usesChrome() ? 'your Chrome' : 'Chromium'}.`, s: st.dim }]];
        return [bar, [], ...help.flatMap((l) => (l.length ? wrap(l, w, w - 2).map((x, i) => (i ? [{ t: '  ', s: '' }, ...x] : x)) : [l]))];
      }
      const room = Math.max(1, rows - 2);
      const view = consoleView
        ? [...(logs.length ? logs.slice(-40).slice(-room).map((l): Line => [{ t: l, s: /^(error|page error)/.test(l) ? st.del : st.fg }]) : [[{ t: 'The console is empty.', s: st.dim }]]), ...new Array(room).fill([])].slice(0, room)
        : [...e.draw(w, room), ...new Array(room).fill([])].slice(0, room);
      return [bar, ...view, state];
    },
    overlay: (col, row, w, rows) => (blank() || consoleView ? null : e.overlay(col, row + 1, w, Math.max(1, rows - 2))),
    hide: e.hide,
    busy: () => false,
    typing: () => typing,
    key(k: Key) {
      if (typing) {
        if (k.name === 'escape') return (typing = false), true;
        if (driving) return true; // Rime is using the page: keys wait until it's done
        if (k.name === 'char' && !k.ctrl) void page.keyboard.type(k.ch ?? '').catch(() => {});
        else if (k.ctrl && /^[a-z]$/.test(k.name)) void page.keyboard.press(`Control+${k.name}`).catch(() => {});
        else if (KEYS[k.name]) void page.keyboard.press(KEYS[k.name]).catch(() => {});
        return true;
      }
      const ch = k.name === 'char' ? k.ch : '';
      if (k.name === 'enter' && !blank()) return (typing = true);
      if (ch === 'g') return { label: 'address ›', value: blank() ? '' : where(), placeholder: 'localhost:5173/pricing or example.com', submit: (v: string) => v.trim() && go(v.trim()) };
      if (ch === 'r') return void page.reload().catch(() => {}), true;
      if (ch === 'o' && !blank()) return void spawn(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [e.url()], { detached: true, stdio: 'ignore' }).unref(), true;
      if (ch === 'c') return (consoleView = !consoleView), true;
      if (k.name === 'down') return void page.mouse.wheel(0, 120).catch(() => {}), true;
      if (k.name === 'up') return void page.mouse.wheel(0, -120).catch(() => {}), true;
      if (ch === 'b') return void page.goBack().catch(() => {}), true;
      return false;
    },
    click(x: number, y: number) {
      if (y < 1 || blank() || consoleView) return;
      const p = e.toPage(x, y - 1);
      typing = true;
      if (!driving) void page.mouse.click(p.x, p.y).catch(() => {});
    },
    wheel: (d: number) => void page.mouse.wheel(0, d * 40).catch(() => {}),
    foot: (): Hint[] => (typing ? [['', 'typing into the page · '], ['esc', ' stop typing']] : [['enter', ' type in page · '], ['g', ' address · '], ['r', ' reload · '], ['b', ' back · '], ['o', ' your browser · '], ['c', consoleView ? ' page' : ' console']]),
    close() {
      e.close();
      h.onClose();
    },
  };

  // The model's actions. Each returns what the model reads.
  async function act(input: Record<string, unknown>): Promise<string> {
    driving = true;
    h.redraw();
    try {
      return await acting(input);
    } finally {
      driving = false;
      h.redraw();
    }
  }
  async function acting(input: Record<string, unknown>): Promise<string> {
    const a = String(input.action ?? '');
    const ref = input.ref ? page.locator(`aria-ref=${input.ref}`) : null;
    const target = () => ref ?? (input.selector ? page.locator(String(input.selector)) : page.getByText(String(input.text ?? ''), { exact: false })).first();
    switch (a) {
      case 'open': {
        const u = withScheme(String(input.url ?? ''));
        const r = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 20000 });
        return `Opened ${page.url()} (${r?.status() ?? 'no status'}): ${(await page.title()) || 'no title'}. Use snapshot to read it.`;
      }
      case 'snapshot':
        return `${page.url()}\n${await snapshot(page)}`;
      case 'click':
        await target().click({ timeout: 5000 });
        return `Clicked ${input.ref ? `[ref=${input.ref}]` : input.selector ?? `"${input.text}"`}. Now at ${page.url()}.`;
      case 'fill':
        await (ref ?? page.locator(String(input.selector ?? 'input'))).first().fill(String(input.text ?? ''), { timeout: 5000 });
        return `Filled ${input.ref ? `[ref=${input.ref}]` : input.selector}.`;
      case 'press':
        await page.keyboard.press(String(input.key ?? 'Enter'));
        return `Pressed ${input.key ?? 'Enter'}.`;
      case 'console':
        return logs.length ? logs.slice(-40).join('\n') : 'The console is empty.';
      case 'back':
        await page.goBack();
        return `Back at ${page.url()}.`;
      case 'reload':
        await page.reload();
        return `Reloaded ${page.url()}.`;
      default:
        return `Unknown action ${a}. Actions: open {url}, snapshot, click {ref | text | selector}, fill {ref | selector, text}, press {key}, console, back, reload.`;
    }
  }

  return { tab, act, url: e.url, reload: () => void page.reload().catch(() => {}), close: () => tab.close?.() };
}
export type BrowserSession = Awaited<ReturnType<typeof openBrowser>>;

// Playwright's AI snapshot (the accessibility tree with [ref=…] ids), cut to size.
export async function snapshot(page: any, max = 8000) {
  const raw = page._snapshotForAI ? await page._snapshotForAI() : await page.locator('body').ariaSnapshot();
  const text = typeof raw === 'string' ? raw : (raw.full ?? JSON.stringify(raw));
  return text.length > max ? text.slice(0, max) + '\n… (cut)' : text;
}

export const BROWSER_TOOL = {
  name: 'browser',
  description: "Drive a real browser page the user watches in a tab: open {url}, snapshot (the page's accessibility tree with [ref=…] ids, cheap), click {ref | text}, fill {ref | selector, text}, press {key}, console (errors and logs), back, reload. Use it to test the user's web app.",
  input_schema: { type: 'object', properties: { action: { type: 'string' }, url: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' }, selector: { type: 'string' }, key: { type: 'string' } }, required: ['action'] },
};
