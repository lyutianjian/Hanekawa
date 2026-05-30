import { z, type ZodIssue, type ZodTypeAny } from 'zod/v3'
import type { Tool } from './types.js'

export interface ToolValidationError {
  path: string
  expected: string
  actual: string
  message: string
}

export interface ToolValidationResult {
  ok: boolean
  errors: ToolValidationError[]
}

export interface JsonSchema {
  type?: string | string[]
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean | JsonSchema
  items?: JsonSchema
  enum?: unknown[]
  pattern?: string
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number | boolean
  exclusiveMaximum?: number | boolean
  minItems?: number
  maxItems?: number
  format?: string
}

export function validateToolInput(toolOrSchema: Tool | ZodTypeAny | JsonSchema, input: unknown): ToolValidationResult {
  if (isTool(toolOrSchema)) {
    return toolOrSchema.validateInput
      ? toolOrSchema.validateInput(input)
      : validateZodInput(toolOrSchema.inputSchema, input)
  }

  if (isZodSchema(toolOrSchema)) {
    return validateZodInput(toolOrSchema, input)
  }

  return validateJsonSchemaInput(toolOrSchema, input)
}

export function validateJsonSchemaInput(schema: unknown, input: unknown): ToolValidationResult {
  if (!isSchemaObject(schema) || Object.keys(schema).length === 0) {
    return { ok: true, errors: [] }
  }

  return validateZodInput(compileJsonSchema(schema), input)
}

function validateZodInput(schema: ZodTypeAny, input: unknown): ToolValidationResult {
  const result = schema.safeParse(input)
  if (result.success) {
    return { ok: true, errors: [] }
  }

  return {
    ok: false,
    errors: result.error.issues.map((issue) => zodIssueToValidationError(issue, input)),
  }
}

function compileJsonSchema(schema: JsonSchema): ZodTypeAny {
  if (schema.enum) {
    const expected = `one of ${schema.enum.map(formatValue).join(', ')}`
    return z.custom((value) => schema.enum?.some((item) => Object.is(item, value)) ?? false, {
      message: expected,
    })
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  if (types.length > 1) {
    return z.union(types.map((type) => compileJsonSchema({ ...schema, type })) as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]])
  }

  switch (types[0]) {
    case 'object':
      return compileObject(schema)
    case 'array':
      return compileArray(schema)
    case 'string':
      return compileString(schema)
    case 'number':
      return compileNumber(schema)
    case 'integer':
      return compileNumber(schema).int()
    case 'boolean':
      return z.boolean()
    case 'null':
      return z.null()
    default:
      return z.unknown()
  }
}

function compileObject(schema: JsonSchema): ZodTypeAny {
  const properties = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  const hasProperties = Object.keys(properties).length > 0

  if (!hasProperties) {
    if (schema.additionalProperties === false) return z.object({}).strict()
    return z.record(z.unknown())
  }

  const shape: Record<string, ZodTypeAny> = {}
  for (const [key, propertySchema] of Object.entries(properties)) {
    const property = compileJsonSchema(propertySchema)
    shape[key] = required.has(key) ? property : property.optional()
  }

  if (schema.additionalProperties === true) return z.object(shape).passthrough()
  if (isSchemaObject(schema.additionalProperties)) {
    return z.object(shape).catchall(compileJsonSchema(schema.additionalProperties))
  }
  return z.object(shape).strict()
}

function compileArray(schema: JsonSchema): ZodTypeAny {
  let arraySchema = z.array(schema.items ? compileJsonSchema(schema.items) : z.unknown())
  if (typeof schema.minItems === 'number') arraySchema = arraySchema.min(schema.minItems)
  if (typeof schema.maxItems === 'number') arraySchema = arraySchema.max(schema.maxItems)
  return arraySchema
}

function compileString(schema: JsonSchema): ZodTypeAny {
  let stringSchema = z.string()
  if (typeof schema.minLength === 'number') stringSchema = stringSchema.min(schema.minLength)
  if (typeof schema.maxLength === 'number') stringSchema = stringSchema.max(schema.maxLength)
  if (schema.pattern) {
    try {
      stringSchema = stringSchema.regex(new RegExp(schema.pattern))
    } catch {
      return stringSchema.refine(() => false, { message: `invalid schema pattern: ${schema.pattern}` })
    }
  }
  if (schema.format) {
    return applyStringFormat(stringSchema, schema.format)
  }
  return stringSchema
}

