import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from './types.js'
import type { JsonSchema } from './toolValidation.js'

export function toolToAPISchema(tool: Tool): JsonSchema {
  if (tool.apiInputSchema) return tool.apiInputSchema
  return stripSchemaMetadata(zodToJsonSchema(tool.inputSchema) as JsonSchema)
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
