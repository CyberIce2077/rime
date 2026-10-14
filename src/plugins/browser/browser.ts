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
import type { Key, Line } from '../../core/term.ts';
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

// npm install into the plug-in's folder, then Chromium unless Chrome is used.
export function install(useChrome: boolean, onStep: (s: string) => void, npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'): Promise<{ ok: boolean; error?: string }> {
  fs.mkdirSync(DIR, { recursive: true });
  const run = (cmd: string, args: string[]) =>
    new Promise<{ ok: boolean; error?: string }>((resolve) => {
      let err = '';
      const p = spawn(cmd, args, { cwd: DIR, stdio: ['ignore', 'ignore', 'pipe'] });
      p.stderr.on('data', (d) => (err += d));
      p.on('error', (e) => resolve({ ok: false, error: e.message }));
      p.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: err.trim().split('\n').at(-1) || `exit ${code}` }));
    });
  return (async () => {
    onStep('installing Playwright');
    const a = await run(npm, ['install', '--prefix', DIR, '--no-audit', '--no-fund', '--loglevel=error', ...PACKAGES]);
    if (!a.ok) return a;
    if (!useChrome) {
      onStep('downloading Chromium (~150 MB)');
      const b = await run(process.execPath, [path.join(DIR, 'node_modules', 'playwright-core', 'cli.js'), 'install', 'chromium']);
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

// A browser session and its tab. One per Rime window.
export async function openBrowser(h: BrowserHost) {
  const req = createRequire(path.join(DIR, 'package.json'));
  const { chromium } = req('playwright-core');
  const { PNG } = req('pngjs');
  const gfx = gfxMode();
  const browser = await chromium.launch({ headless: true, ...(choice().channel ? { channel: choice().channel } : {}) });
  let size = { cols: 60, rows: 20 };
  const page = await browser.newPage({ viewport: { width: size.cols * CELL.w, height: size.rows * CELL.h } });
  const cdp = await page.context().newCDPSession(page);
  const logs: string[] = [];
  let frame: string | null = null, decoded: { width: number; height: number; data: Buffer } | null = null, fresh = false;
  let typing = false, closed = false;
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
  const fitTo = (cols: number, rows: number) => {
    if (cols === size.cols && rows === size.rows) return;
    size = { cols, rows };
    clearTimeout(resizing);
    resizing = setTimeout(() => void page.setViewportSize({ width: cols * CELL.w, height: rows * CELL.h }).then(cast).catch(() => {}), 150);
  };
  const toPage = (x: number, y: number) => ({ x: (x + 0.5) * CELL.w, y: (y + 0.5) * CELL.h });
  const url = () => (closed ? '' : page.url());

  const tab: Omit<CustomTab, 'id' | 'kind'> = {
    title: 'browser',
    byRime: true,
    render(w, rows) {
      const { st } = h;
      const host = url().replace(/^https?:\/\//, '').replace(/\/$/, '') || 'blank';
      tab.title = `browser · ${host.length > 20 ? host.slice(0, 19) + '…' : host}`;
      const bar: Line = [{ t: '◍ ', s: st.accent }, { t: url() || 'about:blank', s: st.title }, ...(typing ? [{ t: '  typing into the page · esc stops', s: st.warn }] : [])];
      fitTo(w, rows - 1);
      if (gfx !== 'blocks' || !frame) return [bar, ...(frame ? [] : [[{ t: 'loading…', s: st.dim }] as Line])];
      decoded ??= PNG.sync.read(Buffer.from(frame, 'base64'));
      return [bar, ...blocks(decoded!, w, rows - 1, h.color)];
    },
    // Kitty and iTerm2 draw the picture after the text, at the tab's content
    // corner; Kitty reuses image 1 so a frame replaces the last.
    overlay(col: number, row: number, w: number, rows: number) {
      if (gfx === 'blocks' || !frame) return null;
      if (!fresh && gfx === 'kitty') return ''; // Kitty keeps the last frame up; iTerm2 images are cells, so they're drawn again
      // ponytail: iTerm2 gets the whole frame again after every repaint (correct, not cheap).
      fresh = false;
      const at = `\x1b[${row + 1};${col}H`;
      if (gfx === 'iterm') return `${at}\x1b]1337;File=inline=1;width=${w};height=${rows - 1};preserveAspectRatio=0;size=${Math.floor((frame.length * 3) / 4)}:${frame}\x07`;
      let s = at;
      for (let i = 0; i < frame.length; i += 4096) {
        const more = i + 4096 < frame.length ? 1 : 0;
        s += `\x1b_G${i === 0 ? `a=T,f=100,i=1,p=1,q=2,C=1,c=${w},r=${rows - 1},m=${more}` : `m=${more}`};${frame.slice(i, i + 4096)}\x1b\\`;
      }
      return s;
    },
    hide: () => (gfx === 'kitty' ? '\x1b_Ga=d,d=I,i=1,q=2\x1b\\' : ''),
    key(k: Key) {
      if (typing) {
        if (k.name === 'escape') return (typing = false), true;
        if (k.name === 'char' && !k.ctrl) void page.keyboard.type(k.ch ?? '').catch(() => {});
        else if (KEYS[k.name]) void page.keyboard.press(KEYS[k.name]).catch(() => {});
        return true;
      }
      const ch = k.name === 'char' ? k.ch : '';
      if (ch === 'r') return void page.reload().catch(() => {}), true;
      if (ch === 'o') return void spawn(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [url()], { detached: true, stdio: 'ignore' }).unref(), true;
      if (ch === 'j' || k.name === 'down') return void page.mouse.wheel(0, 120).catch(() => {}), true;
      if (ch === 'k' || k.name === 'up') return void page.mouse.wheel(0, -120).catch(() => {}), true;
      if (ch === 'b') return void page.goBack().catch(() => {}), true;
      return false;
    },
    click(x: number, y: number) {
      if (y < 1) return;
      const p = toPage(x, y - 1);
      typing = true;
      void page.mouse.click(p.x, p.y).catch(() => {});
    },
    wheel: (d: number) => void page.mouse.wheel(0, d * 40).catch(() => {}),
    foot: (): Hint[] => (typing ? [['', 'keys go to the page · '], ['esc', ' stop typing']] : [['click', ' the page · '], ['r', ' reload · '], ['o', ' open in your browser · '], ['b', ' back · '], ['j k', ' scroll · ']]),
    close() {
      closed = true;
      void browser.close().catch(() => {});
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
      case 'snapshot': {
        const p = page as unknown as { _snapshotForAI?: () => Promise<string | { full?: string }> };
        const raw = p._snapshotForAI ? await p._snapshotForAI() : await page.locator('body').ariaSnapshot();
        const text = typeof raw === 'string' ? raw : (raw.full ?? JSON.stringify(raw));
        return `${page.url()}\n${text.length > 8000 ? text.slice(0, 8000) + '\n… (cut; scroll or open a narrower part)' : text}`;
      }
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

  return { tab, act, url, close: () => tab.close?.() };
}
export type BrowserSession = Awaited<ReturnType<typeof openBrowser>>;

export const BROWSER_TOOL = {
  name: 'browser',
  description: "Drive a real browser page the user watches in a tab: open {url}, snapshot (the page's accessibility tree with [ref=…] ids, cheap), click {ref | text}, fill {ref | selector, text}, press {key}, console (errors and logs), back, reload. Use it to test the user's web app.",
  input_schema: { type: 'object', properties: { action: { type: 'string' }, url: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' }, selector: { type: 'string' }, key: { type: 'string' } }, required: ['action'] },
};
