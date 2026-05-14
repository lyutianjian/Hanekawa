// 懒加载 cli-highlight — 复刻自 ClaudeCode/src/utils/cliHighlight.ts

let highlightFn: ((code: string, options?: { language?: string }) => string) | null = null
let loaded = false

export async function getHighlightFn(): Promise<typeof highlightFn> {
  if (loaded) return highlightFn
  loaded = true
  try {
    const mod = await import('cli-highlight')
    highlightFn = mod.highlight
  } catch {
    highlightFn = null
  }
  return highlightFn
}

export function highlightCode(code: string, language?: string): string {
  if (!highlightFn) return code
  try {
    return highlightFn(code, { language })
  } catch {
    return code
  }
}
