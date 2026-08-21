/**
 * Masking an API key for display.
 *
 * A leaf module with zero imports on purpose: both the TUI's provider panel and
 * the desktop shell's settings snapshot need it, and neither should have to
 * reach into the other's layer for four lines of string work.
 *
 * This is display-only. It is not a security boundary — the boundary is that
 * `WireSettingsSnapshot` never carries a raw key at all (see `shellProtocol.ts`,
 * where the field is deliberately named `apiKeyMasked` so a masked value cannot
 * be assigned back into a `SettingsChange`).
 */
export function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '*'.repeat(key.length)
  return key.slice(0, 4) + '...' + key.slice(-4)
}
