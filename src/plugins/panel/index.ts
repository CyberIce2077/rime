// The panel and its three views, built from one host (the app). The order is
// 1 changes, 2 run, 3 files until you drag a tab somewhere else.

import type { Styles } from '../../core/view.ts';
import { changesView } from './changes.ts';
import { filesView } from './files.ts';
import { type Kit } from './kit.ts';
import { createPanel } from './panel.ts';
import { runView } from './run.ts';

export type SideHost = {
  st: Styles;
  root: string;
  redraw(): void;
  env(): NodeJS.ProcessEnv;
  mention(ref: string, lines?: [number, number]): void; // a chip in the chat prompt
  toChat(): void; // the chat gets the keys
  open(url: string): void; // in the user's own browser
  files(): string[];
  recent?(): string[];
  // changes
  diff(): string;
  git(): boolean;
  undone(file: string, line: number, lines: string[]): void;
  commitByRime(): void;
  // the tab order you dragged, kept in the config
  order?: string[];
  reordered?(ids: string[]): void;
};

export const VIEWS = ['changes', 'run', 'files'] as const;

// Names the views had before (and words for them) to the view that has that job now.
export const OLD_VIEWS: Record<string, (typeof VIEWS)[number]> = { review: 'changes', diff: 'changes', git: 'changes', commit: 'changes', checks: 'run', tests: 'run', shell: 'run', server: 'run', servers: 'run', terminal: 'run', tab: 'run', codebase: 'files', tree: 'files', search: 'files' };

export function createSide(h: SideHost) {
  // The panel exists after the views, so their kit reaches it through `panel`.
  let panel: ReturnType<typeof createPanel>;
  const kit: Kit = {
    st: h.st,
    root: h.root,
    redraw: () => h.redraw(),
    toast: (m) => panel.toast(m),
    mention: (ref, lines) => h.mention(ref, lines),
    openFile: (p, line) => files.openFile(p, line) && panel.go('files'),
    env: () => h.env(),
  };
  const changes = changesView({ ...kit, diff: h.diff, git: h.git, undone: h.undone, toChat: h.toChat, commitByRime: h.commitByRime });
  const run = runView({ ...kit, open: h.open });
  const files = filesView({ ...kit, files: h.files, recent: h.recent });
  panel = createPanel(h.st, [changes, run, files], h.redraw, { order: h.order, reordered: h.reordered });
  // The view worth opening on: the one you were on while it has something,
  // else changes waiting, else a failing check or something running, else files.
  const best = () => {
    changes.refresh();
    const has = (id: string) => (id === 'changes' ? changes.pending > 0 : id === 'run' ? run.procs.some((p) => p.state !== 'idle') : !!files.viewing);
    if (has(panel.active)) return panel.active;
    return changes.pending ? 'changes' : run.badge() ? 'run' : 'files';
  };
  return { panel, changes, run, files, best };
}
export type Side = ReturnType<typeof createSide>;
