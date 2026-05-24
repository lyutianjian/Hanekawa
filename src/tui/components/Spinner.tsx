import { Box, Text } from 'ink'
import { useSpinner } from '../hooks/useSpinner.js'
import { theme } from '../theme.js'

const BASE_COLOR = theme.brand
const SHIMMER_COLOR = '#FFB6C1'

export function Spinner() {
  const { frame, glimmerIndex, glimmerWindow, elapsed } = useSpinner()

  const message = `Thinking... ${elapsed}s`
  const shimmerStart = glimmerIndex - Math.floor(glimmerWindow / 2)
  const shimmerEnd = shimmerStart + glimmerWindow

  const before = message.slice(0, Math.max(0, shimmerStart))
  const shim = message.slice(Math.max(0, shimmerStart), Math.min(message.length, shimmerEnd))
  const after = message.slice(Math.min(message.length, shimmerEnd))

  return (
    <Box>
      <Text color={BASE_COLOR}>{frame} </Text>
      {before && <Text color={BASE_COLOR}>{before}</Text>}
      <Text color={SHIMMER_COLOR}>{shim}</Text>
      {after && <Text color={BASE_COLOR}>{after}</Text>}
    </Box>
  )
}
