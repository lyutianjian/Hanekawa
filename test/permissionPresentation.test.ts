import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  PERMISSION_OPTIONS,
  defaultPermissionIndex,
  destructiveWarningsForRequest,
  formatPermissionInputBlock,
  formatPermissionReason,
  formatPermissionRequestLabel,
  formatPermissionRuleLabel,
  formatPermissionSource,
  formatPermissionSubtitle,
  formatPermissionTitle,
  nextPermissionIndex,
  permissionOptions,
  permissionOptionsForRequest,
  permissionToneForRequest,
  resolvePermissionAction,
  resolvePermissionOption,
} from '../src/runtime/permissionPresentation.js'
import { toPermissionDto } from '../src/runtime/protocol/permissionDto.js'
import type { PermissionRequestDto } from '../src/runtime/protocol/wire.js'
import type { PermissionDecisionSource, PermissionRequest, PermissionRule } from '../src/harness/permissions.js'
import type { RiskLevel, Tool } from '../src/harness/types.js'

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

  it('omits always when the gate offered no always-allow affordance', () => {
    // The gate sets alwaysAllowRule and onAlwaysAllow together, so this cannot
    // happen in production — but a hand-built DTO must not be able to render a
    // button that does nothing.
    const dto: PermissionRequestDto = {
      ...request('Bash', { command: 'npm test' }, 'mode', 'dangerous', 'requires', {
        alwaysAllowRule: allowRule('Bash', 'npm test'),
      }),
      canAlwaysAllow: false,
    }

    assert.deepEqual(permissionOptionsForRequest(dto).map((o) => o.action), ['allow', 'deny'])
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

  it('names the subagent type in a queued Agent label', () => {
    assert.equal(
      formatPermissionRequestLabel(request('Agent', { subagent_type: 'explore', prompt: 'Find the route' })),
      'Agent:explore',
    )
    assert.equal(formatPermissionRequestLabel(request('Agent', { prompt: 'no type' })), 'Agent')
    assert.equal(formatPermissionRequestLabel(request('Bash', { command: 'npm test' })), 'Bash')
  })
})

describe('permissionToneForRequest', () => {
  it('reports a semantic tone rather than a color', () => {
    assert.equal(permissionToneForRequest(request('Read', {}, 'mode', 'safe')), 'normal')
    assert.equal(permissionToneForRequest(request('Bash', { command: 'npm test' }, 'mode', 'dangerous')), 'caution')
  })

  it('lets a destructive command outrank the risk level', () => {
    const destructive = request('Bash', { command: 'rm -rf dist' }, 'mode', 'safe')

    assert.ok(destructiveWarningsForRequest(destructive).length > 0)
    assert.equal(permissionToneForRequest(destructive), 'danger')
  })
})

describe('toPermissionDto', () => {
  it('carries the destructive analysis so a renderer never imports the harness', () => {
    const dto = request('Bash', { command: 'rm -rf dist' })

    assert.ok(dto.destructiveWarnings.length > 0)
    assert.equal(dto.destructiveWarnings[0]?.code, 'recursive_force_delete')
  })

  it('leaves destructiveWarnings empty for non-Bash tools', () => {
    assert.deepEqual(request('Read', { filePath: 'src/app.ts' }).destructiveWarnings, [])
  })

  it('flattens the tool to a name and a risk level', () => {
    const dto = request('Bash', { command: 'npm test' }, 'ask rule', 'dangerous')

    assert.equal(dto.toolName, 'Bash')
    assert.equal(dto.riskLevel, 'dangerous')
    assert.ok(!('tool' in dto))
  })

  it('reports whether the gate offered an always-allow affordance', () => {
    assert.equal(request('Bash', { command: 'npm test' }).canAlwaysAllow, false)
    assert.equal(
      request('Bash', { command: 'npm test' }, 'mode', 'confirm', 'requires', {
        alwaysAllowRule: allowRule('Bash', 'npm test'),
      }).canAlwaysAllow,
      true,
    )
  })

  it('attaches a bounded preview for file tools', () => {
    const dto = toPermissionDto(
      {
        tool: tool('Write', 'confirm'),
        input: { filePath: 'src/brand-new-file.ts', content: 'export {}\n' },
        reason: 'requires confirmation',
        source: 'mode',
        denialStreak: 0,
      },
      { cwd: process.cwd() },
    )

    assert.equal(dto.preview?.kind, 'diff')
    if (dto.preview?.kind !== 'diff') return
    assert.equal(dto.preview.title, 'Create file')
    assert.equal(dto.preview.newText, 'export {}\n')
  })

  it('omits the preview rather than failing the prompt when it cannot be built', () => {
    const dto = toPermissionDto(
      {
        tool: tool('Bash', 'confirm'),
        input: { command: 'npm test' },
        reason: 'requires confirmation',
        source: 'mode',
        denialStreak: 0,
      },
      { cwd: process.cwd() },
    )

    assert.equal(dto.preview, undefined)
  })
})

