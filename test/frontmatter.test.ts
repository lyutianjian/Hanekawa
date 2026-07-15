import assert from 'node:assert/strict'
import test from 'node:test'
import { parseYamlFrontmatter } from '../src/utils/frontmatter.js'

test('parseYamlFrontmatter quotes problematic top-level plain scalars on retry', () => {
  const description = 'Integrate web data: search "sites", run `scrape`, and read C:\\skills\\{name}.'
  const parsed = parseYamlFrontmatter([
    'name: firecrawl-build',
    `description: ${description}`,
  ].join('\r\n')) as Record<string, unknown>

  assert.equal(parsed.name, 'firecrawl-build')
  assert.equal(parsed.description, description)
})

test('parseYamlFrontmatter preserves valid quoted, block, array, and nested values', () => {
  const parsed = parseYamlFrontmatter([
    'name: valid',
    'description: "Already quoted: value"',
    'notes: |',
    '  Keep: this text',
    'items:',
    '  - one',
    'metadata:',
    '  homepage: https://example.com',
  ].join('\n')) as Record<string, unknown>

  assert.equal(parsed.description, 'Already quoted: value')
  assert.equal(parsed.notes, 'Keep: this text\n')
  assert.deepEqual(parsed.items, ['one'])
  assert.deepEqual(parsed.metadata, { homepage: 'https://example.com' })
})

test('parseYamlFrontmatter propagates YAML errors that retry cannot repair', () => {
  assert.throws(
    () => parseYamlFrontmatter([
      'name: broken',
      'description: Broken frontmatter',
      'metadata:',
      '  values: [one, two',
    ].join('\n')),
  )
})
