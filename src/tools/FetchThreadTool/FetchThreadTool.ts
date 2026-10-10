import { z } from 'zod/v3'
import type { Tool } from '../../harness/types.js'
import type { CoordinationHost } from '../../runtime/protocol/coordinationHost.js'
import { callerOf, guarded, quotedThreadData, THREAD_DATA_NOTICE } from '../coordinationShared.js'
import { DESCRIPTION, FETCH_THREAD_TOOL_NAME } from './prompt.js'

export { FETCH_THREAD_TOOL_NAME }

export const fetchThreadInputSchema = z.object({
  threadId: z.string().trim().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

export function createFetchThreadTool(host: CoordinationHost): Tool {
  return {
    name: FETCH_THREAD_TOOL_NAME,
    sessionRoles: ['coordinator'],
    description: DESCRIPTION,
    inputSchema: fetchThreadInputSchema,
    riskLevel: 'safe',
    isReadOnly: true,
    isConcurrencySafe: true,
    userFacingName: () => 'FetchThread',
    async execute(rawInput, context) {
      const input = fetchThreadInputSchema.parse(rawInput)
      return guarded('FetchThread', async () => {
        const caller = callerOf(context)
        const page = await host.fetchThread(caller, input.threadId, {
          ...(input.offset === undefined ? {} : { offset: input.offset }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        })
        const parts = [THREAD_DATA_NOTICE, `Brief:\n${quotedThreadData(page.brief)}`]
        parts.push(page.lastReport === undefined ? 'Last report: none yet.' : `Last report:\n${quotedThreadData(page.lastReport)}`)
        parts.push(
          page.messages.length === 0
            ? 'Messages: none.'
            : `Messages (oldest first):\n${page.messages.map((m) => `[${m.role}${m.at === undefined ? '' : ` ${m.at}`}]\n${quotedThreadData(m.text)}`).join('\n')}`,
        )
        if (page.nextOffset !== undefined) parts.push(`Older messages remain: call again with offset ${page.nextOffset}.`)
        return {
          ok: true,
          content: parts.join('\n\n'),
          metadata: { display: { summary: `Read ${page.messages.length} messages` } },
        }
      })
    },
  }
}
