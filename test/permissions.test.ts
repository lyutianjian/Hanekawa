import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { z } from 'zod/v3'
import {
  PermissionGate,
  isProtectedPath,
  permissionRulesFromSettings,
  type DenialState,
  type PermissionRule,
} from '../src/harness/permissions.js'
import { analyzeShellCommand } from '../src/harness/commandAnalysis.js'
import { bashTool } from '../src/tools/bash.js'
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

test('PermissionGate deny rules win over ask allow and auto mode', async () => {
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
    { mode: 'auto' },
  )

  const approved = await gate.approve(fsWriteTool, { path: 'src/index.ts' })

  assert.equal(approved, false)
  assert.equal(prompted, false)
})

test('PermissionGate denies bash commands touching protected paths without prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return true
  })

  const approved = await gate.approve(bashTool, { command: 'cat .env' })

  assert.equal(approved, false)
  assert.equal(prompted, false)
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

test('PermissionGate still prompts for simple read-only bash commands', async () => {
  let reason = ''
  let prompted = false
  const gate = new PermissionGate(async (request) => {
    prompted = true
    reason = request.reason
    return true
  })

  const approved = await gate.approve(bashTool, { command: 'pwd' })

  assert.equal(approved, true)
  assert.equal(prompted, true)
  assert.match(reason, /dangerous action/)
})

test('PermissionGate always allow creates an exact Bash session rule', async () => {
  let prompts = 0
  let scopedRule: PermissionRule | undefined
  const gate = new PermissionGate(async (request) => {
    prompts++
    scopedRule = request.alwaysAllowRule
    request.onAlwaysAllow?.()
    return true
  })

  assert.equal(await gate.approve(bashTool, { command: 'pwd' }), true)
  assert.deepEqual(scopedRule, {
    toolName: 'Bash',
    contentPattern: 'pwd',
    behavior: 'allow',
    source: 'session',
  })
  assert.deepEqual(gate.getSessionRules(), [scopedRule])

  assert.equal(await gate.approve(bashTool, { command: 'pwd' }), true)
  assert.equal(prompts, 1)

  assert.equal(await gate.approve(bashTool, { command: 'ls' }), true)
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

// --- New: expanded protected secret-file coverage --------------------------

test('isProtectedPath catches SSH private keys by name', () => {
  assert.equal(isProtectedPath('/home/me/.ssh/id_rsa'), true)
  assert.equal(isProtectedPath('id_rsa'), true)
  assert.equal(isProtectedPath('id_rsa.pub'), true)
  assert.equal(isProtectedPath('id_ed25519'), true)
  assert.equal(isProtectedPath('./keys/id_ecdsa'), true)
})

test('isProtectedPath catches PEM, P12, and KEY bundles', () => {
  assert.equal(isProtectedPath('cert.pem'), true)
  assert.equal(isProtectedPath('/var/secrets/key.p12'), true)
  assert.equal(isProtectedPath('client.pfx'), true)
  assert.equal(isProtectedPath('private.key'), true)
})

test('isProtectedPath catches credentials.json and secrets.yaml', () => {
  assert.equal(isProtectedPath('credentials.json'), true)
  assert.equal(isProtectedPath('config/credentials.json'), true)
  assert.equal(isProtectedPath('secrets.yaml'), true)
  assert.equal(isProtectedPath('secrets.yml'), true)
})

test('isProtectedPath catches .aws/credentials regardless of leading path', () => {
  assert.equal(isProtectedPath('/Users/me/.aws/credentials'), true)
  assert.equal(isProtectedPath('.aws/credentials'), true)
  assert.equal(isProtectedPath('C:\\Users\\me\\.aws\\credentials'), true)
  assert.equal(isProtectedPath('/Users/me/.aws/config'), true)
})

test('isProtectedPath does not over-match safe filenames', () => {
  assert.equal(isProtectedPath('readme.md'), false)
  assert.equal(isProtectedPath('src/index.ts'), false)
  assert.equal(isProtectedPath('package.json'), false)
  assert.equal(isProtectedPath('keymap.ts'), false)
})

test('PermissionGate auto-denies fsWrite to id_rsa without prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return true
  })

  const approved = await gate.approve(fsWriteTool, { path: '/home/me/.ssh/id_rsa' })

  assert.equal(approved, false)
  assert.equal(prompted, false)
})

