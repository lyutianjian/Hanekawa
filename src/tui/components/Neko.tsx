import { Box, Text } from 'ink'
import { theme } from '../theme.js'

export function Neko() {
  return (
    <Box flexDirection="column" alignItems="center">
      <Text color={theme.brand}>{'  /\\_/\\ '}</Text>
      <Text color={theme.brand}>{' ( o.o )'}</Text>
      <Text color={theme.brand}>{'  > ^ < '}</Text>
    </Box>
  )
}
