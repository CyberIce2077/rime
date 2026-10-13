// User config: ANTHROPIC_API_KEY wins, then ~/.rime/config (JSON). API key only;
// Rime never uses subscription logins or Claude Code's tokens (SPEC §3).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Model, findModel } from './models.ts';

// No model unless the config file names one; nothing is picked for you.
export type Config = { apiKey?: string; model?: Model; baseUrl: string };

export const CONFIG_PATH = path.join(os.homedir(), '.rime', 'config');

export function loadConfig(env = process.env, file = CONFIG_PATH): Config {
  let raw: { apiKey?: string; model?: string } = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Could not read ${file}: ${(e as Error).message}`);
  }
  return {
    apiKey: env.ANTHROPIC_API_KEY || raw.apiKey,
    model: raw.model ? findModel(raw.model) : undefined,
    baseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
  };
}
