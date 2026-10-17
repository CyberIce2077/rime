# Providers and models

Rime talks to every provider with plain `fetch` in one of two wire formats:
Anthropic Messages or OpenAI Chat Completions. Each provider below is a few lines
of data in `src/providers/presets.ts`; anything else that speaks the OpenAI API
works through the generic preset.

## Connecting one

Run `/setup` inside Rime and pick **a provider**, **this computer** or **your own
server**. Rime checks the connection, lists the models it offers and writes
`~/.rime/config` for you. For a hosted provider you can paste a key, or set its
environment variable first and Rime finds it.

From a script or another shell:

```sh
rime connect http://localhost:8080 --name local
rime connect https://api.example.com/v1 --key-env EXAMPLE_API_KEY
echo "$KEY" | rime connect https://api.example.com/v1 --key -
```

`--key-env` saves the variable's name, never its value. `--key -` reads the key
from stdin, so it doesn't land in your shell history.

## Presets

| Preset | Key variable | Default URL | Prompt cache |
|---|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `https://api.anthropic.com` | explicit breakpoints |
| `openai` | `OPENAI_API_KEY` | `https://api.openai.com/v1` | automatic |
| `openrouter` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` | passed to the model's host |
| `deepseek` | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` | automatic |
| `groq` | `GROQ_API_KEY` | `https://api.groq.com/openai/v1` | |
| `mistral` | `MISTRAL_API_KEY` | `https://api.mistral.ai/v1` | |
| `gemini` | `GEMINI_API_KEY` | `https://generativelanguage.googleapis.com/v1beta/openai` | automatic |
| `xai` | `XAI_API_KEY` | `https://api.x.ai/v1` | automatic |
| `together` | `TOGETHER_API_KEY` | `https://api.together.xyz/v1` | |
| `fireworks` | `FIREWORKS_API_KEY` | `https://api.fireworks.ai/inference/v1` | |
| `llamacpp` | `LLAMA_API_KEY` (optional) | `http://localhost:9931/v1` | pinned slots |
| `ollama` | none | `http://localhost:11434/v1` | automatic |
| `lmstudio` | none | `http://localhost:1234/v1` | automatic |
| `vllm` | none | `http://localhost:8000/v1` | automatic |
| `generic` | any | the URL you give | |

**This computer** in `/setup` looks for a server on ports 8080, 9931, 11434, 1234
and 8000.

## Models

No model is built in. Rime reads `/v1/models` from each provider you connect,
and a model is named `provider/id`, for example `anthropic/claude-sonnet-5-5` or
`local/qwen3.8-32b`. Pick one with `/model`, or type `use <name>` at the prompt.

A conversation keeps its model for the whole task: switching mid-task would
throw away the prompt cache. A new model takes effect from the next task.

### Effort and reasoning

Rime uses one scale for every provider: **reasoning** `on` or `off`, and
**effort** `low`, `medium`, `high` or `max`. Each preset maps these to its own
field (`reasoning_effort`, OpenRouter's `reasoning.effort`, Ollama's `think`,
vLLM's `chat_template_kwargs`, llama.cpp's template options). Providers with no
such field get neither.

Both can change between messages, from `/model`, `/settings`, or by typing
`effort high` or `reasoning off`. On llama.cpp, Rime first checks that the server
keeps its cache across the change; if it doesn't, the change waits for the next task.

## Keys

Rime uses API keys only: the provider's environment variable, or a key saved in
`~/.rime/config` (mode `0600`). It never signs in with a consumer account
(claude.ai, ChatGPT) and never reads another app's tokens. A local server needs
no key. The `rime` tool the model uses can change settings but can never read or
write a key.

Commands the model runs don't see variables that look secret (names ending in
`KEY` or `TOKEN`, or containing `SECRET`, `PASSW` or `CREDENTIAL`). To pass one
through, set it to `passed` under **Commands** in `/settings`.
