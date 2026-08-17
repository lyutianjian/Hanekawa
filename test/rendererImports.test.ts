import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * What the renderer is allowed to import, and which globals it may not touch.
 *
 * This exists because neither typecheck pass can see either problem:
 *
 * - `tsc -p tsconfig.renderer.json --listFiles` already contains ~130 host files,
 *   pulled in transitively through the wire types, including `src/utils/paths.ts`
 *   — which imports `node:fs` and uses `process`. So `@types/node`'s globals are
 *   in scope for the renderer pass despite `"types": []`, and a renderer file
 *   using `process.env` compiles clean in *both* passes.
 * - esbuild does reject an unresolvable `node:` *import*, but the failure names
 *   esbuild rather than the file, and it cannot see a bare global at all.
 *
 * The value/type distinction matters: a `import type` of anything is free at
 * runtime, so only value imports are policed here.
 */

const rendererRoot = fileURLToPath(new URL('../src/desktop/renderer/', import.meta.url))

/**
 * Shared modules the renderer may value-import.
 *
 * Each earns its place by being pure and *type-only* in its own cross-layer
 * imports. Adding an entry is a decision to keep that module browser-safe — a
 * single value import of `node:fs` inside it breaks the desktop build.
 */
const ALLOWED_SHARED_IMPORTS = [
  '../../runtime/protocol/client.js',
  '../../../runtime/protocol/wire.js',
  '../../../runtime/permissionPresentation.js',
  '../../../runtime/planPresentation.js',
  '../../../runtime/rewindPresentation.js',
  '../../../runtime/suggestions/commandSuggestions.js',
  // The pure half of `@` file completion. `fileSuggestions.js` is the other half
  // and is *not* here: it value-imports `node:fs/promises`, which is why the two
  // were split at all.
  '../../../runtime/suggestions/atToken.js',
  '../../../config/effort.js',
]

/**
 * Bare specifiers that bundle for a browser, all verified in the build test.
 *
 * `marked` earns its place by being dependency-free ESM whose `exports` map has a
 * single entry — and the renderer uses only its *lexer*: the parser's output is an
 * HTML string, which `dom/dom.ts` has nowhere to put.
 */
const ALLOWED_PACKAGES = ['diff', 'fuse.js', 'marked']

const FORBIDDEN_LAYERS = /(^|\/)(harness|services|sessions|commands|tui)\//

function rendererFiles(dir = rendererRoot): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return rendererFiles(full)
    return full.endsWith('.ts') ? [full] : []
  })
}

/** `import ... from 'x'` and `export ... from 'x'`, minus the `type` forms. */
function valueImports(source: string): string[] {
  const specifiers: string[] = []
  const pattern = /(?:^|\n)\s*(?:import|export)\s+([^;]*?)\s*from\s*['"]([^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) {
    const clause = match[1] ?? ''
    const specifier = match[2] ?? ''
    // `import type { X } from` and `export type { X } from` are erased.
    if (/^type\s/.test(clause)) continue
    // A clause whose every named binding is `type X` is erased too.
    const named = clause.match(/^\{([\s\S]*)\}$/)
    if (named) {
      const bindings = (named[1] ?? '').split(',').map((part) => part.trim()).filter(Boolean)
      if (bindings.length > 0 && bindings.every((binding) => binding.startsWith('type '))) continue
    }
    specifiers.push(specifier)
  }
  return specifiers
}

test('the renderer has files to check, so this test cannot pass vacuously', () => {
  const files = rendererFiles()
  assert.ok(files.length >= 10, `expected the renderer tree, found ${files.length} files`)
  assert.ok(files.some((file) => file.endsWith('app.ts')))
  assert.ok(files.some((file) => file.includes('model')))
})

test('no renderer module value-imports a host layer', () => {
  for (const file of rendererFiles()) {
    const source = readFileSync(file, 'utf8')
    for (const specifier of valueImports(source)) {
      if (specifier.startsWith('.') && !specifier.includes('/runtime/') && !specifier.includes('/config/')) {
        // A local renderer import.
        assert.equal(
          FORBIDDEN_LAYERS.test(specifier),
          false,
          `${path.relative(rendererRoot, file)} value-imports ${specifier}`,
        )
        continue
      }
      if (specifier.startsWith('.')) {
        assert.ok(
          ALLOWED_SHARED_IMPORTS.includes(specifier),
          `${path.relative(rendererRoot, file)} value-imports ${specifier}, which is not on the shared allowlist`,
        )
        continue
      }
      assert.ok(
        ALLOWED_PACKAGES.includes(specifier),
        `${path.relative(rendererRoot, file)} value-imports the package ${specifier}, which is not known to bundle for a browser`,
      )
    }
  }
})

test('every allowlisted shared module is actually reachable and pure', () => {
  // A stale allowlist entry is a licence nobody is using; a missing file would
  // make the assertion above pass for the wrong reason.
  //
  // `node:crypto` is the one permitted Node import, and only because
  // `build:desktop` aliases it to `renderer/runtime/nodeCryptoShim.ts`
  // (`package.json`, mirrored in `test/desktopBuild.test.ts`). Any other `node:`
  // specifier has no alias and fails the bundle.
  for (const specifier of ALLOWED_SHARED_IMPORTS) {
    const relative = specifier.replace(/^(\.\.\/)+/, '').replace(/\.js$/, '.ts')
    const full = fileURLToPath(new URL(`../src/${relative}`, import.meta.url))
    const source = readFileSync(full, 'utf8')
    for (const nested of valueImports(source)) {
      if (!nested.startsWith('node:')) continue
      assert.equal(
        nested,
        'node:crypto',
        `${relative} value-imports ${nested}, which the desktop build has no alias for`,
      )
    }
  }
})

test('no renderer module reaches for a Node-only global', () => {
  // Not visible to either typecheck pass: `@types/node` is in the renderer
  // program regardless of `"types": []`.
  const forbidden: Array<[RegExp, string]> = [
    [/\bprocess\s*\./, 'process.*'],
    [/\bBuffer\b/, 'Buffer'],
    [/\b__dirname\b/, '__dirname'],
    [/\b__filename\b/, '__filename'],
    [/\brequire\s*\(/, 'require('],
    [/\bglobal\s*\./, 'global.*'],
  ]

  for (const file of rendererFiles()) {
    const source = readFileSync(file, 'utf8')
    // Comments may legitimately discuss these; strip them first.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')

    for (const [pattern, name] of forbidden) {
      assert.equal(
        pattern.test(code),
        false,
        `${path.relative(rendererRoot, file)} uses ${name}, which does not exist in Chromium`,
      )
    }
  }
})

test('the renderer deep-imports the protocol client, never the barrel', () => {
  for (const file of rendererFiles()) {
    const source = readFileSync(file, 'utf8')
    for (const specifier of valueImports(source)) {
      assert.equal(
        /runtime\/protocol\/index\.js$/.test(specifier) || /runtime\/protocol['"]?$/.test(specifier),
        false,
        `${path.relative(rendererRoot, file)} imports the protocol barrel, which pulls node:fs through host.ts`,
      )
    }
  }
})
