import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  target: 'node24',
  dts: false,
  // Harness owns these services; keep their imports in the built plugin.
  deps: { neverBundle: [/^@deepseek-ai\//] },
})
