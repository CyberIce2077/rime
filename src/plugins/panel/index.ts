// The panel and its eight views, built from one host (the app). The order is
// fixed: 1 review, 2 plan, 3 checks, 4 run, 5 git, 6 files, 7 context, 8 log.

import type { Styles } from '../../core/view.ts';
import { checksView } from './checks.ts';
import { type Piece, contextView } from './context.ts';
import { filesView } from './files.ts';
import { gitView } from './git.ts';
import { type Kit } from './kit.ts';
import { type Entry, logView } from './log.ts';
import { createPanel } from './panel.ts';
import { type Step, planView } from './plan.ts';
import { reviewView } from './review.ts';
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
  // review
  diff(): string;
  git(): boolean;
  undone(file: string, line: number, lines: string[]): void;
  // plan
  planChanged(steps: Step[]): void;
  // git
  commitByRime(): void;
  // context
  pieces(): Piece[];
  window(): number | undefined;
  sent(): { prompt: number; cached: number } | null;
  drop(at: [number, number]): void;
  // log
  entries(): Entry[];
};

export const VIEWS = ['review', 'plan', 'checks', 'run', 'git', 'files', 'context', 'log'] as const;

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
  const review = reviewView({ ...kit, diff: h.diff, git: h.git, undone: h.undone, toChat: h.toChat });
  const plan = planView({ ...kit, changed: h.planChanged });
  const checks = checksView(kit);
  const run = runView({ ...kit, open: h.open });
  const git = gitView({ ...kit, commitByRime: h.commitByRime });
  const files = filesView({ ...kit, files: h.files, recent: h.recent });
  const context = contextView({ ...kit, pieces: h.pieces, window: h.window, sent: h.sent, drop: h.drop });
  const log = logView({ ...kit, entries: h.entries });
  panel = createPanel(h.st, [review, plan, checks, run, git, files, context, log], h.redraw);
  return { panel, review, plan, checks, run, git, files, context, log };
}
export type Side = ReturnType<typeof createSide>;
