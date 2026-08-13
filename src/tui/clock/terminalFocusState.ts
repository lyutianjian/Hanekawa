// Terminal focus state, backed by DECSET 1004 focus reporting.
//
// While focus reporting is enabled the terminal emits `ESC [ I` (focused) /
// `ESC [ O` (blurred) CSI sequences. Stock Ink 7.0.6 would otherwise parse
// those bytes and deliver `'[I'` / `'[O'` to every useInput handler as text,
// typing garbage into the prompt. So this module installs a 'readable'
// listener on stdin *before* Ink attaches its own (registration order on
// process.stdin is deterministic), strips complete 3-byte focus sequences,
// and unshifts the remainder back so Ink's listener reads it unchanged.

const ESC = 0x1b
const OPEN_BRACKET = 0x5b
const FOCUS_IN = 0x49 // 'I'
const FOCUS_OUT = 0x4f // 'O'

export const ENABLE_FOCUS_REPORTING = '\x1b[?1004h'
export const DISABLE_FOCUS_REPORTING = '\x1b[?1004l'

export type TerminalFocusState = 'focused' | 'blurred' | 'unknown'

let focusState: TerminalFocusState = 'unknown'
const subscribers = new Set<() => void>()

export function getTerminalFocusState(): TerminalFocusState {
  return focusState
}

/** Terminals that do not report focus are treated as focused so animations never throttle. */
export function getTerminalFocused(): boolean {
  return focusState !== 'blurred'
}

export function setTerminalFocused(focused: boolean): void {
  const next: TerminalFocusState = focused ? 'focused' : 'blurred'
  if (next === focusState) return
  focusState = next
  for (const subscriber of subscribers) subscriber()
}

export function subscribeTerminalFocus(onChange: () => void): () => void {
  subscribers.add(onChange)
  return () => {
    subscribers.delete(onChange)
  }
}

let installed = false

export function installTerminalFocusFilter(stdin: NodeJS.ReadStream): void {
  if (installed) return
  installed = true

  // Bytes held back because they could be the prefix of a split sequence.
  let carry = Buffer.alloc(0)

  const handleReadable = (): void => {
    const chunks: Buffer[] = []
    for (let chunk = stdin.read(); chunk !== null; chunk = stdin.read()) {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
    }
    const buffer = chunks.length === 0
      ? carry
      : carry.length > 0
        ? Buffer.concat([carry, ...chunks])
        : Buffer.concat(chunks)
    carry = Buffer.alloc(0)

    const out: Buffer[] = []
    let i = 0
    while (i < buffer.length) {
      const byte = buffer[i]!
      if (
        byte === ESC
        && buffer[i + 1] === OPEN_BRACKET
        && (buffer[i + 2] === FOCUS_IN || buffer[i + 2] === FOCUS_OUT)
      ) {
        setTerminalFocused(buffer[i + 2] === FOCUS_IN)
        i += 3
      } else {
        out.push(buffer.subarray(i, i + 1))
        i += 1
      }
    }

    if (out.length === 0) return

    const rest = Buffer.concat(out)
    const tailIsSequencePrefix =
      (rest.length >= 2 && rest[rest.length - 2] === ESC && rest[rest.length - 1] === OPEN_BRACKET)
      || rest[rest.length - 1] === ESC
    if (tailIsSequencePrefix) {
      // A focus event split across two read chunks is still recognized; a
      // lone ESC keypress is released on the next emission (one tick later).
      const holdLength = rest[rest.length - 2] === ESC && rest[rest.length - 1] === OPEN_BRACKET ? 2 : 1
      carry = Buffer.from(rest.subarray(-holdLength))
      if (rest.length > holdLength) stdin.unshift(rest.subarray(0, rest.length - holdLength))
    } else {
      stdin.unshift(rest)
    }
  }

  stdin.on('readable', handleReadable)
}