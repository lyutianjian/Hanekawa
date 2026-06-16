/**
 * Session memory service — storage, extraction, and lifecycle management.
 *
 * Session memory is stored as a JSON file per session under
 * `.myagent/session-memory/<sessionId>.json`. The extraction runs
 * asynchronously after each assistant response and produces a structured
 * summary of key conversation facts.
 */

import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionRecord, ModelProvider, TokenUsage } from '../../harness/types.js'
import { EMPTY_TOKEN_USAGE } from '../../harness/usage.js'
import { countTextTokens } from '../../prompts/budget.js'
import type { SessionMemoryState, SessionMemoryConfig, ExtractionResult } from './types.js'
import { DEFAULT_SESSION_MEMORY_CONFIG } from './types.js'
import {
  buildExtractionPrompt,
  EXTRACTION_SYSTEM_PROMPT,
  formatRecordsForExtraction,
  truncateSessionMemory,
  isSessionMemoryEmpty,
} from './prompts.js'

// --- Per-session state (isolated by sessionId) ---

interface PerSessionState {
  extractionInProgress: Promise<ExtractionResult | null> | null
  lastSummarizedRecordId: string | undefined
  initialized: boolean
}

const sessionStates = new Map<string, PerSessionState>()

function getOrCreateSessionState(sessionId: string): PerSessionState {
  let state = sessionStates.get(sessionId)
  if (!state) {
    state = {
      extractionInProgress: null,
      lastSummarizedRecordId: undefined,
      initialized: false,
    }
    sessionStates.set(sessionId, state)
  }
  return state
}

// --- Storage ---

function getMyAgentDir(): string {
  return path.join(process.cwd(), '.myagent')
}

function getMemoryDir(): string {
  return path.join(getMyAgentDir(), 'session-memory')
}

function getMemoryPath(sessionId: string): string {
  return path.join(getMemoryDir(), `${sessionId}.json`)
}

/** Atomic write: write to temp file, then rename. */
async function writeAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath)
  await mkdir(dir, { recursive: true })
  const tmpPath = `${filePath}.tmp.${randomUUID()}`
  await writeFile(tmpPath, content, 'utf-8')
  await rename(tmpPath, filePath)
}

