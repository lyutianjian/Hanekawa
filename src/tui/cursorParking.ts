export interface CursorTarget {
  x: number
  y: number
}

type WritableStdout = NodeJS.WriteStream & {
  write: NodeJS.WriteStream['write']
}

const SHOW_CURSOR = '\x1B[?25h'
const HIDE_CURSOR = '\x1B[?25l'

export class CursorParkingController {
  private originalWrite: NodeJS.WriteStream['write'] | undefined
  private writing = false

  constructor(private readonly stdout: WritableStdout) {}

  patch(): void {
    if (this.originalWrite || this.stdout.isTTY === false) return

    this.originalWrite = this.stdout.write.bind(this.stdout) as NodeJS.WriteStream['write']
    const controller = this

    this.stdout.write = function patchedWrite(
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean {
      return controller.write(chunk, encodingOrCallback, callback)
    } as NodeJS.WriteStream['write']
  }

  unpatch(): void {
    if (!this.originalWrite) return
    this.originalWrite.call(this.stdout, SHOW_CURSOR)
    this.stdout.write = this.originalWrite
    this.originalWrite = undefined
  }

  restoreCursor(): void {
    if (!this.originalWrite) return
    this.originalWrite.call(this.stdout, SHOW_CURSOR)
  }

  private write(
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    if (!this.originalWrite) {
      return false
    }

    if (this.writing) {
      return this.originalWrite.call(this.stdout, chunk, encodingOrCallback as BufferEncoding, callback)
    }

    const text = chunkToString(chunk)
    if (text.length === 0) {
      return this.originalWrite.call(this.stdout, chunk, encodingOrCallback as BufferEncoding, callback)
    }

    this.writing = true
    try {
      const nextChunk = text.includes(SHOW_CURSOR)
        ? text.replaceAll(SHOW_CURSOR, HIDE_CURSOR)
        : chunk
      return this.originalWrite.call(this.stdout, nextChunk, encodingOrCallback as BufferEncoding, callback)
    } finally {
      this.writing = false
    }
  }
}

export function moveFromBottomToTarget(target: CursorTarget, bottomLine: number): string {
  const y = clamp(Math.floor(target.y), 0, Math.max(0, bottomLine - 1))
  const x = Math.max(0, Math.floor(target.x))
  const moveUp = Math.max(0, bottomLine - y)
  return `${cursorUp(moveUp)}${cursorTo(x)}`
}

export function moveFromTargetToBottom(target: CursorTarget, bottomLine: number): string {
  const y = clamp(Math.floor(target.y), 0, Math.max(0, bottomLine - 1))
  const moveDown = Math.max(0, bottomLine - y)
  return `${cursorDown(moveDown)}${cursorTo(0)}`
}

function chunkToString(chunk: string | Uint8Array): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
}

function cursorUp(count: number): string {
  return count > 0 ? `\x1B[${count}A` : ''
}

function cursorDown(count: number): string {
  return count > 0 ? `\x1B[${count}B` : ''
}

function cursorTo(column: number): string {
  return `\x1B[${Math.max(0, column) + 1}G`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
