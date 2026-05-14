import { useState, useEffect } from 'react'
import { useInput } from 'ink'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import type { KeyBinding, KeyBindingContext, KeyBindingsConfig } from './types.js'
import { defaultBindings } from './defaultBindings.js'

async function loadKeyBindingsConfig(): Promise<KeyBindingsConfig> {
  const configPath = path.join(os.homedir(), '.myagent', 'keybindings.json')

  try {
    const exists = await fs.access(configPath).then(() => true).catch(() => false)
    if (exists) {
      const content = await fs.readFile(configPath, 'utf-8')
      return JSON.parse(content)
    }
  } catch (error) {
    console.error('Failed to load keybindings config:', error)
  }

  return {}
}

function mergeBindings(config: KeyBindingsConfig): KeyBinding[] {
  const bindings: KeyBinding[] = []

  bindings.push({
    key: config.global?.interrupt ?? 'c',
    ctrl: true,
    action: 'interrupt',
    context: 'global',
  })

  bindings.push({
    key: config.global?.exit ?? 'd',
    ctrl: true,
    action: 'exit',
    context: 'global',
  })

  bindings.push({
    key: config.global?.clear ?? 'l',
    ctrl: true,
    action: 'clear',
    context: 'global',
  })

  bindings.push({
    key: config.chat?.cancel ?? 'escape',
    action: 'cancel',
    context: 'chat',
  })

  bindings.push({
    key: config.chat?.submit ?? 'return',
    action: 'submit',
    context: 'chat',
  })

  bindings.push({
    key: config.chat?.historyUp ?? 'up',
    action: 'history-up',
    context: 'chat',
  })

  bindings.push({
    key: config.chat?.historyDown ?? 'down',
    action: 'history-down',
    context: 'chat',
  })

  bindings.push({
    key: config.editing?.lineStart ?? 'a',
    ctrl: true,
    action: 'line-start',
    context: 'chat',
  })

  bindings.push({
    key: config.editing?.lineEnd ?? 'e',
    ctrl: true,
    action: 'line-end',
    context: 'chat',
  })

  bindings.push({
    key: config.editing?.killLine ?? 'k',
    ctrl: true,
    action: 'kill-line',
    context: 'chat',
  })

  bindings.push({
    key: config.editing?.killLineBackward ?? 'u',
    ctrl: true,
    action: 'kill-line-backward',
    context: 'chat',
  })

  bindings.push({
    key: config.editing?.killWord ?? 'w',
    ctrl: true,
    action: 'kill-word',
    context: 'chat',
  })

  // Autocomplete bindings
  bindings.push({
    key: config.autocomplete?.accept ?? 'tab',
    action: 'autocomplete.accept',
    context: 'autocomplete',
  })
  bindings.push({
    key: config.autocomplete?.next ?? 'down',
    action: 'autocomplete.next',
    context: 'autocomplete',
  })
  bindings.push({
    key: config.autocomplete?.previous ?? 'up',
    action: 'autocomplete.previous',
    context: 'autocomplete',
  })
  bindings.push({
    key: config.autocomplete?.close ?? 'escape',
    action: 'autocomplete.close',
    context: 'autocomplete',
  })

  return bindings
}

function matchesKey(binding: KeyBinding, input: string, key: { ctrl?: boolean; shift?: boolean; meta?: boolean; escape?: boolean; return?: boolean; upArrow?: boolean; downArrow?: boolean; backspace?: boolean; delete?: boolean }): boolean {
  // Check key name
  let keyMatches = false
  if (binding.key === 'escape' && key.escape) keyMatches = true
  else if (binding.key === 'return' && key.return) keyMatches = true
  else if (binding.key === 'up' && key.upArrow) keyMatches = true
  else if (binding.key === 'down' && key.downArrow) keyMatches = true
  else if (binding.key === 'backspace' && key.backspace) keyMatches = true
  else if (binding.key === 'delete' && key.delete) keyMatches = true
  else if (binding.key === input) keyMatches = true

  if (!keyMatches) return false

  // Check modifiers
  if (binding.ctrl && !key.ctrl) return false
  if (binding.shift && !key.shift) return false
  if (binding.meta && !key.meta) return false

  // If binding has no modifiers, ensure key has no modifiers (for regular keys)
  if (!binding.ctrl && !binding.shift && !binding.meta) {
    if (key.ctrl || key.shift || key.meta) return false
  }

  return true
}

export function useKeyBindings(
  context: KeyBindingContext,
  handlers: Record<string, () => void>,
  customBindings?: KeyBinding[],
) {
  const [configBindings, setConfigBindings] = useState<KeyBinding[]>(defaultBindings)

  useEffect(() => {
    let cancelled = false

    loadKeyBindingsConfig().then(config => {
      if (!cancelled) {
        const merged = mergeBindings(config)
        setConfigBindings(merged)
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  const bindings = customBindings ?? configBindings

  useInput((input, key) => {
    // First check context-specific bindings
    for (const binding of bindings) {
      if (binding.context !== context) continue
      if (matchesKey(binding, input, key)) {
        handlers[binding.action]?.()
        return
      }
    }

    // Then check global bindings
    for (const binding of bindings) {
      if (binding.context !== 'global') continue
      if (matchesKey(binding, input, key)) {
        handlers[binding.action]?.()
        return
      }
    }
  })
}
