import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  applyCommandSuggestion,
  generateCommandSuggestions,
} from '../src/tui/suggestions/commandSuggestions.js'
import type { CommandDefinition } from '../src/commands/types.js'
import { getCommand, hasCommand, listCommands, registerCommand } from '../src/commands/index.js'
import { registerSkillCommands } from '../src/commands/skills.js'

function command(overrides: Partial<CommandDefinition> & { name: string }): CommandDefinition {
  return {
    description: `${overrides.name} description`,
    run: async () => {},
    ...overrides,
  }
}

test('slash command suggestions list enabled visible commands for empty query', () => {
  const suggestions = generateCommandSuggestions('/', [
    command({ name: 'model' }),
    command({ name: 'hidden', isHidden: true }),
    command({ name: 'disabled', isEnabled: () => false }),
    command({ name: 'clear' }),
  ])

  assert.deepEqual(suggestions.map((suggestion) => suggestion.displayText), ['/clear', '/model'])
})

test('slash command suggestions prioritize prefix command names', () => {
  const suggestions = generateCommandSuggestions('/mo', [
    command({ name: 'alpha', description: 'mentions model in description' }),
    command({ name: 'model' }),
    command({ name: 'compact' }),
  ])

  assert.equal(suggestions[0]?.displayText, '/model')
})

test('slash command suggestions include aliases in fuzzy search', () => {
  const suggestions = generateCommandSuggestions('/settings', [
    command({ name: 'provider' }),
    command({ name: 'config', aliases: ['settings'] }),
  ])

  assert.equal(suggestions[0]?.displayText, '/config')
})

test('slash command suggestions hide once real arguments are present', () => {
  const suggestions = generateCommandSuggestions('/model claude', [
    command({ name: 'model' }),
  ])

  assert.deepEqual(suggestions, [])
})

test('applying a command suggestion inserts slash command and trailing space', () => {
  const suggestion = generateCommandSuggestions('/mo', [
    command({ name: 'model' }),
  ])[0]

  assert.ok(suggestion)
  assert.deepEqual(applyCommandSuggestion(suggestion), {
    text: '/model ',
    cursorPos: 7,
  })
})

test('command registry supports aliases and hides hidden commands from listings', () => {
  registerCommand(command({ name: 'autocomplete-alias-target', aliases: ['aat'] }))
  registerCommand(command({ name: 'autocomplete-hidden-target', isHidden: true }))

  assert.equal(getCommand('aat')?.name, 'autocomplete-alias-target')
  assert.equal(hasCommand('aat'), true)
  assert.equal(listCommands().some((item) => item.name === 'autocomplete-hidden-target'), false)
})

test('slash command suggestions include registered skill commands', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-command-suggestion-skill-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'suggestion-skill'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'suggestion-skill', 'SKILL.md'),
      '---\nname: suggestion-skill\ndescription: Skill suggestion\n---\n\nSkill content',
      'utf8',
    )

    await registerSkillCommands(dir)
    const suggestions = generateCommandSuggestions('/suggestion', listCommands())

    assert.ok(suggestions.some((suggestion) => suggestion.displayText === '/suggestion-skill'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
