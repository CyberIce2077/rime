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

Every key has one meaning, and only keys every keyboard has are used. `?` shows them all.

| Key | Does |
|---|---|
| `enter` | send |
| `ctrl+j` | new line (`shift+enter` too, where the terminal reports it) |
| `ctrl+a` `ctrl+e` | start / end of the line |
| `ctrl+w` `ctrl+k` | delete a word / to the end of the line |
| `ctrl+c` | clear the prompt (`ctrl+y` brings it back), or stop what is running |
| `ctrl+v` | paste an image from the clipboard |
| `/` | commands |
| `@` | attach a file or folder from the project |
| `tab` | take the suggestion shown in dim text |
| `shift+tab` | permission mode: ask · auto-edit · plan |
| `↑ ↓` | your earlier prompts |
| `ctrl+r` | search your earlier prompts |
| `ctrl+u` `ctrl+d` | scroll the conversation up / down |
| `ctrl+o` | show the model's thinking |
| `←` | your conversations (on an empty prompt) |
| `esc` | stop the reply, or close what is open |
| `ctrl+g` | to the panel and back |
| `ctrl+c` twice | quit |

| Command | Does |
|---|---|
| `/new` | start a new conversation |
| `/chats` | this project's conversations: search, open, rename, delete |
| `/model` | pick a model, effort and reasoning |
| `/setup` | connect your own server, this computer, or a provider |
| `/settings` | every setting, applied right away (permissions too) |
| `/panel` | the panel, or one view: `/panel review`, `plan`, `checks`, `run`, `git`, `files`, `context`, `log`, or `hide` |
| `/undo` | put back the files Rime changed in its last turn |
| `/compact` | summarise the earlier conversation to free context |
| `/usage` | tokens, cost and cache savings |
| `/exit` | quit |

`/server` (your own server) and `/update` (when there is one) join the list when they
apply. The older names still work: `/clear`, `/conversations`, `/connect`, `/diff`.

There are no sessions to manage: `rime` always reopens the project's last conversation,
and everything is saved as it happens, so quitting is instant. `/new` starts a new one.

Suggestions come from your project and your history, never from an extra AI call: an
empty prompt shows `Try "…"` with a real file from the project, after a reply Rime
suggests the next step ("run the tests", "commit this"), and as you type, earlier
prompts complete in dim text. `tab` takes any of them.

### The panel

`ctrl+g` opens the panel beside the chat and moves the keys to it; `ctrl+g` again goes
back. Each view has a number; drag a tab in the tab bar to put the views in your own
order (Rime remembers it), and the numbers follow:

| | View | What it shows | Its keys |
|---|---|---|---|
| 1 | review | Rime's changes this session, hunk by hunk | `y` keep · `u` undo the hunk · `a` keep all · `enter` ask about a line · `n` `p` next, previous hunk |
| 2 | plan | Rime's steps for a longer task | `enter` done · `a` add · `x` drop · `k` `j` move |
| 3 | checks | your type check, lint and tests, with problems as file:line | `r` run · `w` watch · `enter` open |
| 4 | run | every command Rime runs, your shells, and dev servers | `n` new shell · `r` rerun · `x` stop · `o` open the address |
| 5 | git | branch, staged and changed files, recent commits | `s` stage · `enter` diff · `c` commit (empty: Rime writes the message) |
| 6 | files | the project tree, name and text search, a viewer | `/` search · `enter` open or fold · `@` attach |
| 7 | context | what the model sees and what it costs | `enter` show · `x` drop a big result · `s` biggest first |
| 8 | log | each tool call and exactly what came back | `enter` show it in full |

In the panel, `← →` (or `tab`) go to the next or previous view, `1`-`8` jump straight
to one, `↑ ↓` and `enter` work inside it, `esc` steps back and finally to the chat, `z` zooms the panel to the full screen, and `?`
lists the keys. You can also say it: "show the diff", "run the tests", "start the dev
server", "search the files for validate".

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
