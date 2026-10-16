// Every setting in one typed store (SPEC §15). Each has a type, a default, a
// description and when it applies; modules read through the store and subscribe,
// so a change shows on the next frame and the next request uses it. No setting
// needs a restart. Rime writes ~/.rime/config atomically and watches it, so two
// Rime windows stay in step.

import fs from 'node:fs';
import path from 'node:path';
import { type Config, CONFIG_PATH, loadConfig, saveConfig } from './config.ts';
import { EFFORTS } from '../providers/types.ts';
import { SECRET } from './tools.ts';

export type Applies = 'now' | 'next-message' | 'next-task' | 'next-conversation';
export const WHEN: Record<Applies, string> = { now: 'now', 'next-message': 'from the next message', 'next-task': 'from the next task', 'next-conversation': 'from the next conversation' };

export type Setting = {
  key: string; // "effort", "server.gpubox.onQuit"
  group: 'Model' | 'Server' | 'Commands' | 'Updates';
  label: string;
  help: string;
  applies: Applies;
  values: string[]; // shown in this order; ← → step through them
  get(cfg: Config): string;
  set(cfg: Config, v: string): void;
};

export type Change = { key: string; label: string; from: string; to: string; applies: Applies; at: number; undone?: boolean };

const QUIT = ['keep running', 'stop the server', 'power off'];
const QUIT_KEY = ['keep', 'stop', 'poweroff'] as const;

// The settings that exist right now. Groups from SPEC §15 that have nothing to
// set yet (Panel, Prompt, Tokens, Updates) arrive with their phases.
export function definitions(cfg: Config): Setting[] {
  const out: Setting[] = [
    {
      key: 'effort', group: 'Model', label: 'Effort', help: 'how hard the model thinks', applies: 'next-message',
      values: ['default', ...EFFORTS],
      get: (c) => c.effort ?? 'default',
      set: (c, v) => void (c.effort = v === 'default' ? undefined : (v as Config['effort'])),
    },
    {
      key: 'reasoning', group: 'Model', label: 'Reasoning', help: 'think before answering', applies: 'next-message',
      values: ['on', 'off'],
      get: (c) => (c.reasoning === false ? 'off' : 'on'),
      set: (c, v) => void (c.reasoning = v === 'on'),
    },
  ];
  out.push({
    key: 'updates', group: 'Updates', label: 'Check for updates', help: 'look at npm for a new Rime when it starts', applies: 'next-conversation',
    values: ['on', 'off'],
    get: (c) => c.updates ?? 'on',
    set: (c, v) => void (c.updates = v === 'off' ? 'off' : undefined),
  });
  // Secret-looking variables in your shell: hidden from the commands the model
  // runs unless you pass one through here (the rime tool can't change these).
  for (const name of Object.keys(process.env).filter((k) => SECRET.test(k)).sort())
    out.push({
      key: `commands.env.${name}`, group: 'Commands', label: name, help: 'passed: commands Rime runs see it', applies: 'now',
      values: ['hidden', 'passed'],
      get: (c) => (c.passEnv?.includes(name) ? 'passed' : 'hidden'),
      set: (c, v) => {
        const s = new Set(c.passEnv ?? []);
        v === 'passed' ? s.add(name) : s.delete(name);
        c.passEnv = s.size ? [...s] : undefined;
      },
    });
  for (const [name, p] of Object.entries(cfg.providers)) {
    if (!p.ssh) continue;
    out.push(
      {
        key: `server.${name}.onQuit`, group: 'Server', label: `${name}: when Rime quits`, help: 'what happens to the server when you quit', applies: 'now',
        values: QUIT,
        get: (c) => QUIT[Math.max(0, QUIT_KEY.indexOf(c.providers[name]?.onQuit ?? 'keep'))],
        set: (c, v) => void (c.providers[name].onQuit = QUIT_KEY[QUIT.indexOf(v)]),
      },
      {
        key: `server.${name}.wake`, group: 'Server', label: `${name}: wake when needed`, help: 'Wake-on-LAN when it is off', applies: 'now',
        values: ['yes', 'no'],
        get: (c) => (c.providers[name]?.skip?.includes('wake') ? 'no' : 'yes'),
        set: (c, v) => {
          const skip = new Set(c.providers[name].skip ?? []);
          v === 'no' ? skip.add('wake') : skip.delete('wake');
          c.providers[name].skip = skip.size ? [...skip] : undefined;
        },
      },
    );
  }
  return out;
}

