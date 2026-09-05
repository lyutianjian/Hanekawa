/**
 * Client-side tolerance for the parameter names and scalar types the model
 * actually emits.
 *
 * Hanekawa's schemas are camelCase (`filePath`, `oldString`, `headLimit`) and
 * `.strict()`. The model's prior is Claude Code's wire format (`file_path`,
 * `old_string`, `-i`, `head_limit`), so a call shaped by that prior is rejected
 * outright and the whole turn is spent on a name. Normalizing here costs one
 * pass over a small object and turns those rejections into successful calls.
 *
 * This layer is deliberately NOT advertised: `toolApiSchema.ts` still publishes
 * the camelCase schema, so the model is told one shape and quietly forgiven for
 * the other. Known-but-unsupported keys are dropped rather than rejected — a
 * `Grep` that ignores `output_mode` still answers the question.
 */

interface AliasSpec {
  /** alias -> canonical key */
  rename?: Record<string, string>
  /** keys the model knows from elsewhere that this tool cannot honour */
  drop?: string[]
  /** canonical keys coerced from numeric strings */
  numbers?: string[]
  /** canonical keys coerced from "true"/"false" */
  booleans?: string[]
  /** array-valued key whose items get their own spec */
  nested?: { key: string; spec: AliasSpec }
}

const FILE_PATH_ALIASES = { file_path: 'filePath', filepath: 'filePath', path: 'filePath' }
const EDIT_STRING_ALIASES = {
  old_string: 'oldString',
  new_string: 'newString',
  replace_all: 'replaceAll',
}

const EDIT_ITEM_SPEC: AliasSpec = {
  rename: EDIT_STRING_ALIASES,
  booleans: ['replaceAll'],
}

const SPECS: Record<string, AliasSpec> = {
  Read: {
    rename: { ...FILE_PATH_ALIASES },
    drop: ['pages'],
    numbers: ['offset', 'limit'],
  },
  Edit: {
    rename: { ...FILE_PATH_ALIASES, ...EDIT_STRING_ALIASES },
    booleans: ['replaceAll'],
  },
  MultiEdit: {
    rename: { ...FILE_PATH_ALIASES },
    nested: { key: 'edits', spec: EDIT_ITEM_SPEC },
  },
  Write: {
    rename: { ...FILE_PATH_ALIASES },
  },
  Delete: {
    rename: { ...FILE_PATH_ALIASES },
  },
  // NotebookEdit is already snake_case; the aliases go the other way.
  NotebookEdit: {
    rename: {
      file_path: 'notebook_path',
      filePath: 'notebook_path',
      notebookPath: 'notebook_path',
      cellId: 'cell_id',
      newSource: 'new_source',
      cellType: 'cell_type',
      editMode: 'edit_mode',
    },
  },
  Grep: {
    rename: {
      '-i': 'caseInsensitive',
      case_insensitive: 'caseInsensitive',
      ignore_case: 'caseInsensitive',
      head_limit: 'headLimit',
      file_pattern: 'glob',
      include: 'glob',
    },
    // Ripgrep flags this tool does not model. Dropping beats rejecting: the
    // search still runs, just without the output-mode/context refinement.
    drop: ['output_mode', 'type', '-n', '-A', '-B', '-C', 'context'],
    numbers: ['headLimit', 'offset'],
    booleans: ['caseInsensitive', 'multiline'],
  },
  Glob: {
    rename: { file_pattern: 'pattern' },
  },
}

const NUMERIC_LITERAL = /^-?\d+(\.\d+)?$/

function coerceNumber(value: unknown): unknown {
  if (typeof value !== 'string' || !NUMERIC_LITERAL.test(value)) return value
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : value
}

function coerceBoolean(value: unknown): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  return value
}

function applySpec(input: Record<string, unknown>, spec: AliasSpec): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  const drop = new Set(spec.drop ?? [])

  for (const [key, value] of Object.entries(input)) {
    if (drop.has(key)) continue
    const canonical = spec.rename?.[key] ?? key
    // An explicit canonical key always wins over an alias for the same slot,
    // so `{filePath, file_path}` cannot silently take the alias.
    if (canonical !== key && Object.hasOwn(input, canonical)) continue
    next[canonical] = value
  }

  for (const key of spec.numbers ?? []) {
    if (key in next) next[key] = coerceNumber(next[key])
  }
  for (const key of spec.booleans ?? []) {
    if (key in next) next[key] = coerceBoolean(next[key])
  }

  const nested = spec.nested
  if (nested && Array.isArray(next[nested.key])) {
    next[nested.key] = (next[nested.key] as unknown[]).map((item) =>
      isPlainObject(item) ? applySpec(item, nested.spec) : item,
    )
  }

  return next
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Returns the canonical input for `toolName`, or the original reference when
 * nothing needed changing — callers compare by identity to skip a write.
 */
export function normalizeToolInput(toolName: string, input: unknown): unknown {
  const spec = SPECS[toolName]
  if (!spec || !isPlainObject(input)) return input
  const normalized = applySpec(input, spec)
  return sameShape(input, normalized) ? input : normalized
}

function sameShape(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  const beforeKeys = Object.keys(before)
  if (beforeKeys.length !== Object.keys(after).length) return false
  return beforeKeys.every((key) => Object.hasOwn(after, key) && Object.is(before[key], after[key]))
}

/** Exposed for tests: the tool names this layer knows how to normalize. */
export function aliasedToolNames(): string[] {
  return Object.keys(SPECS)
}
