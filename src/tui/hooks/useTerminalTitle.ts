import { useEffect } from 'react'

export function useTerminalTitle(title: string): void {
  useEffect(() => {
    // Set terminal title using OSC escape sequence
    process.stdout.write(`\x1b]0;${title}\x07`)

    return () => {
      // Reset terminal title on unmount
      process.stdout.write('\x1b]0;\x07')
    }
  }, [title])
}
