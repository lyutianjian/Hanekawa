export const MESSAGE_THREAD_TOOL_NAME = 'MessageThread'

export const DESCRIPTION = `Send a message to a thread. A running thread picks it up at its next step, an idle one starts a turn with it, and one that is not loaded is opened first.\n\nParameters:\n- \`threadId\` — the thread from StartThread or ListThreads.\n- \`text\` — the message, written as a self-contained instruction.\n\nUse it for corrections and follow-ups that belong to the thread's goal; start a new thread for a new goal. It does not wait for a reply. A resolved or stale thread cannot be messaged.`
