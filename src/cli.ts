import readline from 'node:readline'
import { getAllTools } from './tools/index.js'
import type { Tool } from './harness/types.js'
import { handleCommand } from './commands/index.js'

interface Session {
  messages: Array<{ role: string; content: Array<{ type: string; text: string }> }>
  tools: Tool[]
  cwd: string
}

const cwd = process.cwd()

const session: Session = {
  messages: [],
  tools: await getAllTools(cwd),
  cwd,
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '> '
})

rl.prompt()

rl.on('line', async (input) => {
  const trimmed = input.trim()
  if (!trimmed) {
    rl.prompt()
    return
  }

  if (trimmed.startsWith('/')) {
    const result = await handleCommand(trimmed, session)
    if (result.type === 'exit') {
      console.log('Goodbye!')
      rl.close()
      process.exit(0)
    }
    rl.prompt()
    return
  }

  session.messages.push({
    role: 'user',
    content: [{ type: 'text', text: trimmed }]
  })

  // TODO: Implement runSession
  console.log('Agent response not yet implemented.')

  rl.prompt()
})
