import { Box } from 'ink'
import { ThemeProvider } from './design-system/ThemeProvider.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'
import { REPL } from './screens/REPL.js'
import type { Config } from '../config/service.js'

interface AppProps {
  config: Config
  cwd: string
  resumeSessionId?: string
}

export function App({ config, cwd, resumeSessionId }: AppProps) {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultMode="dark">
        <Box flexDirection="column" padding={0}>
          <REPL config={config} cwd={cwd} resumeSessionId={resumeSessionId} />
        </Box>
      </ThemeProvider>
    </ErrorBoundary>
  )
}
