import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { getAllTools, getBuiltinTools } from '../src/tools/index.js'

test('getAllTools() includes builtin tools', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const tools = await getAllTools(dir)
    const builtinTools = getBuiltinTools()

    // Should include all builtin tools
    for (const builtin of builtinTools) {
      const found = tools.find(t => t.name === builtin.name)
      assert.ok(found, `Missing builtin tool: ${builtin.name}`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('getAllTools() includes skill tools', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'debugging'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'debugging', 'SKILL.md'),
      '---\nname: debugging\ndescription: Use when diagnosing bugs\n---\n\nDebug content',
      'utf8'
    )

    await mkdir(path.join(skillsDir, 'tdd'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'tdd', 'SKILL.md'),
      '---\nname: tdd\ndescription: Test-driven development\n---\n\nTDD content',
      'utf8'
    )

    const tools = await getAllTools(dir)

    // Should include skill tools
    const debuggingTool = tools.find(t => t.name === 'skill_debugging')
    const tddTool = tools.find(t => t.name === 'skill_tdd')

    assert.ok(debuggingTool, 'Missing skill_debugging tool')
    assert.ok(tddTool, 'Missing skill_tdd tool')

    assert.equal(debuggingTool.description, 'Use when diagnosing bugs')
    assert.equal(tddTool.description, 'Test-driven development')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Skill tools do not conflict with builtin tools', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'debugging'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'debugging', 'SKILL.md'),
      '---\nname: debugging\ndescription: Debug skill\n---\n\nContent',
      'utf8'
    )

    const tools = await getAllTools(dir)
    const names = tools.map(t => t.name)

    // Check for duplicates
    const uniqueNames = new Set(names)
    assert.equal(names.length, uniqueNames.size, 'Tool names should be unique')

    // Skill tools should have skill_ prefix
    const skillTools = tools.filter(t => t.name.startsWith('skill_'))
    assert.ok(skillTools.length > 0, 'Should have at least one skill tool')

    // Builtin tools should not have skill_ prefix
    const builtinTools = tools.filter(t => !t.name.startsWith('skill_'))
    assert.ok(builtinTools.length > 0, 'Should have builtin tools')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Skill tools have riskLevel safe', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'test'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'test', 'SKILL.md'),
      '---\nname: test\ndescription: Test skill\n---\n\nContent',
      'utf8'
    )

    const tools = await getAllTools(dir)
    const skillTool = tools.find(t => t.name === 'skill_test')

    assert.ok(skillTool)
    assert.equal(skillTool.riskLevel, 'safe')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Skill tool execution returns skill content', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'debugging'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'debugging', 'SKILL.md'),
      '---\nname: debugging\ndescription: Debug skill\n---\n\n# Debug Workflow\n\n1. Reproduce\n2. Fix',
      'utf8'
    )

    const tools = await getAllTools(dir)
    const skillTool = tools.find(t => t.name === 'skill_debugging')

    assert.ok(skillTool)

    const result = await skillTool.execute({}, {
      cwd: dir,
      sessionId: 'test',
      readFiles: new Set<string>()
    })

    assert.equal(result.ok, true)
    assert.match(result.content, /Debug Workflow/)
    assert.match(result.content, /Reproduce/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Multiple calls to same skill tool return consistent results', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'test'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'test', 'SKILL.md'),
      '---\nname: test\ndescription: Test\n---\n\nTest content',
      'utf8'
    )

    const tools = await getAllTools(dir)
    const skillTool = tools.find(t => t.name === 'skill_test')

    assert.ok(skillTool)

    const context = { cwd: dir, sessionId: 'test', readFiles: new Set<string>() }
    const result1 = await skillTool.execute({}, context)
    const result2 = await skillTool.execute({}, context)

    assert.deepEqual(result1, result2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('getAllTools() works when no skills directory exists', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const tools = await getAllTools(dir)
    const builtinTools = getBuiltinTools()

    // Should only have builtin tools
    assert.equal(tools.length, builtinTools.length)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Skill tools and builtin tools coexist in tool list', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'skill1'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'skill1', 'SKILL.md'),
      '---\nname: skill1\ndescription: Skill 1\n---\n\nContent 1',
      'utf8'
    )

    await mkdir(path.join(skillsDir, 'skill2'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'skill2', 'SKILL.md'),
      '---\nname: skill2\ndescription: Skill 2\n---\n\nContent 2',
      'utf8'
    )

    const tools = await getAllTools(dir)
    const builtinTools = getBuiltinTools()

    // Should have builtin + skill tools
    assert.equal(tools.length, builtinTools.length + 2)

    // Verify all builtin tools are present
    for (const builtin of builtinTools) {
      assert.ok(tools.find(t => t.name === builtin.name))
    }

    // Verify skill tools are present
    assert.ok(tools.find(t => t.name === 'skill_skill1'))
    assert.ok(tools.find(t => t.name === 'skill_skill2'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
