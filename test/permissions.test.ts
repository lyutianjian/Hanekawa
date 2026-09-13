import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import { z } from 'zod/v3'
import {
  PermissionGate,
  checkWindowsPathSafety,
  createSessionRuleStore,
  isProtectedPath,
  permissionRulesFromSettings,
  permissionRuleToEntry,
  type DenialState,
  type PermissionRule,
} from '../src/harness/permissions.js'
import { persistPermissionRule } from '../src/config/settings.js'
import { analyzeShellCommand } from '../src/harness/commandAnalysis.js'
import { bashTool } from '../src/tools/BashTool/BashTool.js'
import type { Tool } from '../src/harness/types.js'

const fsWriteTool: Tool = {
  name: 'fsWrite',
  description: 'Write a file',
  riskLevel: 'confirm',
  inputSchema: z.object({
    path: z.string().optional(),
    filePath: z.string().optional(),
  }).strict(),
  execute: async () => ({ ok: true, content: '' }),
}

const writeFileTool: Tool = {
  ...fsWriteTool,
  name: 'Write',
}

const editFileTool: Tool = {
  ...fsWriteTool,
  name: 'Edit',
}

const multiEditFileTool: Tool = {
  ...fsWriteTool,
  name: 'MultiEdit',
}

const deleteFileTool: Tool = {
  ...fsWriteTool,
  name: 'Delete',
  riskLevel: 'dangerous',
  isDestructive: true,
}

const readFileTool: Tool = {
  name: 'Read',
  description: 'Read a file',
  riskLevel: 'safe',
  isReadOnly: true,
  inputSchema: z.object({
    filePath: z.string(),
  }).strict(),
  execute: async () => ({ ok: true, content: '' }),
}

/**
 * A configured deny rule is the only thing that still denies without asking, so
 * it is what the denial-streak cases drive. Safety findings prompt instead.
 */
const DENIED_COMMAND = 'curl https://example.com'
const DENY_RULES: PermissionRule[] = [
  { toolName: 'Bash', contentPattern: 'curl:*', behavior: 'deny', source: 'config' },
]

const skillTool: Tool = {
  name: 'Skill',
  description: 'Load a skill',
  riskLevel: 'safe',
  inputSchema: z.object({}).strict(),
  execute: async () => ({ ok: true, content: '' }),
}

test('PermissionGate keeps bulk session rules separate from config rules', () => {
  const configRules: PermissionRule[] = [
    { toolName: 'Bash', behavior: 'deny', source: 'config' },
  ]
  const sessionRules: PermissionRule[] = [
    { toolName: 'fsWrite', behavior: 'allow', source: 'session' },
  ]
  const gate = new PermissionGate(async () => true, configRules)

  gate.addSessionRules(sessionRules)

  assert.deepEqual(gate.getConfigRules(), configRules)
  assert.deepEqual(gate.getSessionRules(), sessionRules)
})

test('PermissionGate routes bulk rules by source field', () => {
  const configRule: PermissionRule = { toolName: 'Bash', behavior: 'deny', source: 'config' }
  const sessionRule: PermissionRule = { toolName: 'fsWrite', behavior: 'allow', source: 'session' }
  const gate = new PermissionGate(async () => true, [sessionRule])

  gate.addSessionRules([configRule])

  assert.deepEqual(gate.getConfigRules(), [configRule])
  assert.deepEqual(gate.getSessionRules(), [sessionRule])
})

test('PermissionGate dedupes inherited rules by source', () => {
  const configRule: PermissionRule = { toolName: 'Bash', behavior: 'deny', source: 'config' }
  const sessionRule: PermissionRule = {
    toolName: 'fsWrite',
    contentPattern: '*a.txt',
    behavior: 'allow',
    source: 'session',
  }
  const parentGate = new PermissionGate(async () => true, [configRule, configRule])
  parentGate.addSessionRules([sessionRule, sessionRule])
  const childGate = new PermissionGate(async () => true, parentGate.getConfigRules())

  childGate.addSessionRules([...parentGate.getSessionRules(), ...parentGate.getSessionRules()])

  assert.deepEqual(childGate.getConfigRules(), [configRule])
  assert.deepEqual(childGate.getSessionRules(), [sessionRule])
})

test('permissionRulesFromSettings converts allow deny and ask entries', () => {
  assert.deepEqual(permissionRulesFromSettings({
    allow: ['Read', 'Bash:*npm test*'],
    deny: ['Delete'],
    ask: ['Write:src/**'],
  }), [
    { toolName: 'Delete', behavior: 'deny', source: 'config' },
    { toolName: 'Write', contentPattern: 'src/**', behavior: 'ask', source: 'config' },
    { toolName: 'Read', behavior: 'allow', source: 'config' },
    { toolName: 'Bash', contentPattern: '*npm test*', behavior: 'allow', source: 'config' },
  ])
})

test('PermissionGate ask rules force safe tools to prompt', async () => {
  let prompted = false
  let source = ''
  const gate = new PermissionGate(
    async (request) => {
      prompted = true
      source = request.source
      return true
    },
    [{ toolName: 'Read', behavior: 'ask', source: 'config' }],
  )

  const approved = await gate.approve(readFileTool, { filePath: 'src/index.ts' })

  assert.equal(approved, true)
  assert.equal(prompted, true)
  assert.equal(source, 'ask rule')
})

test('PermissionGate deny rules win over ask and allow rules', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return true
    },
    [
      { toolName: 'fsWrite', behavior: 'allow', source: 'config' },
      { toolName: 'fsWrite', behavior: 'ask', source: 'config' },
      { toolName: 'fsWrite', behavior: 'deny', source: 'config' },
    ],
  )

  const approved = await gate.approve(fsWriteTool, { path: 'src/index.ts' })

  assert.equal(approved, false)
  assert.equal(prompted, false)
})

test('PermissionGate allows read-only bash inside protected paths without prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return true
  })

  // Protected paths guard edits, not reads: reading .git/config is normal work.
  const approved = await gate.approve(bashTool, { command: 'cat .git/config' })

  assert.equal(approved, true)
  assert.equal(prompted, false)
})

test('PermissionGate prompts for bash writes into protected paths', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return false
  })

  const approved = await gate.approve(bashTool, { command: 'rm .git/config' })

  assert.equal(approved, false)
  assert.equal(prompted, true)
})

test('PermissionGate allows read-only tools inside protected paths', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return false
  })

  assert.equal(await gate.approve(readFileTool, { filePath: '.git/config' }), true)
  assert.equal(await gate.approve(readFileTool, { filePath: '.myagent/settings.json' }), true)
  assert.equal(prompted, false)
})

test('PermissionGate auto-allows the expanded read-only command set', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return false
  })

  for (const command of [
    'echo hi',
    'which node',
    'date',
    'sort README.md',
    'diff a.txt b.txt',
    'git blame README.md',
    'git stash list',
    'git worktree list',
  ]) {
    assert.equal(await gate.approve(bashTool, { command }), true, command)
  }
  assert.equal(prompted, false)
})

test('PermissionGate keeps output-file variants of read commands off the fast path', async () => {
  let prompts = 0
  const gate = new PermissionGate(async () => {
    prompts++
    return false
  })

  for (const command of ['sort -o out.txt f', 'tree -o out.html', 'uniq in.txt out.txt', 'git stash pop']) {
    assert.equal(await gate.approve(bashTool, { command }), false, command)
  }
  assert.equal(prompts, 4)
})

test('PermissionGate denial reason distinguishes policy from the user', async () => {
  const denyRule: PermissionRule = { toolName: 'Bash', contentPattern: 'curl:*', behavior: 'deny', source: 'config' }
  const gate = new PermissionGate(async () => false, [denyRule])

  const byRule = await gate.approveDetailed(bashTool, { command: DENIED_COMMAND })
  assert.equal(byRule.approved, false)
  assert.equal(byRule.source, 'deny rule')
  assert.match(byRule.denialReason ?? '', /deny rule: Bash\(curl:\*\)/)
  assert.doesNotMatch(byRule.denialReason ?? '', /User denied/)

  const byUser = await gate.approveDetailed(bashTool, { command: 'npm run build' })
  assert.equal(byUser.approved, false)
  assert.match(byUser.denialReason ?? '', /User denied permission for Bash/)
})

