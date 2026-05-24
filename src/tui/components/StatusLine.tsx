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

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text color={theme.dimText} dimColor>
          {model} ({providerName}) [{permissionMode}]
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
