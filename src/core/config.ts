// User config: ANTHROPIC_API_KEY wins, then ~/.rime/config (JSON). API key only;
// Rime never uses subscription logins or Claude Code's tokens (SPEC §3).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, type Effort, type Model, findModel } from './models.ts';

export type Config = { apiKey?: string; model: Model; effort: Effort; baseUrl: string };

export const CONFIG_PATH = path.join(os.homedir(), '.rime', 'config');

export function loadConfig(env = process.env, file = CONFIG_PATH): Config {
  let raw: { apiKey?: string; model?: string; effort?: string } = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Could not read ${file}: ${(e as Error).message}`);
  }
  const effort = EFFORTS.includes(raw.effort as Effort) ? (raw.effort as Effort) : DEFAULT_EFFORT;
  return {
    apiKey: env.ANTHROPIC_API_KEY || raw.apiKey,
    model: (raw.model && findModel(raw.model)) || DEFAULT_MODEL,
    effort,
    baseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
  };
}
