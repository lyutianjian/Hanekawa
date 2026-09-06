import test from 'node:test'
import assert from 'node:assert/strict'
import { getBuiltinTools } from '../src/tools/index.js'
import { createSkillTool } from '../src/tools/SkillTool/SkillTool.js'
import type { Tool } from '../src/harness/types.js'

/**
 * Every tool's description now lives in its own `prompt.ts`, one directory away
 * from the schema it describes. These tests are the tie between the two: a
 * parameter renamed in the schema but not in the prose is exactly the drift
 * that made the model guess at parameter names in the first place.
 */

function tools(): Tool[] {
  return [...getBuiltinTools(), createSkillTool()]
}

/** The object shape behind a schema, unwrapping the `.refine()` wrappers. */
function schemaShape(tool: Tool): Record<string, { description?: string; _def?: { description?: string } }> {
  let node = tool.inputSchema as { _def?: Record<string, unknown> }
  while (node?._def && 'schema' in node._def) {
    node = node._def.schema as typeof node
  }
  const shape = node?._def?.shape
  const resolved = typeof shape === 'function' ? (shape as () => unknown)() : shape
  return (resolved ?? {}) as Record<string, { description?: string; _def?: { description?: string } }>
}

/** Parameter names the description claims the tool accepts. */
function advertisedParameters(description: string): string[] {
  const line = description
    .split('\n')
    .find((row) => /^-\s+(Parameters are|The only parameter)/.test(row.trim()))
  if (!line) return []
  // Only the first sentence lists what the tool takes; the ones after it say
  // what it deliberately does NOT take, and naming those is the whole point.
  const claim = line.split('. ')[0]!
  return [...claim.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((match) => match[1]!)
}

test('every advertised parameter name exists in the tool schema', () => {
  for (const tool of tools()) {
    const shape = schemaShape(tool)
    for (const name of advertisedParameters(tool.description)) {
      assert.ok(
        name in shape,
        `${tool.name} advertises a "${name}" parameter its schema does not accept`,
      )
    }
  }
})

test('every builtin tool parameter carries its own description', () => {
  for (const tool of tools()) {
    for (const [name, field] of Object.entries(schemaShape(tool))) {
      const described = field?._def?.description ?? field?.description
      assert.ok(
        typeof described === 'string' && described.trim().length > 0,
        `${tool.name}.${name} has no .describe(); the model only sees its type`,
      )
    }
  }
})

test('the search and file tools spell out their calling rules', () => {
  const byName = new Map(tools().map((tool) => [tool.name, tool]))
  for (const name of ['Grep', 'Glob', 'Read', 'Edit', 'MultiEdit', 'Write', 'Delete']) {
    const tool = byName.get(name)
    assert.ok(tool, `${name} is not registered`)
    assert.match(tool.description, /\nUsage:\n/, `${name} has no Usage section`)
  }
})
