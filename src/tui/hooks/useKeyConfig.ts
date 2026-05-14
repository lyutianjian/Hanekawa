import { useState, useEffect } from 'react'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

type KeyBindings = Record<string, string>

const DEFAULT_BINDINGS: KeyBindings = {
  'submit': 'return',
  'cancel': 'escape',
  'interrupt': 'ctrl+c',
  'exit': 'ctrl+d',
  'clear': 'ctrl+l',
  'undo': 'ctrl+z',
  'search': 'ctrl+r',
  'help': 'f1',
}

export function useKeyConfig(configDir: string = '.myagent') {
  const [bindings, setBindings] = useState<KeyBindings>(DEFAULT_BINDINGS)

  useEffect(() => {
    const configPath = join(configDir, 'keybindings.json')
    try {
      if (existsSync(configPath)) {
        const saved = JSON.parse(readFileSync(configPath, 'utf-8'))
        setBindings({ ...DEFAULT_BINDINGS, ...saved })
      }
    } catch {
      // 使用默认绑定
    }
  }, [configDir])

  const saveBindings = (newBindings: KeyBindings) => {
    setBindings(newBindings)
    try {
      const configPath = join(configDir, 'keybindings.json')
      writeFileSync(configPath, JSON.stringify(newBindings, null, 2))
    } catch {
      // 静默失败
    }
  }

  return { bindings, saveBindings }
}