test('PermissionGate readonly mode names itself in the denial reason', async () => {
  const gate = new PermissionGate(async () => true, [], { mode: 'readonly' })

  const decision = await gate.approveDetailed(bashTool, { command: 'rm -rf tmp' })

  assert.equal(decision.approved, false)
  assert.equal(decision.source, 'readonly mode')
  assert.match(decision.denialReason ?? '', /Read-only permission mode/)
})

test('PermissionGate checks Windows path safety outside bypass mode', async () => {
  let reason = ''
  const gate = new PermissionGate(async (request) => {
    reason = request.reason
    return false
  })

  assert.equal(await gate.approve(readFileTool, { filePath: 'C:/x/notes.txt:hidden' }), false)
  assert.match(reason, /Suspicious path/)
})

test('checkWindowsPathSafety flags bypass shapes but not ordinary relative navigation', () => {
  for (const safe of [
    // `.` and `..` are navigation, not a trailing-dot bypass. Flagging them
    // made every parent-relative path a "suspicious path" prompt.
    '../out.ts',
    '..',
    '.',
    './a/../b.ts',
    'a/b/../c.ts',
    'src/x.ts',
    '.gitignore',
    'x...y.ts',
  ]) {
    assert.equal(checkWindowsPathSafety(safe).suspicious, false, safe)
  }

  for (const suspicious of [
    '.git./config',
    'settings.json.',
    '.claude ',
    'a/.../b',
    '.../file.txt',
    // A DOS device name reached as a suffix, not just as a whole component.
    'settings.json.PRN',
    '.git.CON',
    'NUL',
    'GIT~1/config',
    'file.txt:hidden',
    '//?/C:/x',
    '\\\\server\\share',
  ]) {
    assert.equal(checkWindowsPathSafety(suspicious).suspicious, true, suspicious)
  }
})

test('PermissionGate includes destructive bash category in prompt reason', async () => {
  let reason = ''
  const gate = new PermissionGate(async (request) => {
    reason = request.reason
    return true
  })

  const approved = await gate.approve(bashTool, { command: 'git reset --hard HEAD' })

  assert.equal(approved, true)
  assert.match(reason, /destructive filesystem or git operation/)
})

test('PermissionGate includes complex command category in prompt reason', async () => {
  let reason = ''
  const gate = new PermissionGate(async (request) => {
    reason = request.reason
    return true
  })

  const approved = await gate.approve(bashTool, { command: 'npm test && npm run typecheck' })

  assert.equal(approved, true)
  assert.match(reason, /complex shell command/)
})

test('PermissionGate auto-allows simple read-only bash commands in default mode', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return true
  })

  const approved = await gate.approve(bashTool, { command: 'pwd' })

  assert.equal(approved, true)
  assert.equal(prompted, false)
})

test('PermissionGate auto-allows read-only bash variants without prompting in default mode', async () => {
  let prompts = 0
  const gate = new PermissionGate(async () => {
    prompts++
    return true
  })

  for (const command of [
    'git status',
    'git log --oneline',
    'git diff',
    'cat README.md',
    'rg TODO src',
    'ls -la',
    'wc -l file.txt',
  ]) {
    assert.equal(await gate.approve(bashTool, { command }), true)
  }
  assert.equal(prompts, 0)

  // Mutating / destructive / external commands still prompt.
  for (const command of ['git push', 'rm -rf dist', 'npm install', 'sed -i s/a/b/ f']) {
    assert.equal(await gate.approve(bashTool, { command }), true)
  }
  assert.equal(prompts, 4)
})

test('PermissionGate Bash prefix rule (CC syntax) matches subcommand args without prompting', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => { prompts++; return true },
    [{ toolName: 'Bash', contentPattern: 'npm install:*', behavior: 'allow', source: 'config' }],
  )
  assert.equal(await gate.approve(bashTool, { command: 'npm install' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'npm install pkg' }), true)
  assert.equal(prompts, 0)
  // Different prefix still prompts.
  assert.equal(await gate.approve(bashTool, { command: 'npm run build' }), true)
  assert.equal(prompts, 1)
})

test('PermissionGate Bash exact rule (CC syntax) matches only the exact command', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => { prompts++; return true },
    [{ toolName: 'Bash', contentPattern: 'npm run build', behavior: 'allow', source: 'config' }],
  )
  assert.equal(await gate.approve(bashTool, { command: 'npm run build' }), true)
  assert.equal(prompts, 0)
  assert.equal(await gate.approve(bashTool, { command: 'npm run build --foo' }), true)
  assert.equal(prompts, 1)
})

test('PermissionGate Bash wildcard rule matches within the prefix', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => { prompts++; return true },
    [{ toolName: 'Bash', contentPattern: 'git *', behavior: 'allow', source: 'config' }],
  )
  assert.equal(await gate.approve(bashTool, { command: 'git push' }), true)
  assert.equal(prompts, 0)
  assert.equal(await gate.approve(bashTool, { command: 'npm run build' }), true)
  assert.equal(prompts, 1)
})

test('PermissionGate Bash prefix rule enforces word boundaries', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => { prompts++; return true },
    [{ toolName: 'Bash', contentPattern: 'ls:*', behavior: 'allow', source: 'config' }],
  )
  // `lsusb` rather than `lsof`: the latter is on the read-only allowlist and
  // would be auto-approved before rule matching ever runs, which would hide
  // the boundary this test is about.
  assert.equal(await gate.approve(bashTool, { command: 'lsusb' }), true)
  assert.equal(prompts, 1)
})

test('PermissionGate Bash allow rule does not match compound commands', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => { prompts++; return true },
    [{ toolName: 'Bash', contentPattern: 'cd:*', behavior: 'allow', source: 'config' }],
  )
  assert.equal(await gate.approve(bashTool, { command: 'cd /x && rm file' }), true)
  assert.equal(prompts, 1)
})

test('PermissionGate Bash deny rule matches compound subcommands', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => { prompts++; return true },
    [{ toolName: 'Bash', contentPattern: 'rm:*', behavior: 'deny', source: 'config' }],
  )
  assert.equal(await gate.approve(bashTool, { command: 'cd /x && rm file' }), false)
  assert.equal(prompts, 0)
})

test('PermissionGate Bash deny rule strips env var prefixes to prevent bypass', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => { prompts++; return true },
    [{ toolName: 'Bash', contentPattern: 'rm:*', behavior: 'deny', source: 'config' }],
  )
  assert.equal(await gate.approve(bashTool, { command: 'FOO=bar rm file' }), false)
  assert.equal(prompts, 0)
})

test('PermissionGate Bash allow rule strips safe wrappers before matching', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => { prompts++; return true },
    [{ toolName: 'Bash', contentPattern: 'npm install:*', behavior: 'allow', source: 'config' }],
  )
  assert.equal(await gate.approve(bashTool, { command: 'timeout 10 npm install' }), true)
  assert.equal(prompts, 0)
})

test('PermissionGate legacy Bash:prefix:* syntax still works as prefix rule', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => { prompts++; return true },
    permissionRulesFromSettings({ allow: ['Bash:npm install:*'] }),
  )
  assert.equal(await gate.approve(bashTool, { command: 'npm install pkg' }), true)
  assert.equal(prompts, 0)
})

test('PermissionGate always allow creates a prefix Bash session rule', async () => {
  let prompts = 0
  let scopedRule: PermissionRule | undefined
  const gate = new PermissionGate(async (request) => {
    prompts++
    scopedRule = request.alwaysAllowRule
    request.onAlwaysAllow?.()
    return true
  })

  assert.equal(await gate.approve(bashTool, { command: 'mkdir test' }), true)
  assert.deepEqual(scopedRule, {
    toolName: 'Bash',
    contentPattern: 'mkdir test:*',
    behavior: 'allow',
    source: 'session',
  })
  assert.deepEqual(gate.getSessionRules(), [scopedRule])

  assert.equal(await gate.approve(bashTool, { command: 'mkdir test' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'mkdir test sub' }), true)
  assert.equal(prompts, 1)

  assert.equal(await gate.approve(bashTool, { command: 'mkdir other' }), true)
  assert.equal(prompts, 2)
})

