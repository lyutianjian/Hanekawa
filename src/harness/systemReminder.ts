/**
 * Unified system-reminder wrapper. All dynamic context injected into user
 * messages should go through this helper so the tag format stays consistent
 * and easy to grep/refactor.
 */
export function wrapInSystemReminder(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`
}

/** Whether a message is model-facing reminders only, never the user's words. */
export function isSystemReminderBlock(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('<system-reminder>') && trimmed.endsWith('</system-reminder>')
}