test('PermissionGate auto-denies bash command writing to a .pem file', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return true
  })

  const approved = await gate.approve(bashTool, { command: 'echo data > server.pem' })

  assert.equal(approved, false)
  assert.equal(prompted, false)
})

test('PermissionGate auto-denies bash reading .aws/credentials', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return true
  })

  const approved = await gate.approve(bashTool, { command: 'cat ~/.aws/credentials' })

  assert.equal(approved, false)
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
    [],
    { denialStreakThreshold: 3 },
  )

  // Calls 1 and 2 are silently auto-denied.
  assert.equal(await gate.approve(bashTool, { command: 'cat .env' }), false)
  assert.equal(await gate.approve(bashTool, { command: 'cat .env' }), false)
  assert.equal(prompts, 0)

  // Call 3 escalates to a user prompt.
  assert.equal(await gate.approve(bashTool, { command: 'cat .env' }), false)
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
  }, [], { denialStreakThreshold: 2, denialStateStore: store })
  assert.equal(await firstGate.approve(bashTool, { command: 'cat .env' }), false)
  assert.deepEqual(state, { streaks: { Bash: 1 }, total: 1 })

  let prompts = 0
  let restoredStreak = 0
  const secondGate = new PermissionGate(async (request) => {
    prompts++
    restoredStreak = request.denialStreak
    return false
  }, [], { denialStreakThreshold: 2, denialStateStore: store })

  assert.equal(await secondGate.approve(bashTool, { command: 'cat .env' }), false)
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
    [],
    { denialStreakThreshold: 2 },
  )

  // First call auto-denies.
  await gate.approve(bashTool, { command: 'cat .env' })
  // Second call hits threshold and prompts the user.
  await gate.approve(bashTool, { command: 'cat .env' })
  assert.equal(prompts, 1)

  // After the user explicitly denies, keep asking instead of dropping back to
  // silent auto-denial.
  await gate.approve(bashTool, { command: 'cat .env' })
  assert.equal(prompts, 2)
})

test('PermissionGate clears denial streak after a user-prompted approval', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => {
      prompts++
      return true
    },
    [],
    { denialStreakThreshold: 2 },
  )

  await gate.approve(bashTool, { command: 'cat .env' })
  await gate.approve(bashTool, { command: 'cat .env' })
  assert.equal(prompts, 1)

  // Approval clears the streak, so the next denial is silent again.
  await gate.approve(bashTool, { command: 'cat .env' })
  assert.equal(prompts, 1)
})

test('PermissionGate streak resets when a different call is approved', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => {
      prompts++
      return true
    },
    [],
    { denialStreakThreshold: 2 },
  )

  // Auto-denied - streak goes to 1.
  await gate.approve(bashTool, { command: 'cat .env' })
  // A normal prompt-and-allow on the same tool resets the streak.
  await gate.approve(bashTool, { command: 'pwd' })
  assert.equal(prompts, 1)

  // Streak should have been reset, so the next denial is silent again.
  await gate.approve(bashTool, { command: 'cat .env' })
  assert.equal(prompts, 1)
})

test('PermissionGate denial streak is per-tool, not global', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => {
      prompts++
      return false
    },
    [],
    { denialStreakThreshold: 2 },
  )

  // bash hits threshold -> prompt.
  await gate.approve(bashTool, { command: 'cat .env' })
  await gate.approve(bashTool, { command: 'cat .env' })
  assert.equal(prompts, 1)

  // bash denial streak does not affect fsWrite's own counter - first denial is silent.
  await gate.approve(fsWriteTool, { path: '.env' })
  assert.equal(prompts, 1)
})

test('PermissionGate prompt request includes denialStreak when escalated', async () => {
  let received = 0
  const gate = new PermissionGate(
    async (request) => {
      received = request.denialStreak
      return false
    },
    [],
    { denialStreakThreshold: 2 },
  )

  await gate.approve(bashTool, { command: 'cat .env' })
  await gate.approve(bashTool, { command: 'cat .env' })

  assert.equal(received, 2)
})