test('PermissionGate always allow creates file-path scoped file-tool rules', async () => {
  const gate = new PermissionGate(async (request) => {
    request.onAlwaysAllow?.()
    return true
  })

  assert.equal(await gate.approve(writeFileTool, { filePath: 'src/app.ts' }), true)
  assert.equal(await gate.approve(editFileTool, { filePath: 'src/edit.ts' }), true)
  assert.equal(await gate.approve(multiEditFileTool, { filePath: 'src/multi.ts' }), true)
  assert.equal(await gate.approve(deleteFileTool, { filePath: 'src/delete.ts' }), true)

  assert.deepEqual(gate.getSessionRules(), [
    { toolName: 'Write', contentPattern: 'src/app.ts', behavior: 'allow', source: 'session' },
    { toolName: 'Edit', contentPattern: 'src/edit.ts', behavior: 'allow', source: 'session' },
    { toolName: 'MultiEdit', contentPattern: 'src/multi.ts', behavior: 'allow', source: 'session' },
    { toolName: 'Delete', contentPattern: 'src/delete.ts', behavior: 'allow', source: 'session' },
  ])
})

test('PermissionGate always allow reuses the git commit prefix for later invocations', async () => {
  let prompts = 0
  const gate = new PermissionGate(async (request) => {
    prompts++
    request.onAlwaysAllow?.()
    return true
  })

  assert.equal(await gate.approve(bashTool, { command: 'git commit -m "first"' }), true)
  assert.deepEqual(gate.getSessionRules(), [
    { toolName: 'Bash', contentPattern: 'git commit:*', behavior: 'allow', source: 'session' },
  ])
  assert.equal(await gate.approve(bashTool, { command: 'git commit -am "second"' }), true)
  assert.equal(prompts, 1)
  // Different prefix still prompts.
  assert.equal(await gate.approve(bashTool, { command: 'git push' }), true)
  assert.equal(prompts, 2)
})

test('PermissionGate always allow covers a compound whose segments share a prefix', async () => {
  let prompts = 0
  const gate = new PermissionGate(async (request) => {
    prompts++
    request.onAlwaysAllow?.()
    return true
  })

  assert.equal(await gate.approve(bashTool, { command: 'npm run build && npm run bundle' }), true)
  assert.equal(prompts, 1)
  assert.deepEqual(gate.getSessionRules(), [
    { toolName: 'Bash', contentPattern: 'npm run:*', behavior: 'allow', source: 'session' },
  ])

  // The rule now covers the compound it was created from, and each half alone.
  assert.equal(await gate.approve(bashTool, { command: 'npm run build && npm run bundle' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'npm run bundle' }), true)
  assert.equal(prompts, 1)

  // A segment the rule does not cover still stops the compound.
  assert.equal(await gate.approve(bashTool, { command: 'npm run build && npm publish' }), true)
  assert.equal(prompts, 2)
})

test('PermissionGate always allow is not offered for bare shells and privilege wrappers', async () => {
  const gate = new PermissionGate(async (request) => {
    request.onAlwaysAllow?.()
    return true
  })
  assert.equal(await gate.approve(bashTool, { command: 'sudo apt update' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'bash -c "echo hi"' }), true)
  assert.deepEqual(gate.getSessionRules(), [])
})

test('PermissionGate always allow is not offered when an operand absorbs shell operators', async () => {
  const gate = new PermissionGate(async (request) => {
    request.onAlwaysAllow?.()
    return true
  })
  assert.equal(await gate.approve(bashTool, { command: 'git commit a&rm -rf x' }), true)
  assert.deepEqual(gate.getSessionRules(), [])
})

test('PermissionGate always allow is not offered when compound segments have different prefixes', async () => {
  const gate = new PermissionGate(async (request) => {
    request.onAlwaysAllow?.()
    return true
  })
  assert.equal(await gate.approve(bashTool, { command: 'mkdir a && mkdir b' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'rm -rf dist' }), true)
  assert.deepEqual(gate.getSessionRules(), [])
})

test('PermissionGate session always allow overrides config ask rules', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async (request) => {
      prompts++
      request.onAlwaysAllow?.()
      return true
    },
    permissionRulesFromSettings({ ask: ['Bash(npm run build)'] }),
  )

  // Config ask rule prompts, and the prompt offers an always option.
  assert.equal(await gate.approve(bashTool, { command: 'npm run build' }), true)
  assert.equal(prompts, 1)
  assert.deepEqual(gate.getSessionRules(), [
    { toolName: 'Bash', contentPattern: 'npm run:*', behavior: 'allow', source: 'session' },
  ])

  // The session allow rule now suppresses the config ask rule.
  assert.equal(await gate.approve(bashTool, { command: 'npm run build' }), true)
  assert.equal(prompts, 1)
  // A command the session rule does not cover still prompts.
  assert.equal(await gate.approve(bashTool, { command: 'npm test' }), true)
  assert.equal(prompts, 2)
})

test('PermissionGate includes matched rules in prompt requests', async () => {
  const askRule: PermissionRule = { toolName: 'Read', contentPattern: 'src/**', behavior: 'ask', source: 'config' }
  const denyRule: PermissionRule = { toolName: 'fsWrite', contentPattern: 'src/**', behavior: 'deny', source: 'config' }
  const allowRule: PermissionRule = { toolName: 'Bash', contentPattern: 'env FOO=bar npm test', behavior: 'allow', source: 'config' }
  const seen: Array<PermissionRule | undefined> = []
  const gate = new PermissionGate(
    async (request) => {
      seen.push(request.matchedRule)
      return true
    },
    [askRule, denyRule, allowRule],
    { denialStreakThreshold: 1 },
  )

  assert.equal(await gate.approve(readFileTool, { filePath: 'src/index.ts' }), true)
  assert.equal(await gate.approve(fsWriteTool, { filePath: 'src/index.ts' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'env FOO=bar npm test' }), true)

  assert.deepEqual(seen, [askRule, denyRule, allowRule])
})

test('PermissionGate omits always allow for unsafe Bash and deny-rule prompts', async () => {
  const alwaysRules: Array<PermissionRule | undefined> = []
  const gate = new PermissionGate(
    async (request) => {
      alwaysRules.push(request.alwaysAllowRule)
      request.onAlwaysAllow?.()
      return true
    },
    [{ toolName: 'fsWrite', behavior: 'deny', source: 'config' }],
    { denialStreakThreshold: 1 },
  )

  assert.equal(await gate.approve(bashTool, { command: 'npm test && npm run typecheck' }), true)
  assert.equal(await gate.approve(fsWriteTool, { filePath: 'src/index.ts' }), true)

  assert.deepEqual(alwaysRules, [undefined, undefined])
  assert.deepEqual(gate.getSessionRules(), [])
})

// --- Protected path coverage (aligned with Claude Code safetyCheck) --------

test('isProtectedPath catches dangerous directories', () => {
  assert.equal(isProtectedPath('.git/config'), true)
  assert.equal(isProtectedPath('repo/.git/HEAD'), true)
  assert.equal(isProtectedPath('.vscode/settings.json'), true)
  assert.equal(isProtectedPath('.idea/workspace.xml'), true)
  assert.equal(isProtectedPath('.myagent/config.json'), true)
})

test('isProtectedPath catches shell config and agent config files', () => {
  assert.equal(isProtectedPath('.gitconfig'), true)
  assert.equal(isProtectedPath('/home/me/.gitconfig'), true)
  assert.equal(isProtectedPath('.bashrc'), true)
  assert.equal(isProtectedPath('.bash_profile'), true)
  assert.equal(isProtectedPath('.zshrc'), true)
  assert.equal(isProtectedPath('.zprofile'), true)
  assert.equal(isProtectedPath('.profile'), true)
  assert.equal(isProtectedPath('.ripgreprc'), true)
  assert.equal(isProtectedPath('.mcp.json'), true)
  assert.equal(isProtectedPath('.myagent.json'), true)
})

