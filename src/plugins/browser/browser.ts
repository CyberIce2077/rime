// browser plug-in (SPEC §9.1, Phase 11; ported from reference/rime-browser-poc):
// a real page in a split-view tab, and one `browser` tool the model drives it
// with. Off until you turn it on: /browser installs Playwright into
// ~/.rime/plugins/browser (not into Rime, which keeps no runtime dependencies)
// and uses your installed Chrome, or downloads Chromium when there's none.
//
// Frames come from Chrome's screencast and are drawn as ▀ half-blocks in any
// truecolor terminal, or as images with the Kitty graphics protocol or iTerm2
// inline images where the terminal says it has them (RIME_GFX=kitty|iterm|blocks
// forces one). Clicks on the page go to the page; keys too once you've clicked
// into it.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { type Key, type Line, wrap } from '../../core/term.ts';
import type { RGB } from '../../core/theme.ts';
import type { Hint, Styles } from '../../core/view.ts';
import type { CustomTab } from '../shell-panel/panel.ts';

export const DIR = path.join(process.env.RIME_PLUGINS_DIR ?? path.join(os.homedir(), '.rime', 'plugins'), 'browser');
const PACKAGES = ['playwright-core@1.56.1', 'pngjs@7.0.0'];
const CELL = { w: 9, h: 18 }; // pixels per cell when the terminal doesn't say

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

