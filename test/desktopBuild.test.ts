import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

/**
 * Smoke for the desktop shell build pipeline. Four artifacts must land at the
 * right depths of the output directory:
 *
 *  - `desktop/main.js` — the Node-targeted main process. `electron` is left
 *    external because the running Electron binary provides it.
 *  - `desktop/preload.js` — the preload, CJS with `electron` external.
 *  - `desktop/renderer/app.js` — the browser-shaped renderer; `node:crypto` is
 *    aliased to a small shim so Web Crypto's `randomUUID` stands in.
 *  - `desktop/renderer/index.html` — copied, because `BrowserWindow.loadFile`
 *    needs it beside `app.js`.
 *
 * Note this file bundles `main.ts` with esbuild while `npm run build:desktop`
 * emits it with `tsc`. That is deliberate: esbuild resolving the whole main
 * graph is a cheap check that no import is unresolvable, and
 * `test/distBuild.test.ts` is what pins the real `tsc` output and its depth.
 */

const run = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const esbuildEntry = join(repoRoot, 'node_modules', 'esbuild', 'bin', 'esbuild')
// A unique directory per run: the previous fixed name meant two concurrent runs
// shared an output root, and `rmSync(recursive)` on Windows is exactly where
// that surfaces as EPERM/EBUSY.
const buildRoot = mkdtempSync(join(tmpdir(), 'hanekawa-desktop-build-'))

before(async () => {
  // Pin the module classification. This is belt-and-braces rather than
  // load-bearing: esbuild currently inlines the entire graph, so the output has
  // no `import`/`export` syntax left and Node loads it the same either way
  // (verified — dropping this line does not change the outcome today). It
  // matters the moment the bundle retains ESM syntax, e.g. a top-level await or
  // a deliberately external import, at which point a CJS misclassification
  // would turn the test below into a syntax check.
  writeFileSync(join(buildRoot, 'package.json'), JSON.stringify({ type: 'module' }))

  // Main process bundle: Node-targeted, with `electron` external so the
  // running binary supplies it. The bundled imports are the runtime,
  // sessions, harness, etc. — full app graph minus the renderer side.
  await run(
    process.execPath,
    [
      esbuildEntry,
      'src/desktop/main.ts',
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--target=node20',
      `--outfile=${join(buildRoot, 'desktop', 'main.js')}`,
      '--external:electron',
    ],
    { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 },
  )
  await run(
    process.execPath,
    [
      esbuildEntry,
      'src/desktop/preload.ts',
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--target=node20',
      `--outfile=${join(buildRoot, 'desktop', 'preload.js')}`,
      '--external:electron',
    ],
    { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 },
  )
  await run(
    process.execPath,
    [
      esbuildEntry,
      'src/desktop/renderer/app.ts',
      '--bundle',
      '--platform=neutral',
      '--format=esm',
      '--target=chrome120',
      '--main-fields=',
      '--alias:node:crypto=./src/desktop/renderer/runtime/nodeCryptoShim.ts',
      `--outfile=${join(buildRoot, 'desktop', 'renderer', 'app.js')}`,
    ],
    { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 },
  )
})

test('main process bundle exists and is non-empty', () => {
  const file = join(buildRoot, 'desktop', 'main.js')
  assert.ok(existsSync(file), 'expected dist/desktop/main.js')
  assert.ok(statSync(file).size > 0, 'main bundle must be non-empty')
})

test('preload bundle exists and is non-empty', () => {
  const file = join(buildRoot, 'desktop', 'preload.js')
  assert.ok(existsSync(file), 'expected dist/desktop/preload.js')
  assert.ok(statSync(file).size > 0, 'preload bundle must be non-empty')
})

test('renderer bundle exists and is non-empty', () => {
  const file = join(buildRoot, 'desktop', 'renderer', 'app.js')
  assert.ok(existsSync(file), 'expected dist/desktop/renderer/app.js')
  assert.ok(statSync(file).size > 0, 'renderer bundle must be non-empty')
})

test('the renderer bundle is self-contained: no module specifier survives', () => {
  // The property the renderer's whole layering rests on. `client.ts` may only
  // *type*-import the harness, the barrel is deep-imported to keep `node:fs`
  // out, and `node:crypto` is aliased to a browser shim — if any of that
  // regresses, esbuild leaves a specifier behind and Chromium cannot resolve it.
  // Checked by reading the bundle rather than by importing it, because a
  // `ReferenceError` from the first DOM access would mask a later import.
  const bundle = readFileSync(join(buildRoot, 'desktop', 'renderer', 'app.js'), 'utf8')
  assert.doesNotMatch(bundle, /^\s*(?:import|export)\s/m, 'everything must be inlined')
  assert.doesNotMatch(bundle, /require\(/, 'no CommonJS require may survive')
  assert.doesNotMatch(bundle, /['"]node:/, 'no node: builtin may survive into the renderer')
})

test('the bundled renderer loads and fails only for want of a DOM', async () => {
  // That the import resolves at all proves the graph is complete; that it fails
  // with a *DOM* error proves it got as far as executing module top level —
  // `app.ts` reads `window.hanekawa` on its first line.
  //
  // Asserting the specific failure is the point. "Throws something without
  // MODULE_NOT_FOUND in the message" was the previous condition, and a
  // `SyntaxError` from a CJS/ESM misclassification satisfied it without ever
  // running a line of the bundle.
  const url = pathToFileURL(join(buildRoot, 'desktop', 'renderer', 'app.js')).href
  let caught: unknown = null
  try {
    await import(url)
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof Error, 'importing the renderer must surface something')
  const error = caught as Error & { code?: string }
  assert.ok(
    error instanceof ReferenceError,
    `expected a missing-DOM ReferenceError, got ${error.name}: ${error.message}`,
  )
  assert.match(
    error.message,
    /window|document/,
    `expected the DOM global to be what is missing, got: ${error.message}`,
  )
  assert.notEqual(error.code, 'ERR_MODULE_NOT_FOUND', 'the bundle must not resolve anything at runtime')
})

test('copy-desktop-assets mirrors index.html next to the bundle', async () => {
  // The renderer is a `BrowserWindow.loadFile` away — the HTML must live next to
  // `app.js`. The copy script takes the destination root as an argument, so this
  // stays inside the temp build and never touches the repo's `dist/`.
  const dest = join(buildRoot, 'desktop', 'renderer', 'index.html')
  rmSync(dest, { force: true })
  await run(process.execPath, ['scripts/copy-desktop-assets.mjs', buildRoot], { cwd: repoRoot })
  assert.ok(existsSync(dest), 'expected the HTML to be copied next to app.js')
  assert.ok(statSync(dest).size > 0, 'copy of index.html must be non-empty')
})
