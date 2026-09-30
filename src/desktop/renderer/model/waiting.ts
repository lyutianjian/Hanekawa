import {
  formatWorkedDuration,
  type ActivityGroup,
  type ActivityStep,
  type TranscriptEntry,
  type TranscriptItem,
  type TurnPhase,
} from './transcript.js'

/**
 * What the turn is doing **right now**, and where that is said.
 *
 * The rule is one line: the live status is the transcript's **last row**, for the
 * whole turn. It used to sit on the activity group's head, at the top of the
 * turn, so that it would not walk down the page — but a long turn scrolls its
 * own top out of view, and the one label whose job is to be found without
 * looking ended up above the fold while the reader followed the tail. The tail
 * is where the reader is looking, so that is where it goes.
 *
 * So there is one carrier — the standalone **row** (`row`) — and one group that
 * knows it is running (`liveGroupId`):
 *
 * - the row reads 「正在思考」 in the gap before the first step, and once a group
 *   is open, `groupActivity`: what the running calls do, or 「正在思考」
 *   when nothing is running and the model is deciding.
 * - a wait no record shows — an automatic compaction, a retry backoff — outranks
 *   both (`phaseLabel`): the steps above it are not what the turn is doing.
 * - the live group's head stays quiet (「工作中 · 3 步」, no bead or clock) and
 *   seals to `groupHeaderLabel`'s 「已处理 …」 when the turn ends.
 *
 * Never a second voice beside a growing draft: if the transcript's last loose
 * item is visibly arriving, the row is withdrawn — the text itself is the status.
 * A draft stops arriving once the model moves on to a tool call's arguments
 * (`tool_input_delta`), which is a wait of its own.
 *
 * DOM-free, like every other `model/` unit: the clock lives in the view, and
 * `startedAt` is only carried through so a test can pin the contents without one.
 */

/** 「正在思考」 — the label for 「the model is deciding」, wherever it is shown. */
export const WAITING_LABEL = '正在思考'

/**
 * `Esc` is a real binding here, not a decoration: `model/keymap.ts` maps it to
 * `interrupt` whenever a turn is streaming and no dialog outranks it. A dialog
 * *does* outrank it — but a dialog is a request, and a request parks the turn on
 * a pending step, which is a state this hint is never drawn in.
 */
export const WAITING_HINT = 'Esc 中断'

export interface WaitingInput {
  /** The session snapshot's own flag: a turn is in flight. */
  readonly isStreaming: boolean
  /** When this turn started, epoch ms. The view counts up from it. */
  readonly startedAt: number | undefined
  /** The turn whose records are arriving (`TranscriptState.turnId`). */
  readonly turnId: string | undefined
  /** A wait no record shows (`TranscriptState.phase`); outranks what the steps say. */
  readonly phase?: TurnPhase
}

export interface WaitingRow {
  readonly label: string
  readonly hint: string
  readonly startedAt: number | undefined
  /**
   * Whether the label is spoken. Only in the gap before the first step, where
   * it appears once and holds still; once it follows the turn from tool to
   * tool, each step's own head announces what is new (§8).
   */
  readonly announce: boolean
}

export interface TurnActivity {
  /** The group of the turn in flight, by `turnId`: open, with a quiet head. */
  readonly liveGroupId: string | undefined
  /** The status row at the transcript's tail. */
  readonly row: WaitingRow | undefined
}

const IDLE: TurnActivity = { liveGroupId: undefined, row: undefined }

/**
 * How long the gap has to last before the counter is worth showing.
 *
 * A turn that answers in two seconds does not need to be timed, and a number
 * that appears with the row and is gone again before it can be read is noise
 * next to the label. Past five seconds the wait is the thing the reader is
 * actually looking at, and how long it has been is the answer they want.
 */
export const WAITING_CLOCK_AFTER_MS = 5_000

/**
 * What the counter reads at `elapsedMs` — the empty string while the wait is
 * still short, which is how the view says 「no counter yet」 without a second
 * piece of state. The threshold lives here rather than in the clock because it
 * is a decision, and the view's timer is not where decisions go.
 */
