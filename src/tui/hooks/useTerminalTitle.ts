import { useEffect } from 'react'

export function useTerminalTitle(title: string) {
  useEffect(() => {
    // 设置终端标题
    process.stdout.write(`\x1b]0;${title}\x07`)

    return () => {
      // 恢复默认标题
      process.stdout.write('\x1b]0;Terminal\x07')
    }
  }, [title])
}
