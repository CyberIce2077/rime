# How Rime works

## The prompt cache

Every provider, local ones included, can skip work it has already seen at the
start of a prompt. Rime builds every request so that start stays the same:

1. **Tools**, in a fixed order.
2. **The system prompt**, including a map of the repository, built once when the
   conversation starts.
3. **Messages**, append-only. Earlier turns, including the model's reasoning,
   are sent back unchanged.

Nothing in the first two changes during a conversation: no timestamps, no
unsorted JSON, and no tools added halfway. Settings that would change them apply
from the next conversation. Each turn shows how many tokens came from the cache
(`/usage` has the totals and the cost they saved).

How the cache is used depends on the provider: Anthropic gets explicit
`cache_control` breakpoints, OpenAI-style hosts cache by themselves, OpenRouter
passes it to the model's host, and llama.cpp gets the conversation pinned to one
slot (`id_slot`).

## Tools

The system prompt is small, and the model gets a short list of tools:

| Tool | Does |
|---|---|
| `read` | a file, 200 numbered lines at a time, or a short summary of a long one |
| `search` | the project's code by words or name, up to 20 ranked `path:line` hits |
| `write` | create or replace a file |
| `edit` | replace one exact piece of text that appears once |
| `bash` | a shell command in the project; long-running ones go to the run view |
| `ask` | one question with 2–4 options, instead of ending a reply on a question |
| `rime` | change Rime itself: settings, the panel, the task's plan |

Every output is capped: reads by line range, commands to their start and end,
and ANSI colour codes stripped.

## Settings without restarting

Every key, command and setting is also an action of the `rime` tool, so you can
ask in plain words ("turn reasoning off", "show the diff"). Short, exact phrases
like `effort high` or `run the tests` are handled in code with no AI call.

Each change shows when it applies (now, from the next message, from the next
task, or from the next conversation) and can be undone. Rime watches
`~/.rime/config`, so two Rime windows stay in step.

## Conversations

`rime` always reopens the project's last conversation. Everything is written to
`~/.rime/rime.db` (SQLite) as it happens, so quitting is instant. A reply cut off
by quitting comes back with "continue". `←` on an empty prompt lists the
project's conversations to search, open, rename, fork or delete.

## Files Rime keeps

| Where | What |
|---|---|
| `~/.rime/config` | providers, models, your settings and rules (JSON, mode `0600`) |
| `~/.rime/rime.db` | every conversation and its timeline |
| `<project>/.rime/index.db` | the code index behind `search` and the repo map |
| `<project>/.rime/checkpoints/` | snapshots for `/undo` and the changes view |
| `<project>/.rime/cache/` | summaries of long files, so the same file isn't summarised twice |
| `<project>/.rime/attachments/` | files dropped or pasted into the prompt |
| `<project>/.rime/permissions.json` | the project's rules (the only file meant to be committed) |

Rime puts a `.gitignore` in `.rime/` that keeps everything but
`permissions.json` out of git.

In a git repo a checkpoint is a snapshot of the whole working tree, stored as a git
tree under `refs/rime/`. Your index, `HEAD` and branches are never touched.
Outside git, Rime copies each file before its first change.

## Plug-ins

The core is in `src/core/`. Everything else is a plug-in under `src/plugins/`:

| Plug-in | Does |
|---|---|
| `code-index` | indexes the project in SQLite (FTS5 chunks plus declarations for TS/JS, Python, Go and Rust) for `search`, the repo map and `@symbol` |
| `diff-undo` | checkpoints before each turn's first change, behind `/undo` |
| `panel` | the panel's views: changes, run, files |
| `token-kit` | the token meter, `/compact` and clearing old tool output |
| `updater` | `rime update` and `/update` |

## Environment variables

| Variable | Does |
|---|---|
| `NO_COLOR` | no colour |
| `RIME_NO_ANIMATION=1` | no snowfall or loader animation |
| `RIME_NO_UPDATE_CHECK=1` | don't check npm for a new version |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, … | provider keys (see [providers](providers.md)) |
