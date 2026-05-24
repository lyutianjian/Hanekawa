import { stat } from 'node:fs/promises'
import type { ReadFileState, ToolContext, ToolResult } from '../harness/types.js'
import type { Stats } from 'node:fs'

type FileSignature = Pick<ReadFileState, 'mtimeMs' | 'ctimeMs' | 'size' | 'dev' | 'ino'>

let lastReadFileTimestamp = 0

export async function captureReadFileState(absolute: string, content: string): Promise<ReadFileState> {
  const fileStat = await stat(absolute)
  return captureReadFileStateFromStat(content, fileStat)
}

export function captureReadFileStateFromStat(content: string, fileStat: Stats): ReadFileState {
  return {
    content,
    timestamp: nextReadFileTimestamp(),
    ...captureFileSignature(fileStat),
  }
}

function nextReadFileTimestamp(): number {
  const now = Date.now()
  lastReadFileTimestamp = Math.max(now, lastReadFileTimestamp + 1)
  return lastReadFileTimestamp
}

function captureFileSignature(fileStat: Stats): FileSignature {
  return {
    mtimeMs: fileStat.mtimeMs,
    ctimeMs: fileStat.ctimeMs,
    size: fileStat.size,
    dev: fileStat.dev,
    ino: fileStat.ino,
  }
}

function signatureChanged(state: ReadFileState, current: FileSignature): boolean {
  if (state.size !== current.size || state.mtimeMs !== current.mtimeMs) {
    return true
  }
  if (state.ctimeMs !== undefined && current.ctimeMs !== undefined && state.ctimeMs !== current.ctimeMs) {
    return true
  }
  if (state.dev !== undefined && current.dev !== undefined && state.dev !== current.dev) {
    return true
  }
  if (state.ino !== undefined && current.ino !== undefined && state.ino !== current.ino) {
    return true
  }
  return false
}

export async function requireFreshRead(absolute: string, filePath: string, context: ToolContext): Promise<ToolResult | undefined> {
  const state = context.readFileState?.get(absolute)
  if (!context.readFiles.has(absolute) || !state) {
    return {
      ok: false,
      content: `Refusing to modify ${filePath}: file must be read first.`,
      errorCode: 'precondition_failed',
    }
  }

  let fileStat
  try {
    fileStat = await stat(absolute)
  } catch {
    return {
      ok: false,
      content: `Refusing to modify ${filePath}: file no longer exists. Read it again before retrying.`,
      errorCode: 'not_found',
    }
  }

  const current = captureFileSignature(fileStat)
  if (signatureChanged(state, current)) {
    return {
      ok: false,
      content: `Refusing to modify ${filePath}: file changed since it was last read. Read it again before retrying.`,
      errorCode: 'stale_file',
      errorDetails: {
        previous: {
          mtimeMs: state.mtimeMs,
          ctimeMs: state.ctimeMs,
          size: state.size,
          dev: state.dev,
          ino: state.ino,
        },
        current,
      },
    }
  }

  return undefined
}

export function getReadFileContent(absolute: string, context: ToolContext): string | undefined {
  return context.readFileState?.get(absolute)?.content
}
