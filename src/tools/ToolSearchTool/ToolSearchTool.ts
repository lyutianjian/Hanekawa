import { z } from 'zod/v3'
import type { Tool, ToolContext, ToolResult, ToolResultBlockParam } from '../../harness/types.js'
import { toolToAPISchema } from '../../harness/toolApiSchema.js'
import { isDeferredTool, getPrompt, TOOL_SEARCH_TOOL_NAME } from './prompt.js'

/**
 * Parse tool name into searchable parts.
 * Handles both MCP tools (mcp__server__action) and regular tools (CamelCase).
 */
function parseToolName(name: string): {
  parts: string[]
  full: string
  isMcp: boolean
} {
  if (name.startsWith('mcp__')) {
    const withoutPrefix = name.replace(/^mcp__/, '').toLowerCase()
    const parts = withoutPrefix.split('__').flatMap(p => p.split('_'))
    return {
      parts: parts.filter(Boolean),
      full: withoutPrefix.replace(/__/g, ' ').replace(/_/g, ' '),
      isMcp: true,
    }
  }

  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  return {
    parts,
    full: parts.join(' '),
    isMcp: false,
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compileTermPatterns(terms: string[]): Map<string, RegExp> {
  const patterns = new Map<string, RegExp>()
  for (const term of terms) {
    if (!patterns.has(term)) {
      patterns.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`))
    }
  }
  return patterns
}

/**
 * Keyword-based search over tool names and descriptions.
 * Ported from ClaudeCode's ToolSearchTool scoring algorithm.
 */
function searchToolsWithKeywords(
  query: string,
  deferredTools: Tool[],
  allTools: Tool[],
  maxResults: number,
): string[] {
  const queryLower = query.toLowerCase().trim()

  // Fast path: exact name match
  const exactMatch =
    deferredTools.find(t => t.name.toLowerCase() === queryLower) ??
    allTools.find(t => t.name.toLowerCase() === queryLower)
  if (exactMatch) {
    return [exactMatch.name]
  }

  // MCP prefix match
  if (queryLower.startsWith('mcp__') && queryLower.length > 5) {
    const prefixMatches = deferredTools
      .filter(t => t.name.toLowerCase().startsWith(queryLower))
      .slice(0, maxResults)
      .map(t => t.name)
    if (prefixMatches.length > 0) {
      return prefixMatches
    }
  }

  const queryTerms = queryLower.split(/\s+/).filter(term => term.length > 0)

  // Partition into required (+prefixed) and optional terms
  const requiredTerms: string[] = []
  const optionalTerms: string[] = []
  for (const term of queryTerms) {
    if (term.startsWith('+') && term.length > 1) {
      requiredTerms.push(term.slice(1))
    } else {
      optionalTerms.push(term)
    }
  }

  const allScoringTerms =
    requiredTerms.length > 0 ? [...requiredTerms, ...optionalTerms] : queryTerms
  const termPatterns = compileTermPatterns(allScoringTerms)

  // Pre-filter to tools matching ALL required terms
  let candidateTools = deferredTools
  if (requiredTerms.length > 0) {
    candidateTools = deferredTools.filter(tool => {
      const parsed = parseToolName(tool.name)
      const descNormalized = tool.description.toLowerCase()
      const hintNormalized = tool.searchHint?.toLowerCase() ?? ''
      return requiredTerms.every(term => {
        const pattern = termPatterns.get(term)!
        return (
          parsed.parts.includes(term) ||
          parsed.parts.some(part => part.includes(term)) ||
          pattern.test(descNormalized) ||
          (hintNormalized && pattern.test(hintNormalized))
        )
      })
    })
  }

  const scored = candidateTools.map(tool => {
    const parsed = parseToolName(tool.name)
    const descNormalized = tool.description.toLowerCase()
    const hintNormalized = tool.searchHint?.toLowerCase() ?? ''

    let score = 0
    for (const term of allScoringTerms) {
      const pattern = termPatterns.get(term)!

      if (parsed.parts.includes(term)) {
        score += parsed.isMcp ? 12 : 10
      } else if (parsed.parts.some(part => part.includes(term))) {
        score += parsed.isMcp ? 6 : 5
      }

      if (parsed.full.includes(term) && score === 0) {
        score += 3
      }

      if (hintNormalized && pattern.test(hintNormalized)) {
        score += 4
      }

      if (pattern.test(descNormalized)) {
        score += 2
      }
    }

    return { name: tool.name, score }
  })

  return scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(item => item.name)
}

/**
 * Build the JSON schema text for matched tools (used by OpenAI provider).
 */
function buildSchemasText(matchNames: string[], allTools: Tool[]): string {
  const lines: string[] = []
  for (const name of matchNames) {
    const tool = allTools.find(t => t.name === name)
    if (!tool) continue
    const schema = toolToAPISchema(tool)
    lines.push(JSON.stringify({ description: tool.description, name: tool.name, parameters: schema }, null, 2))
  }
  return `<functions>\n${lines.join('\n')}\n</functions>`
}

const inputSchema = z.object({
  query: z.string().describe(
    'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.',
  ),
  max_results: z.number().optional().default(5).describe('Maximum number of results to return (default: 5)'),
})

/**
 * Structured output from ToolSearchTool.call().
 * Mirrors ClaudeCode's Output type — the actual API serialization
 * is handled by mapToolResultToToolResultBlockParam.
 */
interface ToolSearchOutput {
  matches: string[]
  query: string
  totalDeferredTools: number
}

export const toolSearchTool: Tool = {
  name: TOOL_SEARCH_TOOL_NAME,
  description: getPrompt(),
  inputSchema,
  riskLevel: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultSizeChars: 100_000,

  /**
   * Returns tool_result with provider-appropriate content.
   *
   * For Anthropic: returns tool_reference blocks that the API expands server-side.
   * For OpenAI: returns schemas as formatted <functions> text (no tool_reference).
   *
   * The `result` parameter is the ToolResult from execute(), where content
   * is JSON.stringify(ToolSearchOutput). We parse it to extract matches.
   * The optional `context` provides _allTools for schema lookup (OpenAI path).
   */
  mapToolResultToToolResultBlockParam(result: unknown, toolUseID: string, context?: ToolContext): ToolResultBlockParam {
    // result is ToolResult {ok, content: string} — parse the JSON content
    const toolResult = result as { ok: boolean; content: string }
    let matches: string[] = []
    try {
      const parsed = JSON.parse(toolResult.content)
      if (Array.isArray(parsed.matches)) {
        matches = parsed.matches
      }
    } catch {
      // Not JSON — shouldn't happen
    }

    if (matches.length === 0) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseID,
        content: 'No matching deferred tools found',
      }
    }

    const isAnthropic = !context?.providerName || context.providerName === 'anthropic'
    if (isAnthropic) {
      // Return tool_reference blocks — the Anthropic API expands these
      // into full tool definitions in the model's context.
      return {
        type: 'tool_result',
        tool_use_id: toolUseID,
        content: matches.map(name => ({
          type: 'tool_reference' as const,
          tool_name: name,
        })),
      }
    }

    // OpenAI: return schemas as formatted text (no tool_reference equivalent)
    const allTools = context?._allTools ?? []
    const schemasText = buildSchemasText(matches, allTools)
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: schemasText,
    }
  },

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = inputSchema.safeParse(input)
    if (!parsed.success) {
      return { content: `Invalid input: ${parsed.error.message}`, ok: false }
    }

    const { query, max_results = 5 } = parsed.data
    const tools: Tool[] = context._allTools ?? []
    const deferredTools = tools.filter(isDeferredTool)

    // Check for select: prefix — direct tool selection
    const selectMatch = query.match(/^select:(.+)$/i)
    if (selectMatch) {
      const requested = selectMatch[1]!
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)

      const found: string[] = []
      const missing: string[] = []
      for (const toolName of requested) {
        const tool =
          deferredTools.find(t => t.name.toLowerCase() === toolName.toLowerCase()) ??
          tools.find(t => t.name.toLowerCase() === toolName.toLowerCase())
        if (tool) {
          if (!found.includes(tool.name)) found.push(tool.name)
        } else {
          missing.push(toolName)
        }
      }

      // Always return JSON so trackDiscoveredTools can parse matches for both providers.
      // mapToolResultToToolResultBlockParam handles Anthropic tool_reference;
      // OpenAI gets schemas as text via buildSchemasText in the tool_result content.
      const output: ToolSearchOutput = { matches: found, query, totalDeferredTools: deferredTools.length }
      return { content: JSON.stringify(output), ok: true }
    }

    // Keyword search
    const matches = searchToolsWithKeywords(query, deferredTools, tools, max_results)

    const output: ToolSearchOutput = { matches, query, totalDeferredTools: deferredTools.length }
    return { content: JSON.stringify(output), ok: true }
  },
}
