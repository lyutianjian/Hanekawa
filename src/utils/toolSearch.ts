/**
 * Tool Search utilities for dynamically discovering deferred tools.
 *
 * When enabled, deferred tools (MCP and shouldDefer tools) are announced
 * by name only in the system prompt. The model uses ToolSearch to discover
 * their full schemas before calling them.
 *
 * Modes (controlled by HANEKAWA_TOOL_SEARCH env var):
 *   - 'always': defer MCP + shouldDefer tools (default)
 *   - 'auto':   defer only when deferred tool descriptions exceed threshold
 *   - 'off':    no deferral, all tools inline
 */

import type { Tool, SessionRecord } from '../harness/types.js'

/** Tool search mode. */
export type ToolSearchMode = 'always' | 'auto' | 'off'

/**
 * Percentage of context window at which to auto-enable tool search in auto mode.
 * Configurable via HANEKAWA_TOOL_SEARCH_AUTO_PERCENT env var.
 */
const DEFAULT_AUTO_PERCENTAGE = 10

/** Approximate chars per token for tool definitions. Used as fallback heuristic. */
const CHARS_PER_TOKEN = 2.5

/**
 * Determines the tool search mode from environment variables.
 *
 *   HANEKAWA_TOOL_SEARCH   Mode
 *   true / 1 / (unset)     always (default)
 *   auto / auto:N          auto
 *   false / 0              off
 */
export function getToolSearchMode(): ToolSearchMode {
  const value = process.env.HANEKAWA_TOOL_SEARCH

  if (!value || value === 'true' || value === '1') return 'always'
  if (value === 'false' || value === '0') return 'off'

  if (value === 'auto') return 'auto'
  if (value.startsWith('auto:')) {
    const percent = parseInt(value.slice(5), 10)
    if (!isNaN(percent) && percent >= 0 && percent <= 100) {
      return percent === 0 ? 'always' : percent === 100 ? 'off' : 'auto'
    }
    return 'auto'
  }

  return 'always'
}

/**
 * Check if a tool should be deferred (requires ToolSearch to load).
 *
 * A tool is deferred if:
 *   - It has shouldDefer: true, OR
 *   - It has isMcp: true
 *
 * A tool is NEVER deferred if:
 *   - It has alwaysLoad: true, OR
 *   - Its name is 'ToolSearch' (the search tool itself)
 */
export function isDeferredTool(tool: Tool): boolean {
  if (tool.alwaysLoad === true) return false
  if (tool.name === TOOL_SEARCH_TOOL_NAME) return false
  if (tool.isMcp === true) return true
  if (tool.shouldDefer === true) return true
  return false
}

/** The canonical name of the ToolSearch tool. */
export const TOOL_SEARCH_TOOL_NAME = 'ToolSearch'

/**
 * Check if tool search is enabled for the current configuration.
 * This is a synchronous check based on mode and tool counts.
 * For 'auto' mode, use isToolSearchEnabledWithThreshold() instead.
 */
export function isToolSearchEnabled(): boolean {
  const mode = getToolSearchMode()
  return mode === 'always' || mode === 'auto'
}

/**
 * Get the auto-threshold in tokens for a given context window size.
 * Returns 0 if auto mode is not active.
 */
export function getAutoThreshold(contextWindowSize: number): number {
  const mode = getToolSearchMode()
  if (mode !== 'auto') return 0

  const percent = getAutoPercentage() / 100
  return Math.floor(contextWindowSize * percent)
}

/**
 * Get the auto-threshold in characters (fallback heuristic).
 */
export function getAutoCharThreshold(contextWindowSize: number): number {
  return Math.floor(getAutoThreshold(contextWindowSize) * CHARS_PER_TOKEN)
}

/**
 * Calculate total description size in characters for a set of tools.
 * Used for the auto-threshold heuristic when token counting is unavailable.
 */
export function calculateToolDescriptionChars(tools: Tool[]): number {
  let total = 0
  for (const tool of tools) {
    total += tool.name.length + tool.description.length
  }
  return total
}

function getAutoPercentage(): number {
  const value = process.env.HANEKAWA_TOOL_SEARCH_AUTO_PERCENT
  if (!value) return DEFAULT_AUTO_PERCENTAGE
  const parsed = parseInt(value, 10)
  if (isNaN(parsed)) return DEFAULT_AUTO_PERCENTAGE
  return Math.max(0, Math.min(100, parsed))
}

// ─── Tool discovery tracking ─────────────────────────────────────────

/**
 * Check if an object is a tool_reference block.
 * tool_reference is a beta feature not in the SDK types.
 */
function isToolReferenceBlock(obj: unknown): obj is { type: 'tool_reference'; tool_name: string } {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'type' in obj &&
    (obj as { type: unknown }).type === 'tool_reference' &&
    'tool_name' in obj &&
    typeof (obj as { tool_name: unknown }).tool_name === 'string'
  )
}

/**
 * Extract tool names from tool_reference blocks in session records.
 *
 * When tool search is enabled, deferred tools are discovered via ToolSearch
 * which returns tool_reference blocks. This function scans the session history
 * to find all tool names that have been referenced, so we can include only
 * those tools in subsequent API requests.
 *
 * Also reads from compact_boundary records' preCompactDiscoveredTools metadata
 * to survive compaction.
 *
 * @param records Session records that may contain tool_result blocks with tool_reference content
 * @returns Set of tool names that have been discovered via tool_reference blocks
 */
export function extractDiscoveredToolNames(records: SessionRecord[]): Set<string> {
  const discoveredTools = new Set<string>()

  for (const record of records) {
    // Compact boundary carries the pre-compact discovered set
    if (record.type === 'compact_boundary') {
      const carried = record.preCompactDiscoveredTools
      if (carried) {
        for (const name of carried) discoveredTools.add(name)
      }
      continue
    }

    // Only tool_result records can contain tool_reference blocks
    if (record.type !== 'tool_result') continue

    // tool_reference blocks are in the apiResultBlock.content
    if (!record.apiResultBlock) continue
    const content = record.apiResultBlock.content
    if (!Array.isArray(content)) continue

    for (const item of content) {
      if (isToolReferenceBlock(item)) {
        discoveredTools.add(item.tool_name)
      }
    }
  }

  return discoveredTools
}

/**
 * Filter tools for the API request: only include deferred tools that have
 * been discovered via tool_reference blocks. Non-deferred tools and
 * ToolSearch itself are always included.
 *
 * Mirrors ClaudeCode's filteredTools logic in claude.ts.
 */
export function filterToolsForRequest(allTools: Tool[], discoveredToolNames: Set<string>): Tool[] {
  return allTools.filter(tool => {
    // Always include non-deferred tools
    if (!isDeferredTool(tool)) return true
    // Always include ToolSearch itself
    if (tool.name === TOOL_SEARCH_TOOL_NAME) return true
    // Only include deferred tools that have been discovered
    return discoveredToolNames.has(tool.name)
  })
}
