import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  PERMISSION_OPTIONS,
  defaultPermissionIndex,
  destructiveWarningsForRequest,
  formatPermissionInputBlock,
  formatPermissionReason,
  formatPermissionRuleLabel,
  formatPermissionSource,
  formatPermissionSubtitle,
  formatPermissionTitle,
  nextPermissionIndex,
  permissionOptionsForRequest,
  resolvePermissionAction,
  resolvePermissionOption,
} from '../src/tui/components/PermissionDialog.js'
import type { PermissionDecisionSource, PermissionRequest, PermissionRule } from '../src/harness/permissions.js'
import type { RiskLevel, Tool } from '../src/harness/types.js'

/**
 * Unit tests for the pure logic backing the PermissionDialog component.
 *
 * Following the project convention (see `restoreMode.test.ts`) we do not render
 * Ink components in tests. Instead, the dialog's interaction logic is exposed
 * as pure functions and exercised here.
 */

describe('PERMISSION_OPTIONS', () => {
  it('has the default allow-once and deny options', () => {
    assert.equal(PERMISSION_OPTIONS.length, 2)
  })

  it('exposes allow / deny actions in order', () => {
    assert.deepEqual(
      PERMISSION_OPTIONS.map((o) => o.action),
      ['allow', 'deny'],
    )
  })

  it('uses unique hotkeys', () => {
    const hotkeys = PERMISSION_OPTIONS.map((o) => o.hotkey)
    assert.equal(new Set(hotkeys).size, hotkeys.length)
  })

  it('binds the conventional y/n hotkeys by default', () => {
    assert.deepEqual(
      PERMISSION_OPTIONS.map((o) => o.hotkey),
      ['y', 'n'],
    )
  })

  it('provides non-empty human-readable labels', () => {
    for (const option of PERMISSION_OPTIONS) {
      assert.ok(option.label.length > 0, `expected label for ${option.action}`)
    }
  })

  it('uses ClaudeCode-style explicit labels without changing default actions or hotkeys', () => {
    assert.deepEqual(
      PERMISSION_OPTIONS.map((o) => o.label),
      ['Yes, allow once', 'No, deny'],
    )
  })

  it('adds a scoped always option when the request provides an always rule', () => {
    const options = permissionOptionsForRequest(request('Bash', { command: 'npm test' }, 'mode', 'dangerous', 'requires', {
      alwaysAllowRule: allowRule('Bash', 'npm test'),
    }))

    assert.deepEqual(
      options.map((o) => o.action),
      ['allow', 'deny', 'always'],
    )
    assert.deepEqual(
      options.map((o) => o.hotkey),
      ['y', 'n', 'a'],
    )
    assert.equal(options[2]?.label, 'Yes, always allow Bash(npm test)')
  })

  it('omits always when the request has no scoped always rule', () => {
    const options = permissionOptionsForRequest(request('Bash', { command: 'npm test' }))

    assert.deepEqual(
      options.map((o) => o.action),
      ['allow', 'deny'],
    )
  })

  it('suppresses always allow and defaults to deny for destructive Bash', () => {
    const destructive = request('Bash', { command: 'git push --force origin main' }, 'mode', 'dangerous', 'requires', {
      alwaysAllowRule: allowRule('Bash', 'git push --force origin main'),
    })

    assert.deepEqual(permissionOptionsForRequest(destructive).map((option) => option.action), ['allow', 'deny'])
    assert.equal(defaultPermissionIndex(destructive), 1)
    assert.equal(destructiveWarningsForRequest(destructive)[0]?.code, 'git_push_force')
    assert.equal(defaultPermissionIndex(request('Bash', { command: 'npm test' })), 0)
  })
})

