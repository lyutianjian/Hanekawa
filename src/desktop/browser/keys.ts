/**
 * Key names into the fields a CDP key event needs.
 *
 * Pure and host-side: nothing here crosses into the page. The table is the US
 * layout, because that is what `code` and `windowsVirtualKeyCode` describe —
 * a page reading `event.code` sees the physical key, whatever it types.
 *
 * Every lookup goes through `Object.hasOwn`: a key name is model input, and
 * `'constructor' in table` is true.
 */

import { BrowserHostError } from './errors.js'

export interface KeyDescription {
  key: string
  code: string
  keyCode: number
  /** What the key types, unmodified or under Shift. Absent for keys that type nothing. */
  text?: string
  /** 1 for the left-hand modifiers. */
  location?: number
}

/** CDP's modifier bitmask. */
export const MODIFIER_BITS: Readonly<Record<string, number>> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

/** How many keys one `page.press_key` may hold at once. */
export const PRESS_KEYS_MAX = 8

const NAMED: Readonly<Record<string, KeyDescription>> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1 },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, location: 1 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, location: 1 },
}

/** Lower-cased spellings the model reaches for, onto the canonical name. */
const ALIASES: Readonly<Record<string, string>> = {
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  space: 'Space',
  spacebar: 'Space',
  ' ': 'Space',
  arrowleft: 'ArrowLeft',
  left: 'ArrowLeft',
  arrowup: 'ArrowUp',
  up: 'ArrowUp',
  arrowright: 'ArrowRight',
  right: 'ArrowRight',
  arrowdown: 'ArrowDown',
  down: 'ArrowDown',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  shift: 'Shift',
  control: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  option: 'Alt',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  super: 'Meta',
  win: 'Meta',
  controlormeta: 'ControlOrMeta',
  cmdorctrl: 'ControlOrMeta',
  commandorcontrol: 'ControlOrMeta',
}

/** Digit row: the digit, then what Shift makes of it. */
const SHIFTED_DIGITS = ')!@#$%^&*('

/** Punctuation: [unshifted, shifted, code, keyCode]. */
const PUNCTUATION: ReadonlyArray<readonly [string, string, string, number]> = [
  ['-', '_', 'Minus', 189],
  ['=', '+', 'Equal', 187],
  ['[', '{', 'BracketLeft', 219],
  [']', '}', 'BracketRight', 221],
  ['\\', '|', 'Backslash', 220],
  [';', ':', 'Semicolon', 186],
  ["'", '"', 'Quote', 222],
  [',', '<', 'Comma', 188],
  ['.', '>', 'Period', 190],
  ['/', '?', 'Slash', 191],
  ['`', '~', 'Backquote', 192],
]

/**
 * One key, as CDP wants it.
 *
 * `shift` is whether Shift is already held: it picks the shifted character for
 * a letter, digit or punctuation key, which is what a real keyboard types. A
 * shifted character named directly (`"!"`) is its own key and types itself.
 * Returns `undefined` for a name nothing here knows.
 */
export function keyDescription(name: string, shift: boolean, platform: string): KeyDescription | undefined {
  const canonical = Object.hasOwn(NAMED, name)
    ? name
    : Object.hasOwn(ALIASES, name.toLowerCase())
      ? (ALIASES[name.toLowerCase()] as string)
      : undefined
  if (canonical === 'ControlOrMeta') return NAMED[platform === 'darwin' ? 'Meta' : 'Control']
  if (canonical !== undefined) return NAMED[canonical]

  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(name)) {
    const n = Number(name.slice(1))
    return { key: `F${n}`, code: `F${n}`, keyCode: 111 + n }
  }
  if (name.length !== 1) return undefined

  if (/^[a-zA-Z]$/.test(name)) {
    const upper = name.toUpperCase()
    const key = shift ? upper : name
    return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key }
  }
  if (/^[0-9]$/.test(name)) {
    const digit = Number(name)
    const key = shift ? (SHIFTED_DIGITS[digit] as string) : name
    return { key, code: `Digit${name}`, keyCode: 48 + digit, text: key }
  }
  const shiftedDigit = SHIFTED_DIGITS.indexOf(name)
  if (shiftedDigit !== -1) {
    return { key: name, code: `Digit${shiftedDigit}`, keyCode: 48 + shiftedDigit, text: name }
  }
  for (const [plain, shifted, code, keyCode] of PUNCTUATION) {
    if (name === plain) {
      const key = shift ? shifted : plain
      return { key, code, keyCode, text: key }
    }
    if (name === shifted) return { key: shifted, code, keyCode, text: shifted }
  }
  return undefined
}

