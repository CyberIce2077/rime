// diff-undo (SPEC §9, Phase 8): a checkpoint before each turn's first change, so
// /diff and /undo work with no API call. In a git repo a checkpoint is a snapshot
// of the whole working tree (tracked and untracked files, .gitignore respected,
// .rime left out) written as a git tree through a temporary index: the real index,
// HEAD and branches are never touched, and a ref under refs/rime/ keeps it from
// garbage collection. Outside git, the files Rime writes or edits are copied before
// their first change.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { rimeDir } from '../../core/config.ts';

export type Checkpoint = { id: number; at: number; label: string; tree?: string; files?: Record<string, boolean> }; // files: rel -> existed before
export type Change = { file: string; how: 'added' | 'changed' | 'deleted' };

const KEEP = 30;

export function createCheckpoints(root: string) {
  const git = (args: string[], env: Record<string, string> = {}) =>
    execFileSync('git', args, { cwd: root, env: { ...process.env, ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256e6 }).trim();
  let gitDir: string | null = null;
  try {
    if (git(['rev-parse', '--show-toplevel']) === fs.realpathSync(root)) gitDir = path.resolve(root, git(['rev-parse', '--git-dir']));
  } catch {}
  const dir = path.join(root, '.rime', 'checkpoints');
  const listFile = path.join(dir, 'list.json');
  const load = (): Checkpoint[] => {
    try {
      return JSON.parse(fs.readFileSync(listFile, 'utf8'));
    } catch {
      return [];
    }
  };
  const store = (l: Checkpoint[]) => {
    rimeDir(root, 'checkpoints');
    fs.writeFileSync(listFile, JSON.stringify(l));
  };

  // The working tree as a git tree. The temporary index starts as a copy of the
  // real one, so only files that changed are hashed again.
  function snapshot() {
    const idx = path.join(gitDir!, 'rime-snapshot.index');
    try {
      fs.copyFileSync(path.join(gitDir!, 'index'), idx);
    } catch {
      fs.rmSync(idx, { force: true });
    }
    try {
      git(['add', '-A', '--', '.', ':(exclude).rime'], { GIT_INDEX_FILE: idx });
      return git(['write-tree'], { GIT_INDEX_FILE: idx });
    } finally {
      fs.rmSync(idx, { force: true });
    }
  }

  // Changes from a checkpoint to now (and the tree for now, in git).
  function changes(cp: Checkpoint): { list: Change[]; now?: string } {
    if (cp.tree) {
      const now = snapshot();
      const out = git(['diff-tree', '-r', '--name-status', '--no-renames', cp.tree, now]);
      const how = { A: 'added', M: 'changed', D: 'deleted', T: 'changed' } as const;
      return { now, list: out ? out.split('\n').map((l) => ({ how: how[l[0] as 'A'] ?? 'changed', file: l.slice(2) })) : [] };
    }
    const list: Change[] = [];
    for (const [file, existed] of Object.entries(cp.files ?? {})) {
      const p = path.join(root, file), saved = path.join(dir, String(cp.id), file);
      const exists = fs.existsSync(p);
      if (!existed && exists) list.push({ file, how: 'added' });
      else if (existed && !exists) list.push({ file, how: 'deleted' });
      else if (existed && !fs.readFileSync(p).equals(fs.readFileSync(saved))) list.push({ file, how: 'changed' });
    }
    return { list };
  }

  return {
    git: !!gitDir,
    list: load,
    last: () => load().at(-1),
    // Before a turn's first change. Old checkpoints beyond the last 30 go.
    begin(label: string): Checkpoint {
      const l = load();
      const cp: Checkpoint = { id: (l.at(-1)?.id ?? 0) + 1, at: Date.now(), label: label.slice(0, 80), ...(gitDir ? { tree: snapshot() } : { files: {} }) };
      if (cp.tree) git(['update-ref', `refs/rime/checkpoints/${cp.id}`, cp.tree]);
      l.push(cp);
      for (const old of l.splice(0, Math.max(0, l.length - KEEP))) {
        if (old.tree) git(['update-ref', '-d', `refs/rime/checkpoints/${old.id}`]);
        fs.rmSync(path.join(dir, String(old.id)), { recursive: true, force: true });
      }
      store(l);
      return cp;
    },
    // Outside git: a file's content before Rime's first write or edit to it.
    touch(cp: Checkpoint, file: string) {
      if (cp.tree || !cp.files || file in cp.files) return;
      const p = path.join(root, file);
      cp.files[file] = fs.existsSync(p);
      if (cp.files[file]) {
        const to = path.join(dir, String(cp.id), file);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(p, to);
      }
      store(load().map((x) => (x.id === cp.id ? cp : x)));
    },
    changes: (cp: Checkpoint) => changes(cp).list,
    // A unified diff from the checkpoint to now.
    diff(cp: Checkpoint): string {
      const c = changes(cp);
      if (cp.tree) return c.list.length ? git(['diff', '--no-color', '--no-ext-diff', cp.tree, c.now!]) : '';
      return c.list
        .map(({ file, how }) => {
          const before = how === 'added' ? '/dev/null' : path.join(dir, String(cp.id), file);
          const after = how === 'deleted' ? '/dev/null' : path.join(root, file);
          try {
            return execFileSync('git', ['diff', '--no-index', '--no-color', before, after], { encoding: 'utf8' });
          } catch (e) {
            return String((e as { stdout?: string }).stdout ?? ''); // exit 1 means "they differ"
          }
        })
        .join('');
    },
    // Puts every changed file back as it was at the checkpoint, then forgets the
    // checkpoint (the next /undo goes one further back).
    undo(cp: Checkpoint): Change[] {
      const c = changes(cp);
      for (const { file, how } of c.list) {
        const p = path.join(root, file);
        if (how === 'added') fs.rmSync(p, { force: true });
        else {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, cp.tree ? execFileSync('git', ['cat-file', 'blob', `${cp.tree}:${file}`], { cwd: root, maxBuffer: 256e6 }) : fs.readFileSync(path.join(dir, String(cp.id), file)));
        }
      }
      if (cp.tree) git(['update-ref', '-d', `refs/rime/checkpoints/${cp.id}`]);
      fs.rmSync(path.join(dir, String(cp.id)), { recursive: true, force: true });
      store(load().filter((x) => x.id !== cp.id));
      return c.list;
    },
  };
}
export type Checkpoints = ReturnType<typeof createCheckpoints>;
