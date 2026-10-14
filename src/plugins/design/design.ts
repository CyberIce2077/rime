// design plug-in (SPEC §9.2, Phase 12; reference/rime-design.html): build a page by
// chatting and watch it in a split-view tab. A design is a plain HTML file in the
// project (design/<name>.html), so it can be diffed, reviewed and committed. Every
// change is kept as a version (.rime/design/<name>/), ← → step through them, and
// a change made on an older version starts a branch from it. d t p switch the
// viewport, i picks a part of the page into the prompt (@Headline), e asks the
// model to turn it into code. Rendered by the browser plug-in's engine.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rimeDir } from '../../core/config.ts';
import type { Key, Line } from '../../core/term.ts';
import type { Hint } from '../../core/view.ts';
import { type BrowserHost, openEngine } from '../browser/browser.ts';
import type { CustomTab } from '../shell-panel/panel.ts';

export const VIEWPORTS = { desktop: 1280, tablet: 834, phone: 390 } as const;
type Viewport = keyof typeof VIEWPORTS;

export const slug = (what: string) => what.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').filter(Boolean).slice(0, 4).join('-') || 'design';
export const designFile = (name: string) => `design/${name}.html`;

// A first page for "/design new landing page for a notes app": the words as its
// headline, plain system fonts, nothing to undo yet.
export function starter(what: string) {
  const title = what.replace(/^./, (c) => c.toUpperCase()).replace(/[<>&]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #14212b; background: #fafcfd; }
  main { max-width: 960px; margin: 0 auto; padding: 96px 24px; }
  h1 { font-size: 48px; line-height: 1.1; margin: 0 0 16px; }
  p { font-size: 19px; color: #4a5d6b; max-width: 36em; }
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <p>Describe this page in the chat and Rime builds it here.</p>
</main>
</body>
</html>
`;
}

// ---- versions ----
// .rime/design/<name>/1.html, 2.html, … and state.json with the one showing.
export function createVersions(project: string, name: string) {
  const dir = () => rimeDir(project, 'design', name);
  const stateFile = () => path.join(dir(), 'state.json');
  const load = (): { count: number; current: number } => {
    try {
      return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    } catch {
      return { count: 0, current: 0 };
    }
  };
  const save = (s: { count: number; current: number }) => fs.writeFileSync(stateFile(), JSON.stringify(s));
  const read = (n: number) => fs.readFileSync(path.join(dir(), `${n}.html`), 'utf8');
  return {
    state: load,
    // The file as it is now becomes a version, unless it's the one showing.
    record(html: string) {
      const s = load();
      if (s.current && read(s.current) === html) return s.current;
      s.count++;
      fs.writeFileSync(path.join(dir(), `${s.count}.html`), html);
      s.current = s.count;
      save(s);
      return s.count;
    },
    // Puts version n back in the design file (the watcher sees it's not new).
    show(n: number) {
      const s = load();
      if (n < 1 || n > s.count) return null;
      s.current = n;
      save(s);
      const html = read(n);
      fs.writeFileSync(path.join(project, designFile(name)), html);
      return html;
    },
  };
}

// What a picked element is called in the prompt: @Headline, @Button "Join", @Hero.
export function pickName(e: { tag: string; text: string; id: string; cls: string; alt: string }) {
  const words = (s: string) => s.trim().split(/\s+/).slice(0, 3).join(' ');
  const cap = (s: string) => s.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()).split(' ')[0];
  if (e.tag === 'h1') return 'Headline';
  if (/^h[2-6]$/.test(e.tag)) return `Heading "${words(e.text)}"`;
  if (e.tag === 'button' || (e.tag === 'a' && e.text)) return `Button "${words(e.text)}"`;
  if (e.tag === 'img') return `Image${e.alt ? ` "${words(e.alt)}"` : ''}`;
  if (e.id) return cap(e.id);
  if (e.cls) return cap(e.cls.split(/\s+/)[0]);
  if (e.tag === 'p') return 'Paragraph';
  return cap(e.tag);
}

export type Pick = { name: string; selector: string; html: string; file: string };
export type DesignHost = BrowserHost & { project: string; insert(text: string): void; pick(p: Pick): void; exportDesign(file: string, version: number): void; credit(): void };

// The design tab for design/<name>.html.
export async function openDesign(h: DesignHost, name: string) {
  const file = designFile(name);
  const abs = path.join(h.project, file);
  const v = createVersions(h.project, name);
  const e = await openEngine(h);
  let vp: Viewport = 'desktop', picking = false, note = '';
  e.width(VIEWPORTS[vp]);
  await e.page.goto(pathToFileURL(abs).href);
  if (!v.state().count) v.record(fs.readFileSync(abs, 'utf8'));
  // Every save is a version and a redraw (also saves made outside Rime).
  let timer: NodeJS.Timeout | undefined;
  const watcher = fs.watch(abs, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        v.record(fs.readFileSync(abs, 'utf8'));
      } catch {}
      void e.page.reload().catch(() => {});
      h.redraw();
    }, 120);
  });
  const step = (d: number) => {
    const s = v.state();
    if (v.show(s.current + d) !== null) (note = ''), h.credit(); // no API call: counted as saved
  };
  const tab: Omit<CustomTab, 'id' | 'kind'> = {
    title: `design · ${name}`,
    byRime: true,
    render(w, rows) {
      const { st } = h;
      const s = v.state();
      const bar: Line = [
        { t: '▣ ', s: st.accent }, { t: file, s: st.title },
        { t: ` · v${s.current} of ${s.count} · ${vp} ${VIEWPORTS[vp]}`, s: st.dim },
        ...(picking ? [{ t: '  pick: click a part of the page', s: st.warn }] : note ? [{ t: `  ${note}`, s: st.dim }] : []),
      ];
      return [bar, ...e.draw(w, rows - 1)];
    },
    overlay: (col, row, w, rows) => e.overlay(col, row + 1, w, rows - 1),
    hide: e.hide,
    key(k: Key) {
      const ch = k.name === 'char' ? k.ch : '';
      if (picking && k.name === 'escape') return (picking = false), true;
      if (k.name === 'left') return step(-1), true;
      if (k.name === 'right') return step(1), true;
      if (ch === 'd' || ch === 't' || ch === 'p') {
        vp = ch === 'd' ? 'desktop' : ch === 't' ? 'tablet' : 'phone';
        e.width(VIEWPORTS[vp]);
        h.credit();
        return true;
      }
      if (ch === 'i') return (picking = !picking), true;
      if (ch === 'e') return h.exportDesign(file, v.state().current), true;
      if (ch === 'r') return void e.page.reload().catch(() => {}), true;
      if (ch === 'j' || k.name === 'down') return void e.page.mouse.wheel(0, 200).catch(() => {}), true;
      if (ch === 'k' || k.name === 'up') return void e.page.mouse.wheel(0, -200).catch(() => {}), true;
      return false;
    },
    // In pick mode a click names the element under it; otherwise it clicks the page.
    click(x, y) {
      if (y < 1) return;
      const p = e.toPage(x, y - 1);
      if (!picking) return void e.page.mouse.click(p.x, p.y).catch(() => {});
      picking = false;
      void e.page
        .evaluate(({ x, y }: { x: number; y: number }) => {
          const el = document.elementFromPoint(x, y);
          if (!el || el === document.body || el === document.documentElement) return null;
          // A selector that finds just this element: its id, or tag:nth-of-type up to one with an id.
          const sel = (n: Element): string => {
            if (n.id) return `#${CSS.escape(n.id)}`;
            if (!n.parentElement || n.parentElement === document.body) return `body > ${n.tagName.toLowerCase()}:nth-of-type(${[...(n.parentElement?.children ?? [])].filter((c) => c.tagName === n.tagName).indexOf(n) + 1})`;
            return `${sel(n.parentElement)} > ${n.tagName.toLowerCase()}:nth-of-type(${[...n.parentElement.children].filter((c) => c.tagName === n.tagName).indexOf(n) + 1})`;
          };
          return { tag: el.tagName.toLowerCase(), text: (el as HTMLElement).innerText ?? '', id: el.id, cls: typeof el.className === 'string' ? el.className : '', alt: el.getAttribute('alt') ?? '', selector: sel(el), html: el.outerHTML };
        }, p)
        .then((info: { tag: string; text: string; id: string; cls: string; alt: string; selector: string; html: string } | null) => {
          if (!info) return;
          const name = pickName(info);
          h.pick({ name, selector: info.selector, html: info.html.length > 1500 ? info.html.slice(0, 1500) + '…' : info.html, file });
          h.insert(`@${name} `);
          note = `picked @${name}`;
          h.redraw();
        })
        .catch(() => {});
    },
    wheel: (d: number) => void e.page.mouse.wheel(0, d * 60).catch(() => {}),
    foot: (): Hint[] => (picking ? [['', 'click a part of the page · '], ['esc', ' stop picking']] : [['← →', ' versions · '], ['d t p', ' viewport · '], ['i', ' pick · '], ['e', ' export to code · ']]),
    close() {
      clearTimeout(timer);
      watcher.close();
      e.close();
    },
  };
  return { tab, file, name, version: () => v.state().current };
}
export type DesignSession = Awaited<ReturnType<typeof openDesign>>;

