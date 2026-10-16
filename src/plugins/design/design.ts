// design plug-in (SPEC §9.2, Phase 12; reference/rime-design.html): build a page by
// chatting and watch it in a split-view tab. A design is a plain HTML file in the
// project (design/<name>.html), so it can be diffed, reviewed and committed. Every
// change is kept as a version (.rime/design/<name>/), ← → step through them, and
// a change made on an older version starts a branch from it. v cycles the
// viewport, p picks a part of the page into the prompt (@Headline), c compares
// with v1, a applies it to the project (docs/split-v2.md §4.6). A design can
// start from the project's own page (capture). Rendered by the browser plug-in's
// engine.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rimeDir } from '../../core/config.ts';
import type { Key, Line } from '../../core/term.ts';
import type { Hint } from '../../core/view.ts';
import { type BrowserHost, openEngine, withScheme } from '../browser/browser.ts';
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
  type State = { count: number; current: number; from?: From };
  const load = (): State => {
    try {
      return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    } catch {
      return { count: 0, current: 0 };
    }
  };
  const save = (s: State) => fs.writeFileSync(stateFile(), JSON.stringify(s));
  const read = (n: number) => fs.readFileSync(path.join(dir(), `${n}.html`), 'utf8');
  return {
    state: load,
    file: (n: number) => path.join(dir(), `${n}.html`),
    // The page a design was captured from, for apply.
    setFrom(from: From) {
      fs.mkdirSync(dir(), { recursive: true });
      save({ ...load(), from });
    },
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

export type From = { url?: string; file?: string };
export type Pick = { name: string; selector: string; html: string; file: string };
export type DesignHost = BrowserHost & { project: string; insert(text: string): void; pick(p: Pick): void; apply(file: string, version: number, from?: From): void; credit(): void };

// "Your page" (§4.6): the running page as a static copy, its DOM with the CSS
// that applies to it in one <style>, scripts stripped, links resolved against
// its address. Nothing in the project changes.
export async function capture(h: BrowserHost, url: string): Promise<string> {
  const e = await openEngine(h);
  try {
    e.width(1280);
    await e.page.goto(withScheme(url), { waitUntil: 'load', timeout: 20000 });
    return await e.page.evaluate(() => {
      const css = [...document.styleSheets].map((s) => {
        if ((s.ownerNode as Element | null)?.id === 'rime-text-off') return ''; // Rime's own, for drawing text as characters
        try {
          return [...s.cssRules].map((r) => r.cssText).join('\n');
        } catch {
          return ''; // a sheet from another origin can't be read
        }
      }).join('\n');
      const doc = document.documentElement.cloneNode(true) as HTMLElement;
      doc.querySelectorAll('script, noscript, link[rel="stylesheet"], link[rel="modulepreload"], style').forEach((n) => n.remove());
      const head = doc.querySelector('head') ?? doc.insertBefore(document.createElement('head'), doc.firstChild);
      const base = document.createElement('base');
      base.href = location.href;
      const style = document.createElement('style');
      style.textContent = css;
      head.prepend(base);
      head.append(style);
      return '<!doctype html>\n' + doc.outerHTML;
    });
  } finally {
    e.close();
  }
}

// The design tab for design/<name>.html.
export async function openDesign(h: DesignHost, name: string) {
  const file = designFile(name);
  const abs = path.join(h.project, file);
  const v = createVersions(h.project, name);
  const e = await openEngine(h);
  let vp: Viewport = 'desktop', picking = false, comparing = false, note = '';
  e.width(VIEWPORTS[vp]);
  await e.page.goto(pathToFileURL(abs).href);
  v.record(fs.readFileSync(abs, 'utf8')); // a new file (a capture) becomes the next version
  // Every save is a version and a redraw (also saves made outside Rime).
  let timer: NodeJS.Timeout | undefined;
  const watcher = fs.watch(abs, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        v.record(fs.readFileSync(abs, 'utf8'));
      } catch {}
      comparing = false;
      void e.page.goto(pathToFileURL(abs).href).catch(() => {});
      h.redraw();
    }, 120);
  });
  const step = (d: number) => {
    const s = v.state();
    comparing = false;
    if (v.show(s.current + d) !== null) (note = ''), h.credit(); // no API call: counted as saved
  };
  const order: Viewport[] = ['desktop', 'tablet', 'phone'];
  const tab: Omit<CustomTab, 'id' | 'kind'> = {
    title: `${name} v${v.state().current}`,
    icon: '✎',
    byRime: true,
    render(w, rows) {
      const { st } = h;
      const s = v.state();
      tab.title = `${name} v${s.current}`;
      const bar: Line = [
        { t: '✎ ', s: st.accent }, { t: file, s: st.title },
        { t: ` · v${s.current} of ${s.count} · ${vp} ${VIEWPORTS[vp]} · ${s.from ? `from ${s.from.url ?? s.from.file}` : 'sketch'}`, s: st.dim },
      ];
      const foot: Line = picking ? [{ t: 'pick: click an element and it goes to the chat prompt as @Name', s: st.warn }]
        : comparing ? [{ t: `showing v1 · c to go back to v${s.current}`, s: st.warn }]
        : e.cramped() ? [{ t: `${vp} ${VIEWPORTS[vp]} needs ${e.cramped()} columns to read here · z zooms · v ${vp === 'phone' ? 'desktop' : 'a narrower viewport'}`, s: st.warn }]
        : [{ t: note || `v${s.current} of ${s.count}`, s: st.dim }];
      const room = Math.max(1, rows - 2);
      return [bar, ...[...e.draw(w, room), ...new Array(room).fill([])].slice(0, room), foot];
    },
    overlay: (col, row, w, rows) => e.overlay(col, row + 1, w, Math.max(1, rows - 2)),
    hide: e.hide,
    key(k: Key) {
      const ch = k.name === 'char' ? k.ch : '';
      if (picking && (k.name === 'escape' || ch === 'p')) return (picking = false), true;
      if (k.name === 'left') return step(-1), true;
      if (k.name === 'right') return step(1), true;
      if (ch === 'v') {
        vp = order[(order.indexOf(vp) + 1) % order.length];
        e.width(VIEWPORTS[vp]);
        h.credit();
        return true;
      }
      if (ch === 'p') return (picking = true), true;
      // Compare: v1 (as captured, or the first sketch) and back, with no API call.
      if (ch === 'c') {
        comparing = !comparing && v.state().count > 1;
        void e.page.goto(pathToFileURL(comparing ? v.file(1) : abs).href).catch(() => {});
        if (comparing) h.credit();
        return true;
      }
      if (ch === 'a') return h.apply(file, v.state().current, v.state().from), true;
      if (k.name === 'down') return void e.page.mouse.wheel(0, 200).catch(() => {}), true;
      if (k.name === 'up') return void e.page.mouse.wheel(0, -200).catch(() => {}), true;
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
    foot: (): Hint[] => {
      const s = v.state();
      if (picking) return [['', 'click a part of the page · '], ['p', ' stop picking']];
      return [['← →', ` v${s.current} of ${s.count} · `], ['v', ` ${vp} · `], ['p', ' pick · '], ['c', comparing ? ` show v${s.current} · ` : ' compare · '], ['a', s.from ? ' apply to project' : ' make it a page in my project']];
    },
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
  input_schema: { type: 'object', properties: { name: { type: 'string', description: 'the design, e.g. landing' }, html: { type: 'string' }, from: { type: 'object', description: "first version only, when it redesigns the user's page: {url} or {file} it came from, so apply knows what to change", properties: { url: { type: 'string' }, file: { type: 'string' } } } }, required: ['name', 'html'] },
};
