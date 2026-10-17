# Permissions

By default Rime asks before every command and every file edit, showing exactly
what will run or change. You answer:

- **Yes**
- **Yes, don't ask again** for this kind of command in this conversation
- **No, and tell Rime what to do instead**

## Modes

`shift+tab` cycles the first three. Auto and god mode are only set in
`/permissions`.

| Mode | What asks |
|---|---|
| ask (default) | every command and every edit |
| auto-edit | commands only; edits apply without asking |
| plan | nothing runs: read-only, Rime answers with a plan |
| auto | only the always-ask list below; other commands run in a sandbox |
| god | nothing; only your deny rules still block |

In auto mode, commands run in a sandbox that can write only inside the project,
the temp folders and a few package caches. It can't write `.git/config`,
`.git/hooks` or `.rime/`. macOS uses `sandbox-exec`. On Linux, install
bubblewrap (`bwrap`); without it Rime warns that commands aren't contained.

## What never asks

Reading or searching inside the project, and these read-only commands:
`ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `rg`, `grep`, `find`, `git status`,
`git diff`, `git log`, `git show`. Rime still asks when one of them writes a file
(`>`, `tee`, `find -delete`), runs another program (`$(…)`, `find -exec`), or
reads a path outside the project.

## What always asks

These ask in every mode except god, and no allow rule covers them:

- `sudo` and `doas`
- `rm -rf`
- a force push (`git push --force`, `-f`, `+branch`, `--mirror`)
- sending files off the machine (`scp`, `rsync`, `nc`, `curl` uploads, …)
- writing outside the project
- changing Rime's or git's settings in the project

## Chained commands

`npm test && rm -rf build` is checked part by part. Rime unwraps `env`,
`nohup`, `timeout`, `xargs`, `VAR=value` and full program paths first, so an allow
rule for `npm test` never lets `rm -rf` through.

## Rules

Rules are `tool(pattern)`. **deny** beats **ask**, which beats **allow**.

```
bash(npm test)        exactly `npm test`
bash(npm test *)      `npm test` with any arguments
edit(src/**)          any file under src/ (also covers write)
read(*.md)            Markdown files in the project root
read(~/.ssh/**)       an absolute path: starts with / or ~
```

Paths are globs relative to the project: `*` stays within a folder and `**`
crosses folders.

Rules come from three places:

- **Yours**, in `~/.rime/config`, for every project.
- **The project's**, in `.rime/permissions.json`, which you can commit so a team
  shares them:

  ```json
  {
    "allow": ["bash(npm test *)", "bash(npm run build)"],
    "deny": ["edit(.env*)"]
  }
  ```

  A cloned repo could bring its own allow rules, so they count only after you
  accept that exact file. If it changes, Rime asks again. Deny and ask rules
  always count, since they only make Rime more careful.
- **This conversation's**, added by "Yes, don't ask again".

`/permissions` lists every rule with where it came from, and lets you add or
remove rules.