/** Read session memory state from disk. Returns undefined if not found. */
export async function getSessionMemory(sessionId: string): Promise<SessionMemoryState | undefined> {
  const filePath = getMemoryPath(sessionId)
  if (!existsSync(filePath)) return undefined
  try {
    const content = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(content) as SessionMemoryState
    if (!parsed.content || !parsed.lastSummarizedRecordId) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** Write session memory state to disk. */
export async function setSessionMemory(
  sessionId: string,
  state: SessionMemoryState,
): Promise<void> {
  const filePath = getMemoryPath(sessionId)
  await writeAtomic(filePath, JSON.stringify(state, null, 2))
}

/** Delete session memory file. */
export async function clearSessionMemory(sessionId: string): Promise<void> {
  const filePath = getMemoryPath(sessionId)
  try {
    await unlink(filePath)
  } catch {
    // Ignore if not found
  }
}

// --- State management ---

/** Reset module-level state for a specific session (for testing). */
export function resetSessionMemoryState(sessionId?: string): void {
  if (sessionId) {
    sessionStates.delete(sessionId)
  } else {
    sessionStates.clear()
  }
}

/** Get the last summarized record ID for a specific session. */
export function getLastSummarizedRecordId(sessionId: string): string | undefined {
  return getOrCreateSessionState(sessionId).lastSummarizedRecordId
}

/** Set the last summarized record ID for a specific session. */
export function setLastSummarizedRecordId(sessionId: string, id: string | undefined): void {
  getOrCreateSessionState(sessionId).lastSummarizedRecordId = id
}

/** Check if session memory is empty or not available. */
export async function isSessionMemoryAvailable(sessionId: string): Promise<boolean> {
  const memory = await getSessionMemory(sessionId)
  return memory !== undefined && !isSessionMemoryEmpty(memory.content)
}

// --- Extraction ---

export interface ExtractSessionMemoryParams {
  provider: ModelProvider
  model: string
  compactRuntime?: { provider: ModelProvider; model: string }
  records: SessionRecord[]
  system?: string
  sessionId: string
  config?: Partial<SessionMemoryConfig>
}

/**
 * Run a single extraction call. Called by maybeExtractSessionMemory.
 * This is the actual LLM call — it should NOT be called directly.
 */
export async function extractSessionMemory(
  params: ExtractSessionMemoryParams,
  existingMemory: string | undefined,
  newRecords: SessionRecord[],
): Promise<ExtractionResult> {
  const config = { ...DEFAULT_SESSION_MEMORY_CONFIG, ...params.config }

  const recordsText = formatRecordsForExtraction(newRecords)
  const prompt = buildExtractionPrompt(existingMemory, recordsText, newRecords.length)

  // Use compact model if available (cheaper), otherwise main model
  const provider = params.compactRuntime?.provider ?? params.provider
  const model = params.compactRuntime?.model ?? params.model

  const response = await provider.createMessage({
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
    model,
    thinking: { type: 'disabled' },
    maxOutputTokens: config.maxMemoryTokens,
    cacheSource: 'compact',
  } as Parameters<ModelProvider['createMessage']>[0])

  let content = response.content.trim()
  if (!content) {
    content = '(No session memory was produced.)'
  }

  // Truncate if oversized
  const { truncatedContent } = truncateSessionMemory(content, config.maxMemoryTokens)

  return {
    content: truncatedContent,
    usage: response.usage ?? { ...EMPTY_TOKEN_USAGE },
    recordCount: newRecords.length,
  }
}

/**
 * Maybe trigger session memory extraction. Called after each assistant response.
 *
 * Guards:
 * - Feature must be enabled
 * - No extraction already in progress
 * - Enough new records since last extraction
 *
 * Runs asynchronously — does not block the caller.
 */
export function maybeExtractSessionMemory(params: ExtractSessionMemoryParams): void {
  const config = { ...DEFAULT_SESSION_MEMORY_CONFIG, ...params.config }
  if (!config.enabled) return

  const state = getOrCreateSessionState(params.sessionId)

  // Initialize session state: load last summarized ID from persisted memory.
  // Uses a synchronous guard so the async load doesn't race with later code.
  if (!state.initialized) {
    state.initialized = true
    // Fire-and-forget load — next invocation will see initialized=true and skip.
    // If this load completes before the extraction below, great; if not, the
    // extraction will start from index 0 (safe, just slightly redundant).
    getSessionMemory(params.sessionId).then((memory) => {
      if (memory) {
        state.lastSummarizedRecordId = memory.lastSummarizedRecordId
      }
    }).catch(() => {
      // Best-effort load
    })
  }

  // Don't start a new extraction if one is already running
  if (state.extractionInProgress) return

  // Find records since last extraction
  const afterIndex = state.lastSummarizedRecordId
    ? params.records.findIndex((r) => r.id === state.lastSummarizedRecordId)
    : -1
  const startIndex = afterIndex >= 0 ? afterIndex + 1 : 0
  const newRecords = params.records.slice(startIndex)

  // Skip if not enough new records
  if (newRecords.length < config.minRecordsForExtraction) return

  // Fire-and-forget extraction
  state.extractionInProgress = (async () => {
    try {
      const existing = await getSessionMemory(params.sessionId)
      const result = await extractSessionMemory(
        params,
        existing?.content,
        newRecords,
      )

      // Update persisted state
      const lastRecord = newRecords[newRecords.length - 1]
      if (lastRecord) {
        const memoryState: SessionMemoryState = {
          content: result.content,
          lastSummarizedRecordId: lastRecord.id,
          lastExtractedAt: new Date().toISOString(),
          tokenCount: countTextTokens(result.content),
        }
        await setSessionMemory(params.sessionId, memoryState)
        state.lastSummarizedRecordId = lastRecord.id
      }

      return result
    } catch {
      // Extraction is best-effort — errors are silently caught
      return null
    } finally {
      state.extractionInProgress = null
    }
  })()
}

/**
 * Wait for any in-progress extraction to complete for a specific session.
 * Returns the extraction result, or null if none was running or timeout exceeded.
 */
export async function waitForExtraction(sessionId: string, timeoutMs = 5_000): Promise<ExtractionResult | null> {
  const state = getOrCreateSessionState(sessionId)
  if (!state.extractionInProgress) return null
  try {
    const result = await Promise.race([
      state.extractionInProgress,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ])
    return result
  } catch {
    return null
  }
}
