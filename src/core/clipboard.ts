// Puts text on the system clipboard: pbcopy / clip where they exist, otherwise
// OSC 52 (works over SSH in most terminals; Terminal.app ignores it).

import { spawn } from 'node:child_process';

export function copy(text: string, write: (s: string) => void) {
  const cmd = process.platform === 'darwin' ? 'pbcopy' : process.platform === 'win32' ? 'clip' : null;
  if (!cmd) return write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
  const p = spawn(cmd, [], { stdio: ['pipe', 'ignore', 'ignore'] });
  p.on('error', () => write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`));
  p.stdin.end(text);
}
