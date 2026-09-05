import { open, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export type LineEndings = 'CRLF' | 'LF'

export interface TextFileRead {
  /** Always LF-normalized. This is what string matching runs against. */
  content: string
  encoding: BufferEncoding
  lineEndings: LineEndings
}

/**
 * Line endings are detected from the head of the file, before normalization
 * erases the distinction. 4096 characters is enough to classify a file without
 * scanning megabytes of it.
 */
const LINE_ENDING_SAMPLE_CHARS = 4096

export function detectLineEndings(sample: string): LineEndings {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] !== '\n') continue
    if (i > 0 && sample[i - 1] === '\r') crlf++
    else lf++
  }
  return crlf > lf ? 'CRLF' : 'LF'
}

export function normalizeToLf(raw: string): string {
  return raw.replaceAll('\r\n', '\n')
}

export function applyLineEndings(content: string, endings: LineEndings): string {
  if (endings !== 'CRLF') return content
  // Normalize first: a newString that already carries \r\n (raw model output)
  // would otherwise become \r\r\n after the join.
  return normalizeToLf(content).split('\n').join('\r\n')
}

function detectEncoding(head: Buffer): BufferEncoding {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'utf16le'
  return 'utf8'
}

/**
 * Read a text file, returning LF-normalized content plus the metadata needed to
 * write it back unchanged. Every string-matching tool reads through this, so a
 * CRLF file and an LF file look identical to `oldString` matching — the model
 * emits `\n` and cannot be expected to emit `\r\n`.
 *
 * Uses a single file handle so a caller that also needs stat gets it without a
 * second open (see `fileState.readFileAndRemember`).
 */
export async function readTextFile(absolute: string): Promise<TextFileRead> {
  const fh = await open(absolute, 'r')
  try {
    return await readTextFromHandle(fh)
  } finally {
    await fh.close()
  }
}

type FileHandleLike = {
  readFile(options: { encoding: BufferEncoding }): Promise<string>
  readFile(): Promise<Buffer>
}

export async function readTextFromHandle(fh: FileHandleLike): Promise<TextFileRead> {
  const raw = await fh.readFile()
  const encoding = detectEncoding(raw.subarray(0, 4))
  const decoded = raw.toString(encoding)
  return {
    content: normalizeToLf(decoded),
    encoding,
    lineEndings: detectLineEndings(decoded.slice(0, LINE_ENDING_SAMPLE_CHARS)),
  }
}

/** Decode an already-read buffer with the same rules as `readTextFile`. */
export function decodeTextBuffer(raw: Buffer): TextFileRead {
  const encoding = detectEncoding(raw.subarray(0, 4))
  const decoded = raw.toString(encoding)
  return {
    content: normalizeToLf(decoded),
    encoding,
    lineEndings: detectLineEndings(decoded.slice(0, LINE_ENDING_SAMPLE_CHARS)),
  }
}

/**
 * Write LF content back in the file's original encoding and line-ending style.
 * `atomic` routes through a temp file plus rename, which is how `Write` avoids
 * following a symlink that appeared between the check and the write.
 */
export async function writeTextFile(
  absolute: string,
  content: string,
  encoding: BufferEncoding,
  lineEndings: LineEndings,
  options: { atomic?: boolean } = {},
): Promise<void> {
  const text = applyLineEndings(content, lineEndings)
  if (!options.atomic) {
    await writeFile(absolute, text, encoding)
    return
  }
  const tmpPath = `${absolute}.tmp.${randomUUID()}`
  await writeFile(tmpPath, text, encoding)
  await rename(tmpPath, absolute)
}
