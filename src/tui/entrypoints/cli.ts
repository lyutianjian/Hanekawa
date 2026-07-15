import type { SessionMeta } from '../../sessions/service.js'

export type TuiStartupCommand =
  | ({ kind: 'new' } & TuiStartupOptions)
  | ({ kind: 'resume'; sessionId: string } & TuiStartupOptions)
  | ({ kind: 'continue' } & TuiStartupOptions)
  | ({ kind: 'list' } & TuiStartupOptions)

export interface TuiStartupOptions {
  otlpEndpoint?: string
}

export interface TuiSessionStore {
  createDraft(): SessionMeta | Promise<SessionMeta>
  list(): Promise<SessionMeta[]>
  resolve(idOrPrefix: string): Promise<SessionMeta | undefined>
}

export function isResumableSession(session: SessionMeta): boolean {
  return session.messageCount > 0
}

export const TUI_USAGE = 'Usage: myagent-tui [--otlp-endpoint <url>] [new|--continue|c|resume <id>|list]'

export function parseTuiStartupCommand(args: string[]): TuiStartupCommand {
  const parsed = parseStartupOptions(args)
  const command = parsed.args[0] ?? 'new'
  const options = parsed.otlpEndpoint ? { otlpEndpoint: parsed.otlpEndpoint } : {}
  switch (command) {
    case 'new':
      return { kind: 'new', ...options }
    case '--continue':
    case 'c':
      return { kind: 'continue', ...options }
    case 'resume': {
      const sessionId = parsed.args[1]
      if (!sessionId) {
        throw new Error('Usage: myagent-tui resume <session-id-or-prefix>')
      }
      return { kind: 'resume', sessionId, ...options }
    }
    case 'list':
      return { kind: 'list', ...options }
    default:
      throw new Error(`Unknown command: ${command}\n${TUI_USAGE}`)
  }
}

export async function resolveStartupSession(
  command: Exclude<TuiStartupCommand, { kind: 'list' }>,
  store: TuiSessionStore,
): Promise<SessionMeta> {
  switch (command.kind) {
    case 'new':
      return store.createDraft()
    case 'resume': {
      const resolved = await store.resolve(command.sessionId)
      if (!resolved) {
        throw new Error(`Session not found: ${command.sessionId}`)
      }
      return resolved
    }
    case 'continue': {
      const latest = (await store.list()).find(isResumableSession)
      if (!latest) {
        throw new Error('No sessions found to continue.')
      }
      return latest
    }
  }
}

function parseStartupOptions(args: string[]): { args: string[]; otlpEndpoint?: string } {
  const positional: string[] = []
  let otlpEndpoint: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--otlp-endpoint') {
      const value = args[index + 1]
      if (!value) throw new Error('Usage: myagent-tui --otlp-endpoint <url>')
      otlpEndpoint = value
      index += 1
      continue
    }
    if (arg?.startsWith('--otlp-endpoint=')) {
      const value = arg.slice('--otlp-endpoint='.length)
      if (!value) throw new Error('Usage: myagent-tui --otlp-endpoint <url>')
      otlpEndpoint = value
      continue
    }
    if (arg) positional.push(arg)
  }
  return otlpEndpoint ? { args: positional, otlpEndpoint } : { args: positional }
}