export function createSettings(cfg: Config, file = CONFIG_PATH) {
  const subs = new Set<(c: Change | null) => void>();
  const recent: Change[] = [];
  let written = '';
  const save = () => {
    saveConfig(cfg, file);
    written = fs.readFileSync(file, 'utf8');
  };
  const emit = (c: Change | null) => subs.forEach((f) => f(c));
  const find = (key: string) => definitions(cfg).find((d) => d.key === key);

  const api = {
    save, // every write goes through here, so the watcher can tell ours from another window's
    list: () => definitions(cfg),
    get: (key: string) => find(key)?.get(cfg),
    // Sets a value, saves the config, and tells every subscriber. Returns the change.
    set(key: string, to: string): Change | null {
      const d = find(key);
      if (!d || !d.values.includes(to)) return null;
      const from = d.get(cfg);
      if (from === to) return null;
      d.set(cfg, to);
      save();
      const c: Change = { key, label: d.label.toLowerCase(), from, to, applies: d.applies, at: Date.now() };
      recent.unshift(c);
      recent.length = Math.min(recent.length, 20);
      emit(c);
      return c;
    },
    undo(c: Change) {
      if (c.undone) return;
      const d = find(c.key);
      if (!d) return;
      d.set(cfg, c.from);
      save();
      c.undone = true;
      emit(null);
    },
    recent: () => recent,
    subscribe(f: (c: Change | null) => void) {
      subs.add(f);
      return () => subs.delete(f);
    },
    // Another Rime window wrote the config: take its values.
    watch() {
      const dir = path.dirname(file);
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const w = fs.watch(dir, (_, name) => {
          if (name !== path.basename(file)) return;
          let text = '';
          try {
            text = fs.readFileSync(file, 'utf8');
          } catch {
            return;
          }
          if (text === written) return;
          written = text;
          try {
            Object.assign(cfg, loadConfig(file));
          } catch {
            return; // half-written by someone else; the next event has it whole
          }
          emit(null);
        });
        w.unref();
        return () => w.close();
      } catch {
        return () => {};
      }
    },
  };
  return api;
}

export type Settings = ReturnType<typeof createSettings>;

// Short, exact requests that need no AI (SPEC §15, the §6 policy layer): they run
// in code with no API call. Anything looser goes to the model.
export function phrase(text: string): { key: string; value: string } | null {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, '');
  let m = /^(?:set |use |change )?effort (?:to )?(default|low|medium|high|max)$/.exec(t);
  if (m) return { key: 'effort', value: m[1] };
  m = /^(?:turn )?reasoning (on|off)$|^turn (on|off) reasoning$/.exec(t);
  if (m) return { key: 'reasoning', value: m[1] ?? m[2] };
  // A model or provider by name; the app checks it's one it knows.
  m = /^(?:use|switch to|load) ([\w.:/@-]+)$/.exec(t);
  if (m) return { key: 'use', value: m[1] };
  // Split view's tabs (SPEC §8): the files, the diff, the tests.
  if (/^(?:open|show)(?: me)? (?:the )?(?:codebase|files|file tree|project)(?: in a (?:new )?tab)?$/.test(t)) return { key: 'tab', value: 'files' };
  if (/^(?:open|show)(?: me)? (?:the )?diff(?: in a (?:new )?tab)?$/.test(t)) return { key: 'tab', value: 'diff' };
  if (/^run (?:the )?tests in a (?:new )?tab$/.test(t)) return { key: 'tab', value: 'tests' };
  // Split view v2 (docs/split-v2.md §5): the panel, servers, commands, the
  // browser, file search and the design studio, by name. The app checks each
  // still makes sense (a real address, a dev script) before handling it.
  if (/^(?:open|show)(?: the)? (?:split|panel)(?: view| screen)?$|^split(?: screen| view)?$/.test(t)) return { key: 'panel', value: 'show' };
  if (/^(?:close|hide)(?: the)? (?:split|panel)(?: view| screen)?$/.test(t)) return { key: 'panel', value: 'hide' };
  if (/^(?:start|run)(?: the)?(?: dev)? server$|^run npm (?:run dev|start)$/.test(t)) return { key: 'serve', value: '' };
  const raw = text.trim().replace(/[.!]+$/, '');
  m = /^run ((?:npm|pnpm|yarn|bun|npx|node|make|cargo|go|pytest|python3?|deno|git|ls|tsc|vitest|jest)\b.*?)(?: in a (?:new )?tab)?$/i.exec(raw);
  if (m) return { key: 'run', value: m[1] };
  m = /^search (?:the |my )?(?:files|code|codebase|project) for (.+)$/i.exec(raw);
  if (m) return { key: 'search', value: `text:${m[1].replace(/^["']|["']$/g, '')}` };
  m = /^find (?:the file )?(\S*[./]\S*)$/i.exec(raw);
  if (m) return { key: 'search', value: `name:${m[1]}` };
  m = /^(?:open |start )?(?:the )?design studio (?:on|for|from) (?:my |the )?(.+?)(?: page)?$|^redesign (?:my |the )?(.+?)(?: page)?$/i.exec(raw);
  if (m) return { key: 'design', value: m[1] ?? m[2] };
  m = /^(?:go to|open|visit|browse to) (\S*[.:/]\S*?)(?: in (?:the|a) (?:browser|tab))?$/i.exec(raw);
  if (m) return { key: 'open', value: m[1] };
  return null;
}