function request(
  toolName: string,
  input: unknown,
  source: PermissionDecisionSource = 'mode',
  riskLevel: RiskLevel = 'confirm',
  reason = 'requires confirmation',
  extra: Partial<PermissionRequest> = {},
): PermissionRequestDto {
  return toPermissionDto(
    {
      tool: tool(toolName, riskLevel),
      input,
      reason,
      source,
      denialStreak: 0,
      // The gate always sets these two together (permissions.ts), so a fixture
      // that supplies a rule without the callback would not be representative.
      ...(extra.alwaysAllowRule ? { onAlwaysAllow: () => {} } : {}),
      ...extra,
    },
    { cwd: process.cwd() },
  )
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

describe('locale', () => {
  it('defaults to English, which is what keeps the TUI untouched', () => {
    // The parameter is optional precisely so the terminal's ~25 call sites did
    // not have to change. If the default ever flips, it fails here rather than
    // in someone's shell.
    const dto = request('Bash', { command: 'ls' }, 'ask rule', 'confirm', 'needs a look', {
      matchedRule: askRule('Bash', 'ls:*'),
    })
    assert.equal(formatPermissionTitle(dto), 'Bash command')
    assert.match(formatPermissionReason(dto), /requires confirmation/)
    assert.equal(formatPermissionInputBlock(dto).label, 'Command')
    assert.equal(formatPermissionSource(dto), 'ask rule')
    assert.deepEqual(permissionOptions(), PERMISSION_OPTIONS)
  })

  it('renders the whole dialog in Chinese when asked', () => {
    const dto = request('Write', { filePath: 'a.txt' }, 'ask rule', 'dangerous', 'needs a look', {
      matchedRule: askRule('Write'),
    })
    assert.equal(formatPermissionTitle(dto, 'zh'), '写入文件')
    assert.equal(formatPermissionReason(dto, 'zh'), '权限规则 Write 要求确认。')
    assert.equal(formatPermissionInputBlock(dto, 'zh').label, '路径')
    assert.equal(formatPermissionSource(dto, 'zh'), '询问规则')
    assert.equal(permissionOptions('zh')[0]?.label, '允许一次')
    assert.deepEqual(
      permissionOptions('zh').map((option) => option.hotkey),
      PERMISSION_OPTIONS.map((option) => option.hotkey),
      'hotkeys are keyboard facts, not prose',
    )
  })

  it('translates the two wire enums the subtitle prints raw', () => {
    // Without their tables the subtitle reads "dangerous - ask rule" in the
    // middle of a Chinese sentence: they are the only enum values that reach a
    // user unmediated.
    const dto = request('Write', { filePath: 'a.txt' }, 'ask rule', 'dangerous')
    const subtitle = formatPermissionSubtitle(dto, 2, 4, 'zh')
    assert.match(subtitle, /危险/)
    assert.match(subtitle, /询问规则/)
    assert.match(subtitle, /第 3\/4 条待处理/)
  })

  it('translates the always-allow row without touching the rule syntax', () => {
    const dto = request('Bash', { command: 'ls' }, 'mode', 'confirm', 'r', {
      // The helper supplies `onAlwaysAllow` alongside the rule, which is what
      // makes the DTO's `canAlwaysAllow` true — the gate sets both together.
      alwaysAllowRule: allowRule('Bash', 'ls:*'),
    })
    const options = permissionOptionsForRequest(dto, 'zh')
    assert.deepEqual(options.map((option) => option.action), ['allow', 'deny', 'always'])
    assert.match(options[2]!.label, /始终允许/)
    assert.match(options[2]!.label, /Bash\(ls:\*\)/, 'rule syntax is not prose')
  })
})
