# Rime

A small, token-frugal AI coding CLI for the terminal. It runs on any provider you
connect, including your own llama.cpp server at home, and it treats the prompt
cache as sacred so long sessions stay cheap and fast.

Rime reads and writes files and runs commands in your project, asking before each
one, with whichever model you connect. Its mascot is a pixel ice cube that freezes
while your server starts up.

> **Status: early.** Expect rough edges and changes between versions.

## Why

- **Bring your own model.** Anthropic, OpenAI, OpenRouter, DeepSeek, Groq, Mistral,
  Gemini, xAI, Together, Fireworks, or anything that speaks the OpenAI API: llama.cpp,
  Ollama, LM Studio, vLLM. No model is hard-coded; Rime lists what your providers offer.
- **Your own GPU, one keypress away.** Point Rime at a machine in `~/.ssh/config` and it
  wakes it with Wake-on-LAN, opens an ssh tunnel, starts `llama-server`, loads the model,
  and warms the cache, showing every step as a command you can edit or skip.
- **Cache first.** Tools, then the system prompt, then append-only history, byte-identical
  turn after turn. Effort and reasoning only change mid-conversation where Rime has
  checked that it's cache-safe. Each turn shows the cached tokens and what they saved.
- **Small.** Plain `fetch` and two wire formats (Anthropic Messages and OpenAI Chat
  Completions). Every other provider is a few lines of data. No runtime dependencies.

## Install

Rime needs Node 22.13 or newer (for its built-in SQLite), on macOS or Linux. On Windows, run it inside WSL.

```sh
git clone https://github.com/CyberIce2077/rime.git
cd rime
npm install
npm run build
npm link        # puts `rime` on your PATH
```

Then run `rime` in a project folder.

## Getting started

On first start Rime opens `/setup`, which offers three choices:

1. **Your own server.** Pick a host from `~/.ssh/config`. Rime checks that it's
   reachable, reads the llama.cpp service and its models, and runs the steps:
   `wake → connect → tunnel → start → load → warm → test`.
2. **This computer.** Rime finds llama.cpp, Ollama, LM Studio or vLLM on the usual
   local ports.
3. **A provider.** Choose one and paste an API key, or set the provider's
   environment variable instead (such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`).

Rime writes `~/.rime/config` itself (mode `0600`), so you never need to edit it.
To add a server from a script, run:

```sh
rime connect http://localhost:8080 --name local
```

## Using it

| Key | Does |
|---|---|
| `enter` | send |
| `ctrl+j` | new line (`shift+enter` too, where the terminal reports it) |
| `esc` | stop the reply, go back one screen, or close a box |
| `ctrl+c` | cancel what is open or running, or clear the prompt |
| `ctrl+y` | bring back what `ctrl+c`, `ctrl+u`, `ctrl+k` or `ctrl+w` removed |
| `↑ ↓` | your earlier prompts (`esc` goes back to what you were typing) |
| `tab` | take the suggestion shown in dim text |
| `@` | attach a file or folder from the project |
| `ctrl+r` | search your earlier prompts |
| `option+⌫` `ctrl+w` | delete the word before the cursor |
| `ctrl+u` `ctrl+d` | scroll the conversation (on an empty prompt); `esc` jumps to the end |
| `ctrl+v` | paste an image from the clipboard |
| `shift+tab` | permission mode: ask · auto-edit · plan |
| `ctrl+g` | split view: files, shells, servers, the browser or design beside the chat; `ctrl+g` moves between the chat and the panel. In the panel: `space` tabs, `:` commands, `/` search, `?` its keys |
| `←` | your conversations (on an empty prompt) |
| `/` | commands |
| `?` | shortcuts |
| `ctrl+c` twice | quit (only when nothing is open) |

| Command | Does |
|---|---|
| `/model` | pick a model, grouped by provider, plus effort and reasoning |
| `/setup` | connect your own server, this computer, or a provider |
| `/server` | status and controls for your server: load, restart, stop, power off |
| `/connect` | add a provider or URL directly |
| `/settings` | every setting, applied right away, with undo |
| `/permissions` | permission mode and allow / ask / deny rules |
| `/conversations` | this project's conversations |
| `/usage` | tokens, cost and cache savings |
| `/panel` | show or hide split view (where a terminal takes `ctrl+g`): `/panel files`, `shell`, `diff` or `hide` |
| `/clear` | start a new conversation |
| `/exit` | quit |

There are no sessions to manage: `rime` always reopens the project's last conversation,
and everything is saved as it happens, so quitting is instant. `/clear` starts a new one.

Suggestions come from your project and your history, never from an extra AI call: an
empty prompt shows `Try "…"` with a real file from the project, after a reply Rime
suggests the next step ("run the tests", "open index.html in the browser", "commit
this"), and as you type, earlier prompts complete in dim text. `tab` takes any of them.

Drag a file, folder, screenshot or video onto the terminal, or paste a long log, and it
becomes a chip in the prompt. Put the cursor on a chip or point at it to see exactly what
the model will get; the line under the prompt sums up the whole message.

To copy text, drag to select it; Rime copies the selection when you let go (on Linux
with `wl-copy`, `xclip` or `xsel`; without them, shift+drag selects with your terminal).
Set `NO_COLOR` to turn colour off, or `RIME_NO_ANIMATION=1` to skip the snowfall.

## Asking first

Rime asks before every command and every file edit, showing the exact command or
change: **yes**, **yes and don't ask again** for that kind of command in this
conversation, or **no, and tell Rime what to do instead**. Read-only commands like
`ls` or `git diff` run without asking, and chained commands are checked part by part.

| Mode | What asks |
|---|---|
| ask (default) | every command and every edit |
| auto-edit | commands only |
| plan | nothing runs: read-only, Rime answers with a plan |
| auto | only risky commands (`sudo`, `rm -rf`, force push, writes outside the project) |
| god mode | nothing; only your own deny rules still block |

`shift+tab` cycles ask, auto-edit and plan. Auto and god mode are chosen in
`/permissions`, which also lists the allow / ask / deny rules and recent decisions.

## Privacy and keys

Rime uses API keys only, read from the provider's environment variable or from
`~/.rime/config`. It never uses consumer logins (claude.ai, ChatGPT) and never
reads another app's tokens. A local server needs no key.

## Development

```sh
npm run dev         # run from source
npm test            # node:test, against a mock llama.cpp server and a fake ssh
npm run typecheck
npm run build       # bundles to dist/rime.js with tsup
```

```
src/
  cli.ts           entry point and `rime connect`
  core/            full-screen app, tools, permissions, prompt, conversations (rime.db)
  providers/       Anthropic and OpenAI wire formats, presets, llama.cpp, probe
  setup/           /setup, /server, ssh, tunnel, Wake-on-LAN, the loader
  plugins/         token meter (more plug-ins to come)
test/              node:test suites, a mock llama.cpp server and a fake ssh
```

## License

[MIT](LICENSE)
