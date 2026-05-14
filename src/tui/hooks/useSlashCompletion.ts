import { useState, useMemo } from 'react'

const SLASH_COMMANDS = [
  '/help', '/model', '/clear', '/cost', '/session',
  '/compact', '/settings', '/retry', '/doctor', '/export', '/config',
]

export function useSlashCompletion(input: string) {
  const [selectedIndex, setSelectedIndex] = useState(0)

  const suggestions = useMemo(() => {
    if (!input.startsWith('/')) return []
    return SLASH_COMMANDS.filter(cmd => cmd.startsWith(input))
  }, [input])

  const accept = (index: number): string | null => {
    if (index < suggestions.length) {
      return suggestions[index] + ' '
    }
    return null
  }

  return { suggestions, selectedIndex, setSelectedIndex, accept }
}
