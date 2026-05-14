import { spawn } from 'node:child_process'
import type { Tool } from '../harness/types.js'

interface BashInput {
  command: string
  timeout?: number
}

export const bashTool: Tool = {
  name: 'bash',
  description: 'Execute a shell command and return its output.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout: { type: 'number' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  riskLevel: 'dangerous',
  async execute(input, context) {
    const options = input as BashInput
    const timeout = options.timeout ?? 30_000

    return new Promise((resolve) => {
      const shell = process.platform === 'win32' ? 'powershell' : 'bash'
      const shellArgs = process.platform === 'win32' ? ['-Command', options.command] : ['-c', options.command]

      const proc = spawn(shell, shellArgs, {
        cwd: context.cwd,
        signal: context.abortSignal,
        timeout,
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code: number | null) => {
        const output = [stdout, stderr].filter(Boolean).join('\n')
        resolve({
          ok: code === 0,
          content: output || '(no output)',
        })
      })

      proc.on('error', (err: Error) => {
        if (err.name === 'AbortError') {
          resolve({ ok: false, content: 'Operation cancelled by user' })
        } else {
          const output = [stdout, stderr, err.message].filter(Boolean).join('\n')
          resolve({ ok: false, content: output || 'Command failed.' })
        }
      })
    })
  },
}