test('PermissionGate sets denialStreak=0 for normal (non-escalated) prompts', async () => {
  let received = -1
  const gate = new PermissionGate(async (request) => {
    received = request.denialStreak
    return true
  })

  await gate.approve(bashTool, { command: 'pwd' })

  assert.equal(received, 0)
})

test('PermissionGate escalated prompt reason calls out the loop', async () => {
  let reason = ''
  const gate = new PermissionGate(
    async (request) => {
      reason = request.reason
      return false
    },
    [],
    { denialStreakThreshold: 2 },
  )

  await gate.approve(bashTool, { command: 'cat .env' })
  await gate.approve(bashTool, { command: 'cat .env' })

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
    [],
    { denialStreakThreshold: 1 },
  )

  await gate.approve(bashTool, { command: 'cat .env' })
  assert.equal(prompts, 1)
})

test('PermissionGate auto-denies bash command substitution even with an allow rule', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return true
    },
    [{ toolName: 'Bash', behavior: 'allow', source: 'config' }],
  )

  const approved = await gate.approve(bashTool, { command: 'echo $(cat package.json)' })

  assert.equal(approved, false)
  assert.equal(prompted, false)
})

test('PermissionGate auto-denies bash redirection before prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return true
  })

  const approved = await gate.approve(bashTool, { command: 'echo data > out.txt' })

  assert.equal(approved, false)
  assert.equal(prompted, false)
})

test('PermissionGate checks protected paths in each bash segment', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return true
  })

  const approved = await gate.approve(bashTool, { command: 'echo ok && cat ~/.aws/credentials' })

  assert.equal(approved, false)
  assert.equal(prompted, false)
})

test('PermissionGate auto-denies bash commands with too many segments', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return true
  })
  const command = Array.from({ length: 51 }, (_, index) => `echo ${index}`).join(' && ')

  const approved = await gate.approve(bashTool, { command })

  assert.equal(approved, false)
  assert.equal(prompted, false)
})

test('PermissionGate auto-denies zsh dangerous builtins', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return true
  })

  const approved = await gate.approve(bashTool, { command: 'zmodload zsh/system' })

  assert.equal(approved, false)
  assert.equal(prompted, false)
})

test('PermissionGate auto-denies quoted newline and comment quote desync syntax', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return true
  })

  assert.equal(await gate.approve(bashTool, { command: 'echo "hello\nworld"' }), false)
  assert.equal(await gate.approve(bashTool, { command: 'echo safe # "unterminated by shell parser"' }), false)
  assert.equal(prompted, false)
})

test('PermissionGate auto-denies standalone empty quoted arguments', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return true
  })

  assert.equal(await gate.approve(bashTool, { command: 'rm "" -rf tmp' }), false)
  assert.equal(await gate.approve(bashTool, { command: "rm '' -rf tmp" }), false)
  assert.equal(prompted, false)
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
    return true
  })

  const approved = await gate.approve(fsWriteTool, { filePath: '.env' })

  assert.equal(approved, false)
  assert.equal(prompted, false)
})

test('PermissionGate auto mode approves confirm tools without prompting when no deny rule matches', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'auto' },
  )

  const approved = await gate.approve(fsWriteTool, { path: 'src/index.ts' })

  assert.equal(approved, true)
  assert.equal(prompted, false)
})

test('PermissionGate auto mode approves read-only bash commands without prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'auto' },
  )

  assert.equal(await gate.approve(bashTool, { command: 'pwd' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'git status' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'rg foo src' }), true)
  assert.equal(prompted, false)
})

test('PermissionGate auto mode approves validation bash commands without prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'auto' },
  )

  assert.equal(await gate.approve(bashTool, { command: 'npm test' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'npm run typecheck' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'bun test' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'tsc --noEmit' }), true)
  assert.equal(prompted, false)
})

test('PermissionGate auto mode approves light workspace bash writes without prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'auto', cwd: process.cwd() },
  )

  assert.equal(await gate.approve(bashTool, { command: 'mkdir src/auto-dir' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'touch src/auto-file.ts' }), true)
  assert.equal(prompted, false)
})

