import { readFile } from 'node:fs/promises'
import path from 'node:path'
import fg from 'fast-glob'
import { z } from 'zod/v3'
import type { Tool } from '../harness/types.js'
import { assertInsideCwd } from '../utils/paths.js'

interface GrepInput {
  pattern: string
  path?: string
  glob?: string
  caseInsensitive?: boolean
  headLimit?: number
}

export const grepTool: Tool = {
  name: 'Grep',
  description: 'Search text files for a regular expression pattern.',
  inputSchema: z.object({
    pattern: z.string().min(1),
    path: z.string().min(1).optional(),
    glob: z.string().min(1).optional(),
    caseInsensitive: z.boolean().optional(),
    headLimit: z.number().int().min(1).max(10_000).optional(),
  }).strict(),
  riskLevel: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultSizeChars: 30_000,
  async execute(input, context) {
    const options = input as GrepInput
    const root = assertInsideCwd(context.cwd, options.path ?? '.')
    const entries = await fg(options.glob ?? '**/*', { cwd: root, onlyFiles: true, dot: false })
    const flags = options.caseInsensitive ? 'i' : ''
    const regex = new RegExp(options.pattern, flags)
    const limit = options.headLimit ?? 50
    const matches: string[] = []

    for (const entry of entries) {
      if (matches.length >= limit) break
      const filePath = path.join(root, entry)
      let raw: string
      try {
        raw = await readFile(filePath, 'utf8')
      } catch {
        continue
      }
      const lines = raw.split('\n')
      for (const [index, line] of lines.entries()) {
        regex.lastIndex = 0
        if (matches.length < limit && regex.test(line)) {
          matches.push(`${path.relative(context.cwd, filePath)}:${index + 1}: ${line}`)
        }
      }
    }

    return { ok: true, content: matches.join('\n') || 'No matches found.' }
  },
}
