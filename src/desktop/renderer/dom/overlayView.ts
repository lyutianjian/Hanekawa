import type { AskViewModel } from '../model/askUserQuestion.js'
import type { EnterPlanViewModel, ExitPlanViewModel } from '../model/planDialogs.js'
import type { PermissionViewModel } from '../model/permissionDialog.js'
import { previewNode } from './diffView.js'
import { el, replace, show } from './dom.js'
import { markdownNode } from './markdownView.js'

/**
 * The four blocking requests, drawn into one modal panel.
 *
 * Every decision — which options exist, which is focused, what the tone is —
 * arrives already made in the view model. This file only turns that into nodes,
 * which is what keeps the interesting parts testable without a DOM.
 */
export interface OverlayView {
  permission(view: PermissionViewModel): void
  ask(view: AskViewModel): void
  enterPlan(view: EnterPlanViewModel): void
  exitPlan(view: ExitPlanViewModel): void
  hide(): void
}

export function createOverlayView(container: HTMLElement, panel: HTMLElement): OverlayView {
  const open = (tone: 'danger' | 'caution' | 'normal', ...children: Array<Node | string | false>) => {
    panel.className = `tone-${tone}`
    replace(panel, ...children)
    show(container, true)
  }

  return {
    permission(view) {
      open(
        view.tone,
        el('div', 'title', view.title),
        el('div', 'subtitle', view.subtitle),
        el('div', 'reason', view.reason),
        view.denialStreakNote !== undefined && el('div', 'streak', view.denialStreakNote),
        ...view.warnings.map((warning) => el('div', 'warning', `- ${warning.message}`)),
        view.inputBlock.kind !== 'none' && el(
          'div',
          undefined,
          el('div', 'block-label', view.inputBlock.label),
          el('div', 'block', view.inputBlock.content),
        ),
        view.preview !== undefined && previewNode(view.preview),
        optionList(view.options.map((option, index) => ({
          label: option.label,
          hotkey: option.hotkey,
          selected: index === view.selectedIndex,
        }))),
        view.alsoWaiting.length > 0
          && el('div', 'also-waiting', `还在等待：${view.alsoWaiting.join('、')}`),
        el('div', 'hint', view.hint),
      )
    },

    ask(view) {
      open(
        'normal',
        el('div', 'title', `[${view.header}] ${view.question}`),
        view.questionTotal > 1
          && el('div', 'subtitle', `第 ${view.questionNumber}/${view.questionTotal} 个问题`),
        optionList(view.rows.map((row, index) => ({
          // A multi-select row shows its toggle state; "Other" never toggles.
          label: view.multiSelect && !row.isOther
            ? `${row.toggled ? '[x]' : '[ ]'} ${row.label}`
            : row.label,
          description: row.description,
          selected: row.selected,
          hotkey: String(index + 1),
        }))),
        view.otherMode && el(
          'div',
          undefined,
          el('div', 'block-label', 'Other'),
          el('div', 'feedback focused', view.otherText),
        ),
        view.preview !== undefined && el('div', 'block', view.preview),
        el('div', 'hint', view.hint),
      )
    },

    enterPlan(view) {
      open(
        'caution',
        el('div', 'title', view.title),
        el('div', 'reason', view.body),
        el('div', 'bullets', view.bullets.map((bullet) => ` · ${bullet}`).join('\n')),
        el('div', 'subtitle', view.reassurance),
        optionList(view.options.map((option, index) => ({
          label: option.label,
          hotkey: option.hotkey,
          selected: index === view.selectedIndex,
        }))),
        el('div', 'hint', view.hint),
      )
    },

    exitPlan(view) {
      open(
        'caution',
        el('div', 'title', view.title),
        // The plan is markdown the model just wrote; the permission dialog's
        // `.block` and diff below stay literal, because those are the exact
        // command and the exact bytes the user is being asked to approve.
        markdownNode(view.planPreview, 'plan md'),
        el('div', 'subtitle', view.planFilePath),
        optionList(view.options.map((option, index) => ({
          label: option.label,
          hotkey: String(index + 1),
          selected: index === view.selectedIndex,
          // The reject slot grows a feedback field once it is focused.
          extra: option.kind === 'reject'
            ? el('div', `feedback${view.feedbackFocused ? ' focused' : ''}`, view.feedback)
            : undefined,
        }))),
        el('div', 'hint', view.hint),
      )
    },

    hide() {
      show(container, false)
      replace(panel)
    },
  }
}

interface OptionRow {
  label: string
  hotkey: string
  selected: boolean
  description?: string
  extra?: HTMLElement | undefined
}

function optionList(rows: OptionRow[]): HTMLElement {
  const list = el('div', 'options')
  for (const row of rows) {
    const line = el('div', `option${row.selected ? ' selected' : ''}`)
    line.appendChild(document.createTextNode(row.selected ? '> [' : '  ['))
    line.appendChild(el('span', 'hotkey', row.hotkey))
    line.appendChild(document.createTextNode(`] ${row.label}`))
    if (row.description) line.appendChild(el('span', 'subtitle', ` — ${row.description}`))
    list.appendChild(line)
    if (row.extra) list.appendChild(row.extra)
  }
  return list
}
