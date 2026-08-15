import { spawn } from 'node:child_process'
import type { PlanModeManager } from '../harness/planModeManager.js'
import { readPlan } from '../utils/plans.js'

/**
 * Reading and editing the draft plan file behind `/plan` and `/plan open`.
 *
 * `resolvePlanFilePathLazy` is read off the *live* plan-mode manager on every
 * call rather than captured: a model switch replaces the manager along with the
 * runtime, and a captured one would keep naming the previous plan slug.
 *
 * `openPlanFileInEditor` is terminal-shaped and knowingly so — it hands the
 * child `stdio: 'inherit'`, which assumes the caller owns a TTY. A GUI shell
 * should not reuse it; opening a file is something the platform does better
 * (`shell.openPath`), and the return shape is already just a message to show.
 */
export interface PlanFileDeps {
  getPlanModeManager: () => PlanModeManager
}

export async function readCurrentPlanFile(
  deps: PlanFileDeps,
): Promise<{ path: string; content: string | null }> {
  const path = deps.getPlanModeManager().resolvePlanFilePathLazy()
  return { path, content: await readPlan(path) }
}

export async function openPlanFileInEditor(deps: PlanFileDeps): Promise<{ message: string }> {
  const { path } = await readCurrentPlanFile(deps)
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano')
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(editor, [path], { stdio: 'inherit' })
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0 || code === null) resolve()
        else reject(new Error(`editor exited with code ${code}`))
      })
    })
    return { message: `Opened plan in editor: ${path}` }
  } catch (error) {
    return { message: `Failed to open plan in editor: ${error instanceof Error ? error.message : String(error)}` }
  }
}
