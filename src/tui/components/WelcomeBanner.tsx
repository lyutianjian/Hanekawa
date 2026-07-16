import { Box, Text, useStdout } from 'ink'
import { getSafeTerminalWidth } from '../layout.js'
import { theme } from '../theme.js'
import { Neko } from './Neko.js'

interface WelcomeBannerProps {
  sessionShortId: string
  model: string
  providerName: string
  cwd: string
}

const tips = [
  'Type your message and press Enter to send',
  'Use /help for available commands',
  'Press Ctrl+C to interrupt generation',
]

export function WelcomeBanner({ sessionShortId, model, providerName, cwd }: WelcomeBannerProps) {
  const { stdout } = useStdout()
  const terminalWidth = stdout.columns || 80
  const width = getSafeTerminalWidth(terminalWidth)
  const isCompact = terminalWidth < 70

  if (isCompact) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.brand}
        paddingX={1}
        paddingY={1}
        alignItems="center"
        width={width}
        marginBottom={1}
      >
        <Text color={theme.brand} bold>Hanekawa</Text>
        <Box marginY={1}>
          <Neko />
        </Box>
        <Box flexDirection="column" alignItems="center">
          <Text color={theme.dimText}>Model    {model} · {providerName}</Text>
          <Text color={theme.dimText}>Session  {sessionShortId}</Text>
          <Text color={theme.dimText}>CWD      {cwd}</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.brand}
      width={width}
      marginBottom={1}
    >
      <Box flexDirection="row" paddingX={1} gap={2}>
        {/* Left panel — title + avatar + info */}
        <Box
          flexDirection="column"
          alignItems="center"
          paddingY={1}
        >
          <Text color={theme.brand} bold>Welcome to Hanekawa</Text>
          <Box marginY={1}>
            <Neko />
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.dimText}>  Model    {model} · {providerName}</Text>
            <Text color={theme.dimText}>  Session  {sessionShortId}</Text>
            <Text color={theme.dimText}>  CWD      {cwd}</Text>
          </Box>
        </Box>

        {/* Vertical divider */}
        <Box
          height="100%"
          borderStyle="single"
          borderColor={theme.brand}
          borderDimColor
          borderTop={false}
          borderBottom={false}
          borderLeft={false}
        />

        {/* Right panel — tips */}
        <Box flexDirection="column" justifyContent="center" flexGrow={1}>
          <Text color={theme.brand} bold>Tips for getting started</Text>
          {tips.map((tip, i) => (
            <Text key={i} color={theme.dimText}>  · {tip}</Text>
          ))}
        </Box>
      </Box>
    </Box>
  )
}
