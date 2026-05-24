export type SystemPromptSectionCompute<T extends string = string> = () => T

export class SystemPromptSectionCache {
  private readonly sections = new Map<string, string>()

  cachedSection<T extends string>(key: string, compute: SystemPromptSectionCompute<T>): T {
    const existing = this.sections.get(key)
    if (existing !== undefined) return existing as T

    const value = compute()
    this.sections.set(key, value)
    return value
  }

  uncachedSection<T extends string>(
    _key: string,
    _reason: string,
    compute: SystemPromptSectionCompute<T>,
  ): T {
    return compute()
  }

  clear(key?: string): void {
    if (key) {
      this.sections.delete(key)
      return
    }
    this.sections.clear()
  }
}

const defaultSystemPromptSections = new SystemPromptSectionCache()

export function cachedSection<T extends string>(key: string, compute: SystemPromptSectionCompute<T>): T {
  return defaultSystemPromptSections.cachedSection(key, compute)
}

export function uncachedSection<T extends string>(
  key: string,
  reason: string,
  compute: SystemPromptSectionCompute<T>,
): T {
  return defaultSystemPromptSections.uncachedSection(key, reason, compute)
}

export function clearCachedSections(key?: string): void {
  defaultSystemPromptSections.clear(key)
}
