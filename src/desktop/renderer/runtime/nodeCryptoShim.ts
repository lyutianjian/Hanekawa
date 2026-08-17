/**
 * A browser-shaped shim of `node:crypto` for the renderer's esbuild bundle.
 *
 * Bundling for the browser keeps `client.ts` shape (it imports
 * `randomUUID` from `node:crypto`), but Chromium cannot satisfy that import.
 * The build script wires `--alias:node:crypto=` to this file so esbuild
 * substitutes the import rather than throwing at bundle time.
 *
 * Web Crypto's `crypto.randomUUID()` returns the exact same v4 string shape
 * Node's `crypto.randomUUID()` does, so the shim's `randomUUID` is a
 * one-liner fallthrough. The fallback path is defensive and almost never
 * runs in practice (Chromium has shipped it for years).
 */

const cryptoApi = globalThis.crypto as Crypto | undefined

export function randomUUID(): string {
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
    throw new Error('Web Crypto API is unavailable in this environment')
  }
  const bytes = new Uint8Array(16)
  cryptoApi.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
