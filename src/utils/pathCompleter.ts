import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Tab-completion for file paths. Uses synchronous I/O because the calling
 * context (TUI input handler) is synchronous. For large directories or slow
 * filesystems, this could block the event loop briefly. If this becomes a
 * problem, consider caching directory listings or switching to async.
 */
export function filePathCompleter(line: string): [string[], string] {
  const match = line.match(/(?:^|\s)(\S*)$/)
  const token = match?.[1] ?? ''
  const directory = token.endsWith(path.sep) || token.endsWith('/')
    ? token
    : path.dirname(token)
  const prefix = token.endsWith(path.sep) || token.endsWith('/')
    ? ''
    : path.basename(token)
  const searchDir = directory === '.' ? process.cwd() : path.resolve(directory)

  try {
    const completions = readdirSync(searchDir)
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => {
        const fullPath = path.join(searchDir, entry)
        const completed = directory === '.'
          ? entry
          : path.join(directory, entry)
        return statSync(fullPath).isDirectory() ? `${completed}/` : completed
      })
    return [completions, token]
  } catch {
    return [[], token]
  }
}
