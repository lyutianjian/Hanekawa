export const RESOLVE_THREAD_TOOL_NAME = 'ResolveThread'

export const DESCRIPTION = `Mark a thread resolved once its work is done and checked.\n\nParameters:\n- \`threadId\` — the thread to close.\n- \`note\` — optional one-line outcome for the record.\n\nA resolved thread leaves the active list; messaging it later reopens it. It does not merge a branch or stop a running turn (use StopThread first).`
