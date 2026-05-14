import type { KeybindingAction, KeybindingBlock } from './types.js'
import { DEFAULT_BINDINGS } from './defaultBindings.js'

function parseKey(input: string, key: { ctrl?: boolean; meta?: boolean; shift?: boolean; return?: boolean; escape?: boolean; upArrow?: boolean; downArrow?: boolean; pageUp?: boolean; pageDown?: boolean; home?: boolean; end?: boolean }): string {
  const parts: string[] = []
  if (key.ctrl) parts.push('ctrl')
  if (key.meta) parts.push('meta')
  if (key.shift) parts.push('shift')

  if (key.return) parts.push('enter')
  else if (key.escape) parts.push('escape')
  else if (key.upArrow) parts.push('up')
  else if (key.downArrow) parts.push('down')
  else if (key.pageUp) parts.push('pageup')
  else if (key.pageDown) parts.push('pagedown')
  else if (key.home) parts.push('home')
  else if (key.end) parts.push('end')
  else if (input) parts.push(input.toLowerCase())

  return parts.join('+')
}

export function resolveAction(
  input: string,
  key: Parameters<typeof parseKey>[1],
  context: string,
  bindings: KeybindingBlock[] = DEFAULT_BINDINGS,
): KeybindingAction | undefined {
  const keyStr = parseKey(input, key)

  const contextBlock = bindings.find(b => b.context === context)
  if (contextBlock?.bindings?.[keyStr]) return contextBlock.bindings[keyStr]

  const globalBlock = bindings.find(b => b.context === 'Global')
  if (globalBlock?.bindings?.[keyStr]) return globalBlock.bindings[keyStr]

  return undefined
}
