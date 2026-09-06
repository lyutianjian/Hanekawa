import type { BaseAgentDefinition } from './AgentTool.js'

/**
 * The `Agent` tool's description. The available `subagent_type` values are
 * interpolated because they come from the user's own agent definitions, and a
 * type the model invents is the most common way this call fails.
 */
export function buildAgentToolDescription(definitions: readonly BaseAgentDefinition[]): string {
  const typeDescriptions = definitions
    .map((definition) => `"${definition.type}" (${[definition.description, formatDefinitionCapabilities(definition)].filter(Boolean).join('; ')})`)
    .join(', ')
  return `Run a typed sub-agent on an isolated task. Use for complex, multi-step research or planning whose intermediate output does not need to stay in main context. Sub-agents cannot spawn nested agents.

Usage:
- Parameters are \`task\` and \`subagent_type\` (both required), plus the optional \`description\`, \`name\`, \`run_in_background\`, \`systemPrompt\`, \`maxTurns\`, \`maxOutputTokens\`. Any other key is rejected.
- \`subagent_type\` must be one of: ${typeDescriptions}. Always pass it explicitly; an invented type is an error, not a fallback.
- \`task\` is the whole brief. The agent starts cold, so explain the goal, why it matters, what you already know, what you ruled out, and the shape of the answer you need.
- Set \`run_in_background: true\` for independent work; you are notified when it finishes, so do not poll for it.
- Continue an existing agent with SendMessage rather than starting a second one on the same subject.
- Do NOT use when you know the exact file to inspect (use Read), when you are searching a known area (use Grep or Glob), or when the task touches one small set of files.
- Never delegate understanding: the agent's report is not shown to the user, so synthesize the result yourself and relay what matters.`
}

function formatDefinitionCapabilities(definition: BaseAgentDefinition): string | undefined {
  const parts: string[] = []
  if (definition.model) parts.push(`model: ${definition.model}`)
  if (definition.background) parts.push('background')
  if (definition.isolation) parts.push(`isolation: ${definition.isolation}`)
  if (definition.permissionMode) parts.push(`permission: ${definition.permissionMode}`)
  if (definition.skills && definition.skills.length > 0) parts.push(`skills: ${definition.skills.join(', ')}`)
  if (definition.mcpServers && definition.mcpServers.length > 0) parts.push(`MCP: ${definition.mcpServers.join(', ')}`)
  return parts.length > 0 ? parts.join('; ') : undefined
}
