import { render } from 'ink'
import { App } from './app.js'
import type { Config } from '../config/service.js'

export function renderAndRun(config: Config, cwd: string, resumeSessionId?: string) {
  const { unmount, waitUntilExit } = render(
    <App config={config} cwd={cwd} resumeSessionId={resumeSessionId} />,
    { exitOnCtrlC: false },
  )

  return { unmount, waitUntilExit }
}
