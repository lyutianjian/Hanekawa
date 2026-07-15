import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { toolToAPISchema } from '../src/harness/toolApiSchema.js'
import { getCommand, registerCommand } from '../src/commands/index.js'
import { buildSkillCommandPrompt, buildSkillPrompt, registerSkillCommands } from '../src/commands/skills.js'
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
    assert.equal(debugging.inclusion, 'manual')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService.list() parses CRLF frontmatter', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillDir = path.join(dir, '.myagent', 'skills', 'windows-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\r\nname: windows-skill\r\ndescription: Uses Windows line endings\r\n---\r\n\r\n# Windows skill\r\n\r\nRun on Windows.',
      'utf8',
    )

    const skills = await new SkillsService(dir).list()

    assert.equal(skills.length, 1)
    assert.equal(skills[0].name, 'windows-skill')
    assert.equal(skills[0].description, 'Uses Windows line endings')
    assert.equal(skills[0].content, '# Windows skill\r\n\r\nRun on Windows.')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService.list() repairs problematic top-level description scalars', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillDir = path.join(dir, '.myagent', 'skills', 'firecrawl-build')
    await mkdir(skillDir, { recursive: true })
    const description = 'Integrate application data: web search, "scrape", and `interact`.'
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: firecrawl-build\ndescription: ${description}\n---\n\n# Firecrawl build\n\nBuild with web data.`,
      'utf8',
    )

    const skills = await new SkillsService(dir).list()

    assert.equal(skills.length, 1)
    assert.equal(skills[0].name, 'firecrawl-build')
    assert.equal(skills[0].description, description)
    assert.equal(skills[0].content, '# Firecrawl build\n\nBuild with web data.')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService.list() parses conditional activation frontmatter', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'react'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'react', 'SKILL.md'),
      [
        '---',
        'name: react',
        'description: React files',
        'inclusion: fileMatch',
        'paths:',
        '  - "src/**/*.tsx"',
        '  - "test/**/*.tsx"',
        '---',
        '',
        'React guidance',
      ].join('\n'),
      'utf8',
    )

    const service = new SkillsService(dir)
    const skills = await service.list()

    assert.equal(skills.length, 1)
    assert.equal(skills[0].inclusion, 'fileMatch')
    assert.deepEqual(skills[0].paths, ['src/**/*.tsx', 'test/**/*.tsx'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService.list() parses slash command execution frontmatter', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'rich'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'rich', 'SKILL.md'),
      [
        '---',
        'name: rich',
        'description: Rich slash command',
        'allowedTools:',
        '  - Read',
        '  - Bash',
        'model: powerful',
        'effort: xhigh',
        'attachments:',
        '  - notes.txt',
        'hooks:',
        '  userPromptSubmit:',
        '    - command: "echo user"',
        '  preToolUse:',
        '    - matcher: Bash',
        '      command: "echo pre"',
        '      timeoutMs: 1000',
        '---',
        '',
        'Rich guidance',
      ].join('\n'),
      'utf8',
    )

    const skills = await new SkillsService(dir).list()
    const skill = skills[0]

    assert.equal(skill.name, 'rich')
    assert.deepEqual(skill.allowedTools, ['Read', 'Bash'])
    assert.equal(skill.model, 'powerful')
    assert.equal(skill.effort, 'xhigh')
    assert.deepEqual(skill.attachments, ['notes.txt'])
    assert.equal(skill.hooks?.userPromptSubmit?.[0]?.command, 'echo user')
    assert.equal(skill.hooks?.preToolUse?.[0]?.matcher, 'Bash')
    assert.equal(skill.hooks?.preToolUse?.[0]?.timeoutMs, 1000)
    assert.equal(skill.skillDir, path.join(skillsDir, 'rich'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService.list() skips skills with invalid execution frontmatter', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'bad-effort'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'bad-effort', 'SKILL.md'),
      '---\nname: bad-effort\ndescription: Bad\neffort: turbo\n---\n\nContent',
      'utf8',
    )

    const skills = await new SkillsService(dir).list()

    assert.deepEqual(skills, [])
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
      '---\nname: broken\ndescription: Broken\nmetadata:\n  values: [one, two\n---\n\nContent',
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

test('createSkillTool() generates Skill tool object', () => {
  const tool = createSkillTool()

  assert.equal(tool.name, 'Skill')
  assert.match(tool.description, /Execute a skill/)
  assert.equal(tool.riskLevel, 'safe')
  assert.deepEqual(toolToAPISchema(tool), {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        minLength: 1,
        description: 'The name of a skill from the available-skills list. Do not guess names.',
      },
      args: {
        type: 'string',
        description: 'Optional arguments for the skill',
      },
    },
    required: ['skill'],
    additionalProperties: false
  })
})

