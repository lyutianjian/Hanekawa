import { useState, useCallback, useRef } from 'react'
import { readdir, stat } from 'node:fs/promises'
import { join, dirname, basename, resolve } from 'node:path'

type CompletionItem = {
  name: string
  path: string
  isDirectory: boolean
}

export function useFileCompletion(cwd: string) {
  const [completions, setCompletions] = useState<CompletionItem[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const cacheRef = useRef<Map<string, CompletionItem[]>>(new Map())

  const getCompletions = useCallback(async (partial: string): Promise<CompletionItem[]> => {
    // 检查缓存
    const cached = cacheRef.current.get(partial)
    if (cached) return cached

    try {
      const dir = partial.includes('/') ? dirname(partial) : '.'
      const prefix = basename(partial)
      const absDir = resolve(cwd, dir)

      const entries = await readdir(absDir, { withFileTypes: true })
      const matches: CompletionItem[] = []

      for (const entry of entries) {
        if (entry.name.startsWith(prefix) && !entry.name.startsWith('.')) {
          const fullPath = join(dir, entry.name)
          matches.push({
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
          })
        }
      }

      // 排序：目录优先，然后字母序
      matches.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })

      cacheRef.current.set(partial, matches)
      return matches
    } catch {
      return []
    }
  }, [cwd])

  const complete = useCallback(async (input: string): Promise<string | null> => {
    // 检测是否在输入路径（以 / 或 ./ 或 ~ 开头）
    const pathMatch = input.match(/(?:^|\s)((?:~|\.\/?|\/)[^\s]*)$/)
    if (!pathMatch) return null

    const partial = pathMatch[1]
    const items = await getCompletions(partial)

    if (items.length === 0) return null

    setCompletions(items)
    setSelectedIndex(0)

    // 返回第一个匹配
    const item = items[0]
    const completed = partial.includes('/')
      ? join(dirname(partial), item.name) + (item.isDirectory ? '/' : '')
      : item.name + (item.isDirectory ? '/' : '')

    return completed
  }, [getCompletions])

  return { completions, selectedIndex, complete, setSelectedIndex }
}
