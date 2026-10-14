// Self-update (SPEC §4.3, §10, Phase 9): a background look at npm for a newer
// version, installed next to the running one in ~/.rime/versions/<v>/, and a tiny
// launcher: the installed `rime` hands over to the newest version found there, so
// an update never swaps code in a running process, and removing a folder rolls
// back.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VERSIONS = path.join(os.homedir(), '.rime', 'versions');
const KEEP = 3;

// 1.10.0 > 1.9.2; a pre-release (1.0.0-beta.1) sorts before its release.
export function compare(a: string, b: string): number {
  const [ma, pa = ''] = a.replace(/^v/, '').split('-'), [mb, pb = ''] = b.replace(/^v/, '').split('-');
  const x = ma.split('.').map(Number), y = mb.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  if (pa === pb) return 0;
  return !pa ? 1 : !pb ? -1 : pa < pb ? -1 : 1;
}

// The registry's latest version and its three change lines (`rime.changes` in the
// published package.json). null when npm can't be reached.
export async function latest(name: string, registry = (process.env.npm_config_registry || 'https://registry.npmjs.org').replace(/\/$/, ''), timeout = 3000): Promise<{ version: string; changes: string[] } | null> {
  try {
    const r = await fetch(`${registry}/${encodeURIComponent(name).replace('%40', '@')}/latest`, { signal: AbortSignal.timeout(timeout) });
    if (!r.ok) return null;
    const j = (await r.json()) as { version?: string; rime?: { changes?: unknown } };
    if (typeof j.version !== 'string') return null;
    const c = j.rime?.changes;
    return { version: j.version, changes: Array.isArray(c) ? c.map(String).slice(0, 3) : [] };
  } catch {
    return null;
  }
}

// Versions installed under ~/.rime/versions, newest first: each one's entry file.
export function installed(name: string, dir = VERSIONS): { version: string; entry: string }[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((v) => ({ version: v, entry: path.join(dir, v, 'node_modules', name, 'dist', 'rime.js') }))
    .filter((x) => /^\d+\.\d+\.\d+/.test(x.version) && fs.existsSync(x.entry))
    .sort((a, b) => compare(b.version, a.version));
}

// The launcher's pick: the newest installed version above the running one.
export const newest = (name: string, current: string, dir = VERSIONS) => installed(name, dir).find((x) => compare(x.version, current) > 0) ?? null;

// Runs that version in this terminal and returns its exit code.
export function launch(entry: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [entry, ...args], { stdio: 'inherit', env: { ...process.env, RIME_LAUNCHED: '1', ...env } }).status ?? 0;
}

// npm install into ~/.rime/versions/<v>/ (a half-done folder never counts: the
// entry file is the last thing there), then only the newest few are kept.
export function install(name: string, version: string, dir = VERSIONS, npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'): Promise<{ ok: boolean; error?: string }> {
  const to = path.join(dir, version);
  fs.mkdirSync(to, { recursive: true });
  return new Promise((resolve) => {
    let err = '';
    const p = spawn(npm, ['install', '--prefix', to, '--no-audit', '--no-fund', '--loglevel=error', `${name}@${version}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false, error: err.trim().split('\n').at(-1) || `npm exited ${code}` });
      for (const old of installed(name, dir).slice(KEEP)) fs.rmSync(path.dirname(path.dirname(path.dirname(path.dirname(old.entry)))), { recursive: true, force: true });
      resolve({ ok: true });
    });
  });
}
