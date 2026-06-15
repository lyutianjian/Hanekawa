/**
 * OSC 8 hyperlink utilities.
 *
 * OSC 8 is a terminal escape sequence that makes text clickable.
 * Format: ESC ] 8 ; ; URL ESC \ (start) ... ESC ] 8 ; ; ESC \ (end)
 *
 * We only enable it for terminals known to support it, to avoid
 * rendering garbage on terminals that don't.
 */

/**
 * Check if the terminal likely supports OSC 8 hyperlinks.
 * Conservative: only returns true for known-supporting terminals.
 * Returns false when uncertain — a missed hyperlink is better than garbage.
 */
export function supportsHyperlinks(): boolean {
  // Windows Terminal sets WT_SESSION
  if (process.env.WT_SESSION) return true

  const termProgram = process.env.TERM_PROGRAM ?? ''
  if (['WezTerm', 'iTerm.app', 'vscode', 'Hyper', 'Tabby', 'Alacritty'].includes(termProgram)) {
    return true
  }

  // Kitty
  if (process.env.TERM === 'xterm-kitty') return true

  // Ghostty
  if (process.env.GHOSTTY_RESOURCES_DIR) return true

  return false
}

/**
 * Wrap `displayText` in an OSC 8 hyperlink pointing to `url`.
 * Terminals that support OSC 8 render this as a clickable link.
 * Terminals that don't will silently ignore the escape sequences.
 */
export function createHyperlink(url: string, displayText: string): string {
  return `\x1b]8;;${url}\x07${displayText}\x1b]8;;\x07`
}
