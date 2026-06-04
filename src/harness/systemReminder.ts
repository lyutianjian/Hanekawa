/**
 * Unified system-reminder wrapper. All dynamic context injected into user
 * messages should go through this helper so the tag format stays consistent
 * and easy to grep/refactor.
 */
export function wrapInSystemReminder(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`
}