function applyStringFormat(schema: z.ZodString, format: string): ZodTypeAny {
  if (format === 'email') return schema.email()
  if (format === 'uuid') return schema.uuid()
  if (format === 'uri' || format === 'url') return schema.url()
  if (format === 'date-time') return schema.datetime({ offset: true })
  // Unknown format — accept without validation for forward compatibility.
  // Known formats that are NOT validated: ipv4, ipv6, hostname, etc.
  // This is intentional: rejecting unknown formats would break tools that
  // declare formats this validator doesn't support yet.
  return schema
}

function compileNumber(schema: JsonSchema): z.ZodNumber {
  let numberSchema = z.number().finite()
  // Handle draft-04 boolean form: exclusiveMinimum/exclusiveMaximum as booleans
  // that modify minimum/maximum
  if (schema.exclusiveMinimum === true && typeof schema.minimum === 'number') {
    numberSchema = numberSchema.gt(schema.minimum)
  } else if (typeof schema.exclusiveMinimum === 'number') {
    numberSchema = numberSchema.gt(schema.exclusiveMinimum)
  } else if (typeof schema.minimum === 'number') {
    numberSchema = numberSchema.min(schema.minimum)
  }

  if (schema.exclusiveMaximum === true && typeof schema.maximum === 'number') {
    numberSchema = numberSchema.lt(schema.maximum)
  } else if (typeof schema.exclusiveMaximum === 'number') {
    numberSchema = numberSchema.lt(schema.exclusiveMaximum)
  } else if (typeof schema.maximum === 'number') {
    numberSchema = numberSchema.max(schema.maximum)
  }
  return numberSchema
}

function zodIssueToValidationError(issue: ZodIssue, input: unknown): ToolValidationError {
  const issuePath = issue.code === 'unrecognized_keys' && issue.keys.length === 1
    ? [...issue.path, issue.keys[0]]
    : issue.path
  const path = formatPath(issuePath)
  return {
    path,
    expected: expectedFromIssue(issue),
    actual: describeValue(valueAtPath(input, issuePath)),
    message: messageFromIssue(issue, path),
  }
}

function expectedFromIssue(issue: ZodIssue): string {
  if (issue.code === 'invalid_type') return String(issue.expected)
  if (issue.code === 'unrecognized_keys') return 'no additional properties'
  if (issue.code === 'invalid_enum_value') return `one of ${issue.options.map(formatValue).join(', ')}`
  if (issue.code === 'custom') return issue.message
  if (issue.code === 'too_small') {
    if (issue.type === 'string') return `string length >= ${issue.minimum}`
    if (issue.type === 'array') return `array length >= ${issue.minimum}`
    return `number >= ${issue.minimum}`
  }
  if (issue.code === 'too_big') {
    if (issue.type === 'string') return `string length <= ${issue.maximum}`
    if (issue.type === 'array') return `array length <= ${issue.maximum}`
    return `number <= ${issue.maximum}`
  }
  if (issue.code === 'invalid_string') return issue.validation.toString()
  return issue.message
}

function messageFromIssue(issue: ZodIssue, path: string): string {
  if (issue.code === 'invalid_type') {
    if (issue.received === 'undefined') return `${path} is required`
    return `${path} must be ${article(String(issue.expected))} ${issue.expected}`
  }
  if (issue.code === 'unrecognized_keys') {
    const parent = issue.path.length === 0 ? '$' : formatPath(issue.path)
    return issue.keys.map((key) => `${parent}.${key} is not allowed`).join('; ')
  }
  if (issue.code === 'invalid_enum_value') {
    return `${path} must be one of ${issue.options.map(formatValue).join(', ')}`
  }
  return `${path} ${issue.message}`
}

function formatPath(path: (string | number)[]): string {
  if (path.length === 0) return '$'
  let result = '$'
  for (const part of path) {
    if (typeof part === 'number') result += `[${part}]`
    else result += `.${part}`
  }
  return result
}

function valueAtPath(input: unknown, path: (string | number)[]): unknown {
  let current = input
  for (const part of path) {
    if (current === null || current === undefined) return undefined
    if (typeof part === 'number') {
      if (!Array.isArray(current)) return undefined
      current = current[part]
      continue
    }
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function isTool(value: unknown): value is Tool {
  return isSchemaObject(value) && 'name' in value && 'inputSchema' in value && isZodSchema(value.inputSchema)
}

function isZodSchema(value: unknown): value is ZodTypeAny {
  return isSchemaObject(value) && typeof (value as { safeParse?: unknown }).safeParse === 'function'
}

function isSchemaObject(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'missing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : String(value)
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a'
}
