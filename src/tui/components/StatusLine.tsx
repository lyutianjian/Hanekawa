import { Box, Text } from 'ink'
import { theme } from '../theme.js'
import type { TUIUsage } from '../types.js'
import type { PermissionMode } from '../../harness/permissions.js'

const BAR_WIDTH = 20
const BAR_FULL = '█'
const BAR_EMPTY = '░'
const BAR_LEFT = '▕'
const BAR_RIGHT = '▏'
const BAR_FRAC = ['▏', '▎', '▍', '▌', '▋', '▊', '▉']

const EFFORT_SYMBOLS: Record<string, string> = {
  low:    '○',
  medium: '◐',
  high:   '●',
  xhigh:  '◉',
  max:    '◈',
}

const MODE_INDICATOR: Record<string, { icon: string; label: string; color: string }> = {
  acceptEdits: { icon: '⏵⏵', label: 'accept edits on', color: '#90EE90' },
  plan:        { icon: '⏸', label: 'plan mode on', color: '#8AB4F8' },
  auto:        { icon: '⏵⏵', label: 'auto mode on', color: '#FFD700' },
  bypass:      { icon: '⏵⏵', label: 'bypass mode on', color: '#FF6B6B' },
}

interface StatusLineProps {
  model: string
  usage: TUIUsage
  permissionMode: PermissionMode
  hintMessage?: string | null
  effortLevel?: string
  contextWindow?: number
  backgroundTaskCount?: number
}

export function StatusLine({ model, usage, permissionMode, hintMessage, effortLevel, contextWindow, backgroundTaskCount = 0 }: StatusLineProps) {
  const effortSymbol = effortLevel ? EFFORT_SYMBOLS[effortLevel] : undefined
  const modeInfo = permissionMode !== 'default' ? MODE_INDICATOR[permissionMode] : undefined

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text color={theme.subtleText}>
          {model}
          {'  '}{formatBar(usage, contextWindow)}{'  '}{formatStats(usage, contextWindow)}
        </Text>
        {effortSymbol && (
          <Text color={theme.subtleText}>{effortSymbol} {effortLevel}</Text>
        )}
      </Box>
      {hintMessage && (
        <Box>
          <Text color={theme.brand}>{hintMessage}</Text>
        </Box>
      )}
      {backgroundTaskCount > 0 && (
        <Box>
          <Text color={theme.subtleText}>{backgroundTaskCount} background task{backgroundTaskCount === 1 ? '' : 's'}</Text>
        </Box>
      )}
      {modeInfo && (
        <Box>
          <Text color={modeInfo.color}>{modeInfo.icon} {modeInfo.label} </Text>
          <Text color={theme.subtleText}>(shift+tab to cycle)</Text>
        </Box>
      )}
    </Box>
  )
}

function formatBar(usage: TUIUsage, contextWindow?: number): string {
  if (!contextWindow || !usage.lastRequest) return ''
  const used = usage.lastRequest.inputTokens + usage.lastRequest.cacheReadInputTokens
  const pct = Math.min(1, used / contextWindow)
  const raw = pct * BAR_WIDTH
  const full = Math.floor(raw)
  const frac = raw - full
  const fracIdx = Math.round(frac * 8) % 8
  const filled = BAR_FULL.repeat(full) + (fracIdx > 0 ? BAR_FRAC[fracIdx - 1] : '')
  const empty = BAR_EMPTY.repeat(BAR_WIDTH - full - (fracIdx > 0 ? 1 : 0))
  return `${BAR_LEFT}${filled}${empty}${BAR_RIGHT}`
}

function formatStats(usage: TUIUsage, contextWindow?: number): string {
  if (!usage.lastRequest) return 'Ready'
  const t = usage.lastRequest
  const used = t.inputTokens + t.cacheReadInputTokens
  const parts: string[] = []

  if (contextWindow) {
    parts.push(`${(used / contextWindow * 100).toFixed(1)}%`)
    parts.push(`${formatTokens(used)}/${formatTokens(contextWindow)}`)
  }
  if (t.cacheReadInputTokens > 0) {
    parts.push(`hit:${formatTokens(t.cacheReadInputTokens)}`)
  }
  parts.push(`in:${formatTokens(t.inputTokens)}`)
  parts.push(`out:${formatTokens(t.outputTokens)}`)

  return parts.join('  ')
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`
  return String(n)
}
