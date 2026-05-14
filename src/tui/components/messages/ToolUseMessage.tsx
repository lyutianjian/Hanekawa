import React, { useState } from 'react'
import { Box, Text } from '../../ink.js'

type Props = {
  id: string
  name: string
  input: unknown
  verbose?: boolean
}

// 工具图标映射
const TOOL_ICONS: Record<string, string> = {
  bash: '$',
  readFile: '📖',
  writeFile: '✏️',
  editFile: '✏️',
  deleteFile: '🗑',
  glob: '🔍',
  grep: '🔍',
  webSearch: '🌐',
  skillTool: '⚡',
  taskCreate: '📋',
  taskUpdate: '📋',
  taskList: '📋',
  taskGet: '📋',
}

export function ToolUseMessage({ id, name, input, verbose }: Props) {
  const [expanded, setExpanded] = useState(false)
  const icon = TOOL_ICONS[name] || '⚡'

  const inputStr = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
  const truncated = inputStr.length > 200 ? inputStr.slice(0, 200) + '...' : inputStr

  // 提取关键参数摘要
  const getSummary = (): string => {
    if (!input || typeof input !== 'object') return ''
    const obj = input as Record<string, unknown>
    if (obj.command) return String(obj.command).slice(0, 100)
    if (obj.path) return String(obj.path)
    if (obj.pattern) return String(obj.pattern)
    if (obj.query) return String(obj.query)
    return truncated.slice(0, 80)
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="yellow"> {'│'} </Text>
        <Text color="yellow">{icon} </Text>
        <Text bold color="yellow">{name}</Text>
        <Text dimColor> {getSummary()}</Text>
      </Box>
      {(verbose || expanded) && inputStr && (
        <Box marginLeft={3}>
          <Text dimColor>{verbose ? inputStr : truncated}</Text>
        </Box>
      )}
    </Box>
  )
}