// After a change: does anything stick out at the three viewports? Text, which is
// far cheaper for the model than screenshots.
export async function overflow(h: BrowserHost, abs: string): Promise<string> {
  const e = await openEngine(h);
  try {
    const out: string[] = [];
    for (const [name, width] of Object.entries(VIEWPORTS)) {
      await e.page.setViewportSize({ width, height: 900 });
      await e.page.goto(pathToFileURL(abs).href);
      const r = await e.page.evaluate(() => {
        const W = document.documentElement.clientWidth;
        const wide = [...document.querySelectorAll('body *')].filter((n) => n.getBoundingClientRect().right > W + 1).slice(0, 3).map((n) => n.tagName.toLowerCase() + (n.id ? `#${n.id}` : n.classList[0] ? `.${n.classList[0]}` : ''));
        return { by: document.documentElement.scrollWidth - W, wide };
      });
      out.push(r.by > 0 ? `${name} ${width}: overflows by ${r.by}px (${r.wide.join(', ')})` : `${name} ${width}: fits`);
    }
    return out.join(' · ');
  } finally {
    e.close();
  }
}

export const DESIGN_TOOL = {
  name: 'design',
  description: 'Write the design page the user is building (design/<name>.html, plain HTML and CSS in one file). Each write is a new version the user can step through, and the reply says whether anything overflows at desktop, tablet and phone widths. When the user picked a part (@Headline), change just that part.',
  input_schema: { type: 'object', properties: { name: { type: 'string', description: 'the design, e.g. landing' }, html: { type: 'string' } }, required: ['name', 'html'] },
};
