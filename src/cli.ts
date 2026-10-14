import fs from 'node:fs';
import pkg from '../package.json' with { type: 'json' };
import { runApp } from './core/app.ts';
import { loadConfig, saveConfig } from './core/config.ts';
import { renderHeader } from './core/header.ts';
import { probe } from './providers/probe.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function load() {
  try {
    return loadConfig();
  } catch (e) {
    console.error(`rime: ${(e as Error).message}`);
    process.exit(1);
  }
}

// `rime connect <url> [--key-env VAR | --key -] [--name NAME]`: /connect for
// scripts. The key comes from an environment variable (saved as its name, never
// its value) or from stdin, so it stays out of shell history.
async function connect(url: string) {
  const keyEnv = opt('--key-env');
  const raw = opt('--key');
  const key = keyEnv ? process.env[keyEnv] : raw === '-' ? fs.readFileSync(0, 'utf8').trim() : raw;
  if (keyEnv && !key) return console.error(`rime: ${keyEnv} is not set`), process.exit(1);
  const p = await probe(url, key);
  if (!p) return console.error(`rime: nothing answered at ${url}`), process.exit(1);
  if (p.needKey) return console.error(`rime: ${url} needs an API key (--key-env VAR, or --key - to read it from stdin)`), process.exit(1);
  const cfg = load();
  const host = new URL(p.base).hostname;
  const name = opt('--name') ?? (host === 'localhost' || host === '127.0.0.1' ? 'local' : /^[\d.]+$/.test(host) ? 'server' : host.split('.')[0]);
  const preset = p.kind === 'openai' ? 'generic' : p.kind;
  cfg.providers[name] = { preset, url: p.base, ...(keyEnv ? { keyEnv } : key ? { key } : {}) };
  const models = (p.server ?? p.models).map((m) => m.id);
  if (!cfg.model && models[0]) cfg.model = `${name}/${models[0]}`;
  saveConfig(cfg);
  console.log(`connected ${name} (${preset}${p.build ? ` ${p.build}` : ''}) at ${p.base}`);
  for (const m of models) console.log(`  ${name}/${m}`);
  for (const w of p.warnings) console.log(`  ! ${w}`);
}

if (args.includes('-v') || args.includes('--version')) {
  console.log(pkg.version);
} else if (args.includes('-h') || args.includes('--help')) {
  console.log(`rime ${pkg.version}

usage: rime                    start a session in this directory
       rime connect <url>      add an OpenAI-compatible or llama.cpp server
            [--key-env VAR | --key -] [--name NAME]
                               (--key - reads the key from stdin)
       rime -v                 print the version

Inside Rime, /setup connects your own server, this computer, or a provider.`);
} else if (args[0] === 'connect') {
  if (!args[1]) console.error('usage: rime connect <url> [--key-env VAR | --key -] [--name NAME]'), process.exit(1);
  await connect(args[1]);
} else {
  const cfg = load();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(['', ...renderHeader({ version: pkg.version, model: cfg.model?.split('/').slice(1).join('/'), details: cfg.model ? cfg.model.split('/')[0] : 'no model connected' }), ''].join('\n'));
    console.error('rime: needs an interactive terminal');
    process.exit(1);
  }
  await runApp(cfg, pkg.version);
}
