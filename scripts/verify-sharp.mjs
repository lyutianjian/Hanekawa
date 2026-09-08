#!/usr/bin/env node
/**
 * S01 dependency probe, Node side: load `sharp` under plain Node and decode a
 * committed fixture PNG, printing the dimensions it finds.
 *
 * The fixture path is resolved relative to this file so the script works
 * from any cwd; run it with `node scripts/verify-sharp.mjs` (or
 * `npm run verify:sharp`). Exit code 0 means the native binding loaded and
 * decoded — anything else prints the failure on stderr. The Electron-side
 * twin is `scripts/verify-sharp-electron.mjs`; keep the two in step.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'images',
  'transparent.png',
)

try {
  // Dynamic so a binding that fails to load is reported by the `catch` below
  // rather than by a bare module-load stack; the Electron twin depends on this
  // shape for its exit code, so the two stay spelled the same way.
  const { default: sharp } = await import('sharp')
  const meta = await sharp(fixture).metadata()
  if (meta.format !== 'png' || !meta.width || !meta.height) {
    throw new Error(`unexpected metadata: ${meta.format} ${meta.width}x${meta.height}`)
  }
  console.log(
    `[verify-sharp] node ${process.version} sharp ${sharp.versions.sharp}: ` +
      `decoded ${meta.format} ${meta.width}x${meta.height}`,
  )
} catch (error) {
  console.error(`[verify-sharp] FAILED: ${error?.message ?? error}`)
  process.exit(1)
}
