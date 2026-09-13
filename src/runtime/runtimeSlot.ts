import { clampEffort, type EffortLevel, type EffortValue } from '../config/effort.js'
import type { ModelConfig } from '../config/service.js'
import type { AgentSession } from './types.js'
import { MODEL_CONFIGURATION_REQUIRED, MISSING_MODEL_ISSUE, RuntimeStartupError, type RuntimeConfigurationIssue } from './errors.js'

/** What consumers observe: the live runtime plus the effort level applied to it. */
export type RuntimeSlotSnapshot = { readonly effort: string } & (
  | { readonly status: 'ready'; readonly session: AgentSession; readonly configurationIssue?: undefined }
  | { readonly status: 'needs_configuration'; readonly session: undefined; readonly configurationIssue: RuntimeConfigurationIssue }
)

/**
 * Owns *the* current {@link AgentSession} and the effort level bound to it.
 *
 * Swapping a runtime is the one operation in the system with no second chance:
 * the outgoing session's `dispose()` unregisters its tool arrays and tears down
 * its plan-slug provider, so it must run only once and only after the incoming
 * session is already the visible one. Centralising that here means no caller
 * can get the order wrong.
 */
export class RuntimeSlot {
  private session: AgentSession | undefined
  private configurationIssue: RuntimeConfigurationIssue
  private effort: string
  private snapshot: RuntimeSlotSnapshot
  private readonly listeners = new Set<() => void>()

  constructor(initial: AgentSession | undefined, initialEffort: string, issue = MISSING_MODEL_ISSUE) {
    this.session = initial
    this.effort = initialEffort
    this.configurationIssue = issue
    this.snapshot = this.buildSnapshot()
  }

  get current(): AgentSession | undefined {
    return this.session
  }

  /** Required only by actions that actually use a loop, never by shell startup. */
  requireCurrent(): AgentSession {
    if (!this.session) {
      throw new RuntimeStartupError(
        this.configurationIssue.code,
        `${this.configurationIssue.message} ${MODEL_CONFIGURATION_REQUIRED}`,
      )
    }
    return this.session
  }

  getSnapshot = (): RuntimeSlotSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Installs a new runtime and disposes the previous one. Order is load-bearing. */
  replace(next: AgentSession | undefined, issue = MISSING_MODEL_ISSUE): void {
    const previous = this.session
    if (previous === next && (next || (
      this.configurationIssue.code === issue.code && this.configurationIssue.message === issue.message
    ))) return
    this.session = next
    this.configurationIssue = issue
    previous?.dispose()
    this.publish()
  }

  /**
   * Updates only the displayed model metadata after the loop switched models on
   * its own (fallback activation). The loop and plan-mode manager keep running,
   * so nothing is disposed and no runtime is constructed.
   */
  patchModel(modelKey: string, modelConfig: ModelConfig, providerName?: string): void {
    if (!this.session || this.session.modelKey === modelKey) return
    this.session = {
      ...this.session,
      modelKey,
      modelConfig,
      providerName: providerName ?? this.session.providerName,
    }
    this.publish()
  }

  getEffort(): string {
    return this.effort
  }

  /** A user-driven effort change, clamped to what the active model supports. */
  setEffort(level: string): string {
    return this.applyEffort(level)
  }

  /**
   * Re-clamps the existing effort against the current model. Called after a
   * runtime swap; unlike {@link setEffort} it is not a user choice, so callers
   * must not persist the result.
   */
  reapplyEffort(): string {
    return this.applyEffort(this.effort)
  }

  /** Disposes the live runtime. There is nothing to replace it with afterwards. */
  dispose(): void {
    this.session?.dispose()
    this.session = undefined
  }

  private applyEffort(level: string): string {
    const clamped = clampEffort(level as EffortValue, this.session?.modelConfig.supportedEfforts)
    // A numeric effort is a raw token budget, not a level, so it is never clamped
    // down to a named level — keep what the caller asked for.
    const clampedLevel = typeof clamped === 'number' ? level : clamped
    this.session?.loop.setEffort(typeof clamped === 'string' ? clamped as EffortLevel : undefined)
    if (clampedLevel !== this.effort) {
      this.effort = clampedLevel
      this.publish()
    }
    return clampedLevel
  }

  private buildSnapshot(): RuntimeSlotSnapshot {
    return this.session
      ? Object.freeze({ status: 'ready', session: this.session, effort: this.effort })
      : Object.freeze({ status: 'needs_configuration', session: undefined, effort: this.effort, configurationIssue: this.configurationIssue })
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot()
    for (const listener of [...this.listeners]) listener()
  }
}
