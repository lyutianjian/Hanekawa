#!/usr/bin/env node
// Global launcher. Re-execs node with `--import tsx` (same as `npm run dev:tui`)
// so the TypeScript/TSX sources run without a build step. In-process
// `tsx/esm/api` registration is not equivalent: on Node 22+ its load hook also
// intercepts `require()` of package.json and breaks it (src/harness/otlp.ts).
//
// process.cwd() is inherited untouched, so the agent operates on whatever
// directory the command was invoked from and keeps its state in <cwd>/.myagent.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../src/tui/entrypoints/tui.tsx', import.meta.url))
// Resolved from this file, not from the caller's cwd: `--import tsx` alone would
// look for tsx under whatever directory the command was run in.
const tsx = import.meta.resolve('tsx')
// Same reason: tsx discovers tsconfig.json from the cwd, so from any other
// directory it would miss `"jsx": "react-jsx"` and fall back to the classic
// transform, making every component throw `React is not defined`.
const tsconfig = fileURLToPath(new URL('../tsconfig.json', import.meta.url))

const { status, signal } = spawnSync(
  process.execPath,
  ['--import', tsx, entry, ...process.argv.slice(2)],
  { stdio: 'inherit', env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig } },
)

process.exit(signal ? 1 : (status ?? 1))