test('isProtectedPath does not protect secrets outside the CC list', () => {
  assert.equal(isProtectedPath('.env'), false)
  assert.equal(isProtectedPath('.ssh/id_rsa'), false)
  assert.equal(isProtectedPath('id_rsa'), false)
  assert.equal(isProtectedPath('cert.pem'), false)
  assert.equal(isProtectedPath('credentials.json'), false)
  assert.equal(isProtectedPath('.aws/credentials'), false)
  assert.equal(isProtectedPath('.npmrc'), false)
})

test('isProtectedPath does not over-match safe filenames', () => {
  assert.equal(isProtectedPath('readme.md'), false)
  assert.equal(isProtectedPath('src/index.ts'), false)
  assert.equal(isProtectedPath('package.json'), false)
  assert.equal(isProtectedPath('keymap.ts'), false)
})

test('PermissionGate prompts before fsWrite to .bashrc', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return false
  })

  const approved = await gate.approve(fsWriteTool, { path: '/home/me/.bashrc' })

  assert.equal(approved, false)
  assert.equal(prompted, true)
})

test('PermissionGate prompts before a bash command writing into .git', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return false
  })

  const approved = await gate.approve(bashTool, { command: 'echo data > .git/config' })

  assert.equal(approved, false)
  assert.equal(prompted, true)
})

test('PermissionGate allows bash reading .gitconfig without prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return true
  })

  const approved = await gate.approve(bashTool, { command: 'cat ~/.gitconfig' })

  assert.equal(approved, true)
  assert.equal(prompted, false)
})

// --- New: denial streak tracking ------------------------------------------

test('PermissionGate auto-denies up to threshold-1 times, then prompts the user', async () => {
  let prompts = 0
  let lastStreak = 0
  const gate = new PermissionGate(
    async (request) => {
      prompts++
      lastStreak = request.denialStreak
      return false
    },
    DENY_RULES,
    { denialStreakThreshold: 3 },
  )

  // Calls 1 and 2 are silently auto-denied.
  assert.equal(await gate.approve(bashTool, { command: DENIED_COMMAND }), false)
  assert.equal(await gate.approve(bashTool, { command: DENIED_COMMAND }), false)
  assert.equal(prompts, 0)

  // Call 3 escalates to a user prompt.
  assert.equal(await gate.approve(bashTool, { command: DENIED_COMMAND }), false)
  assert.equal(prompts, 1)
  assert.equal(lastStreak, 3)
})

test('PermissionGate restores persisted denial state across instances', async () => {
  let state: DenialState = { streaks: {}, total: 0 }
  const store = {
    getDenialState: async () => state,
    setDenialState: async (next: DenialState) => { state = next },
  }

  const firstGate = new PermissionGate(async () => {
    throw new Error('first gate should not prompt')
  }, DENY_RULES, { denialStreakThreshold: 2, denialStateStore: store })
  assert.equal(await firstGate.approve(bashTool, { command: DENIED_COMMAND }), false)
  assert.deepEqual(state, { streaks: { Bash: 1 }, total: 1 })

  let prompts = 0
  let restoredStreak = 0
  const secondGate = new PermissionGate(async (request) => {
    prompts++
    restoredStreak = request.denialStreak
    return false
  }, DENY_RULES, { denialStreakThreshold: 2, denialStateStore: store })

  assert.equal(await secondGate.approve(bashTool, { command: DENIED_COMMAND }), false)
  assert.equal(prompts, 1)
  assert.equal(restoredStreak, 2)
})

test('PermissionGate keeps prompting after a user-prompted denial', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => {
      prompts++
      return false
    },
    DENY_RULES,
    { denialStreakThreshold: 2 },
  )

  // First call auto-denies.
  await gate.approve(bashTool, { command: DENIED_COMMAND })
  // Second call hits threshold and prompts the user.
  await gate.approve(bashTool, { command: DENIED_COMMAND })
  assert.equal(prompts, 1)

  // After the user explicitly denies, keep asking instead of dropping back to
  // silent auto-denial.
  await gate.approve(bashTool, { command: DENIED_COMMAND })
  assert.equal(prompts, 2)
})

test('PermissionGate clears denial streak after a user-prompted approval', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => {
      prompts++
      return true
    },
    DENY_RULES,
    { denialStreakThreshold: 2 },
  )

  await gate.approve(bashTool, { command: DENIED_COMMAND })
  await gate.approve(bashTool, { command: DENIED_COMMAND })
  assert.equal(prompts, 1)

  // Approval clears the streak, so the next denial is silent again.
  await gate.approve(bashTool, { command: DENIED_COMMAND })
  assert.equal(prompts, 1)
})

test('PermissionGate streak resets when a different call is approved', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => {
      prompts++
      return true
    },
    DENY_RULES,
    { denialStreakThreshold: 2 },
  )

  // Auto-denied - streak goes to 1.
  await gate.approve(bashTool, { command: DENIED_COMMAND })
  // A normal prompt-and-allow on the same tool resets the streak.
  await gate.approve(bashTool, { command: 'mkdir normal' })
  assert.equal(prompts, 1)

  // Streak should have been reset, so the next denial is silent again.
  await gate.approve(bashTool, { command: DENIED_COMMAND })
  assert.equal(prompts, 1)
})

test('PermissionGate denial streak is per-tool, not global', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => {
      prompts++
      return false
    },
    [...DENY_RULES, { toolName: 'fsWrite', behavior: 'deny', source: 'config' }],
    { denialStreakThreshold: 2 },
  )

  // bash hits threshold -> prompt.
  await gate.approve(bashTool, { command: DENIED_COMMAND })
  await gate.approve(bashTool, { command: DENIED_COMMAND })
  assert.equal(prompts, 1)

  // bash denial streak does not affect fsWrite's own counter - first denial is silent.
  await gate.approve(fsWriteTool, { path: 'src/index.ts' })
  assert.equal(prompts, 1)
})

test('PermissionGate prompt request includes denialStreak when escalated', async () => {
  let received = 0
  const gate = new PermissionGate(
    async (request) => {
      received = request.denialStreak
      return false
    },
    DENY_RULES,
    { denialStreakThreshold: 2 },
  )

  await gate.approve(bashTool, { command: DENIED_COMMAND })
  await gate.approve(bashTool, { command: DENIED_COMMAND })

  assert.equal(received, 2)
})

test('PermissionGate sets denialStreak=0 for normal (non-escalated) prompts', async () => {
  let received = -1
  const gate = new PermissionGate(async (request) => {
    received = request.denialStreak
    return true
  })

  await gate.approve(bashTool, { command: 'mkdir x' })

  assert.equal(received, 0)
})

test('PermissionGate escalated prompt reason calls out the loop', async () => {
  let reason = ''
  const gate = new PermissionGate(
    async (request) => {
      reason = request.reason
      return false
    },
    DENY_RULES,
    { denialStreakThreshold: 2 },
  )

  await gate.approve(bashTool, { command: DENIED_COMMAND })
  await gate.approve(bashTool, { command: DENIED_COMMAND })

  assert.match(reason, /auto-denied/i)
  assert.match(reason, /2 times/i)
})

test('PermissionGate threshold of 1 prompts on the very first denial', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => {
      prompts++
      return false
    },
    DENY_RULES,
    { denialStreakThreshold: 1 },
  )

  await gate.approve(bashTool, { command: DENIED_COMMAND })
  assert.equal(prompts, 1)
})

test('PermissionGate prompts for bash command substitution even with an allow rule', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return true
    },
    [{ toolName: 'Bash', behavior: 'allow', source: 'config' }],
  )

  // The allow rule still cannot auto-approve it; the user decides instead.
  const approved = await gate.approve(bashTool, { command: 'echo $(cat package.json)' })

  assert.equal(approved, true)
  assert.equal(prompted, true)
})

