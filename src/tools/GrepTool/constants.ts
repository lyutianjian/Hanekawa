export const RG_TIMEOUT_MS = 30_000
export const DEFAULT_HEAD_LIMIT = 250
/** Version control metadata is noise in every search anyone actually runs. */
export const VCS_EXCLUSIONS = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']
/** Keeps a minified or base64 line from swallowing the whole result budget. */
export const MAX_COLUMNS = 500
/** Upper bound on rows collected when `headLimit: 0` asks for "everything". */
export const UNLIMITED_FETCH_CAP = 10_000

export const OUTPUT_MODES = ['content', 'files_with_matches', 'count'] as const
export type OutputMode = (typeof OUTPUT_MODES)[number]
