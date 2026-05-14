import { useStdout } from 'ink'
import { useState, useEffect } from 'react'

interface TerminalSize {
  columns: number
  rows: number
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout()
  const [size, setSize] = useState<TerminalSize>({
    columns: stdout.columns,
    rows: stdout.rows,
  })

  useEffect(() => {
    const handler = () => {
      setSize({ columns: stdout.columns, rows: stdout.rows })
    }

    stdout.on('resize', handler)
    return () => {
      stdout.off('resize', handler)
    }
  }, [stdout])

  return size
}