test('PermissionGate auto mode prompts for unsafe light-write bash paths', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => {
      prompts++
      return true
    },
    [],
    { mode: 'auto', cwd: process.cwd(), denialStreakThreshold: 10 },
  )

  assert.equal(await gate.approve(bashTool, { command: 'touch ../outside.txt' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'touch src/*.ts' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'touch ~/outside.txt' }), true)
  assert.equal(prompts, 3)
})

test('PermissionGate auto mode still auto-denies protected light-write paths', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return true
    },
    [],
    { mode: 'auto', denialStreakThreshold: 10 },
  )

  assert.equal(await gate.approve(bashTool, { command: 'touch .env' }), false)
  assert.equal(prompted, false)
})

test('PermissionGate auto mode prompts for destructive and external bash commands', async () => {
  let prompts = 0
  let reason = ''
  let source = ''
  const gate = new PermissionGate(
    async (request) => {
      prompts++
      reason = request.reason
      source = request.source
      return true
    },
    [],
    { mode: 'auto' },
  )

  assert.equal(await gate.approve(bashTool, { command: 'rm -rf tmp' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'sed -i s/a/b/ src/index.ts' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'git push origin main' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'npm install' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'curl https://example.com' }), true)
  assert.equal(prompts, 5)
  assert.equal(source, 'mode')
  assert.match(reason, /Auto mode requires confirmation/)
})

test('PermissionGate auto mode prompts for dangerous tools outside bash allowlists', async () => {
  let prompted = false
  let reason = ''
  const deleteTool: Tool = {
    ...fsWriteTool,
    name: 'Delete',
    riskLevel: 'dangerous',
    isDestructive: true,
  }
  const gate = new PermissionGate(
    async (request) => {
      prompted = true
      reason = request.reason
      return true
    },
    [],
    { mode: 'auto' },
  )

  const approved = await gate.approve(deleteTool, { path: 'src/index.ts' })

  assert.equal(approved, true)
  assert.equal(prompted, true)
  assert.match(reason, /Auto mode requires confirmation/)
})

test('PermissionGate auto mode does not bypass deny rules for confirm tools', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return true
    },
    [{ toolName: 'fsWrite', behavior: 'deny', source: 'config' }],
    { mode: 'auto', denialStreakThreshold: 2 },
  )

  assert.equal(await gate.approve(fsWriteTool, { path: 'src/index.ts' }), false)
  assert.equal(prompted, false)
  assert.equal(await gate.approve(fsWriteTool, { path: 'src/index.ts' }), true)
  assert.equal(prompted, true)
})

test('PermissionGate auto mode respects ask rules before auto approval', async () => {
  let prompted = false
  let source = ''
  const gate = new PermissionGate(
    async (request) => {
      prompted = true
      source = request.source
      return true
    },
    [{ toolName: 'Bash', behavior: 'ask', source: 'config' }],
    { mode: 'auto' },
  )

  assert.equal(await gate.approve(bashTool, { command: 'pwd' }), true)
  assert.equal(prompted, true)
  assert.equal(source, 'ask rule')
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

  assert.equal(await gate.approve(bashTool, { command: 'pwd' }), true)
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

test('PermissionGate acceptEdits mode does not bypass protected paths or deny rules', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return true
    },
    [{ toolName: 'Write', behavior: 'deny', source: 'config' }],
    { mode: 'acceptEdits', denialStreakThreshold: 2 },
  )

  assert.equal(await gate.approve(writeFileTool, { path: 'src/index.ts' }), false)
  assert.equal(await gate.approve(editFileTool, { path: '.env' }), false)
  assert.equal(prompted, false)
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

test('PermissionGate plan mode respects ask rules for otherwise allowed read tools', async () => {
  let prompted = false
  let source = ''
  const gate = new PermissionGate(
    async (request) => {
      prompted = true
      source = request.source
      return true
    },
    [{ toolName: 'Read', behavior: 'ask', source: 'config' }],
    { mode: 'plan' },
  )

  const approved = await gate.approve(readFileTool, { filePath: 'src/index.ts' })

  assert.equal(approved, true)
  assert.equal(prompted, true)
  assert.equal(source, 'ask rule')
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

test('PermissionGate plan mode denies write and unrelated safe tools without prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return true
    },
    [],
    { mode: 'plan' },
  )

  assert.equal(await gate.approve(fsWriteTool, { path: 'src/index.ts' }), false)
  assert.equal(await gate.approve(skillTool, {}), false)
  assert.equal(prompted, false)
})

