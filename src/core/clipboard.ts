// Puts text on the system clipboard: pbcopy / clip, or on Linux wl-copy, xclip or
// xsel. Over SSH, and when none of those work, OSC 52 (most terminals honour it;
// Terminal.app and GNOME Terminal don't). Resolves false when only OSC 52 was
// left and it may have gone nowhere.

import { spawn } from 'node:child_process';

const TOOLS = process.platform === 'darwin' ? [['pbcopy']] : process.platform === 'win32' ? [['clip']] : [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '-b']];

const run = ([cmd, ...args]: string[], text: string) =>
  new Promise<boolean>((resolve) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
    p.stdin.on('error', () => {});
    p.stdin.end(text);
  });

export async function copy(text: string, write: (s: string) => void): Promise<boolean> {
  const osc = () => write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
  if (process.env.SSH_TTY || process.env.SSH_CONNECTION) return osc(), true;
  for (const t of TOOLS) if (await run(t, text)) return true;
  osc();
  return process.platform !== 'linux';
}
