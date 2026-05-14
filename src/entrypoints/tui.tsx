#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { ConfigService } from '../config/service.js'
import { getMyAgentDir } from '../utils/paths.js'
import { renderAndRun } from '../tui/index.js'

async function main() {
  const args = process.argv.slice(2)

  let resumeSessionId: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--resume' && args[i + 1]) {
      resumeSessionId = args[i + 1]
      i++
    }
  }

  const cwd = process.cwd()
  const myagentDir = getMyAgentDir(cwd)

  if (!existsSync(myagentDir)) {
    console.error('No .myagent directory found. Run "myagent new" from a project root first.')
    process.exit(1)
  }

  const configService = new ConfigService(cwd)
  await configService.load()
  const config = configService.get()

  if (!config.defaultModel) {
    console.error('No default model configured. Check .myagent/config.json')
    process.exit(1)
  }

  const { waitUntilExit } = renderAndRun(config, cwd, resumeSessionId)
  await waitUntilExit()
}

main().catch((err) => {
  console.error('Fatal error:', err.message)
  process.exit(1)
})