test('createSkillTool() execute returns skill content', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'debugging'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'debugging', 'SKILL.md'),
      '---\nname: debugging\ndescription: Use when diagnosing bugs\n---\n\nDebug workflow content',
      'utf8'
    )

    const tool = createSkillTool()
    const context = { cwd: dir, sessionId: 's1', readFiles: new Set<string>(), invokedSkills: new Map<string, { content: string; timestamp: number }>() }
    const result = await tool.execute({ skill: 'debugging' }, context)

    assert.equal(result.ok, true)
    assert.equal(result.content, 'Debug workflow content')
    assert.equal(context.invokedSkills.get('debugging')?.content, 'Debug workflow content')
    assert.equal(typeof context.invokedSkills.get('debugging')?.timestamp, 'number')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('createSkillTool() rejects missing skill name', async () => {
  const tool = createSkillTool()

  await assert.rejects(
    () => tool.execute({}, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() }),
    /Skill input must include a non-empty skill name/,
  )
})

test('buildSkillPrompt replaces arguments placeholder', () => {
  assert.equal(
    buildSkillPrompt('Run this with $ARGUMENTS.', 'hello world'),
    'Run this with hello world.',
  )
})

test('buildSkillPrompt replaces multiple arguments placeholders', () => {
  assert.equal(
    buildSkillPrompt('$ARGUMENTS\nAgain: $ARGUMENTS', 'hello world'),
    'hello world\nAgain: hello world',
  )
})

test('buildSkillPrompt appends arguments when no placeholder exists', () => {
  assert.equal(
    buildSkillPrompt('Use this skill.', 'hello world'),
    'Use this skill.\n\nArguments: hello world',
  )
})

test('buildSkillPrompt does not append empty arguments', () => {
  assert.equal(buildSkillPrompt('Use this skill.', ''), 'Use this skill.')
})

