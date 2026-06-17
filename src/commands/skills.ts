import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import type { CommandDefinition, CommandShellResult } from './types.js'
import { hasCommand, registerCommand } from './registry.js'
import { SkillsService, type SkillDefinition } from '../services/skills/skillsService.js'

const ARGUMENTS_PLACEHOLDER = '$ARGUMENTS'
const RESERVED_SKILL_COMMAND_NAMES = new Set(['exit'])
const INLINE_SHELL_PATTERN = /!`([^`]+)`/g
const MAX_SKILL_ATTACHMENT_BYTES = 200_000

export const skillsCommand: CommandDefinition = {
  name: 'skills',
  description: 'List available skills',
  run: async (_args, context) => {
    const skills = await new SkillsService(context.cwd).list()
    if (skills.length === 0) {
      context.writeLine('No skills available.')
      return
    }

    const lines = [`Available skills (${skills.length}):`, '']
    for (const skill of skills) {
      lines.push(`  /${skill.name} - ${skill.description}`)
    }
    lines.push('', 'Invoke a skill with /<name> when its name is not shadowed by a built-in command.')
    context.writeLine(lines.join('\n'))
  },
}

export function buildSkillPrompt(content: string, args: string): string {
  const trimmedArgs = args.trim()
  if (content.includes(ARGUMENTS_PLACEHOLDER)) {
    return content.replaceAll(ARGUMENTS_PLACEHOLDER, trimmedArgs)
  }
  if (trimmedArgs.length === 0) return content
  return `${content}\n\nArguments: ${trimmedArgs}`
}

export async function buildSkillCommandPrompt(
  skill: SkillDefinition,
  args: string,
  options: {
    runShellCommand?: (command: string) => Promise<CommandShellResult>
  } = {},
): Promise<string> {
  const expanded = await expandInlineShell(skill.content, options.runShellCommand)
  const prompt = buildSkillPrompt(expanded, args)
  return appendSkillAttachments(prompt, skill)
}

export async function expandInlineShell(
  content: string,
  runShellCommand?: (command: string) => Promise<CommandShellResult>,
): Promise<string> {
  const matches = [...content.matchAll(INLINE_SHELL_PATTERN)]
  if (matches.length === 0) return content
  if (!runShellCommand) {
    throw new Error('Skill prompt uses inline shell, but shell execution is not available in this command context.')
  }

  let expanded = content
  for (const match of matches) {
    const raw = match[0]
    const command = match[1]?.trim()
    if (!command) continue
    const result = await runShellCommand(command)
    if (!result.ok) {
      throw new Error(`Inline shell command failed: ${command}\n${result.content}`)
    }
    expanded = expanded.replace(raw, result.content.trimEnd())
  }
  return expanded
}

export async function appendSkillAttachments(prompt: string, skill: SkillDefinition): Promise<string> {
  if (!skill.attachments || skill.attachments.length === 0) return prompt
  if (!skill.skillDir) {
    throw new Error(`Skill attachments require a disk-backed skill directory: ${skill.name}`)
  }

  const blocks: string[] = []
  for (const attachment of skill.attachments) {
    const resolved = resolveSkillAttachmentPath(skill.skillDir, attachment)
    const info = await stat(resolved).catch((error: unknown) => {
      throw new Error(`Skill attachment not found: ${attachment} (${error instanceof Error ? error.message : String(error)})`)
    })
    if (!info.isFile()) {
      throw new Error(`Skill attachment is not a file: ${attachment}`)
    }
    if (info.size > MAX_SKILL_ATTACHMENT_BYTES) {
      throw new Error(`Skill attachment is too large: ${attachment} (${info.size} bytes, max ${MAX_SKILL_ATTACHMENT_BYTES})`)
    }
    const buffer = await readFile(resolved)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      throw new Error(`Skill attachment must be valid UTF-8 text: ${attachment}`)
    }
    blocks.push(`<attachment path="${escapeAttribute(normalizeAttachmentPath(attachment))}">\n${text}\n</attachment>`)
  }

  return [
    prompt,
    '<skill-attachments>',
    ...blocks,
    '</skill-attachments>',
  ].join('\n\n')
}

export async function registerSkillCommands(cwd: string): Promise<{ registered: number; skipped: string[] }> {
  const skills = await new SkillsService(cwd).list()
  const skipped: string[] = []
  let registered = 0

  for (const skill of skills) {
    if (RESERVED_SKILL_COMMAND_NAMES.has(skill.name) || hasCommand(skill.name)) {
      skipped.push(skill.name)
      console.warn(`Skipping skill slash command /${skill.name}: command name is already in use.`)
      continue
    }

    registerCommand(createSkillCommand(cwd, skill.name, skill.description))
    registered += 1
  }

  return { registered, skipped }
}

function createSkillCommand(cwd: string, skillName: string, description: string): CommandDefinition {
  return {
    name: skillName,
    description,
    argumentHint: '[arguments]',
    run: async (args, context) => {
      if (!context.submitQuery) {
        throw new Error(`Skill command /${skillName} requires query submission support.`)
      }
      const skill = await new SkillsService(cwd).load(skillName)
      const prompt = await buildSkillCommandPrompt(skill, args, {
        runShellCommand: context.runShellCommand,
      })
      await context.submitQuery(prompt, {
        ...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}),
        ...(skill.model ? { model: skill.model } : {}),
        ...(skill.effort ? { effort: skill.effort } : {}),
        ...(skill.hooks ? { hooks: skill.hooks } : {}),
        skillName: skill.name,
        skillArgs: args.trim(),
        displayInput: formatSkillDisplayInput(skill.name, args),
      })
    },
  }
}

function formatSkillDisplayInput(skillName: string, args: string): string {
  const trimmedArgs = args.trim()
  return trimmedArgs.length > 0 ? `/${skillName} ${trimmedArgs}` : `/${skillName}`
}

function resolveSkillAttachmentPath(skillDir: string, attachment: string): string {
  const resolved = path.resolve(skillDir, attachment)
  const root = path.resolve(skillDir)
  const relative = path.relative(root, resolved)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Skill attachment must stay inside the skill directory: ${attachment}`)
  }
  return resolved
}

function normalizeAttachmentPath(value: string): string {
  return value.trim().replace(/\\/g, '/')
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