export function isModifier(description: KeyDescription): boolean {
  return Object.hasOwn(MODIFIER_BITS, description.key)
}

/**
 * The key names a request holds, one per key.
 *
 * `"Control+A"` in a single entry is split, because that is how a shortcut is
 * written everywhere else; a lone `"+"` is the plus key.
 */
export function splitKeys(keys: readonly string[]): string[] {
  const out: string[] = []
  for (const entry of keys) {
    if (entry.length > 1 && entry.includes('+')) {
      const parts = entry.split('+')
      // `Control++` is Control and plus.
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i] as string
        if (part !== '') out.push(part)
        else if (i === parts.length - 1 && parts[i - 1] === '') out.push('+')
      }
    } else {
      out.push(entry)
    }
  }
  return out
}

/**
 * Every name resolved, or the one that is not a key.
 *
 * Validation up front: a chord refused halfway would already have pressed its
 * first keys, and "which key did it not know" is the whole of the useful
 * answer.
 */
export function describeKeys(keys: readonly string[], platform: string): KeyDescription[] {
  const names = splitKeys(keys)
  if (names.length === 0 || names.length > PRESS_KEYS_MAX) {
    throw new BrowserHostError('INVALID_REQUEST', `page.press_key takes 1–${PRESS_KEYS_MAX} keys; this call had ${names.length}.`)
  }
  const descriptions: KeyDescription[] = []
  let shift = false
  for (const name of names) {
    const description = keyDescription(name, shift, platform)
    if (description === undefined) {
      throw new BrowserHostError(
        'INVALID_REQUEST',
        `"${name}" is not a key page.press_key knows. Use a name like Enter, Tab, Escape, ArrowDown, PageDown, F5, a single character, or a modifier (Control, Shift, Alt, Meta, ControlOrMeta).`,
      )
    }
    if (description.key === 'Shift') shift = true
    descriptions.push(description)
  }
  if (descriptions.every(isModifier)) {
    throw new BrowserHostError(
      'INVALID_REQUEST',
      'page.press_key needs a key besides the modifiers, e.g. ["Control", "a"]. Holding a modifier on its own does nothing.',
    )
  }
  return descriptions
}

/**
 * The macOS editing command a shortcut stands for.
 *
 * Chromium on macOS routes Cmd+A and friends through the system key bindings,
 * which CDP only reaches through the `commands` field; without it the event
 * arrives and nothing is selected, copied or pasted.
 */
export function macCommand(description: KeyDescription, modifiers: number): string | undefined {
  if (description.key === 'Backspace' && modifiers === 0) return 'deleteBackward'
  if (description.key === 'Delete' && modifiers === 0) return 'deleteForward'
  const meta = MODIFIER_BITS['Meta'] as number
  const shift = MODIFIER_BITS['Shift'] as number
  const letter = description.code.startsWith('Key') ? description.code.slice(3).toLowerCase() : ''
  if (letter === '') return undefined
  if (modifiers === meta) {
    const table: Record<string, string> = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo' }
    return Object.hasOwn(table, letter) ? table[letter] : undefined
  }
  if (modifiers === (meta | shift) && letter === 'z') return 'redo'
  return undefined
}
