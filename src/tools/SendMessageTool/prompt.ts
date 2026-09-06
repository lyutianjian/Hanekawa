export const SEND_MESSAGE_TOOL_NAME = 'SendMessage'

export const DESCRIPTION = `Send a follow-up message to a sub-agent in this session.

Usage:
- Parameters are snake_case: \`agent_id\` and \`message\`, both required. Any other key is rejected.
- \`agent_id\` is the id or name reported when the Agent tool started the sub-agent. Only sub-agents of this session are addressable.
- A running agent receives the message in its queue and answers on its own schedule. A finished agent resumes with its prior context and returns the new answer directly.
- Use this to continue an existing agent rather than starting a fresh one, which would re-derive everything from scratch.`
