// Providers are data (docs/providers.md §2.3). Every one speaks one of two wire
// formats; anything else that speaks them works with the generic `openai` preset.
// ponytail: base URLs and key variables were taken from the design note, verify each
// against its provider's docs when that provider is first used for real.

import type { CacheMode, Wire } from './types.ts';

export type Preset = {
  label: string;
  wire: Wire;
  url: string;
  keyEnv?: string;
  local?: boolean;
  cache?: CacheMode;
  llamacpp?: boolean;
  effortField?: string;
};

export const PRESETS: Record<string, Preset> = {
  anthropic: { label: 'Anthropic', wire: 'anthropic', url: 'https://api.anthropic.com', keyEnv: 'ANTHROPIC_API_KEY', cache: 'explicit' },
  openai: { label: 'OpenAI', wire: 'openai', url: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', cache: 'auto' },
  openrouter: { label: 'OpenRouter', wire: 'openai', url: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', cache: 'passthrough', effortField: 'reasoning.effort' },
  deepseek: { label: 'DeepSeek', wire: 'openai', url: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY', cache: 'auto' },
  groq: { label: 'Groq', wire: 'openai', url: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY' },
  mistral: { label: 'Mistral', wire: 'openai', url: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY' },
  gemini: { label: 'Gemini', wire: 'openai', url: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY', cache: 'auto' },
  xai: { label: 'xAI', wire: 'openai', url: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', cache: 'auto' },
  together: { label: 'Together', wire: 'openai', url: 'https://api.together.xyz/v1', keyEnv: 'TOGETHER_API_KEY' },
  fireworks: { label: 'Fireworks', wire: 'openai', url: 'https://api.fireworks.ai/inference/v1', keyEnv: 'FIREWORKS_API_KEY' },
  llamacpp: { label: 'llama.cpp', wire: 'openai', url: 'http://localhost:9931/v1', keyEnv: 'LLAMA_API_KEY', local: true, cache: 'slots', llamacpp: true },
  ollama: { label: 'Ollama', wire: 'openai', url: 'http://localhost:11434/v1', local: true, cache: 'auto' },
  lmstudio: { label: 'LM Studio', wire: 'openai', url: 'http://localhost:1234/v1', local: true, cache: 'auto' },
  vllm: { label: 'vLLM', wire: 'openai', url: 'http://localhost:8000/v1', local: true, cache: 'auto' },
  // Any other OpenAI-compatible endpoint (`/connect <url>`).
  generic: { label: 'OpenAI-compatible', wire: 'openai', url: '' },
};

// The hosted providers offered in /setup, in the order shown.
export const HOSTED = ['openrouter', 'openai', 'anthropic', 'deepseek', 'groq', 'mistral', 'gemini', 'xai', 'together', 'fireworks'];