export function waitingElapsedLabel(elapsedMs: number): string {
  return elapsedMs < WAITING_CLOCK_AFTER_MS ? '' : formatWorkedDuration(elapsedMs)
}

/**
 * Which group is live, and what the tail row reads, for this paint.
 *
 * The live group is found by the state's own `turnId` rather than by 「the last
 * group」: a new turn that has not produced a record yet has no `turnId` at all,
 * and the group above it belongs to the turn before — marking *that* one live
 * would report the wrong turn as running.
 *
 * `ActivityGroup.status` is deliberately not consulted either. It reads 「done」
 * the moment the last tool result merges in, which happens several times inside
 * a turn that is still very much running; the session's own `isStreaming` is the
 * only honest source for 「the turn is over」. An aborted group is the exception
 * it looks like: the interruption is already in the transcript, and its head
 * says 已中断.
 */
export function turnActivity(entries: readonly TranscriptEntry[], input: WaitingInput): TurnActivity {
  if (!input.isStreaming) return IDLE
  const group = liveGroup(entries, input.turnId)
  const liveGroupId = group?.turnId
  if (input.phase) {
    return { liveGroupId, row: { label: phaseLabel(input.phase), hint: WAITING_HINT, startedAt: input.startedAt, announce: true } }
  }
  const last = entries[entries.length - 1]
  if (last !== undefined && last.kind === 'item' && isArriving(last.item)) return { liveGroupId, row: undefined }
  const { label, awaiting } = group === undefined ? { label: WAITING_LABEL, awaiting: false } : groupActivity(group)
  return {
    liveGroupId,
    row: { label, hint: awaiting ? '' : WAITING_HINT, startedAt: input.startedAt, announce: group === undefined },
  }
}

const RETRY_REASONS: Record<Extract<TurnPhase, { kind: 'retrying' }>['reason'], string> = {
  rate_limit: '请求被限流',
  overload: '服务过载',
  server_error: '服务端出错',
  transient: '连接中断',
  auth: '认证失败',
  unknown: '请求失败',
}

/**
 * 「正在压缩上下文」, or 「服务过载 · 第 2 次重试」. The attempt that failed is
 * the retry's ordinal: attempt 1 failing is the first retry.
 */
export function phaseLabel(phase: TurnPhase): string {
  return phase.kind === 'compacting' ? '正在压缩上下文' : `${RETRY_REASONS[phase.reason]} · 第 ${phase.attempt} 次重试`
}

function liveGroup(entries: readonly TranscriptEntry[], turnId: string | undefined): ActivityGroup | undefined {
  if (turnId === undefined) return undefined
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (entry.kind !== 'group' || entry.group.turnId !== turnId) continue
    return entry.group.status === 'aborted' ? undefined : entry.group
  }
  return undefined
}

/**
 * The tail row's label while a group is open: what the running calls do, in
 * words — 「读取 waiting.ts」, 「运行 npm test」 — else 「正在思考」.
 *
 * Calls that run together are said once: the same tool as a count
 * (「读取 3 个文件」), a mix as the last one plus how many (「… 等 3 项」), the
 * last because a batch settles in order and the one still open is the one
 * being waited on. A call the user still has to allow outranks all of them —
 * the turn is waiting on the reader, not on the tool — and drops the `Esc`
 * hint, since the dialog owns that key then.
 */
export function groupActivity(group: ActivityGroup): { readonly label: string; readonly awaiting: boolean } {
  const running = group.steps.filter(isRunningCall)
  const waiting = running.filter((step) => step.tool.awaitingApproval === true).at(-1)
  if (waiting) return { label: `等待确认 · ${callPhrase(waiting)}`, awaiting: true }
  const last = running[running.length - 1]
  if (last === undefined) return { label: WAITING_LABEL, awaiting: false }
  if (running.length === 1) return { label: callPhrase(last), awaiting: false }
  const plural = last.toolName !== undefined && running.every((step) => step.toolName === last.toolName)
    ? PLURALS[last.toolName]
    : undefined
  return { label: plural ? `${plural[0]} ${running.length} ${plural[1]}` : `${callPhrase(last)} 等 ${running.length} 项`, awaiting: false }
}

