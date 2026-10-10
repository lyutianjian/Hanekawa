export const RESOLVE_THREAD_TOOL_NAME = 'ResolveThread'

export const DESCRIPTION = `Mark a thread resolved once its work is done and checked.\n\nParameters:\n- \`threadId\` — the thread to close.\n- \`note\` — optional one-line outcome for the record.\n\nResolving is final: the thread stops if it is still running and takes no more messages from you or the user. It does not merge a branch.`
