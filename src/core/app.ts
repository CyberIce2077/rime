// The single-pane Rime screen (SPEC §4, reference/rime-prototype.html).
//
// Full screen on the alternate screen: the transcript scrolls in the top part
// (wheel, PgUp/PgDn), the boxes, prompt and status line are pinned to the bottom.

import { type Message, ApiError, createAccumulator, streamMessages } from './api.ts';
import type { Config } from './config.ts';
import { type Header, type HeaderOpts, cubeArea, mascotStyle, playHeader } from './header.ts';
import { EFFORTS, MODELS, findModel } from './models.ts';
import { type InputEvent, type Line, createParser, fit, lineWidth, strWidth, truncAnsi, wrap } from './term.ts';
import { colorMode } from './theme.ts';
import { type BoxRow, type Hit, type Item, box, caretOf, footRows, layoutInput, listRow, prompt, renderItem, spaced, status, styles } from './view.ts';
import { createMeter, fmt$, fmtT } from '../plugins/token-kit/meter.ts';

const CMDS: [string, string][] = [
  ['/model', 'switch model or effort'],
  ['/clear', 'start a new conversation'],
  ['/usage', 'token, cost and savings breakdown'],
  ['/exit', 'quit Rime'],
];

const KEYS: [string, string][] = [
  ['enter', 'send'], ['shift+enter', 'new line'], ['esc', 'stop Rime, or close a box'],
  ['↑', 'edit your last message'], ['tab', 'complete a command'], ['ctrl+c ×2', 'quit'],
  ['pgup pgdn', 'scroll, or use the wheel'], ['/', 'commands'], ['?', 'this list'],
];

// Frozen for the whole session: any byte change here would break the prompt cache.
const system = (cwd: string) =>
  `You are Rime, a coding assistant running in the user's terminal.\n` +
  `Working directory: ${cwd}\n` +
  `Be brief and direct. Use plain text with light markdown (lists, \`code\`, fenced blocks); no tables.`;

const fmtP = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

// Modes: alternate screen, SGR mouse clicks and wheel, bracketed paste, kitty
// keyboard (disambiguate) and xterm modifyOtherKeys so shift+enter is
// distinguishable, accent cursor color.
const MODES_ON = '\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[>1u\x1b[>4;1m\x1b]12;#7FD4F5\x07';
const MODES_OFF = '\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[<u\x1b[>4;0m\x1b]112\x07\x1b[?25h\x1b[?1049l';

