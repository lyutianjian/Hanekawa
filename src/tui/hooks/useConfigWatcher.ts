import { useState, useEffect } from 'react'
import { watch } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Config = {
  theme?: string
  verbose?: boolean
  model?: string
  [key: string]: unknown
}

export function useConfigWatcher(configDir: string = '.myagent') {
  const [config, setConfig] = useState<Config>({})
  const configPath = join(configDir, 'config.json')

  useEffect(() => {
    // 初始加载
    try {
      const data = readFileSync(configPath, 'utf-8')
      setConfig(JSON.parse(data))
    } catch {
      // 配置文件不存在
    }

    // 文件监听
    let watcher: ReturnType<typeof watch> | null = null
    try {
      watcher = watch(configPath, (eventType) => {
        if (eventType === 'change') {
          try {
            const data = readFileSync(configPath, 'utf-8')
            setConfig(JSON.parse(data))
          } catch {
            // 静默失败
          }
        }
      })
    } catch {
      // 监听失败
    }

    return () => {
      watcher?.close()
    }
  }, [configPath])

  return config
}
