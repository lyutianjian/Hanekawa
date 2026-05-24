import type { SessionMeta } from '../../sessions/service.js'

export type TuiStartupCommand =
  | { kind: 'new' }
  | { kind: 'resume'; sessionId: string }
  | { kind: 'continue' }
  | { kind: 'list' }

export interface TuiSessionStore {
  create(): Promise<SessionMeta>
  list(): Promise<SessionMeta[]>
  resolve(idOrPrefix: string): Promise<SessionMeta | undefined>
}

export const TUI_USAGE = 'Usage: myagent-tui [new|--continue|c|resume <id>|list]'

export function parseTuiStartupCommand(args: string[]): TuiStartupCommand {
  const command = args[0] ?? 'new'
  switch (command) {
    case 'new':
      return { kind: 'new' }
    case '--continue':
    case 'c':
      return { kind: 'continue' }
    case 'resume': {
      const sessionId = args[1]
      if (!sessionId) {
        throw new Error('Usage: myagent-tui resume <session-id-or-prefix>')
      }
      return { kind: 'resume', sessionId }
    }
    case 'list':
      return { kind: 'list' }
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
      return store.create()
    case 'resume': {
      const resolved = await store.resolve(command.sessionId)
      if (!resolved) {
        throw new Error(`Session not found: ${command.sessionId}`)
      }
      return resolved
    }
    case 'continue': {
      const latest = (await store.list())[0]
      if (!latest) {
        throw new Error('No sessions found to continue.')
      }
      return latest
    }
  }
}