test('PermissionGate plan mode allows session plan file writes despite protected plan dir', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'plan', cwd: process.cwd() },
  )
  gate.setPlanSlugProvider(() => 'draft-plan')
  const planPath = path.join(process.cwd(), '.myagent', 'plans', 'draft-plan.md')

  assert.equal(await gate.approve(writeFileTool, { path: planPath }), true)
  assert.equal(await gate.approve(editFileTool, { path: planPath }), true)
  assert.equal(await gate.approve(multiEditFileTool, { path: planPath }), true)
  assert.equal(prompted, false)
})

test('PermissionGate plan mode still respects ask and deny rules for session plan files', async () => {
  let prompted = false
  let source = ''
  const planPath = path.join(process.cwd(), '.myagent', 'plans', 'draft-plan.md')
  const askGate = new PermissionGate(
    async (request) => {
      prompted = true
      source = request.source
      return true
    },
    [{ toolName: 'Write', behavior: 'ask', source: 'config' }],
    { mode: 'plan', cwd: process.cwd() },
  )
  askGate.setPlanSlugProvider(() => 'draft-plan')

  assert.equal(await askGate.approve(writeFileTool, { path: planPath }), true)
  assert.equal(prompted, true)
  assert.equal(source, 'ask rule')

  prompted = false
  const denyGate = new PermissionGate(
    async () => {
      prompted = true
      return true
    },
    [{ toolName: 'Write', behavior: 'deny', source: 'config' }],
    { mode: 'plan', cwd: process.cwd(), denialStreakThreshold: 2 },
  )
  denyGate.setPlanSlugProvider(() => 'draft-plan')

  assert.equal(await denyGate.approve(writeFileTool, { path: planPath }), false)
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

test('PermissionGate plan mode allows read-only built-in agents without prompting', async () => {
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
  assert.equal(await gate.approve(agentTool, { subagent_type: 'custom-writer', task: 'edit' }), false)
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
  assert.equal(await gate.approve(bashTool, { command: 'stat package.json' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'fd package' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'find src -name "*.ts"' }), true)
  assert.equal(prompted, false)
})

test('PermissionGate plan mode denies non-read bash commands without prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return true
    },
    [],
    { mode: 'plan' },
  )

  assert.equal(await gate.approve(bashTool, { command: 'npm test' }), false)
  assert.equal(await gate.approve(bashTool, { command: 'cat .env' }), false)
  assert.equal(await gate.approve(bashTool, { command: 'sed -i s/a/b/ src/index.ts' }), false)
  assert.equal(await gate.approve(bashTool, { command: 'fd package -x rm {}' }), false)
  assert.equal(await gate.approve(bashTool, { command: 'find src -delete' }), false)
  assert.equal(prompted, false)
})

test('PermissionGate bypass mode approves non-protected actions without prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [{ toolName: 'fsWrite', behavior: 'deny', source: 'config' }],
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

test('PermissionGate bypass mode still prompts for destructive bash without adding always rules', async () => {
  let prompted = false
  let hasAlwaysAllow = false
  const gate = new PermissionGate(
    async (request) => {
      prompted = true
      hasAlwaysAllow = typeof request.onAlwaysAllow === 'function'
      request.onAlwaysAllow?.()
      return true
    },
    [],
    { mode: 'bypass' },
  )

  assert.equal(await gate.approve(bashTool, { command: 'git reset --hard HEAD' }), true)
  assert.equal(prompted, true)
  assert.equal(hasAlwaysAllow, false)
  assert.deepEqual(gate.getSessionRules(), [])
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

  assert.equal(await gate.approve(bashTool, { command: 'cat .env' }), true)
  assert.equal(prompts, 1)
  assert.equal(denialStreak, 0)
  assert.match(reason, /Even in bypass mode, protected paths require explicit confirmation/)
  assert.match(reason, /\.env/)
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

  assert.equal(await gate.approve(bashTool, { command: 'cat .env' }), false)
  assert.equal(await gate.approve(bashTool, { command: 'cat .env' }), false)
  assert.equal(prompts, 2)
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