describe('nextPermissionIndex', () => {
  it('moves up by one when above zero', () => {
    assert.equal(nextPermissionIndex(1, 'up', 3), 0)
    assert.equal(nextPermissionIndex(2, 'up', 3), 1)
  })

  it('clamps at zero when moving up from the top', () => {
    assert.equal(nextPermissionIndex(0, 'up', 3), 0)
  })

  it('moves down by one when below the last index', () => {
    assert.equal(nextPermissionIndex(0, 'down', 3), 1)
    assert.equal(nextPermissionIndex(1, 'down', 3), 2)
  })

  it('clamps at total - 1 when moving down from the bottom', () => {
    assert.equal(nextPermissionIndex(2, 'down', 3), 2)
  })

  it('clamps a negative current to zero before applying direction', () => {
    // -1 -> clamp to 0, then down -> 1
    assert.equal(nextPermissionIndex(-1, 'down', 3), 1)
    // -1 -> clamp to 0, then up -> still 0
    assert.equal(nextPermissionIndex(-1, 'up', 3), 0)
  })

  it('clamps an oversized current to total - 1 before applying direction', () => {
    // 99 -> clamp to 2, then up -> 1
    assert.equal(nextPermissionIndex(99, 'up', 3), 1)
    // 99 -> clamp to 2, then down -> still 2
    assert.equal(nextPermissionIndex(99, 'down', 3), 2)
  })

  it('returns 0 when total is non-positive', () => {
    assert.equal(nextPermissionIndex(5, 'up', 0), 0)
    assert.equal(nextPermissionIndex(5, 'down', -1), 0)
  })
})

describe('resolvePermissionAction', () => {
  it('maps index 0 to allow', () => {
    assert.equal(resolvePermissionAction(0), 'allow')
  })

  it('maps index 1 to deny', () => {
    assert.equal(resolvePermissionAction(1), 'deny')
  })

  it('clamps negative indices to the first action', () => {
    assert.equal(resolvePermissionAction(-1), 'allow')
    assert.equal(resolvePermissionAction(-100), 'allow')
  })

  it('clamps oversized indices to the last action', () => {
    assert.equal(resolvePermissionAction(3), 'deny')
    assert.equal(resolvePermissionAction(99), 'deny')
  })

  it('agrees with PERMISSION_OPTIONS for every valid index', () => {
    for (let i = 0; i < PERMISSION_OPTIONS.length; i++) {
      assert.equal(resolvePermissionAction(i), PERMISSION_OPTIONS[i]!.action)
    }
  })

  it('resolves dynamic always options when provided', () => {
    const options = permissionOptionsForRequest(request('Bash', { command: 'npm test' }, 'mode', 'dangerous', 'requires', {
      alwaysAllowRule: allowRule('Bash', 'npm test'),
    }))

    assert.equal(resolvePermissionOption(2, options).action, 'always')
    assert.equal(resolvePermissionOption(99, options).action, 'always')
  })
})

describe('formatPermissionSource', () => {
  it('surfaces the permission trigger source', () => {
    assert.equal(formatPermissionSource(request('Read', {}, 'ask rule')), 'ask rule')
  })
})

