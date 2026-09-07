import { composerChipView } from './composer.js'
import { effortPickerView, modelPickerView, type SurfaceRow } from './surfaces.js'
import type { ModelPickerOption } from '../../../runtime/modelPicker.js'
import type { WireModelsResult, WireRuntimeSnapshot } from '../../../runtime/protocol/wire.js'

/**
 * The composer chip's own menu: model and effort as **one** control.
 *
 * They used to be two buttons opening two full-width `#surface` cards. The chip
 * is now a single status label, and this is what it opens: two rows naming the
 * field and its current value, each with a flyout of the levels it can take.
 * The `#surface` pickers stay exactly as they were — `/model` and `/effort`
 * still open them, and this menu must not become a second answer to what the
 * options *are*.
 *
 * Which is why the rows come from `modelPickerView` / `effortPickerView`
 * verbatim, including their `disabled` / `disabledReason` (an effort level over
 * the model's ceiling) and their `SurfaceAction`. The action is a
 * `run-command` — `/model <key>`, `/effort <level>` — because the slash command
 * is what writes the choice back to config; see `model/surfaces.ts`.
 *
 * Pure and DOM-free: `dom/composerView.ts` turns this into nodes.
 */

export type RuntimeMenuKey = 'model' | 'effort'

export interface RuntimeMenuEntry {
  readonly key: RuntimeMenuKey
  /** The field's name, as the row reads it: 「模型」/「推理强度」. */
  readonly label: string
  /** Its current value, the same text the chip itself shows. */
  readonly value: string
  /** The flyout's heading; the picker's own title, so the two cannot drift. */
  readonly title: string
  readonly rows: readonly SurfaceRow[]
}

export interface RuntimeMenuView {
  readonly entries: readonly RuntimeMenuEntry[]
  /** False until a runtime snapshot has arrived; the chip is inert until then. */
  readonly enabled: boolean
}

/**
 * The model rows, down to their names.
 *
 * `modelPickerView` builds a row for a full-width card, so its label carries the
 * model key and its detail the model id, the provider and 「默认」 — three columns
 * of context that read as noise in a flyout half that width, where the point is
 * "which model", not "what is it made of". The row is otherwise untouched: its
 * `current`, its `action` and its `disabledReason` (a key that cannot be loaded
 * still has to say so) are the picker's, so the two cannot disagree about what
 * is selectable.
 *
 * Matched by id rather than by position: `SurfaceRow.id` *is* the model key.
 */
function modelRows(rows: readonly SurfaceRow[], options: readonly ModelPickerOption[]): SurfaceRow[] {
  return rows.map((row) => ({
    ...row,
    label: options.find((option) => option.key === row.id)?.label ?? row.label,
    detail: '',
  }))
}

export function runtimeMenuView(input: {
  runtime: WireRuntimeSnapshot | undefined
  /**
   * Undefined when the model list could not be fetched. The menu still opens —
   * the effort half is answerable from the snapshot alone, and a row that lists
   * nothing says more than a chip that refuses to open.
   */
  models: WireModelsResult | undefined
}): RuntimeMenuView {
  const chip = composerChipView(input.runtime)
  const models = input.models ? modelPickerView(input.models) : undefined
  const effort = effortPickerView({
    current: input.runtime?.effort ?? '',
    ...(input.runtime?.supportedEfforts ? { supportedEfforts: input.runtime.supportedEfforts } : {}),
  })

  return {
    enabled: chip.enabled,
    entries: [
      {
        key: 'model',
        label: '模型',
        value: chip.model,
        title: models?.title ?? '选择模型',
        rows: models ? modelRows(models.rows, input.models?.pickerOptions ?? []) : [],
      },
      {
        key: 'effort',
        label: '推理强度',
        value: chip.effort,
        title: effort.title,
        rows: effort.rows,
      },
    ],
  }
}