test('PermissionGate prompts for bash redirection instead of denying it', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return true
  })

  const approved = await gate.approve(bashTool, { command: 'echo data > out.txt' })

  assert.equal(approved, true)
  assert.equal(prompted, true)
})

test('PermissionGate treats discard redirections as read-only', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return true
  })

  for (const command of ['ls -la 2>/dev/null', 'git log --oneline 2>&1 | head -5', 'cat f > /dev/null']) {
    assert.equal(await gate.approve(bashTool, { command }), true, command)
  }
  assert.equal(prompted, false)
})

test('PermissionGate checks protected paths in each bash segment', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return false
  })

  // A write in any segment is enough; the read-only twin stays silent.
  assert.equal(await gate.approve(bashTool, { command: 'echo ok && rm ~/.gitconfig' }), false)
  assert.equal(prompted, true)

  prompted = false
  assert.equal(await gate.approve(bashTool, { command: 'echo ok && cat ~/.gitconfig' }), true)
  assert.equal(prompted, false)
})

test('PermissionGate prompts for bash commands with too many segments', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return false
  })
  const command = Array.from({ length: 51 }, (_, index) => `echo ${index}`).join(' && ')

  const approved = await gate.approve(bashTool, { command })

  assert.equal(approved, false)
  assert.equal(prompted, true)
})

test('PermissionGate prompts for zsh dangerous builtins', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return false
  })

  const approved = await gate.approve(bashTool, { command: 'zmodload zsh/system' })

  assert.equal(approved, false)
  assert.equal(prompted, true)
})

test('PermissionGate prompts for quoted newline and comment quote desync syntax', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return false
  })

  assert.equal(await gate.approve(bashTool, { command: 'echo "hello\nworld"' }), false)
  assert.equal(await gate.approve(bashTool, { command: 'echo safe # "unterminated by shell parser"' }), false)
  assert.equal(prompted, true)
})

test('PermissionGate prompts for standalone empty quoted arguments', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return false
  })

  assert.equal(await gate.approve(bashTool, { command: 'rm "" -rf tmp' }), false)
  assert.equal(await gate.approve(bashTool, { command: "rm '' -rf tmp" }), false)
  assert.equal(prompted, true)
})

test('PermissionGate shell wrapper prefixes bypass auto-allow and prompt', async () => {
  let prompted = false
  let reason = ''
  const gate = new PermissionGate(
    async (request) => {
      prompted = true
      reason = request.reason
      return true
    },
    [{ toolName: 'Bash', behavior: 'allow', source: 'config' }],
  )

  const approved = await gate.approve(bashTool, { command: 'env FOO=bar npm test' })

  assert.equal(approved, true)
  assert.equal(prompted, true)
  assert.match(reason, /shell wrapper or privilege prefix/)
})

test('analyzeShellCommand detects recursive force rm across whitespace and flag order', () => {
  const commands = [
    'rm -fr tmp',
    'rm -f  -r tmp',
    'rm\t-rf tmp',
    'rm --force --recursive tmp',
  ]

  for (const command of commands) {
    const analysis = analyzeShellCommand(command)
    assert.ok(analysis.categories.includes('destructive filesystem or git operation'), command)
  }
})

test('analyzeShellCommand flags write-capable find fd and sed variants', () => {
  const commands = [
    'sed -i s/a/b/ file.txt',
    'perl -i.bak -pe s/a/b/ file.txt',
    'fd pattern --exec rm {}',
    'fd pattern -x rm {}',
    'find . -delete',
    'find . -exec rm {} ;',
  ]

  for (const command of commands) {
    const analysis = analyzeShellCommand(command)
    assert.ok(analysis.categories.includes('destructive filesystem or git operation'), command)
  }
})

test('PermissionGate catches protected filePath inputs', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return false
  })

  const approved = await gate.approve(fsWriteTool, { filePath: '.bashrc' })

  assert.equal(approved, false)
  assert.equal(prompted, true)
})

test('PermissionGate acceptEdits mode approves edit tools without prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'acceptEdits' },
  )

  assert.equal(await gate.approve(writeFileTool, { path: 'src/index.ts' }), true)
  assert.equal(await gate.approve(editFileTool, { path: 'src/index.ts' }), true)
  assert.equal(prompted, false)
})

test('PermissionGate acceptEdits mode prompts for edits outside the workspace', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => {
      prompts++
      return true
    },
    [],
    { mode: 'acceptEdits' },
  )

  assert.equal(await gate.approve(editFileTool, { filePath: '../outside.ts' }), true)
  assert.equal(await gate.approve(editFileTool, { filePath: path.join(os.tmpdir(), 'outside.ts') }), true)
  assert.equal(prompts, 2)
  assert.equal(await gate.approve(editFileTool, { filePath: 'src/index.ts' }), true)
  assert.equal(prompts, 2)
})

test('PermissionGate acceptEdits mode keeps other tools on the normal gate', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return true
    },
    [],
    { mode: 'acceptEdits' },
  )

  assert.equal(await gate.approve(bashTool, { command: 'npm run build' }), true)
  assert.equal(prompted, true)
})

test('PermissionGate acceptEdits mode allows simple workspace mkdir and touch bash commands', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'acceptEdits', cwd: process.cwd() },
  )

  assert.equal(await gate.approve(bashTool, { command: 'mkdir src/new-dir' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'touch src/new-file.ts' }), true)
  assert.equal(prompted, false)
})

test('PermissionGate acceptEdits mode prompts for bash paths outside the workspace', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return true
    },
    [],
    { mode: 'acceptEdits', cwd: process.cwd() },
  )

  assert.equal(await gate.approve(bashTool, { command: 'touch ../outside.txt' }), true)
  assert.equal(prompted, true)
})

test('PermissionGate acceptEdits mode allows the filesystem command allowlist inside the workspace', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'acceptEdits', cwd: process.cwd() },
  )

  for (const command of [
    'mkdir src/new-dir',
    'touch src/new-file.ts',
    'rm src/old-file.ts',
    'rm -rf src/build',
    'rmdir src/empty',
    'mv src/a.ts src/b.ts',
    'cp src/a.ts src/b.ts',
    'sed -i "s/a/b/" src/a.ts',
  ]) {
    assert.equal(await gate.approve(bashTool, { command }), true, command)
  }
  assert.equal(prompted, false)
})

test('PermissionGate acceptEdits mode still prompts for unsafe allowlist invocations', async () => {
  const prompts: string[] = []
  const gate = new PermissionGate(
    async (request) => {
      prompts.push((request.input as { command: string }).command)
      return true
    },
    [],
    { mode: 'acceptEdits', cwd: process.cwd() },
  )

  const mustPrompt = [
    // Outside the workspace.
    'rm ../outside.txt',
    'mv src/a.ts ../a.ts',
    // Protected path.
    'rm .git/config',
    // The sed script itself writes or executes.
    'sed -i "s/a/b/w /tmp/leak" src/a.ts',
    'sed -i "/x/e touch marker" src/a.ts',
    // The script is in a file this analysis cannot read.
    'sed -i -f script.sed src/a.ts',
    // Not an in-place edit at all, so not an accept-edits write.
    'sed "s/a/b/" src/a.ts > src/b.ts',
    // A category other than the destructive one.
    'rm src/a.ts && curl https://example.com',
    'cp $(ls src) dest',
  ]
  for (const command of mustPrompt) {
    await gate.approve(bashTool, { command })
  }

  assert.deepEqual(prompts, mustPrompt)
})

