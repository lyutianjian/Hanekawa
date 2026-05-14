export type TerminalCapabilities = {
  supportsColor: boolean
  supports256Color: boolean
  supportsTrueColor: boolean
  supportsUnicode: boolean
  supportsEmoji: boolean
  width: number
  height: number
}

export function detectTerminalCapabilities(): TerminalCapabilities {
  const term = process.env.TERM || ''
  const termProgram = process.env.TERM_PROGRAM || ''
  const colorterm = process.env.COLORTERM || ''

  return {
    supportsColor: !!process.env.FORCE_COLOR ||
      term.includes('256') ||
      term.includes('color') ||
      colorterm === 'truecolor',
    supports256Color: term.includes('256') || colorterm === 'truecolor',
    supportsTrueColor: colorterm === 'truecolor',
    supportsUnicode: !!(process.env.LANG?.includes('UTF-8') || process.env.LC_ALL?.includes('UTF-8')),
    supportsEmoji: termProgram === 'iTerm' || termProgram === 'vscode' || term.includes('xterm'),
    width: process.stdout.columns || 80,
    height: process.stdout.rows || 24,
  }
}
