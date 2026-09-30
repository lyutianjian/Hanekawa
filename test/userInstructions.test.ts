import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadProjectContext, writeUserInstructions } from '../src/services/context/projectContext.js'
import { getUserInstructionsPath } from '../src/utils/paths.js'

test('user instructions come first and a blank write removes the file', async () => {
  const project = await mkdtemp(join(tmpdir(), 'ui-'))
  await writeFile(join(project, 'AGENTS.md'), 'PROJECT')
  await writeUserInstructions('USER')
  assert.equal(await readFile(getUserInstructionsPath(), 'utf-8'), 'USER')
  const context = await loadProjectContext(project)
  assert.ok(context.indexOf('USER') < context.indexOf('PROJECT'))
  await writeUserInstructions('  \n')
  assert.equal(existsSync(getUserInstructionsPath()), false)
})

test('each instruction file is labelled with its path and kind', async () => {
  const project = await mkdtemp(join(tmpdir(), 'ui-'))
  await writeFile(join(project, 'AGENTS.md'), 'PROJECT')
  await writeUserInstructions('USER')
  const context = await loadProjectContext(project)
  assert.match(context, /Contents of .*AGENTS\.md \(user's private global instructions for all projects\):\n\nUSER/)
  assert.match(context, /AGENTS\.md \(project instructions, checked into the codebase\):\n\nPROJECT/)
})