test('PermissionGate acceptEdits mode closes the flag-shaped path-validation bypasses', async () => {
  const prompts: string[] = []
  const gate = new PermissionGate(
    async (request) => {
      prompts.push((request.input as { command: string }).command)
      return true
    },
    [],
    { mode: 'acceptEdits', cwd: process.cwd() },
  )

  const mustPrompt = [
    // POSIX `--`: a path after it starts with `-` and a naive flag filter
    // would never present it for validation.
    'rm -rf src/build -- -/../../elsewhere',
    // A flag can carry the destination, so mv/cp take no flags at all.
    'cp --target-directory=/etc src/a.ts',
    'mv --target-directory=/etc src/a.ts',
    // Outside the sed substitution allowlist: a delete command, an `-e`
    // expression, and two commands in one script.
    'sed -i "1,10d" src/a.ts',
    'sed -i -e "s/a/b/" src/a.ts',
    'sed -i "s/a/b/;s/c/d/" src/a.ts',
  ]
  for (const command of mustPrompt) {
    await gate.approve(bashTool, { command })
  }
  assert.deepEqual(prompts, mustPrompt)

  for (const command of ['cp src/a.ts src/b.ts', 'mv src/a.ts src/b.ts', 'sed -i -E "s/a/b/g" src/a.ts']) {
    assert.equal(await gate.approve(bashTool, { command }), true, command)
  }
  assert.deepEqual(prompts, mustPrompt)
})

test('PermissionGate never auto-approves a dangerous removal, even under an allow rule', async () => {
  const prompted: string[] = []
  const gate = new PermissionGate(
    async (request) => {
      prompted.push((request.input as { command: string }).command)
      return false
    },
    [{ toolName: 'Bash', contentPattern: 'rm:*', behavior: 'allow', source: 'config' }],
    { mode: 'default', cwd: process.cwd() },
  )

  const dangerous = ['rm -rf /', 'rm -rf ~', 'rm -rf /usr', 'rm -rf C:/Windows', 'rm -rf src/*']
  for (const command of dangerous) {
    assert.equal(await gate.approve(bashTool, { command }), false, command)
  }
  assert.deepEqual(prompted, dangerous)

  // The allow rule still covers an ordinary removal.
  assert.equal(await gate.approve(bashTool, { command: 'rm -rf src/build' }), true)
  assert.deepEqual(prompted, dangerous)
})

test('PermissionGate acceptEdits mode honours permissions.additionalDirectories', async () => {
  const outside = path.resolve(process.cwd(), '..', 'hanekawa-extra-root')
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return true
    },
    [],
    { mode: 'acceptEdits', cwd: process.cwd(), additionalDirectories: [outside] },
  )

  assert.equal(await gate.approve(bashTool, { command: `touch ${outside}/note.txt` }), true)
  assert.equal(prompted, false)

  assert.equal(await gate.approve(bashTool, { command: 'touch ../elsewhere/note.txt' }), true)
  assert.equal(prompted, true)
})

test('PermissionGate acceptEdits mode does not bypass protected paths or deny rules', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [{ toolName: 'Write', behavior: 'deny', source: 'config' }],
    { mode: 'acceptEdits', denialStreakThreshold: 2 },
  )

  // The deny rule denies silently; the protected path asks first.
  assert.equal(await gate.approve(writeFileTool, { path: 'src/index.ts' }), false)
  assert.equal(prompted, false)

  assert.equal(await gate.approve(editFileTool, { path: '.bashrc' }), false)
  assert.equal(prompted, true)
})

test('PermissionGate acceptEdits mode respects ask rules for edit tools', async () => {
  let prompted = false
  let source = ''
  const gate = new PermissionGate(
    async (request) => {
      prompted = true
      source = request.source
      return true
    },
    [{ toolName: 'Write', behavior: 'ask', source: 'config' }],
    { mode: 'acceptEdits' },
  )

  assert.equal(await gate.approve(writeFileTool, { path: 'src/index.ts' }), true)
  assert.equal(prompted, true)
  assert.equal(source, 'ask rule')
})

const webFetchTestTool: Tool = {
  name: 'WebFetch',
  description: 'Fetch a URL',
  riskLevel: 'confirm',
  isReadOnly: true,
  inputSchema: z.object({ url: z.string() }).strict(),
  execute: async () => ({ ok: true, content: '' }),
}

test('PermissionGate auto-approves preapproved WebFetch hosts and prompts for the rest', async () => {
  const prompted: string[] = []
  const gate = new PermissionGate(async (request) => {
    prompted.push((request.input as { url: string }).url)
    return true
  })

  for (const url of [
    'https://docs.python.org/3/library/os.html',
    'http://react.dev/learn',
    'https://github.com/anthropics/claude-code',
    'https://vercel.com/docs/functions',
  ]) {
    assert.equal(await gate.approve(webFetchTestTool, { url }), true, url)
  }
  assert.deepEqual(prompted, [])

  const mustPrompt = [
    'https://example.com/page',
    // The path prefix must land on a segment boundary.
    'https://github.com/anthropics-evil/repo',
    // A subdomain is not the preapproved host.
    'https://evil.docs.python.org/x',
  ]
  for (const url of mustPrompt) {
    await gate.approve(webFetchTestTool, { url })
  }
  assert.deepEqual(prompted, mustPrompt)
})

test('PermissionGate matches WebFetch domain rules against the URL host', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return true
    },
    [
      { toolName: 'WebFetch', contentPattern: 'domain:docs.python.org', behavior: 'deny', source: 'config' },
      { toolName: 'WebFetch', contentPattern: 'domain:*.internal.test', behavior: 'allow', source: 'config' },
    ],
  )

  // A deny rule outranks the preapproved list.
  assert.equal(await gate.approve(webFetchTestTool, { url: 'https://docs.python.org/3/' }), false)

  prompted = false
  assert.equal(await gate.approve(webFetchTestTool, { url: 'https://wiki.internal.test/page' }), true)
  assert.equal(prompted, false)

  assert.equal(await gate.approve(webFetchTestTool, { url: 'https://other.test/page' }), true)
  assert.equal(prompted, true)
})

test('PermissionGate offers a WebFetch always-allow rule scoped to the host', async () => {
  let offered: PermissionRule | undefined
  const gate = new PermissionGate(async (request) => {
    offered = request.alwaysAllowRule
    request.onAlwaysAllow?.()
    return true
  })

  assert.equal(await gate.approve(webFetchTestTool, { url: 'https://example.com/a/b?c=d' }), true)
  assert.deepEqual(offered, {
    toolName: 'WebFetch',
    contentPattern: 'domain:example.com',
    behavior: 'allow',
    source: 'session',
  })
  assert.equal(permissionRuleToEntry(offered!), 'WebFetch(domain:example.com)')
})

test('PermissionGate Edit and Read rules govern their whole tool family', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return true
    },
    [
      { toolName: 'Edit', contentPattern: 'src/**', behavior: 'deny', source: 'config' },
      { toolName: 'Read', contentPattern: 'secrets/**', behavior: 'deny', source: 'config' },
    ],
    { denialStreakThreshold: 5 },
  )

  // An `Edit(...)` rule reaches every write tool.
  for (const tool of [writeFileTool, editFileTool, multiEditFileTool, deleteFileTool]) {
    assert.equal(await gate.approve(tool, { path: 'src/index.ts' }), false, tool.name)
  }
  // A `Read(...)` rule reaches every read tool.
  assert.equal(await gate.approve(readFileTool, { filePath: 'secrets/key.pem' }), false)
  assert.equal(prompted, false)

  // A path the rules do not name is unaffected.
  assert.equal(await gate.approve(writeFileTool, { path: 'docs/readme.md' }), true)
  assert.equal(prompted, true)
})

test('PermissionGate restores the mode that was active before plan mode', () => {
  const gate = new PermissionGate(async () => false, undefined, { mode: 'acceptEdits' })

  gate.setMode('plan')
  assert.equal(gate.getPrePlanMode(), 'acceptEdits')
  assert.equal(gate.exitPlanMode(), 'acceptEdits')
  assert.equal(gate.getMode(), 'acceptEdits')
})

test('PermissionGate plan mode allows read tools without prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'plan' },
  )

  const approved = await gate.approve(readFileTool, { filePath: 'src/index.ts' })

  assert.equal(approved, true)
  assert.equal(prompted, false)
})