// The page as ▀ cells: the top pixel is the foreground, the bottom the background.
export function blocks(png: { width: number; height: number; data: Uint8Array | Buffer }, cols: number, rows: number, color: (rgb: RGB, bg: boolean) => string): Line[] {
  const { width: W, height: H, data } = png;
  const px = (x: number, y: number): RGB => {
    const sx = Math.min(W - 1, Math.floor((x * W) / cols)), sy = Math.min(H - 1, Math.floor((y * H) / (rows * 2)));
    const i = (sy * W + sx) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const out: Line[] = [];
  for (let r = 0; r < rows; r++) {
    const line: Line = [];
    for (let c = 0; c < cols; c++) line.push({ t: '▀', s: color(px(c, r * 2), false) + color(px(c, r * 2 + 1), true) });
    out.push(line);
  }
  return out;
}

const KEYS: Record<string, string> = { enter: 'Enter', backspace: 'Backspace', tab: 'Tab', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', delete: 'Delete', home: 'Home', end: 'End', space: ' ' };
const withScheme = (url: string) => (/^[a-z]+:\/\//i.test(url) ? url : (/^(localhost|127\.|\d+\.\d+\.\d+\.\d+)/.test(url) ? 'http://' : 'https://') + url);

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
  const viewport = () => (css ? { width: css, height: Math.max(200, Math.round((css * size.rows * CELL.h) / (size.cols * CELL.w))) } : { width: size.cols * CELL.w, height: size.rows * CELL.h });
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
  cdp.on('Page.screencastFrame', ({ data, sessionId }: { data: string; sessionId: number }) => {
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    frame = data;
    decoded = null;
    fresh = true;
    h.redraw();
  });
  const cast = async () => {
    await cdp.send('Page.stopScreencast').catch(() => {});
    await cdp.send('Page.startScreencast', {
      format: gfx === 'iterm' ? 'jpeg' : 'png',
      quality: 80,
      ...(gfx === 'blocks' ? { maxWidth: size.cols, maxHeight: size.rows * 2 } : { maxWidth: size.cols * CELL.w, maxHeight: size.rows * CELL.h }),
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
    // The picture in `rows` rows of `w` cells (half-blocks), or nothing when an
    // image protocol draws it (overlay).
    draw(w: number, rows: number): Line[] {
      if (w !== size.cols || rows !== size.rows) (size = { cols: w, rows }), refit();
      if (gfx !== 'blocks') return frame ? [] : [[{ t: 'loading…', s: h.st.dim }]];
      if (!frame) return [[{ t: 'loading…', s: h.st.dim }]];
      decoded ??= PNG.sync.read(Buffer.from(frame, 'base64'));
      return blocks(decoded!, w, rows, h.color);
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

// The browser tab and the model's actions on it. One per Rime window.
export async function openBrowser(h: BrowserHost) {
  const e = await openEngine(h);
  const { page, logs } = e;
  let typing = false;
  const tab: Omit<CustomTab, 'id' | 'kind'> = {
    title: 'browser',
    byRime: true,
    render(w, rows) {
      const { st } = h;
      const host = e.url().replace(/^https?:\/\//, '').replace(/\/$/, '') || 'blank';
      tab.title = `browser · ${host.length > 20 ? host.slice(0, 19) + '…' : host}`;
      const bar: Line = [{ t: '◍ ', s: st.accent }, { t: e.url() || 'about:blank', s: st.title }, ...(typing ? [{ t: '  typing into the page · esc stops', s: st.warn }] : [])];
      // No page yet: say how to open one, not a white page.
      if (!e.url() || e.url() === 'about:blank') {
        const help: Line[] = [[{ t: 'No page open yet.', s: st.title }], [], [{ t: '/browser <url>', s: st.accentB }, { t: '  a web address, localhost:5173, or a file like index.html', s: st.dim }], [{ t: '/browser use chrome', s: st.accentB }, { t: ' · ', s: st.dim }, { t: '/browser use chromium', s: st.accentB }, { t: '  switch browsers', s: st.dim }], [{ t: '/browser uninstall', s: st.accentB }, { t: '  remove the plug-in', s: st.dim }], [], [{ t: 'Or ask Rime to open a page.', s: st.dim }], [{ t: `Using ${usesChrome() ? 'your Chrome' : 'Chromium'}.`, s: st.dim }]];
        return [bar, [], ...help.flatMap((l) => (l.length ? wrap(l, w, w - 2).map((x, i) => (i ? [{ t: '  ', s: '' }, ...x] : x)) : [l]))];
      }
      return [bar, ...e.draw(w, rows - 1)];
    },
    overlay: (col, row, w, rows) => (!e.url() || e.url() === 'about:blank' ? null : e.overlay(col, row + 1, w, rows - 1)),
    hide: e.hide,
    key(k: Key) {
      if (typing) {
        if (k.name === 'escape') return (typing = false), true;
        if (k.name === 'char' && !k.ctrl) void page.keyboard.type(k.ch ?? '').catch(() => {});
        else if (KEYS[k.name]) void page.keyboard.press(KEYS[k.name]).catch(() => {});
        return true;
      }
      const ch = k.name === 'char' ? k.ch : '';
      if (ch === 'r') return void page.reload().catch(() => {}), true;
      if (ch === 'o') return void spawn(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [e.url()], { detached: true, stdio: 'ignore' }).unref(), true;
      if (ch === 'j' || k.name === 'down') return void page.mouse.wheel(0, 120).catch(() => {}), true;
      if (ch === 'k' || k.name === 'up') return void page.mouse.wheel(0, -120).catch(() => {}), true;
      if (ch === 'b') return void page.goBack().catch(() => {}), true;
      return false;
    },
    click(x: number, y: number) {
      if (y < 1) return;
      const p = e.toPage(x, y - 1);
      typing = true;
      void page.mouse.click(p.x, p.y).catch(() => {});
    },
    wheel: (d: number) => void page.mouse.wheel(0, d * 40).catch(() => {}),
    foot: (): Hint[] => (typing ? [['', 'keys go to the page · '], ['esc', ' stop typing']] : [['click', ' the page · '], ['r', ' reload · '], ['o', ' open in your browser · '], ['b', ' back · '], ['j k', ' scroll · ']]),
    close() {
      e.close();
      h.onClose();
    },
  };

  // The model's actions. Each returns what the model reads.
  async function act(input: Record<string, unknown>): Promise<string> {
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

  return { tab, act, url: e.url, close: () => tab.close?.() };
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