export async function runApp(cfg: Config, version: string) {
  const out = process.stdout, inp = process.stdin;
  const st = styles(colorMode(out));
  const write = (s: string) => out.write(s);
  const meter = createMeter();
  const cwd = process.cwd();
  const SYSTEM = system(cwd);

  // ---- state ----
  let model = cfg.model, effort = cfg.effort;
  let sessionEffort = effort; // top-level effort, fixed per conversation for the cache
  let sentEffort = effort; // the effort the model was last told about
  let messages: Message[] = [];
  const history: string[] = [];
  let buf = '', cur = 0, sel = 0;
  let boxKind: 'keys' | 'model' | 'usage' | null = null;
  let modelSel = 0, effortSel = 0;
  let busy: AbortController | null = null;
  let quitArmed: NodeJS.Timeout | null = null;

  // ---- screen ----
  let scrollOff = 0; // transcript lines scrolled up from the bottom
  let lastTotal = 0;
  let viewH = 0;
  let headerRow = 0; // screen row of the header's first line (can be off screen)
  let hits: { row: number; x0: number; x1: number; id: string }[] = [];
  let scheduled = false;
  const cache = new WeakMap<Item, { width: number; lines: string[] }>();

  const style = mascotStyle();
  const cube = cubeArea(style);
  const details = () => `${model.context} context · ${effort} effort`;
  let header!: Header;
  const headerOpts: HeaderOpts & { ready: (h: Header) => void } = {
    version, model: model.label, details: details(), cwd, mode: st.mode, interactive: false, style,
    onFrame: () => schedule(),
    ready: (h) => (header = h),
  };
  const headerItem: Item = { kind: 'header', lines: () => header.lines() };
  let items: Item[] = [headerItem];

  const W = () => out.columns || 80;
  const H = () => out.rows || 24;

  function render(it: Item, width: number) {
    const done = it.kind === 'user' || it.kind === 'cost' || it.kind === 'note' || (it.kind === 'reply' && it.done);
    const hit = cache.get(it);
    if (done && hit && hit.width === width) return hit.lines;
    const lines = renderItem(it, width, st);
    if (done) cache.set(it, { width, lines });
    return lines;
  }

  function transcript(width: number) {
    const lines: string[] = [];
    let prev: Item | undefined;
    for (const it of items) {
      if (spaced(prev, it)) lines.push('');
      lines.push(...render(it, width));
      prev = it;
    }
    if (prev !== headerItem) lines.push(''); // the log's bottom margin
    return lines;
  }

  // ---- boxes above the prompt ----

  const matches = () => {
    const q = buf.slice(1).toLowerCase();
    const pre = CMDS.filter(([n]) => n.slice(1).startsWith(q));
    return [...pre, ...CMDS.filter((c) => !pre.includes(c) && (c[0] + ' ' + c[1]).toLowerCase().includes(q))];
  };
  const cmdsOpen = () => boxKind !== 'keys' && buf.startsWith('/') && !/\s/.test(buf);

  function usageRows(width: number): BoxRow[] {
    const t = meter.tokens, c = meter.cost, p = model.price;
    const sp = meter.spent(), sv = meter.savedTotal();
    const savedCell = `${fmt$(sv)} (${meter.pct()}%)`;
    const data: [string, string, string][] = [
      ['input', fmtT(t.uncached), fmt$(c.uncached)],
      ['cache reads', fmtT(t.read), fmt$(c.read)],
      ['cache writes', fmtT(t.write), fmt$(c.write)],
      ['output', fmtT(t.out), fmt$(c.out)],
      ['total spent', fmtT(meter.totalTokens()), fmt$(sp)],
    ];
    const inner = width - 4;
    const tw = Math.max(6, ...data.map((d) => d[1].length));
    const cw = Math.max(4, savedCell.length, ...data.map((d) => d[2].length));
    const row = (label: Line, tok: string, cost: string, s: string): BoxRow => ({
      line: [...fit(label, inner - tw - cw - 2, true), { t: ' ' + tok.padStart(tw) + ' ' + cost.padStart(cw), s }],
    });
    const why = `context re-read at ${fmtP(p.read)} instead of ${fmtP(p.in)}`;
    const foot = wrap([
      { t: `Without Rime this session would have cost ${fmt$(sp + sv)}. Prices per million tokens: ${fmtP(p.in)} input, ${fmtP(p.read)} cache read, ${fmtP(p.write)} cache write, ${fmtP(p.out)} output. `, s: st.dim },
      { t: '/usage', s: st.accent },
      { t: ' or a click on the meter closes this.', s: st.dim },
    ], inner);
    return [
      row([{ t: 'spent', s: st.dim }], 'tokens', 'cost', st.dim),
      ...data.slice(0, 4).map(([a, b, d]) => row([{ t: a, s: st.fg }], b, d, st.fg)),
      { line: [], rule: 'inner' },
      row([{ t: data[4][0], s: st.title }], data[4][1], data[4][2], st.title),
      { line: [] },
      { line: [], rule: 'inner' },
      row([{ t: 'Rime saved', s: st.ok }], '', savedCell, st.ok),
      row([{ t: '  prompt caching', s: st.fg }], '', fmt$(meter.saved.cache), st.fg),
      { line: [{ t: '  ' + why, s: st.dim }] },
      { line: [], rule: 'inner' },
      ...foot.map((line) => ({ line })),
    ];
  }

  function currentBox(width: number) {
    if (cmdsOpen()) {
      const m = matches();
      sel = Math.min(sel, Math.max(0, m.length - 1));
      const rows: BoxRow[] = m.length
        ? m.map(([n, h], i) => listRow(n, h, i === sel, st, `cmd:${i}`))
        : [{ line: [{ t: `no command matches ${buf}`, s: st.dim }] }];
      return box('commands', [...rows, ...footRows('↑↓ choose · tab complete · ↵ run · esc close', st)], width, st);
    }
    if (boxKind === 'keys') {
      return box('shortcuts', [...KEYS.map(([k, h]) => listRow(k, h, false, st)), ...footRows('any key to close', st)], width, st);
    }
    if (boxKind === 'model') {
      const rows = MODELS.map((m, i) =>
        listRow(m.label, `${m.context} context · ${fmtP(m.price.in)} / ${fmtP(m.price.out)} per M tokens`, i === modelSel, st, `model:${i}`));
      const eff: Line = [{ t: '  effort'.padEnd(15), s: st.title }];
      EFFORTS.forEach((e, i) => {
        if (i) eff.push({ t: ' · ', s: st.dim });
        eff.push({ t: e, s: i === effortSel ? st.accentB : st.dim });
      });
      return box('model', [...rows, { line: eff }, ...footRows('↑↓ model · ←→ effort · ↵ select · esc close', st)], width, st);
    }
    if (boxKind === 'usage') return box(`usage · this session · ${model.label}`, usageRows(width), width, st);
    return null;
  }

  function ui(width: number, height: number) {
    const lines: string[] = [];
    const rowHits: Hit[][] = [];
    const b = currentBox(width);
    if (b && b.lines.length <= height - 4) {
      lines.push(...b.lines);
      b.hits.forEach((id) => rowHits.push(id ? [{ x0: 1, x1: width, id }] : []));
    }
    const p = prompt(buf, cur, width, Math.max(1, Math.min(10, height - lines.length - 3)), st);
    const promptAt = lines.length;
    lines.push(...p.lines);
    p.lines.forEach(() => rowHits.push([]));

    let left: Line, leftHits: Hit[] = [];
    if (quitArmed) left = [{ t: 'press ctrl+c again to quit', s: st.dim }];
    else if (scrollOff > 0) {
      left = [{ t: '↓', s: st.accentB }, { t: ` ${scrollOff} lines below · pgdn`, s: st.dim }];
      leftHits = [{ x0: 1, x1: lineWidth(left), id: 'bottom' }];
    } else if (busy) left = [{ t: 'esc', s: st.accentB }, { t: ' to stop', s: st.dim }];
    else {
      left = [
        { t: '/', s: st.accentB }, { t: ' for commands', s: st.dim }, { t: ' · ', s: st.dim },
        { t: '?', s: st.accentB }, { t: ' for shortcuts', s: st.dim },
      ];
      leftHits = [{ x0: 1, x1: 14, id: '/' }, { x0: 18, x1: 32, id: '?' }];
    }
    const sv = meter.savedTotal();
    const m: Line = [
      { t: `${fmtT(meter.totalTokens())} tokens · ${fmt$(meter.spent())} · `, s: st.dim },
      { t: `saved ${fmt$(sv)} (${meter.pct()}%)`, s: st.ok },
    ];
    const s = status(left, m, width, st, leftHits);
    lines.push(s.line);
    rowHits.push(s.hits);
    return { lines, rowHits, cursor: { row: promptAt + p.cursor.row, col: p.cursor.col } };
  }

  // ---- drawing ----

  // Full screen, like vim: the transcript fills the top (scrollable), the boxes,
  // prompt and status line sit at the bottom. Every frame repaints every row.
  function frame() {
    scheduled = false;
    const width = W(), height = H();
    const lines = transcript(width);
    const u = ui(width, height);
    viewH = Math.max(0, height - u.lines.length);
    if (scrollOff > 0) scrollOff += lines.length - lastTotal; // hold still while scrolled up
    lastTotal = lines.length;
    scrollOff = Math.max(0, Math.min(scrollOff, lines.length - viewH));
    const start = Math.max(0, lines.length - viewH - scrollOff);
    const view = lines.slice(start, start + viewH);
    const rows = [...view, ...new Array(viewH - view.length).fill(''), ...u.lines];
    headerRow = items[0] === headerItem ? 2 - start : -99;
    hits = u.rowHits.flatMap((hs, i) => hs.map((h) => ({ ...h, row: viewH + 1 + i })));
    write(
      '\x1b[?2026h\x1b[?25l' +
      // Clear first: erasing after a full-width line would eat its last cell.
      rows.map((l, i) => `\x1b[${i + 1};1H\x1b[2K${truncAnsi(l, width)}${st.reset}`).join('') +
      `\x1b[${viewH + 1 + u.cursor.row};${u.cursor.col + 1}H\x1b[?25h\x1b[?2026l`,
    );
  }

  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      setImmediate(frame);
    }
  };

  // ---- chat ----

  const drop = (it: Item) => {
    const i = items.indexOf(it);
    if (i >= 0) items.splice(i, 1);
  };

  async function send(text: string) {
    items.push({ kind: 'user', text });
    history.push(text);
    if (!cfg.apiKey) {
      items.push({ kind: 'note', tone: 'warn', text: 'No API key. Set ANTHROPIC_API_KEY, or put {"apiKey": "sk-ant-…"} in ~/.rime/config.' });
      return schedule();
    }
    // Per-message effort keeps the cached prefix intact (beta, SPEC §6).
    const betas = ['server-side-fallback-2026-07-01'];
    if (effort !== sentEffort) {
      messages.push({ role: 'system', content: [], output_config: { effort } });
      sentEffort = effort;
    }
    if (messages.some((m) => m.role === 'system')) betas.push('mid-conversation-output-config-2026-07-01');
    messages.push({ role: 'user', content: text });

    const thinking: Item = { kind: 'tool', verb: 'Thinking' };
    items.push(thinking);
    let dots = 0;
    const spin = setInterval(() => {
      if (thinking.kind === 'tool') thinking.verb = 'Thinking' + '.'.repeat(++dots % 4);
      schedule();
    }, 200);
    const ac = new AbortController();
    busy = ac;
    schedule();

    const acc = createAccumulator();
    let reply: Extract<Item, { kind: 'reply' }> | null = null;
    let used = model;
    const charge = () => {
      if (acc.usage.input_tokens !== undefined) items.push({ kind: 'cost', turn: meter.charge(acc.usage, used.price) });
    };
    const forget = () => {
      if (messages.at(-1)?.role === 'user') messages.pop();
    };
    try {
      for await (const ev of streamMessages({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        betas,
        signal: ac.signal,
        body: {
          model: model.id,
          max_tokens: 64000,
          system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
          messages,
          output_config: { effort: sessionEffort },
          cache_control: { type: 'ephemeral' },
          fallbacks: 'default',
        },
      })) {
        if (ev.type === 'message_start' && ev.message?.model) used = findModel(ev.message.model) ?? model;
        const delta = acc.add(ev);
        if (!delta) continue;
        if (!reply) {
          clearInterval(spin);
          drop(thinking);
          reply = { kind: 'reply', text: '', done: false };
          items.push(reply);
        }
        reply.text += delta;
        schedule();
      }
      const blocks = acc.blocks.filter(Boolean).map(({ _json, ...b }) => b);
      if (reply) reply.done = true;
      if (blocks.length) messages.push({ role: 'assistant', content: blocks });
      else forget();
      drop(thinking);
      charge();
      const why = acc.stopReason();
      if (why === 'refusal') items.push({ kind: 'note', tone: 'warn', text: 'The model declined this request. Rephrase it, or /clear to start over.' });
      else if (why === 'max_tokens') items.push({ kind: 'note', tone: 'warn', text: 'The reply hit the output limit and was cut off.' });
    } catch (e) {
      drop(thinking);
      if (reply) reply.done = true;
      if (ac.signal.aborted) {
        if (reply?.text.trim()) messages.push({ role: 'assistant', content: [{ type: 'text', text: reply.text.trimEnd() }] });
        else forget();
        charge();
        items.push({ kind: 'note', tone: 'dim', text: 'stopped' });
      } else {
        if (messages.at(-1)?.role === 'assistant') messages.pop();
        forget();
        const err = e as Error;
        const text = err instanceof ApiError && err.status === 401
          ? 'Invalid API key. Check ANTHROPIC_API_KEY or ~/.rime/config.'
          : err instanceof ApiError ? err.message
          : `Couldn't reach ${new URL(cfg.baseUrl).host}. ${err.message}`;
        items.push({ kind: 'note', tone: 'warn', text });
      }
    } finally {
      clearInterval(spin);
      if (busy === ac) busy = null;
      schedule();
    }
  }

  // ---- commands ----

  function applyModel() {
    model = MODELS[modelSel];
    effort = EFFORTS[effortSel];
    if (!messages.length) sessionEffort = sentEffort = effort;
    headerOpts.model = model.label;
    headerOpts.details = details();
    header.redraw();
    items.push({ kind: 'tool', verb: 'Model', rest: `${model.label} · ${effort} effort` });
    boxKind = null;
  }

  function submit() {
    const v = buf.trim();
    if (!v) return;
    if (busy && !v.startsWith('/')) return; // one reply at a time; esc stops it
    buf = '';
    cur = 0;
    sel = 0;
    if (!v.startsWith('/')) {
      scrollOff = 0;
      return void send(v);
    }
    const c = v.split(/\s+/)[0];
    if (c === '/model') {
      boxKind = 'model';
      modelSel = MODELS.indexOf(model);
      effortSel = EFFORTS.indexOf(effort);
    } else if (c === '/clear') {
      busy?.abort();
      messages = [];
      items = [headerItem];
      sessionEffort = sentEffort = effort;
      boxKind = null;
      scrollOff = 0;
      return;
    } else if (c === '/usage') boxKind = boxKind === 'usage' ? null : 'usage';
    else if (c === '/exit') quit();
    else {
      items.push({ kind: 'user', text: v });
      items.push({ kind: 'reply', text: `Unknown command ${c}. Press / to see the commands.`, done: true });
    }
  }

  // ---- input ----

  const tw = () => Math.max(1, W() - 6);
  const prevCp = (i: number) => (i >= 2 && /[\udc00-\udfff]/.test(buf[i - 1]) ? i - 2 : Math.max(0, i - 1));
  const nextCp = (i: number) => (/[\ud800-\udbff]/.test(buf[i] || '') ? i + 2 : Math.min(buf.length, i + 1));
  const insert = (s: string) => {
    buf = buf.slice(0, cur) + s + buf.slice(cur);
    cur += s.length;
    sel = 0;
  };
  const wordLeft = (i: number) => {
    while (i > 0 && /\s/.test(buf[i - 1])) i--;
    while (i > 0 && !/\s/.test(buf[i - 1])) i--;
    return i;
  };
  const wordRight = (i: number) => {
    while (i < buf.length && /\s/.test(buf[i])) i++;
    while (i < buf.length && !/\s/.test(buf[i])) i++;
    return i;
  };
  const lineStart = () => buf.lastIndexOf('\n', cur - 1) + 1;
  const lineEnd = () => (buf.indexOf('\n', cur) < 0 ? buf.length : buf.indexOf('\n', cur));

  // Moves the caret one visual row up or down. Returns false at the edge.
  function vertical(dir: -1 | 1) {
    const rows = layoutInput(buf, tw());
    const c = caretOf(rows, cur);
    const r = rows[c.row + dir];
    if (!r) return false;
    let i = 0, w = 0;
    for (const ch of r.text) {
      if (w + strWidth(ch) > c.col) break;
      w += strWidth(ch);
      i += ch.length;
    }
    cur = r.start + i;
    return true;
  }

  function act(id: string) {
    if (id.startsWith('cmd:')) {
      buf = matches()[+id.slice(4)][0];
      submit();
    } else if (id.startsWith('model:')) modelSel = +id.slice(6);
    else if (id === '/') {
      buf = '/';
      cur = 1;
      sel = 0;
      boxKind = null;
    } else if (id === '?') {
      buf = '';
      cur = 0;
      boxKind = 'keys';
    } else if (id === 'meter') boxKind = boxKind === 'usage' ? null : 'usage';
    else if (id === 'bottom') scrollOff = 0;
  }

  function onKey(k: Extract<InputEvent, { type: 'key' }>) {
    if (boxKind === 'keys') {
      boxKind = null; // any key closes the sheet
      return;
    }
    if (k.ctrl && k.name === 'c') {
      if (busy) busy.abort();
      else if (buf) {
        buf = '';
        cur = 0;
        return;
      } else if (quitArmed) return quit();
      if (quitArmed) clearTimeout(quitArmed);
      quitArmed = setTimeout(() => {
        quitArmed = null;
        schedule();
      }, 2000);
      return;
    }
    if (quitArmed) {
      clearTimeout(quitArmed);
      quitArmed = null;
    }

    if (cmdsOpen()) {
      const m = matches();
      if (k.name === 'up' || k.name === 'down') {
        if (m.length) sel = (sel + (k.name === 'down' ? 1 : -1) + m.length) % m.length;
        return;
      }
      if (k.name === 'tab') {
        if (m.length) buf = m[sel][0], cur = buf.length;
        return;
      }
      if (k.name === 'enter' && !k.shift && !k.alt) {
        if (m.length) buf = m[sel][0];
        return submit();
      }
      if (k.name === 'escape') {
        buf = '';
        cur = 0;
        return;
      }
    }
    if (boxKind === 'model') {
      if (k.name === 'up' || k.name === 'down') modelSel = (modelSel + (k.name === 'down' ? 1 : -1) + MODELS.length) % MODELS.length;
      else if (k.name === 'left') effortSel = Math.max(0, effortSel - 1);
      else if (k.name === 'right') effortSel = Math.min(EFFORTS.length - 1, effortSel + 1);
      else if (k.name === 'enter') applyModel();
      else if (k.name === 'escape') boxKind = null;
      return;
    }
    if (k.name === 'escape') {
      if (boxKind) boxKind = null;
      else busy?.abort();
      return;
    }

    switch (k.name) {
      case 'enter':
        if (k.shift || k.alt) insert('\n');
        else if (buf[cur - 1] === '\\') {
          buf = buf.slice(0, cur - 1) + buf.slice(cur);
          cur--;
          insert('\n');
        } else submit();
        return;
      case 'j':
        if (k.ctrl) insert('\n');
        return;
      case 'char':
        if (k.alt && k.ch === 'b') cur = wordLeft(cur);
        else if (k.alt && k.ch === 'f') cur = wordRight(cur);
        else if (k.ch === '?' && !buf && !k.alt) boxKind = 'keys';
        else if (!k.alt && k.ch) insert(k.ch);
        return;
      case 'space':
        insert(' ');
        return;
      case 'tab':
        return;
      case 'backspace':
        if (k.alt || k.ctrl) {
          const i = wordLeft(cur);
          buf = buf.slice(0, i) + buf.slice(cur);
          cur = i;
        } else if (cur > 0) {
          const i = prevCp(cur);
          buf = buf.slice(0, i) + buf.slice(cur);
          cur = i;
        }
        return;
      case 'delete':
        if (cur < buf.length) buf = buf.slice(0, cur) + buf.slice(nextCp(cur));
        return;
      case 'left':
        cur = k.alt || k.ctrl ? wordLeft(cur) : prevCp(cur);
        return;
      case 'right':
        cur = k.alt || k.ctrl ? wordRight(cur) : nextCp(cur);
        return;
      case 'home': case 'a':
        if (k.name === 'home' || k.ctrl) cur = lineStart();
        return;
      case 'end': case 'e':
        if (k.name === 'end' || k.ctrl) cur = lineEnd();
        return;
      case 'u':
        if (k.ctrl) {
          const i = lineStart();
          buf = buf.slice(0, i) + buf.slice(cur);
          cur = i;
        }
        return;
      case 'k':
        if (k.ctrl) buf = buf.slice(0, cur) + buf.slice(lineEnd());
        return;
      case 'w':
        if (k.ctrl) {
          const i = wordLeft(cur);
          buf = buf.slice(0, i) + buf.slice(cur);
          cur = i;
        }
        return;
      case 'up':
        if (!vertical(-1) && !buf && history.length) {
          buf = history.at(-1)!;
          cur = buf.length;
        }
        return;
      case 'down':
        vertical(1);
        return;
    }
  }

  function onEvent(ev: InputEvent) {
    if (ev.type === 'mouse') {
      if (ev.button === 64 || ev.button === 65) scrollOff += ev.button === 64 ? 3 : -3; // wheel
      else if (!ev.release && ev.button === 0) {
        const onCube = ev.x >= cube.x0 && ev.x <= cube.x1 && ev.y >= headerRow + cube.y0 && ev.y <= headerRow + cube.y1;
        const h = hits.find((h) => h.row === ev.y && ev.x >= h.x0 && ev.x <= h.x1);
        if (onCube && ev.y <= viewH) header.blink();
        else if (h) act(h.id);
      }
    } else if (ev.type === 'paste') {
      if (boxKind === 'keys' || boxKind === 'model') boxKind = null;
      insert(ev.text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ''));
    } else if (ev.type === 'key') {
      if (ev.name === 'pageup' || ev.name === 'pagedown') scrollOff += (ev.name === 'pageup' ? 1 : -1) * Math.max(1, viewH - 2);
      else onKey(ev);
    }
    schedule();
  }

  // ---- lifecycle ----

  const restore = () => {
    write(MODES_OFF);
    if (inp.isTTY) inp.setRawMode(false);
  };

  function quit(): never {
    busy?.abort();
    header?.close();
    restore();
    process.exit(0);
  }

  const parse = createParser();
  inp.setRawMode(true);
  inp.resume();
  inp.on('data', (d: Buffer) => {
    for (const ev of parse(d.toString('utf8'))) onEvent(ev);
  });
  process.on('exit', restore);
  process.on('SIGTERM', quit);
  process.on('SIGHUP', quit);
  out.on('resize', schedule);

  write(MODES_ON);
  playHeader(headerOpts);
  frame();
}
