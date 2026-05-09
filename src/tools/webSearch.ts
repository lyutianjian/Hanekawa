import type { Tool } from '../harness/types.js'

export const webSearchTool: Tool = {
  name: 'webSearch',
  description: 'Search the web (placeholder - not implemented).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  riskLevel: 'safe',
  async execute(input) {
    const { query } = input as { query: string }
    return { ok: false, content: `Web search not implemented. Query was: ${query}` }
  },
}
