import pkg from '../package.json' with { type: 'json' };
import { runApp } from './core/app.ts';
import { loadConfig } from './core/config.ts';
import { renderHeader } from './core/header.ts';

const args = process.argv.slice(2);

if (args.includes('-v') || args.includes('--version')) {
  console.log(pkg.version);
} else if (args.includes('-h') || args.includes('--help')) {
  console.log(`rime ${pkg.version}

usage: rime          start a session in this directory
       rime -v       print the version

Set ANTHROPIC_API_KEY, or put {"apiKey": "sk-ant-…"} in ~/.rime/config.`);
} else {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error(`rime: ${(e as Error).message}`);
    process.exit(1);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const details = `${cfg.model.context} context · ${cfg.effort} effort`;
    console.log(['', ...renderHeader({ version: pkg.version, model: cfg.model.label, details }), ''].join('\n'));
    console.error('rime: needs an interactive terminal');
    process.exit(1);
  }
  await runApp(cfg, pkg.version);
}
