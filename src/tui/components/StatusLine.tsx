import { Box, Text } from 'ink'
import { theme } from '../theme.js'
import { formatUsageLine } from '../../harness/usage.js'
import { formatCacheHitRate } from '../../harness/cacheBreakDetection.js'
import type { TUIUsage } from '../types.js'
import type { ModelPricing } from '../../harness/types.js'
import type { PermissionMode } from '../../harness/permissions.js'

interface StatusLineProps {
  model: string
  providerName: string
  usage: TUIUsage
  pricing?: ModelPricing
  permissionMode: PermissionMode
  hintMessage?: string | null
}

export function StatusLine({ model, providerName, usage, pricing, permissionMode, hintMessage }: StatusLineProps) {
  const cacheText = formatCacheHitRate(usage.total)
  const usageText = usage.current
    ? `${formatUsageLine(usage.total, pricing)} | ${cacheText}`
    : `Ready | ${cacheText}`
  const modeStyle = permissionModeStyle(permissionMode)

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text color={theme.dimText} dimColor>
          {model} ({providerName}){' '}
          <Text color={modeStyle.color} bold={modeStyle.bold}>
            [{modeStyle.label}]
          </Text>
        </Text>
        <Text color={theme.dimText} dimColor>
          {usageText}
        </Text>
      </Box>
      {hintMessage && (
        <Box>
          <Text color={theme.brand}>{hintMessage}</Text>
        </Box>
      )}
    </Box>
  )
}

function permissionModeStyle(mode: PermissionMode): { label: string; color: string; bold?: boolean } {
  switch (mode) {
    case 'plan':
      return { label: 'plan', color: theme.warning, bold: true }
    case 'acceptEdits':
      return { label: 'accept-edits', color: theme.success, bold: true }
    case 'auto':
      return { label: 'auto', color: theme.toolName }
    case 'bypass':
      return { label: 'bypass', color: theme.error, bold: true }
    case 'default':
    default:
      return { label: 'default', color: theme.dimText }
  }
}