type RunningCall = Extract<ActivityStep, { kind: 'tool' | 'task' }>

function isRunningCall(step: ActivityStep): step is RunningCall {
  return (step.kind === 'tool' || step.kind === 'task') && step.pending === true
}

/** How each built-in reads as an activity: the verb, and which target it names. */
const PHRASES: Record<string, { readonly verb: string; readonly target?: 'file' | 'text' }> = {
  Read: { verb: '读取', target: 'file' },
  Edit: { verb: '编辑', target: 'file' },
  MultiEdit: { verb: '编辑', target: 'file' },
  NotebookEdit: { verb: '编辑', target: 'text' },
  Write: { verb: '写入', target: 'file' },
  Delete: { verb: '删除', target: 'file' },
  Grep: { verb: '搜索', target: 'text' },
  Glob: { verb: '查找文件', target: 'text' },
  Bash: { verb: '运行', target: 'text' },
  BashOutput: { verb: '读取输出' },
  KillShell: { verb: '结束进程' },
  WebFetch: { verb: '抓取', target: 'text' },
  WebSearch: { verb: '联网搜索', target: 'text' },
  Browser: { verb: '浏览器', target: 'text' },
  Skill: { verb: '使用技能', target: 'text' },
  Agent: { verb: '子代理', target: 'text' },
  SendMessage: { verb: '发送消息', target: 'text' },
  AskUserQuestion: { verb: '等待回答' },
  TodoWrite: { verb: '更新任务' },
  TaskCreate: { verb: '更新任务' },
  TaskUpdate: { verb: '更新任务' },
  TaskList: { verb: '查看任务' },
  TaskGet: { verb: '查看任务' },
  EnterPlanMode: { verb: '进入计划模式' },
  ExitPlanMode: { verb: '提交计划' },
  Config: { verb: '修改设置' },
}

const PLURALS: Record<string, readonly [string, string]> = {
  Read: ['读取', '个文件'],
  Edit: ['编辑', '个文件'],
  MultiEdit: ['编辑', '个文件'],
  Write: ['写入', '个文件'],
  Delete: ['删除', '个文件'],
  Grep: ['搜索', '处'],
  Glob: ['查找', '组文件'],
  Bash: ['运行', '个命令'],
  WebFetch: ['抓取', '个网页'],
  WebSearch: ['联网搜索', '次'],
  Agent: ['运行', '个子代理'],
}

const TARGET_MAX = 40

function callPhrase(step: RunningCall): string {
  const phrase = step.toolName === undefined ? undefined : PHRASES[step.toolName]
  if (phrase === undefined) return `调用 ${step.tool.displayName || step.toolName || '工具'}`
  if (phrase.target === undefined) return phrase.verb
  // Grep and Glob caption as `pattern · glob · path`; the pattern is the target.
  const raw = step.tool.description ?? step.tool.useSummary.split(' · ')[0] ?? ''
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  const target = phrase.target === 'file' ? oneLine.split(/[\\/]/).pop()! : oneLine
  if (target.length === 0) return phrase.verb
  return `${phrase.verb}${step.toolName === 'Agent' ? ' · ' : ' '}${target.length > TARGET_MAX ? `${target.slice(0, TARGET_MAX - 1)}…` : target}`
}

/**
 * Whether the transcript's last loose item is visibly still coming.
 *
 * A pending message or thinking segment only says so once it has text:
 * `text_delta` can open a draft with an empty string, and an empty bubble is
 * exactly the blank page the row exists for.
 */
function isArriving(item: TranscriptItem): boolean {
  if (item.pending !== true) return false
  if (item.kind === 'tool' || item.kind === 'subagent') return true
  return item.text.trim().length > 0
}
