import readline from 'node:readline'
import { getAllTools } from './tools/index.js'
import type { Tool } from './harness/types.js'
import { registerBuiltinCommands, getCommand } from './commands/index.js'

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

// Register built-in commands
registerBuiltinCommands()

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
    const [cmdName, ...argsParts] = trimmed.slice(1).split(' ')
    const command = getCommand(cmdName)
    if (command) {
      const context = {
        cwd,
        sessionId: 'cli',
        writeLine: (msg: string) => console.log(msg),
        clearMessages: () => { session.messages = [] },
      }
      await command.run(argsParts.join(' '), context)
    } else {
      console.log(`Unknown command: /${cmdName}. Type /help for available commands.`)
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
