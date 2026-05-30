import { z } from 'zod/v3'
import type { Tool } from '../../harness/types.js'
import { validateJsonSchemaInput, type JsonSchema } from '../../harness/toolValidation.js'
import type { McpToolClient } from './client.js'
import type { McpTool } from './types.js'

const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000

export function wrapMcpTool(serverName: string, mcpTool: McpTool, client: McpToolClient): Tool {
  const hasReadOnlyHint = hasMcpReadOnlyHint(mcpTool)

  return {
    name: `mcp__${serverName}__${mcpTool.name}`,
    description: mcpTool.description,
    inputSchema: z.unknown(),
    apiInputSchema: normalizeMcpInputSchema(mcpTool.inputSchema),
    validateInput: (input) => validateJsonSchemaInput(mcpTool.inputSchema, input),
    riskLevel: hasReadOnlyHint ? 'safe' : 'confirm',
    isReadOnly: hasReadOnlyHint,
    isConcurrencySafe: hasReadOnlyHint,
    async execute(input, context) {
      const result = await client.callTool({
        name: mcpTool.name,
        arguments: input as Record<string, unknown>,
      }, undefined, {
        signal: context.abortSignal,
        timeout: DEFAULT_MCP_TOOL_TIMEOUT_MS,
      })

      const content = 'content' in result
        ? stringifyMcpContent(result.content)
        : JSON.stringify(result.toolResult)

      return {
        ok: !('isError' in result && result.isError),
        content: content || '(no output)',
      }
    },
  }
}

function hasMcpReadOnlyHint(mcpTool: McpTool): boolean {
  // Trust tool-level annotations (standard MCP location).
  return readOnlyHintFromRecord(mcpTool.annotations)
    // Also accept mcp_readonly_hint in inputSchema (legacy convention used by
    // some MCP servers). Do NOT accept generic readOnlyHint in inputSchema
    // since inputSchema is server-controlled and could be spoofed.
    || mcpReadonlyHintFromSchema(mcpTool.inputSchema)
}

function readOnlyHintFromRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.mcp_readonly_hint === true || record.readOnlyHint === true) return true
  return readOnlyHintFromRecord(record.annotations)
}

function mcpReadonlyHintFromSchema(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  // Only accept mcp_readonly_hint, not generic readOnlyHint
  if (record.mcp_readonly_hint === true) return true
  return mcpReadonlyHintFromSchema(record.annotations)
}

function stringifyMcpContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content)

  return content.map((item) => {
    if (!item || typeof item !== 'object') return JSON.stringify(item)
    const block = item as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string') return block.text
    return JSON.stringify(block)
  }).join('\n')
}

function normalizeMcpInputSchema(schema: unknown): JsonSchema {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    return schema as JsonSchema
  }
  return {
    type: 'object',
    properties: {},
    additionalProperties: false,
  }
}