test('PermissionGate plan mode ignores ask rules (bypass-equivalent)', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return true
    },
    [{ toolName: 'Read', behavior: 'ask', source: 'config' }],
    { mode: 'plan' },
  )

  const approved = await gate.approve(readFileTool, { filePath: 'src/index.ts' })

  assert.equal(approved, true)
  assert.equal(prompted, false)
})

test('PermissionGate plan mode allows tools marked read-only by metadata', async () => {
  let prompted = false
  const readOnlyTool: Tool = {
    name: 'mcp__server__search',
    description: 'Search remote state',
    riskLevel: 'confirm',
    isReadOnly: true,
    inputSchema: z.object({}).strict(),
    execute: async () => ({ ok: true, content: '' }),
  }
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'plan' },
  )

  const approved = await gate.approve(readOnlyTool, {})

  assert.equal(approved, true)
  assert.equal(prompted, false)
})

test('PermissionGate plan mode auto-allows write tools (bypass-equivalent)', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return true
    },
    [],
    { mode: 'plan' },
  )

  assert.equal(await gate.approve(fsWriteTool, { path: 'src/index.ts' }), true)
  assert.equal(await gate.approve(skillTool, {}), true)
  assert.equal(prompted, false)
})

test('PermissionGate plan mode allows session plan file writes despite protected plan dir', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-plan-permission-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'plan', cwd },
  )
  gate.setPlanSlugProvider(() => 'draft-plan')
  const planPath = path.join(cwd, '.myagent', 'plans', 'draft-plan.md')

  assert.equal(await gate.approve(writeFileTool, { path: planPath }), true)
  assert.equal(await gate.approve(editFileTool, { path: planPath }), true)
  assert.equal(await gate.approve(multiEditFileTool, { path: planPath }), true)
  assert.equal(prompted, false)
})

test('PermissionGate clearPlanSlugProvider only uninstalls the provider it was handed', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-plan-permission-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'plan', cwd },
  )
  const provider = () => 'draft-plan'
  gate.setPlanSlugProvider(provider)
  const planPath = path.join(cwd, '.myagent', 'plans', 'draft-plan.md')

  // A superseded runtime disposing after a newer one installed its own
  // provider must not uninstall the newer one.
  gate.clearPlanSlugProvider(() => 'draft-plan')
  assert.equal(await gate.approve(writeFileTool, { path: planPath }), true)
  assert.equal(prompted, false)

  gate.clearPlanSlugProvider(provider)
  assert.equal(await gate.approve(writeFileTool, { path: planPath }), false)
  assert.equal(prompted, true)
})

test('PermissionGate resetDenialState re-reads the store for the next session', async () => {
  let state: DenialState = { streaks: {}, total: 0 }
  const store = {
    getDenialState: async () => state,
    setDenialState: async (next: DenialState) => { state = next },
  }
  const gate = new PermissionGate(async () => false, DENY_RULES, {
    denialStreakThreshold: 3,
    denialStateStore: store,
  })

  assert.equal(await gate.approve(bashTool, { command: DENIED_COMMAND }), false)
  assert.deepEqual(state, { streaks: { Bash: 1 }, total: 1 })

  // The host retargeted the store at a different session; the counters the
  // gate still holds belong to the old one.
  state = { streaks: {}, total: 0 }
  gate.resetDenialState()

  assert.equal(await gate.approve(bashTool, { command: DENIED_COMMAND }), false)
  assert.deepEqual(state, { streaks: { Bash: 1 }, total: 1 })
})

test('PermissionGate plan mode ignores deny rules (bypass-equivalent)', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-plan-permission-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  let prompted = false
  const planPath = path.join(cwd, '.myagent', 'plans', 'draft-plan.md')
  const denyGate = new PermissionGate(
    async () => {
      prompted = true
      return true
    },
    [{ toolName: 'Write', behavior: 'deny', source: 'config' }],
    { mode: 'plan', cwd },
  )
  denyGate.setPlanSlugProvider(() => 'draft-plan')

  assert.equal(await denyGate.approve(writeFileTool, { path: planPath }), true)
  assert.equal(prompted, false)
})

test('PermissionGate plan mode allows exitPlanMode without prompting', async () => {
  let prompted = false
  const exitPlanModeTool: Tool = {
    name: 'ExitPlanMode',
    description: 'Exit plan mode',
    riskLevel: 'safe',
    inputSchema: z.object({ plan: z.string() }).strict(),
    execute: async () => ({ ok: true, content: '' }),
  }
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'plan' },
  )

  const approved = await gate.approve(exitPlanModeTool, { plan: 'Do the thing.' })

  assert.equal(approved, true)
  assert.equal(prompted, false)
})

test('PermissionGate plan mode auto-allows all agents (bypass-equivalent)', async () => {
  let prompted = false
  const agentTool: Tool = {
    name: 'Agent',
    description: 'Run agent',
    riskLevel: 'safe',
    inputSchema: z.object({ subagent_type: z.string(), task: z.string() }).strict(),
    execute: async () => ({ ok: true, content: '' }),
  }
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'plan' },
  )

  assert.equal(await gate.approve(agentTool, { subagent_type: 'explore', task: 'inspect' }), true)
  assert.equal(await gate.approve(agentTool, { subagent_type: 'plan', task: 'design' }), true)
  assert.equal(await gate.approve(agentTool, { subagent_type: 'custom-writer', task: 'edit' }), true)
  assert.equal(prompted, false)
})

test('PermissionGate plan mode allows read-only bash subset', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'plan' },
  )

  assert.equal(await gate.approve(bashTool, { command: 'git status' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'git diff -- src/index.ts' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'git log --oneline | head -10' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'pwd && rg TODO src' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'stat package.json' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'fd package' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'find src -name "*.ts"' }), true)
  assert.equal(prompted, false)
})

test('PermissionGate plan mode auto-allows non-read bash commands (bypass-equivalent)', async () => {
  const gate = new PermissionGate(
    async () => true,
    [],
    { mode: 'plan' },
  )

  assert.equal(await gate.approve(bashTool, { command: 'npm test' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'pwd | touch marker' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'sed -i s/a/b/ src/index.ts' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'fd package -x rm {}' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'find src -delete' }), true)
})

