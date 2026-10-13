# Rime

A minimal, token-frugal AI coding CLI for the terminal, on your own Anthropic API key.

```sh
npm install
npm run build        # bundles to dist/rime.js
./dist/rime.js       # or: npm link && rime
npm run dev          # run from source (Node 22.6+)
npm test
```

The first start opens `/setup`: your own llama.cpp server over ssh (wake, tunnel,
start, load, all from inside Rime), a server on this computer, or a hosted
provider. `rime connect <url>` adds an OpenAI-compatible server from a script.
Rime writes `~/.rime/config` itself. `RIME_NO_ANIMATION=1` skips the snowfall;
`NO_COLOR` turns colour off.

Spec: `docs/SPEC.md` and `docs/providers.md` · decisions: `docs/DECISIONS.md` · mockups: `reference/`.
