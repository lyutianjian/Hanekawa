#!/usr/bin/env node

import readline from 'node:readline'
import { ConfigService } from '../config/service.js'
import { createProvider } from '../config/providers.js'
import { SessionStore, type SessionMeta } from '../sessions/service.js'
import { getBuiltinTools } from '../tools/index.js'
import { PermissionGate } from '../harness/permissions.js'
import { ToolRunner } from '../harness/toolRunner.js'
import { ContextBuilder } from '../harness/contextBuilder.js'
import { AgentLoop } from '../harness/loop.js'
import type { SessionRecord } from '../harness/types.js'
import type { PermissionRequest } from '../harness/permissions.js'

const cwd = process.cwd()

async function main() {
  const args = process.argv.slice(2)
  const command = args[0] ?? 'help'

  switch (command) {
    case 'help':
      printHelp()
      break

    case 'new':
      await runNewSession()
      break

    case 'list':
      await listSessions()
      break

    case 'resume': {
      const sessionId = args[1]
      if (!sessionId) {
        console.error('Usage: myagent resume <session-id-or-prefix>')
        process.exit(1)
      }
      await resumeSession(sessionId)
      break
    }

    default:
      console.error(`Unknown command: ${command}`)
      console.error('Run "myagent help" for usage information')
      process.exit(1)
  }
}

function printHelp() {
  console.log(`
MyAgent CLI

Usage:
  myagent [command]

Commands:
  new             Start a new interactive session
  list            List saved sessions with usable IDs
  resume <id>     Resume a session by full ID or unambiguous prefix
  help            Show this help message

During a session:
  - type your prompt and press Enter
  - type /exit to quit
`)
}

async function runNewSession() {
  const store = new SessionStore(cwd)
  await store.init()
  const session = await store.create()
  await startInteractiveSession(session)
}

async function resumeSession(sessionId: string) {
  const store = new SessionStore(cwd)
  await store.init()
  const session = await store.resolve(sessionId)
  if (!session) {
    console.error(`Session not found or ambiguous: ${sessionId}`)
    process.exit(1)
  }
  await startInteractiveSession(session)
}

async function startInteractiveSession(session: SessionMeta) {
  const config = new ConfigService(cwd)
  await config.load()

  const modelConfig = config.getDefaultModel()
  if (!modelConfig) {
    console.error('No default model configured.')
    process.exit(1)
  }

  const provider = createProvider(modelConfig)
  if (!provider) {
    console.error(`Failed to create provider for: ${modelConfig.provider}`)
    process.exit(1)
  }

  const store = new SessionStore(cwd)
  await store.init()
  const tools = getBuiltinTools()
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const permissionGate = new PermissionGate((request) => promptPermission(rl, request))
  const toolRunner = new ToolRunner(tools, permissionGate, {
    onRecord: async (record) => {
      await store.appendRecord(session.id, record)
    },
  })

  const loop = new AgentLoop({
    provider,
    model: modelConfig.model,
    maxTokens: config.get().agent.maxTokens,
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner,
    toolContext: { cwd, sessionId: session.id, readFiles: new Set() },
    system: config.get().agent.system,
    loadRecords: async () => store.loadRecords(session.id),
    appendRecord: async (record) => store.appendRecord(session.id, record),
  })

  const records = await store.loadRecords(session.id)
  const messageCount = records.filter((record) => record.type === 'message').length
  console.log(`Session: ${session.shortId} (${session.id})`)
  console.log(`Using model: ${modelConfig.model} (${provider.name} format)`)
  if (modelConfig.baseUrl) {
    console.log(`Provider wire format: ${provider.name}`)
  }
  if (messageCount > 0) {
    console.log(`Loaded ${messageCount} previous messages.`)
  }
  console.log('Type /exit to quit.\n')

  const prompt = () => {
    rl.question('> ', async (input) => {
      const trimmed = input.trim()
      if (trimmed === '/exit' || trimmed === 'exit') {
        rl.close()
        return
      }
      if (!trimmed) {
        prompt()
        return
      }

      try {
        console.log('\nThinking...\n')
        const response = await loop.run(trimmed)
        if (response) console.log(response)
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
      }

      console.log()
      prompt()
    })
  }

  prompt()
}

async function promptPermission(rl: readline.Interface, request: PermissionRequest): Promise<boolean> {
  const summary = JSON.stringify(request.input)
  const answer = await askQuestion(
    rl,
    `[permission] ${request.tool.name}: ${request.reason}\ninput: ${summary}\nAllow? (y/N) `,
  )
  return /^(y|yes)$/i.test(answer.trim())
}

function askQuestion(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve)
  })
}

async function listSessions() {
  const store = new SessionStore(cwd)
  await store.init()

  const sessions = await store.list()
  if (sessions.length === 0) {
    console.log('No sessions found.')
    return
  }

  console.log('Sessions:\n')
  for (const session of sessions) {
    const date = new Date(session.updatedAt).toLocaleString()
    const title = session.title ?? '(untitled)'
    console.log(`  ${session.shortId}  ${session.id}  ${session.messageCount} msgs  ${date}  ${title}`)
  }
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
