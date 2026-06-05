import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from './types.js'
import type { JsonSchema } from './toolValidation.js'
import { getToolSchemaCache } from '../utils/toolSchemaCache.js'

/**
 * Convert a tool's input schema to JSON Schema for the API.
 *
 * Uses a session-scoped cache to prevent mid-session schema churn from
 * busting the prompt cache. The cached base includes name, description,
 * and input_schema. Per-request overlays (defer_loading, cache_control)
 * are applied at the payload level, not here.
 */
export function toolToAPISchema(tool: Tool): JsonSchema {
  if (tool.apiInputSchema) return tool.apiInputSchema

  const cache = getToolSchemaCache()
  const cached = cache.get(tool.name)
  if (cached) return cached.input_schema

  const schema = stripSchemaMetadata(zodToJsonSchema(tool.inputSchema) as JsonSchema)

  // Cache the base schema for this session
  cache.set(tool.name, {
    name: tool.name,
    description: tool.description,
    input_schema: schema,
  })

  return schema
}

/**
 * Get or build the full cached schema for a tool (name + description + input_schema).
 * Used by the payload builders to get the base schema before applying per-request overlays.
 */
export function getCachedToolSchema(tool: Tool): { name: string; description: string; input_schema: JsonSchema } {
  if (tool.apiInputSchema) {
    return { name: tool.name, description: tool.description, input_schema: tool.apiInputSchema }
  }

  const cache = getToolSchemaCache()
  const cached = cache.get(tool.name)
  if (cached) return cached

  const input_schema = stripSchemaMetadata(zodToJsonSchema(tool.inputSchema) as JsonSchema)
  const entry = { name: tool.name, description: tool.description, input_schema }
  cache.set(tool.name, entry)
  return entry
}

function stripSchemaMetadata(schema: JsonSchema): JsonSchema {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$schema') continue
    if (Array.isArray(value)) {
      next[key] = value.map((item) => typeof item === 'object' && item !== null
        ? stripSchemaMetadata(item as JsonSchema)
        : item)
      continue
    }
    next[key] = typeof value === 'object' && value !== null
      ? stripSchemaMetadata(value as JsonSchema)
      : value
  }
  return next as JsonSchema
}