describe('permission dialog formatters', () => {
  it('formats action-specific titles', () => {
    assert.equal(formatPermissionTitle(request('Bash', { command: 'npm test' })), 'Bash command')
    assert.equal(formatPermissionTitle(request('Write', { filePath: 'src/new.ts' })), 'Write file')
    assert.equal(formatPermissionTitle(request('Edit', { filePath: 'src/app.ts' })), 'Edit file')
    assert.equal(formatPermissionTitle(request('MultiEdit', { filePath: 'src/app.ts' })), 'Edit file')
    assert.equal(formatPermissionTitle(request('Delete', { filePath: 'src/old.ts' })), 'Delete file')
    assert.equal(formatPermissionTitle(request('TaskCreate', { subject: 'New task', description: 'Do something' })), 'Tool permission')
  })

  it('formats subtitles with path, risk, source, and queue position', () => {
    const subtitle = formatPermissionSubtitle(
      request('Write', { filePath: 'src/app.ts' }, 'mode', 'confirm'),
      1,
      4,
    )

    assert.match(subtitle, /src\/app\.ts/)
    assert.match(subtitle, /confirm/)
    assert.match(subtitle, /mode/)
    assert.match(subtitle, /2\/4 pending/)
  })

  it('formats trigger reasons in natural language', () => {
    assert.equal(
      formatPermissionReason(request('Read', {}, 'mode', 'safe', 'current mode asks')),
      'current mode asks.',
    )
    assert.equal(
      formatPermissionReason(request('Read', {}, 'ask rule', 'safe', 'requires', {
        matchedRule: askRule('Read', 'src/**'),
      })),
      'Permission rule Read(src/**) requires confirmation.',
    )
    assert.equal(
      formatPermissionReason(request('Read', {}, 'deny rule', 'safe', 'requires', {
        matchedRule: denyRule('Read', 'secrets/**'),
      })),
      'Permission deny rule Read(secrets/**) is blocking this action.',
    )
    assert.equal(
      formatPermissionReason(request('Write', { filePath: '.env' }, 'protected path', 'confirm', 'Protected path requires confirmation')),
      'Protected path requires confirmation.',
    )
    assert.equal(
      formatPermissionReason(request('Bash', { command: 'rm -rf dist' }, 'bash safety', 'dangerous', 'Shell safety check requires confirmation')),
      'Shell safety check requires confirmation.',
    )
    assert.equal(
      formatPermissionReason(request('Write', { filePath: 'src/app.ts' }, 'allow rule', 'confirm', 'Allow rule matched but safety still requires confirmation', {
        matchedRule: allowRule('Write', 'src/**'),
      })),
      'Allow rule Write(src/**) matched, but safety still requires confirmation.',
    )
  })

  it('formats permission rule labels', () => {
    assert.equal(formatPermissionRuleLabel(allowRule('Bash', 'npm test')), 'Bash(npm test)')
    assert.equal(formatPermissionRuleLabel(allowRule('Read')), 'Read')
  })

  it('formats bash input as the command', () => {
    assert.deepEqual(
      formatPermissionInputBlock(request('Bash', { command: 'npm run typecheck' })),
      { kind: 'bash', label: 'Command', content: 'npm run typecheck' },
    )
  })

  it('formats file tools as a path-first input block', () => {
    assert.deepEqual(
      formatPermissionInputBlock(request('Delete', { filePath: 'src/old.ts' }, 'mode', 'dangerous')),
      { kind: 'file', label: 'Path', content: 'src/old.ts' },
    )
  })

  it('formats other tools as compact JSON', () => {
    assert.deepEqual(
      formatPermissionInputBlock(request('Agent', { subagent_type: 'explore', prompt: 'Find the route' })),
      {
        kind: 'json',
        label: 'Input',
        content: '{"subagent_type":"explore","prompt":"Find the route"}',
      },
    )
  })
})

function request(
  toolName: string,
  input: unknown,
  source: PermissionDecisionSource = 'mode',
  riskLevel: RiskLevel = 'confirm',
  reason = 'requires confirmation',
  extra: Partial<PermissionRequest> = {},
): PermissionRequest {
  return {
    tool: tool(toolName, riskLevel),
    input,
    reason,
    source,
    denialStreak: 0,
    ...extra,
  }
}

function tool(name: string, riskLevel: RiskLevel): Tool {
  return {
    name,
    description: '',
    riskLevel,
    inputSchema: {} as Tool['inputSchema'],
    execute: async () => ({ ok: true, content: '' }),
  }
}

function allowRule(toolName: string, contentPattern?: string): PermissionRule {
  return rule(toolName, 'allow', contentPattern)
}

function askRule(toolName: string, contentPattern?: string): PermissionRule {
  return rule(toolName, 'ask', contentPattern)
}

function denyRule(toolName: string, contentPattern?: string): PermissionRule {
  return rule(toolName, 'deny', contentPattern)
}

function rule(
  toolName: string,
  behavior: PermissionRule['behavior'],
  contentPattern?: string,
): PermissionRule {
  return {
    toolName,
    ...(contentPattern ? { contentPattern } : {}),
    behavior,
    source: 'config',
  }
}
