// ~/.rime/config: JSON that Rime writes and owns (docs/providers.md §2.4). Users
// never have to edit it; /setup, /connect and /model change it. Keys never live in
// the project folder, and the file is written with mode 0600.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Effort, Price } from '../providers/types.ts';

export type Step = 'wake' | 'connect' | 'tunnel' | 'start' | 'load' | 'warm' | 'test';

export type ProviderConfig = {
  preset: string;
  url?: string | string[]; // a list is tried in order ("alias or IP")
  key?: string;
  keyEnv?: string;
  // An own server reached over ssh (gpubox):
  ssh?: string;
  tunnel?: { remote: string };
  wake?: { mac: string; broadcast?: string };
  model?: string; // the model to load on it
  steps?: Partial<Record<Step, string>>; // only steps the user edited
  skip?: Step[];
  onQuit?: 'keep' | 'stop' | 'poweroff';
  saveCache?: boolean;
  probe?: { build?: string; slots?: number; ctx?: number; effortSafe?: boolean; reasoningSafe?: boolean };
};

export type ModelConfig = {
  label?: string;
  context?: number;
  price?: Price;
  efforts?: Partial<Record<Effort | 'off', string>>;
  budgets?: Partial<Record<Effort, number>>;
  vision?: boolean;
};

export type Config = {
  providers: Record<string, ProviderConfig>;
  models: Record<string, ModelConfig>;
  model?: string; // a model ref "provider/id"; "auto" arrives with the router
  effort?: Effort;
  reasoning?: boolean;
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[] }; // your rules (SPEC §17)
};

export const CONFIG_PATH = path.join(os.homedir(), '.rime', 'config');

export function loadConfig(file = CONFIG_PATH): Config {
  let raw: any = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Could not read ${file}: ${(e as Error).message}`);
  }
  const cfg: Config = { providers: raw.providers ?? {}, models: raw.models ?? {}, model: raw.model, effort: raw.effort, reasoning: raw.reasoning, ...(raw.permissions ? { permissions: raw.permissions } : {}) };
  // Old files: a top-level apiKey was Anthropic's.
  if (raw.apiKey && !cfg.providers.anthropic) cfg.providers.anthropic = { preset: 'anthropic', key: raw.apiKey };
  return cfg;
}

export function saveConfig(cfg: Config, file = CONFIG_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
