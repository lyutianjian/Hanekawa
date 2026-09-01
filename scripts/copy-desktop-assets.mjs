#!/usr/bin/env node
/**
 * Copy non-TypeScript assets (the renderer's `index.html`, `styles.css`,
 * `fonts.css`, and the `fonts/` webfont directory) into the build output after
 * `tsc` and `esbuild` finish. Two prior stages of `npm run build:desktop`
 * already wrote the compiled `.js` files; this script makes the corresponding
 * `.html` available where `desktop/main.ts` reads it
 * (`<dest>/desktop/renderer/index.html`), and everything the HTML links beside
 * it — `loadFile` resolves `./styles.css`, `./fonts.css`, and the
 * `./fonts/*.woff2` referenced by the sheet and the preload tags relative to
 * the page, so a missing copy is an unstyled or fallback-font window rather
 * than a build error.
 *
 * Single files go through the `sources` list (`[from, to]` pairs); whole
 * trees go through `directories` and are mirrored with
 * `cpSync(from, to, { recursive: true })` — Node 22 native, no new dependency.
 *
 * Kept as a standalone file rather than an `npm run` chain to avoid quoting
 * headaches on Windows where `&&` inside JSON script strings is fussy and `cp`
 * is not a builtin.
 *
 * Usage: `node scripts/copy-desktop-assets.mjs [destRoot]`
 *
 * `destRoot` defaults to `<repo>/dist`. It is a parameter because the source
 * path has to stay anchored to this file (so the script works from any cwd)
 * while the destination must be redirectable — `test/desktopBuild.test.ts`
 * builds into a temp directory, and a script that always wrote into the repo's
 * `dist/` would both miss the assertion and scribble on a directory another
 * test file is rebuilding in a sibling process.
 */
import { copyFileSync, cpSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const destRoot = process.argv[2] ? resolve(process.argv[2]) : join(repoRoot, 'dist')

const sources = [
  ['src/desktop/renderer/index.html', 'desktop/renderer/index.html'],
  ['src/desktop/renderer/styles.css', 'desktop/renderer/styles.css'],
  ['src/desktop/renderer/fonts.css', 'desktop/renderer/fonts.css'],
]

const directories = [['src/desktop/renderer/fonts', 'desktop/renderer/fonts']]

for (const [from, to] of sources) {
  const absoluteFrom = join(repoRoot, from)
  const absoluteTo = join(destRoot, to)
  mkdirSync(dirname(absoluteTo), { recursive: true })
  copyFileSync(absoluteFrom, absoluteTo)
  console.log(`copied ${from} -> ${absoluteTo}`)
}

for (const [from, to] of directories) {
  const absoluteFrom = join(repoRoot, from)
  const absoluteTo = join(destRoot, to)
  mkdirSync(dirname(absoluteTo), { recursive: true })
  cpSync(absoluteFrom, absoluteTo, { recursive: true })
  console.log(`copied ${from}/ -> ${absoluteTo}`)
}
