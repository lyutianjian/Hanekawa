import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import {
  AGENT_MAX_RESULT_SIZE_CHARS,
  BUILT_IN_AGENT_DEFINITIONS,
  DEFAULT_AGENT_MAX_TURNS,
  NESTED_AGENT_FORBIDDEN_TOOLS,
  infersReadOnlyAgentFromTools,
  type BaseAgentDefinition,
} from '../../tools/agentTool.js'
import { getAgentsDir, getLocalAgentsDir } from '../../utils/paths.js'

interface AgentFrontmatter {
  name?: unknown
  description?: unknown
  tools?: unknown
  isReadOnlyAgent?: unknown
  omitProjectContext?: unknown
  maxTurns?: unknown
  maxResultSizeChars?: unknown
}

const CUSTOM_AGENT_PROMPT_WARN_CHARS = 16_000
const BUILT_IN_AGENT_TYPES = new Set(BUILT_IN_AGENT_DEFINITIONS.map((definition) => definition.type))

export class AgentDefinitionLoader {
  constructor(
    private readonly cwd: string,
    private readonly homeDir = homedir(),
  ) {}

  async list(): Promise<BaseAgentDefinition[]> {
    const definitions = new Map<string, BaseAgentDefinition>()
    for (const dir of this.agentDirs()) {
      for (const definition of await this.loadDir(dir)) {
        definitions.set(definition.type, definition)
      }
    }
    return [...definitions.values()]
  }

  private agentDirs(): string[] {
    return [
      path.join(this.homeDir, '.myagent', 'agents'),
      getAgentsDir(this.cwd),
      getLocalAgentsDir(this.cwd),
    ]
  }

  private async loadDir(dir: string): Promise<BaseAgentDefinition[]> {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    const definitions: BaseAgentDefinition[] = []
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.md')) continue
      const filePath = path.join(dir, entry)
      try {
        definitions.push(this.parse(await readFile(filePath, 'utf8')))
      } catch (error) {
        console.warn(`Failed to load agent definition from ${entry}:`, (error as Error).message)
      }
    }
    return definitions
  }

  private parse(raw: string): BaseAgentDefinition {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) {
      throw new Error('Agent file must include YAML frontmatter (---\\n...\\n---)')
    }

    const frontmatter = YAML.parse(match[1]) as AgentFrontmatter
    if (typeof frontmatter.name !== 'string' || frontmatter.name.trim() === '') {
      throw new Error('Agent frontmatter must include non-empty string "name" field')
    }
    if (typeof frontmatter.description !== 'string' || frontmatter.description.trim() === '') {
      throw new Error('Agent frontmatter must include non-empty string "description" field')
    }

    const tools = parseTools(frontmatter.tools)
    const maxTurns = parsePositiveInt(frontmatter.maxTurns, DEFAULT_AGENT_MAX_TURNS, 'maxTurns')
    const maxResultSizeChars = parsePositiveInt(
      frontmatter.maxResultSizeChars,
      AGENT_MAX_RESULT_SIZE_CHARS,
      'maxResultSizeChars',
    )
    const omitProjectContext = parseBoolean(frontmatter.omitProjectContext, false, 'omitProjectContext')
    const explicitReadOnlyAgent = parseOptionalBoolean(frontmatter.isReadOnlyAgent, 'isReadOnlyAgent')
    const content = match[2].trim()
    const inferredReadOnlyAgent = infersReadOnlyAgentFromTools(tools)

    if (BUILT_IN_AGENT_TYPES.has(frontmatter.name)) {
      console.warn(`Custom agent '${frontmatter.name}' overrides built-in definition`)
    }
    if (explicitReadOnlyAgent === true && !inferredReadOnlyAgent) {
      console.warn(`Custom agent '${frontmatter.name}' declares isReadOnlyAgent: true but lists write-like tools; treating it as non-read-only`)
    }
    if (content.length > CUSTOM_AGENT_PROMPT_WARN_CHARS) {
      console.warn(`Custom agent '${frontmatter.name}' system prompt is ${content.length} chars, above the recommended ${CUSTOM_AGENT_PROMPT_WARN_CHARS} char soft limit`)
    }

    return {
      type: frontmatter.name,
      description: frontmatter.description,
      ...(tools ? { tools } : {}),
      disallowedTools: NESTED_AGENT_FORBIDDEN_TOOLS,
      maxTurns,
      maxResultSizeChars,
      isReadOnlyAgent: explicitReadOnlyAgent === false ? false : inferredReadOnlyAgent,
      omitProjectContext,
      getSystemPrompt: () => content,
    }
  }
}

function parseTools(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    throw new Error('Agent frontmatter "tools" must be an array of non-empty strings')
  }
  const tools = value.map((item) => item.trim())
  if (tools.includes('*')) {
    if (tools.length !== 1) {
      throw new Error('Agent frontmatter "tools" may use "*" only by itself')
    }
    return undefined
  }
  return tools
}

function parsePositiveInt(value: unknown, defaultValue: number, field: string): number {
  if (value === undefined) return defaultValue
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`Agent frontmatter "${field}" must be a positive integer`)
  }
  return value
}

function parseBoolean(value: unknown, defaultValue: boolean, field: string): boolean {
  if (value === undefined) return defaultValue
  if (typeof value !== 'boolean') {
    throw new Error(`Agent frontmatter "${field}" must be a boolean`)
  }
  return value
}

function parseOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new Error(`Agent frontmatter "${field}" must be a boolean`)
  }
  return value
}
