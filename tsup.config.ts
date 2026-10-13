import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { rime: 'src/cli.ts' },
  format: 'esm',
  target: 'node22',
  platform: 'node',
  bundle: true,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  removeNodeProtocol: false, // node:sqlite only exists with the prefix
});
