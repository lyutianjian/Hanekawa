import { ThemedText } from './ThemedText.js'

type StatusType = 'success' | 'error' | 'warning' | 'info' | 'pending' | 'in_progress'

interface StatusIconProps {
  status: StatusType
  size?: 'small' | 'medium'
}

const icons: Record<StatusType, { small: string; medium: string }> = {
  success: { small: '✓', medium: '✔' },
  error: { small: '✗', medium: '✘' },
  warning: { small: '⚠', medium: '⚠' },
  info: { small: 'ℹ', medium: 'ℹ' },
  pending: { small: '○', medium: '◎' },
  in_progress: { small: '●', medium: '◉' },
}

const colorMap: Record<StatusType, 'success' | 'error' | 'warning' | 'accent' | 'dimmed' | 'warning'> = {
  success: 'success',
  error: 'error',
  warning: 'warning',
  info: 'accent',
  pending: 'dimmed',
  in_progress: 'warning',
}

export function StatusIcon({ status, size = 'small' }: StatusIconProps) {
  const icon = icons[status][size]
  const color = colorMap[status]

  return <ThemedText color={color}>{icon}</ThemedText>
}
