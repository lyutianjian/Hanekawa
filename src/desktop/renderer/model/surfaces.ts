import { EFFORT_RANK, VALID_EFFORT_LEVELS, type EffortLevel } from '../../../config/effort.js'
import { EFFORT_LABELS } from './composer.js'
import type { ModelPickerOption } from '../../../runtime/modelPicker.js'
import type { CommandSurface, WireModelsResult } from '../../../runtime/protocol/wire.js'
import type { BackgroundTaskSnapshot } from '../../../services/backgroundTasks/registry.js'
import type { SessionMeta } from '../../../sessions/service.js'

/**
 * The pickers a slash command can ask for, as row lists.
 *
 * A `CommandEffect` of kind `open-surface` names one of six surfaces; a shell
 * that has no panel for one ignores it *by name*, which is why they collapse
 * into a single wire variant. This renderer draws five of them, but only four
 * are here: `rewind-panel` is a two-screen modal with its own state
 * (`model/rewindPanel.ts`) rather than a row list, so `app.ts` resolves it
 * before consulting `isSupportedSurface` — a `false` from that predicate means
 * "not a row list", not "not drawn". `provider-panel` is the one genuinely
 * ignored: everything it would show comes off `ConfigService`, which a renderer
 * cannot reach, and no wire message projects it.
 *
 * DOM-free on purpose; see `diffRows.ts`.
 */

/**
 * What activating a row does.
 *
 * Three of the four pickers resolve to a **slash command line**, not to the
 * matching `SessionClient` method, and that is load-bearing rather than
 * roundabout. `set-model` and `switchModel` are deliberately two layers: the
 * wire command only points the current runtime somewhere else, while `/model`
 * is the user expressing a preference and is what writes the model back to
 * config (`protocol/commandContext.ts` wires `setModel` to `switchModel`).
 * Calling `client.setModel` from here would silently drop that persistence, and
 * would let the two shells drift apart on a decision neither of them owns.
 *
 * `resume-picker` is the exception because `/resume` takes no argument — it
 * exists only to open this panel. The desktop equivalent of switching sessions
 * is already defined by the tab bar: one pane per session, so `open-pane`
 * focuses the window that has it or opens one.
 *
 * `background-tasks` peeks rather than kills. `killTask` is destructive and gets
 * no keyboard-adjacent affordance in this pass.
 */
export type SurfaceAction =
  | { readonly kind: 'run-command'; readonly line: string }
  | { readonly kind: 'open-pane'; readonly sessionId: string }
  | { readonly kind: 'peek-task'; readonly taskId: string }

export interface SurfaceRow {
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly current?: boolean
  readonly disabled?: boolean
  readonly disabledReason?: string
  /** Absent on a disabled row, which is shown to explain itself, not to be picked. */
  readonly action?: SurfaceAction
}

export interface SurfaceView {
  readonly surface: CommandSurface
  readonly title: string
  readonly rows: readonly SurfaceRow[]
  readonly emptyMessage: string
}

/**
 * The surfaces this shell draws *as a row list*.
 *
 * `provider-panel` is absent because it is not drawn at all; `rewind-panel` is
 * absent because it is drawn by `model/rewindPanel.ts` instead. See the header.
 */
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
    title: '选择模型',
    rows: result.pickerOptions.map(modelRow),
    emptyMessage: '尚未配置任何模型。',
  }
}

function modelRow(option: ModelPickerOption): SurfaceRow {
  const detail = [
    option.modelId,
    option.providerName,
    option.isDefault ? '默认' : undefined,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0).join(' · ')

  return {
    // The model key: it is the row's stable id and exactly what `/model` takes.
    id: option.key,
    label: `${option.label}${option.modelKey ? ` — ${option.modelKey}` : ''}`,
    detail,
    ...(option.isCurrent ? { current: true } : {}),
    ...(option.disabledReason
      ? { disabled: true, disabledReason: option.disabledReason }
      : { action: { kind: 'run-command', line: `/model ${option.key}` } as const }),
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
    title: '选择思考强度',
    rows: VALID_EFFORT_LEVELS.map((level) => {
      // Bound to a local so the "beyond the ceiling" branch can name the ceiling
      // without an assertion the compiler cannot check.
      const ceiling = input.maxEffort
      const beyondCeiling = ceiling !== undefined && EFFORT_RANK[level] > EFFORT_RANK[ceiling]
      return {
        id: level,
        // The same label the composer's chip shows. One concept, one spelling:
        // the picker used to print the raw `low`/`medium`/`high` next to a chip
        // saying 低/中/高 (`todo.md`'s 4f accounting). The *command* is still
        // built from the raw level — that is an argument, not a label.
        label: EFFORT_LABELS[level],
        detail: input.configured === level && input.configured !== input.current ? '已配置' : '',
        ...(level === input.current ? { current: true } : {}),
        ...(beyondCeiling
          ? { disabled: true, disabledReason: `超过该模型上限（${ceiling ? EFFORT_LABELS[ceiling] : ''}）` }
          : { action: { kind: 'run-command', line: `/effort ${level}` } as const }),
      }
    }),
    emptyMessage: '',
  }
}

export function backgroundTasksView(tasks: readonly BackgroundTaskSnapshot[]): SurfaceView {
  return {
    surface: 'background-tasks',
    title: '后台任务',
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
      action: { kind: 'peek-task', taskId: task.id } as const,
    })),
    emptyMessage: '没有后台任务。',
  }
}

export function resumePickerView(input: {
  sessions: readonly SessionMeta[]
  currentSessionId?: string
}): SurfaceView {
  return {
    surface: 'resume-picker',
    title: '恢复会话',
    rows: input.sessions.map((session) => ({
      id: session.id,
      label: session.title ?? session.shortId,
      detail: `${session.messageCount} 条消息 · ${session.updatedAt}`,
      ...(session.id === input.currentSessionId ? { current: true } : {}),
      action: { kind: 'open-pane', sessionId: session.id } as const,
    })),
    emptyMessage: '还没有其他会话。',
  }
}

// --- selection --------------------------------------------------------------

/**
 * Moving through the rows, skipping the ones that cannot be picked.
 *
 * A disabled row is still *drawn* — a model key that cannot be loaded should say
 * why — but stepping onto it would leave Enter doing nothing, which reads as the
 * app having hung. Wraps like the completion dropdown does.
 *
 * Returns the same index when nothing is selectable, so a panel of nothing but
 * disabled rows is inert rather than looping forever.
 */
export function moveSurfaceSelection(
  view: SurfaceView,
  selectedIndex: number,
  direction: 'up' | 'down',
): number {
  const total = view.rows.length
  if (total === 0) return selectedIndex
  const step = direction === 'up' ? -1 : 1
  let index = selectedIndex
  for (let hops = 0; hops < total; hops += 1) {
    index = ((index + step) % total + total) % total
    if (view.rows[index]?.action) return index
  }
  return selectedIndex
}

/** The first row a freshly opened panel should sit on. */
export function initialSurfaceSelection(view: SurfaceView): number {
  const current = view.rows.findIndex((row) => row.current && row.action)
  if (current >= 0) return current
  const first = view.rows.findIndex((row) => row.action)
  return first >= 0 ? first : 0
}

/** The action for a row, or undefined when the row is disabled or absent. */
export function activateSurfaceRow(view: SurfaceView, selectedIndex: number): SurfaceAction | undefined {
  return view.rows[selectedIndex]?.action
}

/** Same answer, addressed by row id — the shape a click handler has. */
export function activateSurfaceRowById(view: SurfaceView, id: string): SurfaceAction | undefined {
  return view.rows.find((row) => row.id === id)?.action
}
