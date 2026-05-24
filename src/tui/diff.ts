import { diffWords } from 'diff'

export interface DiffPart {
  value: string
  added?: boolean
  removed?: boolean
}

export function computeWordDiff(oldText: string, newText: string): DiffPart[] {
  return diffWords(oldText, newText)
}

export function truncateContent(
  content: string,
  maxLines: number,
): { text: string; truncated: boolean; remaining: number } {
  const lines = content.split('\n')
  if (lines.length <= maxLines) {
    return { text: content, truncated: false, remaining: 0 }
  }
  return {
    text: lines.slice(0, maxLines).join('\n'),
    truncated: true,
    remaining: lines.length - maxLines,
  }
}
