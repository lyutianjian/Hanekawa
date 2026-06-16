/**
 * Prompts and formatting for session memory extraction.
 */

import type { SessionRecord } from '../../harness/types.js'
import { countTextTokens } from '../../prompts/budget.js'

/** System prompt for the extraction LLM call. */
export const EXTRACTION_SYSTEM_PROMPT =
  'You extract and maintain a structured memory of conversation context so an agent can continue after compaction.'

/** Build the user-facing extraction prompt. */
export function buildExtractionPrompt(
  existingMemory: string | undefined,
  newRecordsText: string,
  newRecordCount: number,
): string {
  const sections: string[] = [
    'You are updating the session memory for an ongoing agent conversation.',
    '',
    'Session memory captures key facts that survive context compaction. Focus on:',
    '- User goals and requirements (what they asked for)',
    '- Decisions made and rationale',
    '- Key file paths and code locations',
    '- Constraints and preferences',
    '- Unresolved tasks and open questions',
    '- Error patterns and fixes applied',
    '- Important tool results (summaries, not raw output)',
    '',
    'Rules:',
    '- Write a concise but complete summary.',
    '- Do not answer the user or perform tasks.',
    '- Do not include raw tool output — summarize findings instead.',
    '- Preserve important details: file paths, function names, error messages.',
    '- If the existing memory covers a topic, update it with new information.',
    '- Remove information that is no longer relevant.',
  ]

  if (existingMemory) {
    sections.push(
      '',
      '<existing_memory>',
      existingMemory,
      '</existing_memory>',
      '',
      `Below are ${newRecordCount} new conversation records to integrate.`,
    )
  } else {
    sections.push(
      '',
      `Below are ${newRecordCount} conversation records to summarize.`,
    )
  }

  sections.push(
    '',
    '<new_records>',
    newRecordsText,
    '</new_records>',
    '',
    'Produce the updated session memory below. Use markdown sections for structure.',
  )

  return sections.join('\n')
}

/**
 * Format session records into readable text for the extraction prompt.
 * Skips subagent_transcript records (too verbose) and compact_boundary records.
 */
export function formatRecordsForExtraction(records: SessionRecord[]): string {
  const lines: string[] = []

  for (const record of records) {
    switch (record.type) {
      case 'message': {
        const role = record.role === 'user' ? 'User' : 'Assistant'
        const content = typeof record.content === 'string'
          ? record.content.slice(0, 2000)
          : '(empty)'
        lines.push(`[${role}]: ${content}`)
        break
      }
      case 'tool_use': {
        const input = typeof record.input === 'string'
          ? record.input
          : JSON.stringify(record.input ?? {}).slice(0, 500)
        lines.push(`[Tool Call: ${record.tool}] ${input}`)
        break
      }
      case 'tool_result': {
        const status = record.ok ? 'ok' : 'error'
        const content = record.content.slice(0, 1000)
        lines.push(`[Tool Result: ${record.tool} (${status})] ${content}`)
        break
      }
      case 'tool_use_summary': {
        lines.push(`[Tool Summary] ${record.summary}`)
        break
      }
      // Skip: subagent_transcript, subagent_task, compact_boundary,
      // tool_approval, at_mention_context, plan_mode_*, turn_interruption
    }
  }

  return lines.join('\n')
}

/**
 * Truncate session memory content to fit within the configured token budget.
 * Returns the truncated content and whether truncation occurred.
 */
export function truncateSessionMemory(
  content: string,
  maxTokens: number,
): { truncatedContent: string; wasTruncated: boolean } {
  const tokens = countTextTokens(content)
  if (tokens <= maxTokens) {
    return { truncatedContent: content, wasTruncated: false }
  }

  // Rough truncation: proportionally cut based on token ratio
  const ratio = maxTokens / tokens
  const targetChars = Math.floor(content.length * ratio * 0.9) // 10% safety margin
  const truncated = content.slice(0, targetChars)

  // Try to cut at a paragraph boundary
  const lastNewline = truncated.lastIndexOf('\n\n')
  const cutPoint = lastNewline > targetChars * 0.5 ? lastNewline : targetChars

  return {
    truncatedContent: `${content.slice(0, cutPoint)}\n\n[... truncated for length ...]`,
    wasTruncated: true,
  }
}

/**
 * Default session memory template — used to detect "empty" memories that
 * have not been populated by a real extraction. Matches Claude Code's
 * approach of comparing against a known template rather than using a
 * length threshold that can误判 short but valid memories.
 */
const DEFAULT_SESSION_MEMORY_TEMPLATE = `# Session Title
_A short and distinctive title for this session._

# Current State
_What is actively being worked on right now?_

# Key Decisions
_Decisions made and their rationale._

# File Paths
_Important file paths and locations._

# Constraints
_User preferences and constraints._

# Open Tasks
_Unresolved tasks and open questions._

# Error Patterns
_Known error patterns and fixes applied._
`

/**
 * Check if session memory content is empty or just a template.
 * Returns true if the content has no meaningful extraction.
 *
 * Uses template matching (like Claude Code) rather than a raw length
 * threshold to avoid误判 short but valid memories.
 */
export function isSessionMemoryEmpty(content: string | undefined): boolean {
  if (!content) return true
  const trimmed = content.trim()
  if (trimmed.length === 0) return true
  // Compare against template — if content matches exactly, no real extraction
  if (trimmed === DEFAULT_SESSION_MEMORY_TEMPLATE.trim()) return true
  // Fallback: extremely short content that cannot be a meaningful extraction
  if (trimmed.length < 20) return true
  return false
}
