import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SkillsService } from '../src/services/skills/skillsService.js'
import { createSkillTool } from '../src/tools/skillTool.js'

test('SkillsService.list() returns empty array when directory does not exist', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const service = new SkillsService(dir)
    const skills = await service.list()
    assert.deepEqual(skills, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService.list() returns skills from directory', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'debugging'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'debugging', 'SKILL.md'),
      '---\nname: debugging\ndescription: Use when diagnosing bugs\n---\n\n# Debug workflow\n\n1. Reproduce\n2. Fix',
      'utf8'
    )

    await mkdir(path.join(skillsDir, 'tdd'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'tdd', 'SKILL.md'),
      '---\nname: tdd\ndescription: Test-driven development\n---\n\nWrite tests first.',
      'utf8'
    )

    const service = new SkillsService(dir)
    const skills = await service.list()

    assert.equal(skills.length, 2)
    assert.ok(skills.find(s => s.name === 'debugging'))
    assert.ok(skills.find(s => s.name === 'tdd'))

    const debugging = skills.find(s => s.name === 'debugging')!
    assert.equal(debugging.description, 'Use when diagnosing bugs')
    assert.match(debugging.content, /Debug workflow/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService.load() loads specific skill', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'debugging'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'debugging', 'SKILL.md'),
      '---\nname: debugging\ndescription: Use when diagnosing bugs\n---\n\nDebug content',
      'utf8'
    )

    const service = new SkillsService(dir)
    const skill = await service.load('debugging')

    assert.equal(skill.name, 'debugging')
    assert.equal(skill.description, 'Use when diagnosing bugs')
    assert.equal(skill.content, 'Debug content')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService.load() throws when skill not found', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const service = new SkillsService(dir)
    await assert.rejects(
      () => service.load('nonexistent'),
      /Skill not found: nonexistent/
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService skips skills with missing SKILL.md', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'valid'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'valid', 'SKILL.md'),
      '---\nname: valid\ndescription: Valid skill\n---\n\nContent',
      'utf8'
    )

    await mkdir(path.join(skillsDir, 'invalid'), { recursive: true })
    // No SKILL.md in invalid directory

    const service = new SkillsService(dir)
    const skills = await service.list()

    assert.equal(skills.length, 1)
    assert.equal(skills[0].name, 'valid')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService throws on invalid YAML frontmatter', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'broken'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'broken', 'SKILL.md'),
      '---\ninvalid: yaml: syntax:\n---\n\nContent',
      'utf8'
    )

    const service = new SkillsService(dir)
    const skills = await service.list()

    // Should skip broken skill
    assert.equal(skills.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService throws on missing required fields', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'incomplete'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'incomplete', 'SKILL.md'),
      '---\nname: incomplete\n---\n\nContent',
      'utf8'
    )

    const service = new SkillsService(dir)
    const skills = await service.list()

    // Should skip skill with missing description
    assert.equal(skills.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService throws on missing frontmatter', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'nofrontmatter'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'nofrontmatter', 'SKILL.md'),
      'Just content without frontmatter',
      'utf8'
    )

    const service = new SkillsService(dir)
    const skills = await service.list()

    // Should skip skill without frontmatter
    assert.equal(skills.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('createSkillTool() generates correct Tool object', () => {
  const skill = {
    name: 'debugging',
    description: 'Use when diagnosing bugs',
    content: 'Debug workflow content'
  }

  const tool = createSkillTool(skill)

  assert.equal(tool.name, 'skill_debugging')
  assert.equal(tool.description, 'Use when diagnosing bugs')
  assert.equal(tool.riskLevel, 'safe')
  assert.deepEqual(tool.inputSchema, {
    type: 'object',
    properties: {},
    additionalProperties: false
  })
})

test('createSkillTool() execute returns skill content', async () => {
  const skill = {
    name: 'debugging',
    description: 'Use when diagnosing bugs',
    content: 'Debug workflow content'
  }

  const tool = createSkillTool(skill)
  const result = await tool.execute({}, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })

  assert.equal(result.ok, true)
  assert.equal(result.content, 'Debug workflow content')
})

test('Skill tool names use skill_ prefix', () => {
  const skill1 = createSkillTool({ name: 'debugging', description: 'Debug', content: 'Content' })
  const skill2 = createSkillTool({ name: 'tdd', description: 'TDD', content: 'Content' })

  assert.equal(skill1.name, 'skill_debugging')
  assert.equal(skill2.name, 'skill_tdd')
})
