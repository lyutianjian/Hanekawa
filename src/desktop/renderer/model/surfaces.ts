import { EFFORT_RANK, VALID_EFFORT_LEVELS, type EffortLevel } from '../../../config/effort.js'
import type { ModelPickerOption } from '../../../runtime/modelPicker.js'
import type { CommandSurface, WireModelsResult } from '../../../runtime/protocol/wire.js'
import type { BackgroundTaskSnapshot } from '../../../services/backgroundTasks/registry.js'
import type { SessionMeta } from '../../../sessions/service.js'

/**
 * The pickers a slash command can ask for, as row lists.
 *
 * A `CommandEffect` of kind `open-surface` names one of five surfaces; a shell
 * that has no panel for one ignores it *by name*, which is why the five collapse
 * into a single wire variant. This renderer implements four and ignores
 * `provider-panel`: everything it would show comes off `ConfigService`, which a
 * renderer cannot reach, and no wire message projects it.
 *
 * DOM-free on purpose; see `diffRows.ts`.
 */

export interface SurfaceRow {
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly current?: boolean
  readonly disabled?: boolean
  readonly disabledReason?: string
}

export interface SurfaceView {
  readonly surface: CommandSurface
  readonly title: string
  readonly rows: readonly SurfaceRow[]
  readonly emptyMessage: string
}

/** Surfaces this shell can draw. `provider-panel` is deliberately absent. */
export type SupportedSurface = 'model-picker' | 'effort-picker' | 'background-tasks' | 'resume-picker'

export const SUPPORTED_SURFACES: readonly SupportedSurface[] = [
  'model-picker',
  'effort-picker',
  'background-tasks',
  'resume-picker',
] as const

/** A predicate, so the caller's switch over the four is exhaustive. */
export function isSupportedSurface(surface: CommandSurface): surface is SupportedSurface {
  return (SUPPORTED_SURFACES as readonly CommandSurface[]).includes(surface)
}

/**
 * Rows built from `WireModelsResult.pickerOptions`, which the *host* computed —
 * `buildModelPickerOptions` needs `ConfigService.getModel`, and anything projected
 * from a `ModelConfig` must be built field by field because `resolveModel` folds
 * the endpoint's `apiKey` and `baseUrl` into what it returns.
 */
export function modelPickerView(result: WireModelsResult): SurfaceView {
  return {
    surface: 'model-picker',
    title: 'Select a model',
    rows: result.pickerOptions.map(modelRow),
    emptyMessage: 'No models are configured.',
  }
}

function modelRow(option: ModelPickerOption): SurfaceRow {
  const detail = [
    option.modelId,
    option.providerName,
    option.isDefault ? 'default' : undefined,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0).join(' · ')

  return {
    // The tier, not the model key: a disabled tier has no key, and the tier is
    // what `/model <tier>` accepts.
    id: option.tier,
    label: `${option.label}${option.modelKey ? ` — ${option.modelKey}` : ''}`,
    detail,
    ...(option.isCurrent ? { current: true } : {}),
    ...(option.disabledReason ? { disabled: true, disabledReason: option.disabledReason } : {}),
  }
}

/**
 * Effort levels, with anything above the model's ceiling shown as unavailable
 * rather than hidden — a user who set `max` in config should see why it is not
 * in force.
 */
export function effortPickerView(input: {
  current: string
  maxEffort?: EffortLevel
  configured?: string
}): SurfaceView {
  return {
    surface: 'effort-picker',
    title: 'Select reasoning effort',
    rows: VALID_EFFORT_LEVELS.map((level) => {
      const beyondCeiling = input.maxEffort !== undefined
        && EFFORT_RANK[level] > EFFORT_RANK[input.maxEffort]
      return {
        id: level,
        label: level,
        detail: input.configured === level && input.configured !== input.current ? 'configured' : '',
        ...(level === input.current ? { current: true } : {}),
        ...(beyondCeiling
          ? { disabled: true, disabledReason: `above this model's maximum (${input.maxEffort})` }
          : {}),
      }
    }),
    emptyMessage: '',
  }
}

export function backgroundTasksView(tasks: readonly BackgroundTaskSnapshot[]): SurfaceView {
  return {
    surface: 'background-tasks',
    title: 'Background tasks',
    rows: tasks.map((task) => ({
      id: task.id,
      label: task.kind === 'agent'
        ? `${task.agentType ?? 'agent'}: ${task.description ?? task.agentId ?? task.id}`
        : task.command ?? task.id,
      detail: [
        task.status,
        task.exitCode !== undefined && task.exitCode !== null ? `exit ${task.exitCode}` : undefined,
        task.unreadBytes > 0 ? `${task.unreadBytes} new bytes` : undefined,
      ].filter((part): part is string => typeof part === 'string').join(' · '),
    })),
    emptyMessage: 'No background tasks.',
  }
}

export function resumePickerView(input: {
  sessions: readonly SessionMeta[]
  currentSessionId?: string
}): SurfaceView {
  return {
    surface: 'resume-picker',
    title: 'Resume a session',
    rows: input.sessions.map((session) => ({
      id: session.id,
      label: session.title ?? session.shortId,
      detail: `${session.messageCount} message${session.messageCount === 1 ? '' : 's'} · ${session.updatedAt}`,
      ...(session.id === input.currentSessionId ? { current: true } : {}),
    })),
    emptyMessage: 'No other sessions yet.',
  }
}
