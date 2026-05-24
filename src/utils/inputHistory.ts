import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getMyAgentDir } from './paths.js'

const HISTORY_MAX = 1000

export function getHistoryPath(cwd = process.cwd()): string {
  return path.join(getMyAgentDir(cwd), 'history')
}

export function loadHistoryFile(cwd = process.cwd()): string[] {
  const historyPath = getHistoryPath(cwd)
  if (!existsSync(historyPath)) return []
  return readFileSync(historyPath, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
}

export function appendHistoryLine(line: string, cwd = process.cwd()): void {
  if (line.length === 0) return
  const lines = loadHistoryFile(cwd)
  lines.push(line)
  saveHistoryFile(lines, cwd)
}

export function saveHistoryFile(lines: string[], cwd = process.cwd()): void {
  const seen = new Set<string>()
  const deduped = lines.filter((line) => {
    if (seen.has(line)) return false
    seen.add(line)
    return true
  })
  const retained = deduped.slice(-HISTORY_MAX)
  const historyPath = getHistoryPath(cwd)
  mkdirSync(path.dirname(historyPath), { recursive: true })
  writeFileSync(historyPath, `${retained.join('\n')}\n`, 'utf-8')
}
