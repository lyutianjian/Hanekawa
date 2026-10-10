export const STOP_THREAD_TOOL_NAME = 'StopThread'

export const DESCRIPTION = `Stop a thread: interrupt its running turn and discard messages still queued for it.\n\nParameters:\n- \`threadId\` — the thread to stop.\n\nThe thread keeps its history and branch and can be messaged again later. Use ResolveThread instead to close a thread whose work is done.`
