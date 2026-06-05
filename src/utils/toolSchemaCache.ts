import type { JsonSchema } from '../harness/toolValidation.js'

/**
 * Session-scoped cache of rendered tool schemas.
 *
 * Tool schemas render at server position 2 (before system prompt), so any
 * byte-level change busts the entire tool block AND everything downstream.
 * Caching per-session locks the schema bytes at first render.
 *
 * Per-request overlays (defer_loading, cache_control) are applied AFTER the
 * cache lookup so they don't pollute the cached base.
 */

interface CachedSchema {
  name: string
  description: string
  input_schema: JsonSchema
}

const TOOL_SCHEMA_CACHE = new Map<string, CachedSchema>()

export function getToolSchemaCache(): Map<string, CachedSchema> {
  return TOOL_SCHEMA_CACHE
}

export function clearToolSchemaCache(): void {
  TOOL_SCHEMA_CACHE.clear()
}
