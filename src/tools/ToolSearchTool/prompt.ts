import type { Tool } from '../../harness/types.js'
import { TOOL_SEARCH_TOOL_NAME } from './constants.js'

export { TOOL_SEARCH_TOOL_NAME } from './constants.js'

const PROMPT_HEAD = `Fetches full schema definitions for deferred tools so they can be called.
`

const PROMPT_TAIL = ` Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block. Once a tool's schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.

Result format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside the <functions> block — the same encoding as the tool list at the top of this prompt.

Query forms:
- "select:Read,Edit,Grep" — fetch these exact tools by name
- "notebook jupyter" — keyword search, up to max_results best matches
- "+slack send" — require "slack" in the name, rank by remaining terms`

/**
 * Check if a tool should be deferred (requires ToolSearch to load).
 */
export function isDeferredTool(tool: Tool): boolean {
  if (tool.alwaysLoad === true) return false
  if (tool.name === TOOL_SEARCH_TOOL_NAME) return false
  if (tool.isMcp === true) return true
  if (tool.shouldDefer === true) return true
  return false
}

/**
 * Format one deferred-tool line for the available-deferred-tools announcement.
 */
export function formatDeferredToolLine(tool: Tool): string {
  return tool.name
}

export function getPrompt(): string {
  return PROMPT_HEAD + PROMPT_TAIL
}