test('PermissionGate bypass mode approves non-protected actions without prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [{ toolName: 'fsWrite', behavior: 'deny', contentPattern: 'other/**', source: 'config' }],
    { mode: 'bypass' },
  )

  assert.equal(await gate.approve(fsWriteTool, { path: 'src/index.ts' }), true)
  assert.equal(prompted, false)
})

test('PermissionGate bypass mode approves read-only bash without prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'bypass' },
  )

  assert.equal(await gate.approve(bashTool, { command: 'ls' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'git status' }), true)
  assert.equal(prompted, false)
})

test('PermissionGate bypass mode approves destructive bash without prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'bypass' },
  )

  assert.equal(await gate.approve(bashTool, { command: 'git reset --hard HEAD' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'rm -rf tmp' }), true)
  assert.equal(await gate.approve(deleteFileTool, { path: 'tmp/junk.txt' }), true)
  assert.equal(prompted, false)
  assert.deepEqual(gate.getSessionRules(), [])
})

test('PermissionGate bypass mode approves shell syntax findings without prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'bypass' },
  )

  assert.equal(await gate.approve(bashTool, { command: 'echo hi > out.txt' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'echo $(cat package.json)' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'bash -c "echo x"' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'sudo npm test' }), true)
  assert.equal(prompted, false)
})

test('PermissionGate bypass mode prompts immediately for protected paths', async () => {
  let prompts = 0
  let reason = ''
  let denialStreak = -1
  const gate = new PermissionGate(
    async (request) => {
      prompts++
      reason = request.reason
      denialStreak = request.denialStreak
      return true
    },
    [],
    { mode: 'bypass', denialStreakThreshold: 2 },
  )

  assert.equal(await gate.approve(bashTool, { command: 'rm .git/config' }), true)
  assert.equal(prompts, 1)
  assert.equal(denialStreak, 0)
  assert.match(reason, /Even in bypass mode, protected paths require explicit confirmation/)
  assert.match(reason, /\.git/)
})

test('PermissionGate bypass mode does not accumulate protected path denial streaks', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async (request) => {
      prompts++
      assert.equal(request.denialStreak, 0)
      return false
    },
    [],
    { mode: 'bypass', denialStreakThreshold: 2 },
  )

  assert.equal(await gate.approve(bashTool, { command: 'rm .git/config' }), false)
  assert.equal(await gate.approve(bashTool, { command: 'rm .git/config' }), false)
  assert.equal(prompts, 2)
})

test('PermissionGate bypass mode prompts the user for deny rules', async () => {
  const sources: string[] = []
  const approveGate = new PermissionGate(
    async (request) => {
      sources.push(request.source)
      return true
    },
    [{ toolName: 'Bash', behavior: 'deny', source: 'config' }],
    { mode: 'bypass' },
  )

  assert.equal(await approveGate.approve(bashTool, { command: 'npm test' }), true)
  assert.deepEqual(sources, ['deny rule'])

  const denyGate = new PermissionGate(
    async () => false,
    [{ toolName: 'Bash', behavior: 'deny', source: 'config' }],
    { mode: 'bypass' },
  )

  assert.equal(await denyGate.approve(bashTool, { command: 'npm test' }), false)
})

test('PermissionGate bypass mode enforces tool-wide ask rules', async () => {
  let prompted = false
  let source = ''
  const gate = new PermissionGate(
    async (request) => {
      prompted = true
      source = request.source
      return true
    },
    [{ toolName: 'Bash', behavior: 'ask', source: 'config' }],
    { mode: 'bypass' },
  )

  const approved = await gate.approve(bashTool, { command: 'npm test' })

  assert.equal(approved, true)
  assert.equal(prompted, true)
  assert.equal(source, 'ask rule')
})

test('PermissionGate bypass mode prompts for shell config files but not .env', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => {
      prompts++
      return true
    },
    [],
    { mode: 'bypass' },
  )

  assert.equal(await gate.approve(writeFileTool, { path: '.bashrc' }), true)
  assert.equal(prompts, 1)
  assert.equal(await gate.approve(writeFileTool, { path: '.env' }), true)
  assert.equal(prompts, 1)
})

test('PermissionGate bypass mode enforces content-specific ask rules', async () => {
  let prompted = false
  let source = ''
  const gate = new PermissionGate(
    async (request) => {
      prompted = true
      source = request.source
      return true
    },
    [{ toolName: 'Bash', contentPattern: 'npm publish*', behavior: 'ask', source: 'config' }],
    { mode: 'bypass' },
  )

  const approved = await gate.approve(bashTool, { command: 'npm publish --access public' })

  assert.equal(approved, true)
  assert.equal(prompted, true)
  assert.equal(source, 'ask rule')
})

test('PermissionGate bypass mode prompts for suspicious Windows paths', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return true
    },
    [],
    { mode: 'bypass' },
  )

  const approved = await gate.approve(writeFileTool, { path: 'C:\\Users\\test\\file.txt:secret:$DATA' })

  assert.equal(approved, true)
  assert.equal(prompted, true)
})

test('PermissionGate global denial threshold prompts across different tools', async () => {
  let prompts = 0
  let reason = ''
  const otherWriteTool: Tool = {
    ...fsWriteTool,
    name: 'otherWrite',
  }
  const gate = new PermissionGate(
    async (request) => {
      prompts++
      reason = request.reason
      return false
    },
    [
      { toolName: 'fsWrite', behavior: 'deny', source: 'config' },
      { toolName: 'otherWrite', behavior: 'deny', source: 'config' },
    ],
    { denialStreakThreshold: 100, globalDenialPromptThreshold: 2 },
  )

  assert.equal(await gate.approve(fsWriteTool, { path: 'a.txt' }), false)
  assert.equal(await gate.approve(otherWriteTool, { path: 'b.txt' }), false)
  assert.equal(prompts, 0)

  assert.equal(await gate.approve(fsWriteTool, { path: 'c.txt' }), false)
  assert.equal(prompts, 1)
  assert.match(reason, /session has already had 2 auto-denials/)
})

test('PermissionGate persists always-allow rules via the persistRule callback', async () => {
  const persisted: PermissionRule[] = []
  const gate = new PermissionGate(
    async (request) => {
      request.onAlwaysAllow?.()
      return true
    },
    undefined,
    { persistRule: async (rule) => { persisted.push(rule) } },
  )

  assert.equal(await gate.approve(bashTool, { command: 'mkdir test' }), true)
  assert.deepEqual(gate.getSessionRules(), [
    { toolName: 'Bash', contentPattern: 'mkdir test:*', behavior: 'allow', source: 'session' },
  ])
  assert.deepEqual(persisted, [
    { toolName: 'Bash', contentPattern: 'mkdir test:*', behavior: 'allow', source: 'session' },
  ])
})

test('PermissionGate without persistRule keeps always allow session-only', async () => {
  const gate = new PermissionGate(async (request) => {
    request.onAlwaysAllow?.()
    return true
  })

  assert.equal(await gate.approve(bashTool, { command: 'mkdir test' }), true)
  assert.equal(gate.getSessionRules().length, 1)
})

test('persistPermissionRule writes deduped entries into settings.local.json', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-perm-'))
  try {
    const rule: PermissionRule = { toolName: 'Bash', contentPattern: 'git commit:*', behavior: 'allow', source: 'session' }
    const rule2: PermissionRule = { toolName: 'Bash', contentPattern: 'git commit:*', behavior: 'allow', source: 'session' }
    await persistPermissionRule(dir, rule)
    await persistPermissionRule(dir, rule2)
    const settingsPath = path.join(dir, '.myagent', 'settings.local.json')
    const saved = JSON.parse(await readFile(settingsPath, 'utf-8'))
    assert.deepEqual(saved.permissions.allow, ['Bash(git commit:*)'])

    const reloaded = permissionRulesFromSettings(saved.permissions)
    assert.deepEqual(reloaded, [
      { toolName: 'Bash', contentPattern: 'git commit:*', behavior: 'allow', source: 'config' },
    ])
    assert.equal(permissionRuleToEntry(reloaded[0]!), 'Bash(git commit:*)')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('PermissionGate gates sharing a session rule store see each others rules live', async () => {
  const store = createSessionRuleStore()
  let parentPrompts = 0
  let childPrompts = 0
  const parent = new PermissionGate(async () => { parentPrompts++; return true }, [], { sessionRuleStore: store })
  const child = new PermissionGate(async () => { childPrompts++; return true }, [], { sessionRuleStore: store })

  // Parent's always-allow is immediately visible to the child (no snapshot).
  parent.addSessionRule({ toolName: 'Bash', contentPattern: 'git commit:*', behavior: 'allow', source: 'session' })
  assert.equal(await child.approve(bashTool, { command: 'git commit -m x' }), true)
  assert.equal(childPrompts, 0)

  // Child's always-allow propagates back to the parent.
  const childGateWithPrompt = new PermissionGate(async (request) => {
    childPrompts++
    request.onAlwaysAllow?.()
    return true
  }, [], { sessionRuleStore: store })
  assert.equal(await childGateWithPrompt.approve(bashTool, { command: 'mkdir x' }), true)
  assert.equal(childPrompts, 1)
  assert.equal(await parent.approve(bashTool, { command: 'mkdir x' }), true)
  assert.equal(parentPrompts, 0)
})

test('PermissionGate session rule store keeps config rules isolated', async () => {
  const store = createSessionRuleStore()
  const parent = new PermissionGate(async () => true, [], { sessionRuleStore: store })
  const child = new PermissionGate(async () => true, [
    { toolName: 'Bash', contentPattern: 'rm:*', behavior: 'deny', source: 'config' },
  ], { sessionRuleStore: store })

  assert.equal(child.getConfigRules().length, 1)
  assert.equal(parent.getConfigRules().length, 0)
  assert.equal(parent.getSessionRules().length, 0)
  // The child's config deny does not leak into the shared session rules.
  assert.equal(await parent.approve(bashTool, { command: 'rm file' }), true)
})
