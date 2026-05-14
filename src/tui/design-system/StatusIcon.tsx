// 复刻自 ClaudeCode/src/components/design-system/StatusIcon.tsx

import React from 'react'
import figures from 'figures'
import { Text } from 'ink'
import type { Theme } from './theme.js'

type Status = 'success' | 'error' | 'warning' | 'info' | 'pending' | 'loading'

type Props = {
  status: Status
  withSpace?: boolean
}

const STATUS_CONFIG: Record<Status, {
  icon: string
  color: keyof Theme | undefined
}> = {
  success: { icon: figures.tick, color: 'success' },
  error: { icon: figures.cross, color: 'error' },
  warning: { icon: figures.warning, color: 'warning' },
  info: { icon: figures.info, color: 'suggestion' },
  pending: { icon: figures.circle, color: undefined },
  loading: { icon: '…', color: undefined },
}

export function StatusIcon({ status, withSpace = false }: Props) {
  const config = STATUS_CONFIG[status]
  return (
    <Text color={config.color as any} dimColor={!config.color}>
      {config.icon}{withSpace && ' '}
    </Text>
  )
}
