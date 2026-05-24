import test from 'node:test'
import assert from 'node:assert/strict'
import { validateToolInput } from '../src/harness/toolValidation.js'
import { bashTool } from '../src/tools/bash.js'

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    count: { type: 'number' },
    enabled: { type: 'boolean' },
    mode: { type: 'string', enum: ['fast', 'safe'] },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['name'],
  additionalProperties: false,
}

test('validateToolInput accepts valid input', () => {
  const result = validateToolInput(schema, {
    name: 'build',
    count: 1,
    enabled: true,
    mode: 'safe',
    tags: ['test'],
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
})

test('validateToolInput rejects missing required properties', () => {
  const result = validateToolInput(schema, {})

  assert.equal(result.ok, false)
  assert.equal(result.errors[0]?.path, '$.name')
  assert.match(result.errors[0]?.message ?? '', /required/)
})

test('validateToolInput rejects wrong primitive types', () => {
  const result = validateToolInput(schema, { name: 1 })

  assert.equal(result.ok, false)
  assert.equal(result.errors[0]?.expected, 'string')
  assert.equal(result.errors[0]?.actual, 'number')
})

test('validateToolInput rejects additional properties', () => {
  const result = validateToolInput(schema, { name: 'build', extra: true })

  assert.equal(result.ok, false)
  assert.equal(result.errors[0]?.path, '$.extra')
  assert.match(result.errors[0]?.message ?? '', /not allowed/)
})

test('validateToolInput rejects enum mismatches', () => {
  const result = validateToolInput(schema, { name: 'build', mode: 'loose' })

  assert.equal(result.ok, false)
  assert.equal(result.errors[0]?.path, '$.mode')
  assert.match(result.errors[0]?.expected ?? '', /fast/)
})

test('validateToolInput rejects invalid array items', () => {
  const result = validateToolInput(schema, { name: 'build', tags: ['ok', 1] })

  assert.equal(result.ok, false)
  assert.equal(result.errors[0]?.path, '$.tags[1]')
  assert.equal(result.errors[0]?.expected, 'string')
})

test('validateToolInput treats object schemas with properties as strict by default', () => {
  const result = validateToolInput({
    type: 'object',
    properties: {
      command: { type: 'string' },
    },
    required: ['command'],
  }, { command: 'pwd', ignored: true })

  assert.equal(result.ok, false)
  assert.equal(result.errors[0]?.path, '$.ignored')
  assert.equal(result.errors[0]?.expected, 'no additional properties')
})

test('validateToolInput allows arbitrary keys for object schemas without properties', () => {
  const result = validateToolInput({
    type: 'object',
    properties: {
      metadata: { type: 'object' },
    },
    required: ['metadata'],
  }, { metadata: { branch: 'main', attempts: 2 } })

  assert.equal(result.ok, true)
})

test('validateToolInput supports string length, pattern, and format constraints', () => {
  const result = validateToolInput({
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 3, maxLength: 5, pattern: '^[a-z]+$' },
      website: { type: 'string', format: 'uri' },
    },
    required: ['name', 'website'],
  }, { name: 'AB', website: 'not a url' })

  assert.equal(result.ok, false)
  assert.equal(result.errors.some((error) => error.path === '$.name'), true)
  assert.equal(result.errors.some((error) => error.path === '$.website'), true)
})

test('validateToolInput supports numeric and array bounds', () => {
  const result = validateToolInput({
    type: 'object',
    properties: {
      timeout: { type: 'integer', minimum: 1, maximum: 10 },
      tags: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string' } },
    },
  }, { timeout: 0, tags: [] })

  assert.equal(result.ok, false)
  assert.equal(result.errors.some((error) => error.path === '$.timeout'), true)
  assert.equal(result.errors.some((error) => error.path === '$.tags'), true)
})

test('validateToolInput rejects extra and empty bash inputs', () => {
  const extra = validateToolInput(bashTool.inputSchema, { command: 'pwd', extra: true })
  const empty = validateToolInput(bashTool.inputSchema, { command: '' })

  assert.equal(extra.ok, false)
  assert.equal(extra.errors[0]?.path, '$.extra')
  assert.equal(empty.ok, false)
  assert.equal(empty.errors[0]?.path, '$.command')
})
