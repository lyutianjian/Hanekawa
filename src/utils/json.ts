import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * Safely parses a value that might be a JSON string.
 * Returns the parsed value if it's a valid JSON string, otherwise returns the original value.
 */
export function safeJsonParse(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/**
 * Parses JSONL (JSON Lines) format with error tolerance.
 * Skips empty lines and corrupted entries.
 */
export function parseJsonLines<T>(content: string): T[] {
  const records: T[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line) as T)
    } catch {
      // Skip corrupted lines (partial write, disk error)
    }
  }
  return records
}
