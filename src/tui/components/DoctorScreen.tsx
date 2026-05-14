import React, { useState, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import { Divider } from '../design-system/Divider.js'
import { StatusIcon } from '../design-system/StatusIcon.js'
import { detectTerminalCapabilities } from '../utils/terminalCapabilities.js'

type Props = {
  onClose: () => void
}

type Check = {
  name: string
  status: 'success' | 'error' | 'warning' | 'pending'
  detail?: string
}

export function DoctorScreen({ onClose }: Props) {
  const [checks, setChecks] = useState<Check[]>([
    { name: 'Node.js', status: 'pending' },
    { name: 'TypeScript', status: 'pending' },
    { name: 'Config file', status: 'pending' },
    { name: 'Session store', status: 'pending' },
    { name: 'API key', status: 'pending' },
    { name: 'Git repository', status: 'pending' },
    { name: 'MCP servers', status: 'pending' },
    { name: 'Terminal colors', status: 'pending' },
    { name: 'Unicode support', status: 'pending' },
  ])

  useEffect(() => {
    const runChecks = async () => {
      const results: Check[] = []

      // Node.js
      results.push({
        name: 'Node.js',
        status: 'success',
        detail: process.version,
      })

      // TypeScript
      try {
        const ts = await import('typescript')
        results.push({
          name: 'TypeScript',
          status: 'success',
          detail: ts.version,
        })
      } catch {
        results.push({ name: 'TypeScript', status: 'error', detail: 'Not found' })
      }

      // Config file
      try {
        const { existsSync } = await import('node:fs')
        const configPath = '.myagent/config.json'
        results.push({
          name: 'Config file',
          status: existsSync(configPath) ? 'success' : 'warning',
          detail: existsSync(configPath) ? 'Found' : 'Not found (using defaults)',
        })
      } catch {
        results.push({ name: 'Config file', status: 'warning', detail: 'Check failed' })
      }

      // Session store
      try {
        const { existsSync } = await import('node:fs')
        results.push({
          name: 'Session store',
          status: existsSync('.myagent/sessions') ? 'success' : 'warning',
          detail: existsSync('.myagent/sessions') ? 'Found' : 'Not found',
        })
      } catch {
        results.push({ name: 'Session store', status: 'warning', detail: 'Check failed' })
      }

      // API key
      const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY
      const hasOpenaiKey = !!process.env.OPENAI_API_KEY
      results.push({
        name: 'API key',
        status: hasAnthropicKey || hasOpenaiKey ? 'success' : 'error',
        detail: hasAnthropicKey ? 'ANTHROPIC_API_KEY set' : hasOpenaiKey ? 'OPENAI_API_KEY set' : 'No API key found',
      })

      // Git repository
      try {
        const { existsSync } = await import('node:fs')
        results.push({
          name: 'Git repository',
          status: existsSync('.git') ? 'success' : 'warning',
          detail: existsSync('.git') ? 'Found' : 'Not a git repo',
        })
      } catch {
        results.push({ name: 'Git repository', status: 'warning', detail: 'Check failed' })
      }

      // MCP servers
      try {
        const { existsSync } = await import('node:fs')
        const mcpConfig = existsSync('.myagent/mcp.json') || existsSync('.mcp.json')
        results.push({
          name: 'MCP servers',
          status: mcpConfig ? 'success' : 'warning',
          detail: mcpConfig ? 'Config found' : 'No MCP config',
        })
      } catch {
        results.push({ name: 'MCP servers', status: 'warning', detail: 'Check failed' })
      }

      // Terminal capabilities
      const caps = detectTerminalCapabilities()
      results.push({
        name: 'Terminal colors',
        status: caps.supportsTrueColor ? 'success' : caps.supports256Color ? 'success' : 'warning',
        detail: caps.supportsTrueColor ? 'True color' : caps.supports256Color ? '256 color' : 'Basic color',
      })
      results.push({
        name: 'Unicode support',
        status: caps.supportsUnicode ? 'success' : 'warning',
        detail: caps.supportsUnicode ? 'Yes' : 'No',
      })

      setChecks(results)
    }

    runChecks()
  }, [])

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose()
    }
  })

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Doctor — System Diagnostics</Text>
      <Divider />
      <Box flexDirection="column" marginTop={1}>
        {checks.map((check, i) => (
          <Box key={i}>
            <StatusIcon status={check.status} withSpace />
            <Text bold>{check.name}</Text>
            {check.detail && <Text dimColor> — {check.detail}</Text>}
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press Esc to close</Text>
      </Box>
    </Box>
  )
}
