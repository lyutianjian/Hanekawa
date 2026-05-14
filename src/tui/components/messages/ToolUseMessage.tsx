import React from 'react'
import { Box, Text } from '../../ink.js'

type Props = {
  id: string
  name: string
  input: unknown
  verbose?: boolean
}

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
  const icon = TOOL_ICONS[name] || '⚡'

  const getSummary = (): string => {
    if (!input || typeof input !== 'object') return ''
    const obj = input as Record<string, unknown>
    if (obj.command) return String(obj.command).slice(0, 80)
    if (obj.path) return String(obj.path)
    if (obj.pattern) return String(obj.pattern)
    if (obj.query) return String(obj.query)
    if (obj.filePath) return String(obj.filePath)
    return JSON.stringify(input).slice(0, 60)
  }

  const summary = getSummary()

  return (
    <Box marginBottom={1} paddingX={1}>
      <Text color="yellow" dimColor>{icon} {name}</Text>
      {summary && <Text dimColor> — {summary}</Text>}
    </Box>
  )
}
