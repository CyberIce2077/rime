# Rime

A minimal, token-frugal AI coding CLI for the terminal, on your own Anthropic API key.

```sh
npm install
npm run build        # bundles to dist/rime.js
./dist/rime.js       # or: npm link && rime
npm run dev          # run from source (Node 22.6+)
npm test
```

Set `ANTHROPIC_API_KEY`, or put `{"apiKey": "sk-ant-…"}` in `~/.rime/config`.
`RIME_NO_ANIMATION=1` skips the snowfall; `NO_COLOR` turns colour off.

Spec: `docs/SPEC.md` · decisions: `docs/DECISIONS.md` · mockups: `reference/`.
