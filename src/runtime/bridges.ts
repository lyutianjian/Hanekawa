import type { PermissionPrompt, PermissionRequest } from '../harness/permissions.js'
import type {
  AskUserQuestionRequest,
  AskUserQuestionResult,
  ModelStreamEvent,
  SessionRecord,
  ToolProgressEvent,
} from '../harness/types.js'
import type { ExitDialogInput, ExitPlanDecision } from '../harness/planModeManager.js'

/**
 * The complete human-in-the-loop surface of the runtime.
 *
 * Every proxy here is a stable object created before any UI exists, holding a
 * mutable handler that the UI installs once it is ready and removes when it
 * goes away. The runtime only ever sees the function signatures, so the same
 * assembly works for the Ink TUI, a desktop shell, or a headless caller.
 *
 * Two directions are represented: `record` is a one-way push out of the
 * runtime, the other four are blocking request/response calls into the UI.
 * The pre-mount fallbacks are deliberately different per bridge — see each
 * factory.
 */

export interface RecordProxy {
  onRecord: (record: SessionRecord) => void
  setHandler: (fn: (record: SessionRecord) => void) => void
  onProgress: (event: ToolProgressEvent) => void
  setProgressHandler: (fn: (event: ToolProgressEvent) => void) => void
  onStreamEvent: (event: ModelStreamEvent) => void
  setStreamEventHandler: (fn: (event: ModelStreamEvent) => void) => void
}

export function createRecordProxy(): RecordProxy {
  let handler: (record: SessionRecord) => void = () => {}
  let progressHandler: (event: ToolProgressEvent) => void = () => {}
  let streamEventHandler: (event: ModelStreamEvent) => void = () => {}
  return {
    onRecord: (record) => handler(record),
    setHandler: (fn) => { handler = fn },
    onProgress: (event) => progressHandler(event),
    setProgressHandler: (fn) => { progressHandler = fn },
    onStreamEvent: (event) => streamEventHandler(event),
    setStreamEventHandler: (fn) => { streamEventHandler = fn },
  }
}

/**
 * Bridges the imperative PermissionGate with whatever UI renders the prompt.
 *
 * Usage:
 * 1. Call `createPromptProxy()` to get a stable PermissionPrompt function
 * 2. Pass it to the PermissionGate constructor
 * 3. In the UI, install the real handler via `setPrompt`
 */
export interface PermissionPromptProxy {
  prompt: PermissionPrompt
  setPrompt: (fn: PermissionPrompt) => void
}

export function createPromptProxy(): PermissionPromptProxy {
  // The proxy holds a mutable reference to the actual prompt function.
  // Initially it auto-denies (before the UI is up).
  let currentPrompt: PermissionPrompt = async () => false

  return {
    prompt: (request: PermissionRequest) => currentPrompt(request),
    setPrompt: (fn: PermissionPrompt) => {
      currentPrompt = fn
    },
  }
}

/**
 * Bridges PlanModeManager.openExitDialog with the UI.
 *
 * Before the UI installs a handler the proxy auto-rejects with empty feedback
 * so the manager can still drive a clean test run.
 */
export interface ExitPlanPromptProxy {
  open(input: ExitDialogInput): Promise<ExitPlanDecision>
  setOpen(fn: (input: ExitDialogInput) => Promise<ExitPlanDecision>): void
}

export function createExitPlanProxy(): ExitPlanPromptProxy {
  let currentOpen: (input: ExitDialogInput) => Promise<ExitPlanDecision> = async () => ({
    kind: 'reject',
    feedback: '',
  })
  return {
    open: (input) => currentOpen(input),
    setOpen: (fn) => { currentOpen = fn },
  }
}

/**
 * Bridges PlanModeManager.openEnterPrompt with the UI.
 *
 * Before the UI installs a handler the proxy auto-approves entry, mirroring
 * the fallback in PlanModeManager.processEnterRequest where a missing
 * openEnterPrompt was implicitly treated as "approve". This keeps headless /
 * unit-test paths that never mount a UI working.
 */
export interface EnterPlanPromptProxy {
  open(): Promise<boolean>
  setOpen(fn: () => Promise<boolean>): void
}

export function createEnterPlanProxy(): EnterPlanPromptProxy {
  let currentOpen: () => Promise<boolean> = async () => true
  return {
    open: () => currentOpen(),
    setOpen: (fn) => { currentOpen = fn },
  }
}

/**
 * Bridges the AskUserQuestion tool with the UI.
 *
 * Before the UI installs a handler the proxy auto-rejects so the tool surfaces
 * a clean error instead of hanging.
 */
export interface AskUserQuestionProxy {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionResult>
  setOpen(fn: (request: AskUserQuestionRequest) => Promise<AskUserQuestionResult>): void
}

export function createAskUserQuestionProxy(): AskUserQuestionProxy {
  let currentOpen: (request: AskUserQuestionRequest) => Promise<AskUserQuestionResult> = async () => ({
    kind: 'rejected',
    feedback: 'AskUserQuestion UI is not mounted.',
  })
  return {
    ask: (request) => currentOpen(request),
    setOpen: (fn) => { currentOpen = fn },
  }
}

export interface UiBridges {
  prompt: PermissionPromptProxy
  record: RecordProxy
  exitPlan: ExitPlanPromptProxy
  enterPlan: EnterPlanPromptProxy
  askUserQuestion: AskUserQuestionProxy
}

export function createUiBridges(): UiBridges {
  return {
    prompt: createPromptProxy(),
    record: createRecordProxy(),
    exitPlan: createExitPlanProxy(),
    enterPlan: createEnterPlanProxy(),
    askUserQuestion: createAskUserQuestionProxy(),
  }
}