test('buildSkillCommandPrompt appends text attachments in stable order', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skill-attachments-'))
  try {
    await writeFile(path.join(dir, 'a.txt'), 'alpha', 'utf8')
    await writeFile(path.join(dir, 'b.txt'), 'beta', 'utf8')

    const prompt = await buildSkillCommandPrompt({
      name: 'with-attachments',
      description: 'attachments',
      content: 'Use this skill.',
      skillDir: dir,
      attachments: ['a.txt', 'b.txt'],
    }, '')

    assert.match(prompt, /<skill-attachments>/)
    assert.ok(prompt.indexOf('path="a.txt"') < prompt.indexOf('path="b.txt"'))
    assert.match(prompt, /alpha/)
    assert.match(prompt, /beta/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildSkillCommandPrompt rejects attachment path escape', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skill-attachments-'))
  try {
    await assert.rejects(
      () => buildSkillCommandPrompt({
        name: 'escape',
        description: 'escape',
        content: 'Use this skill.',
        skillDir: dir,
        attachments: ['../outside.txt'],
      }, ''),
      /must stay inside the skill directory/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildSkillCommandPrompt expands inline shell before applying arguments', async () => {
  const commands: string[] = []
  const prompt = await buildSkillCommandPrompt({
    name: 'shell',
    description: 'shell',
    content: 'Shell: !`echo ready`\nArgs: $ARGUMENTS',
    skillDir: process.cwd(),
  }, 'hello !`do not run`', {
    runShellCommand: async (command) => {
      commands.push(command)
      return { ok: true, content: 'ready\n' }
    },
  })

  assert.deepEqual(commands, ['echo ready'])
  assert.equal(prompt, 'Shell: ready\nArgs: hello !`do not run`')
})

test('buildSkillCommandPrompt rejects failed inline shell and does not continue', async () => {
  await assert.rejects(
    () => buildSkillCommandPrompt({
      name: 'shell-fail',
      description: 'shell',
      content: 'Shell: !`exit 1`',
      skillDir: process.cwd(),
    }, '', {
      runShellCommand: async () => ({ ok: false, content: 'boom', errorCode: 'command_failed' }),
    }),
    /Inline shell command failed/,
  )
})

test('registerSkillCommands registers disk skills as slash commands', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skill-command-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'slash-runner'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'slash-runner', 'SKILL.md'),
      '---\nname: slash-runner\ndescription: Run as slash command\n---\n\nPrompt: $ARGUMENTS',
      'utf8',
    )

    const result = await registerSkillCommands(dir)
    const command = getCommand('slash-runner')
    const submitted: Array<{ input: string; options?: unknown }> = []

    assert.deepEqual(result, { registered: 1, skipped: [] })
    assert.ok(command)
    assert.equal(command.description, 'Run as slash command')

    await command.run('hello world', {
      cwd: dir,
      sessionId: 's1',
      writeLine: () => {},
      clearMessages: () => {},
      submitQuery: async (input, options) => {
        submitted.push({ input, options })
      },
    })

    assert.deepEqual(submitted, [{
      input: 'Prompt: hello world',
      options: {
        skillName: 'slash-runner',
        skillArgs: 'hello world',
        displayInput: '/slash-runner hello world',
      },
    }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('registered skill command display input omits trailing space without args', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skill-command-display-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'slash-display'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'slash-display', 'SKILL.md'),
      '---\nname: slash-display\ndescription: Display command\n---\n\nPrompt body',
      'utf8',
    )

    await registerSkillCommands(dir)
    const command = getCommand('slash-display')
    const submitted: Array<{ input: string; options?: unknown }> = []

    assert.ok(command)
    await command.run('', {
      cwd: dir,
      sessionId: 's1',
      writeLine: () => {},
      clearMessages: () => {},
      submitQuery: async (input, options) => {
        submitted.push({ input, options })
      },
    })

    assert.deepEqual(submitted, [{
      input: 'Prompt body',
      options: {
        skillName: 'slash-display',
        skillArgs: '',
        displayInput: '/slash-display',
      },
    }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('registered skill command submits rich execution options', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skill-command-rich-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'slash-rich'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'slash-rich', 'SKILL.md'),
      [
        '---',
        'name: slash-rich',
        'description: Rich command',
        'allowedTools: [Read, Bash]',
        'model: powerful',
        'effort: high',
        'hooks:',
        '  stop:',
        '    - command: "echo stop"',
        '---',
        '',
        'Prompt: !`echo shell` $ARGUMENTS',
      ].join('\n'),
      'utf8',
    )

    await registerSkillCommands(dir)
    const command = getCommand('slash-rich')
    const submitted: Array<{ input: string; options?: unknown }> = []
    const shellCommands: string[] = []

    assert.ok(command)
    await command.run('hello world', {
      cwd: dir,
      sessionId: 's1',
      writeLine: () => {},
      clearMessages: () => {},
      runShellCommand: async (command) => {
        shellCommands.push(command)
        return { ok: true, content: 'shell-output' }
      },
      submitQuery: async (input, options) => {
        submitted.push({ input, options })
      },
    })

    assert.deepEqual(shellCommands, ['echo shell'])
    assert.equal(submitted[0]?.input, 'Prompt: shell-output hello world')
    assert.deepEqual(submitted[0]?.options, {
      allowedTools: ['Read', 'Bash'],
      model: 'powerful',
      effort: 'high',
      hooks: { stop: [{ command: 'echo stop' }] },
      skillName: 'slash-rich',
      skillArgs: 'hello world',
      displayInput: '/slash-rich hello world',
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('registered skill command requires shell helper for inline shell', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skill-command-shell-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'slash-shell'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'slash-shell', 'SKILL.md'),
      '---\nname: slash-shell\ndescription: Shell command\n---\n\nPrompt: !`echo shell`',
      'utf8',
    )

    await registerSkillCommands(dir)
    const command = getCommand('slash-shell')

    assert.ok(command)
    await assert.rejects(
      () => command.run('', {
        cwd: dir,
        sessionId: 's1',
        writeLine: () => {},
        clearMessages: () => {},
        submitQuery: async () => {
          throw new Error('submitQuery should not run')
        },
      }),
      /shell execution is not available/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('registerSkillCommands skips commands whose names are already registered', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skill-command-conflict-'))
  try {
    registerCommand({
      name: 'slash-conflict-target',
      description: 'Existing command',
      run: async () => {},
    })

    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'slash-conflict-target'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'slash-conflict-target', 'SKILL.md'),
      '---\nname: slash-conflict-target\ndescription: Skill command\n---\n\nSkill content',
      'utf8',
    )

    const result = await registerSkillCommands(dir)

    assert.deepEqual(result, { registered: 0, skipped: ['slash-conflict-target'] })
    assert.equal(getCommand('slash-conflict-target')?.description, 'Existing command')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('skill slash command reports missing query submission support', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skill-command-submit-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'slash-requires-submit'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'slash-requires-submit', 'SKILL.md'),
      '---\nname: slash-requires-submit\ndescription: Needs submit\n---\n\nSkill content',
      'utf8',
    )

    await registerSkillCommands(dir)
    const command = getCommand('slash-requires-submit')

    assert.ok(command)
    await assert.rejects(
      () => command.run('', {
        cwd: dir,
        sessionId: 's1',
        writeLine: () => {},
        clearMessages: () => {},
      }),
      /requires query submission support/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
