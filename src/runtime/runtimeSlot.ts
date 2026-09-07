import { clampEffort, type EffortLevel, type EffortValue } from '../config/effort.js'
import type { ModelConfig } from '../config/service.js'
import type { AgentSession } from './types.js'

/** What consumers observe: the live runtime plus the effort level applied to it. */
export interface RuntimeSlotSnapshot {
  readonly session: AgentSession
  readonly effort: string
}

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
  private session: AgentSession
  private effort: string
  private snapshot: RuntimeSlotSnapshot
  private readonly listeners = new Set<() => void>()

  constructor(initial: AgentSession, initialEffort: string) {
    this.session = initial
    this.effort = initialEffort
    this.snapshot = Object.freeze({ session: initial, effort: initialEffort })
  }

  get current(): AgentSession {
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
  replace(next: AgentSession): void {
    const previous = this.session
    if (previous === next) return
    this.session = next
    previous.dispose()
    this.publish()
  }

  /**
   * Updates only the displayed model metadata after the loop switched models on
   * its own (fallback activation). The loop and plan-mode manager keep running,
   * so nothing is disposed and no runtime is constructed.
   */
  patchModel(modelKey: string, modelConfig: ModelConfig, providerName?: string): void {
    if (this.session.modelKey === modelKey) return
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
    this.session.dispose()
  }

  private applyEffort(level: string): string {
    const clamped = clampEffort(level as EffortValue, this.session.modelConfig.supportedEfforts)
    // A numeric effort is a raw token budget, not a level, so it is never clamped
    // down to a named level — keep what the caller asked for.
    const clampedLevel = typeof clamped === 'number' ? level : clamped
    this.session.loop.setEffort(typeof clamped === 'string' ? clamped as EffortLevel : undefined)
    if (clampedLevel !== this.effort) {
      this.effort = clampedLevel
      this.publish()
    }
    return clampedLevel
  }

  private publish(): void {
    this.snapshot = Object.freeze({ session: this.session, effort: this.effort })
    for (const listener of [...this.listeners]) listener()
  }
}
