import { z } from 'zod/v3'
import type { Tool } from '../../harness/types.js'
import type { CoordinationHost } from '../../runtime/protocol/coordinationHost.js'
import { callerOf, guarded, quotedThreadData, THREAD_DATA_NOTICE } from '../coordinationShared.js'
import { DESCRIPTION, LIST_THREADS_TOOL_NAME } from './prompt.js'

export { LIST_THREADS_TOOL_NAME }

export const listThreadsInputSchema = z.object({})

export function createListThreadsTool(host: CoordinationHost): Tool {
  return {
    name: LIST_THREADS_TOOL_NAME,
    sessionRoles: ['coordinator'],
    description: DESCRIPTION,
    inputSchema: listThreadsInputSchema,
    riskLevel: 'safe',
    isReadOnly: true,
    isConcurrencySafe: true,
    userFacingName: () => 'ListThreads',
    async execute(rawInput, context) {
      listThreadsInputSchema.parse(rawInput)
      return guarded('ListThreads', async () => {
        const caller = callerOf(context)
        const threads = await host.listThreads(caller)
        if (threads.length === 0) return { ok: true, content: 'No threads yet.', metadata: { display: { summary: 'No threads' } } }
        const lines = threads.map((t) => {
          const flags = [t.status, t.writesCode ? (t.branch ?? 'writes code') : 'read-only', ...(t.needsUser ? ['needs the user'] : [])]
          const when = t.lastActivityAt === undefined ? '' : ` | last activity ${t.lastActivityAt}`
          const report = t.lastReport === undefined ? '' : ` | report: ${quotedThreadData(t.lastReport)}`
          return `- ${t.threadId} ${quotedThreadData(t.title)} [${flags.join(', ')}]${when}${report}`
        })
        return {
          ok: true,
          content: `${THREAD_DATA_NOTICE}\n\n${lines.join('\n')}`,
          metadata: { display: { summary: `${threads.length} thread${threads.length === 1 ? '' : 's'}` } },
        }
      })
    },
  }
}
