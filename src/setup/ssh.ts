// ssh for own servers (docs/providers.md §3): list hosts from ~/.ssh/config,
// resolve them with `ssh -G`, run commands, and read what a server has (its MAC,
// the llama-server systemd unit, llama.cpp version, GPU, models preset).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export type Result = { code: number; out: string; err: string };

// Runs a command without a shell. Never throws; a timeout kills it (code 124).
export function run(cmd: string, args: string[], timeoutMs = 15000, input?: string): Promise<Result> {
  return new Promise((resolve) => {
    let out = '', err = '';
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: 127, out, err: e.message });
    });
    p.on('close', (code, signal) => {
      clearTimeout(t);
      resolve({ code: signal ? 124 : (code ?? 1), out, err });
    });
    p.stdin.end(input ?? '');
  });
}

// A user-editable step command runs through the shell, like typing it.
export const shell = (command: string, timeoutMs?: number) => run('sh', ['-c', command], timeoutMs);

export const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5'];
export const ssh = (host: string, remote: string, timeoutMs?: number, input?: string) => run('ssh', [...SSH_OPTS, host, remote], timeoutMs, input);

const CODE_HOSTS = /^(github\.com|gitlab\.com|bitbucket\.org|ssh\.dev\.azure\.com)$/i;

// Host aliases from ~/.ssh/config and the files it Includes (no wildcards).
export function sshHosts(file = path.join(os.homedir(), '.ssh', 'config'), seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const hosts: string[] = [];
  for (const raw of text.split('\n')) {
    const [key, ...rest] = raw.trim().split(/\s+/);
    if (/^include$/i.test(key)) {
      for (const inc of rest) {
        const p = inc.replace(/^~/, os.homedir());
        hosts.push(...sshHosts(path.isAbsolute(p) ? p : path.join(os.homedir(), '.ssh', p), seen));
      }
    } else if (/^host$/i.test(key)) {
      hosts.push(...rest.filter((h) => !/[*?!]/.test(h) && !CODE_HOSTS.test(h)));
    }
  }
  return [...new Set(hosts)];
}

// What ssh would actually use for a host (HostName, User, Port), with no connection.
export async function resolveHost(host: string) {
  const r = await run('ssh', ['-G', host], 5000);
  const get = (k: string) => r.out.match(new RegExp(`^${k} (.+)$`, 'm'))?.[1]?.trim();
  return { hostname: get('hostname') ?? host, user: get('user'), port: Number(get('port') ?? 22) };
}

export function tcpOpen(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ---- reading the server ----

// One round trip: MAC of the default interface, the llama-server unit, its state, GPU.
export const SURVEY = [
  "echo '###MAC'",
  "i=$(ip route show default 2>/dev/null | awk '{print $5; exit}'); [ -n \"$i\" ] && cat /sys/class/net/$i/address",
  "echo '###UNIT'",
  'systemctl cat llama-server 2>/dev/null',
  "echo '###ACTIVE'",
  'systemctl is-active llama-server 2>/dev/null',
  "echo '###GPU'",
  'nvidia-smi --query-gpu=name,memory.total,memory.used,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits 2>/dev/null',
  "echo '###END'",
].join('; ');

export function sections(text: string) {
  const out: Record<string, string> = {};
  let cur = '';
  for (const line of text.split('\n')) {
    const m = /^###(\w+)$/.exec(line.trim());
    if (m) cur = m[1];
    else if (cur) out[cur] = (out[cur] ? out[cur] + '\n' : '') + line;
  }
  return out;
}

// Splits a shell-ish command line, honouring simple quotes.
export function argv(line: string) {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

export type Unit = { bin?: string; router: boolean; host: string; port: number; preset?: string; model?: string; alias?: string; args: string[] };

// The llama-server flags from a `systemctl cat` dump (ExecStart may span lines).
export function parseUnit(text: string): Unit | null {
  const joined = text.replace(/\\\n\s*/g, ' ');
  const exec = joined.split('\n').reverse().find((l) => /^\s*ExecStart=\S/.test(l));
  if (!exec) return null;
  const args = argv(exec.replace(/^\s*ExecStart=[-@+!:]*/, ''));
  const flag = (...names: string[]) => {
    const i = args.findIndex((a) => names.includes(a));
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    bin: args[0],
    router: args.includes('--models-preset') || args.includes('--models-dir'),
    host: flag('--host') ?? '127.0.0.1',
    port: Number(flag('--port') ?? 9931), // llama-server's default port (checked on master)
    preset: flag('--models-preset'),
    model: flag('-m', '--model'),
    alias: flag('-a', '--alias'),
    args,
  };
}

export type Gpu = { name: string; memTotal: number; memUsed: number; temp: number; power: number; powerLimit: number };

export function parseGpu(text: string): Gpu | null {
  const line = text.trim().split('\n')[0];
  if (!line) return null;
  const [name, memTotal, memUsed, temp, power, powerLimit] = line.split(',').map((s) => s.trim());
  return { name, memTotal: +memTotal, memUsed: +memUsed, temp: +temp, power: +power, powerLimit: +powerLimit };
}

// presets.ini: [model-name] sections with llama-server flags as keys.
export function parseIni(text: string) {
  const out: Record<string, Record<string, string>> = {};
  let cur = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[;#].*$/, '').trim();
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) out[(cur = sec[1].trim())] ??= {};
    else if (cur && line.includes('=')) {
      const i = line.indexOf('=');
      out[cur][line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return out;
}

// Second round trip once the unit is known: llama.cpp's version and the preset file.
export function detailsScript(u: Unit) {
  const q = (p: string) => `"${p.replace(/^~/, '$HOME').replace(/"/g, '\\"')}"`;
  return [
    "echo '###VERSION'",
    u.bin ? `${q(u.bin)} --version 2>&1 | head -3` : 'true',
    "echo '###PRESETS'",
    u.preset ? `cat ${q(u.preset)} 2>/dev/null` : 'true',
    "echo '###END'",
  ].join('; ');
}

export const buildOf = (versionText: string) => {
  const m = versionText.match(/version:?\s*b?(\d+)/i);
  return m ? `b${m[1]}` : undefined;
};
