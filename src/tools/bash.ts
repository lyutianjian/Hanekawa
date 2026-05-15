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

      const MAX_OUTPUT_BYTES = 1_000_000
      let stdout = ''
      let stderr = ''
      let truncated = false

      proc.stdout.on('data', (data: Buffer) => {
        if (stdout.length < MAX_OUTPUT_BYTES) {
          stdout += data.toString()
          if (stdout.length > MAX_OUTPUT_BYTES) {
            stdout = stdout.slice(0, MAX_OUTPUT_BYTES)
            truncated = true
          }
        }
      })

      proc.stderr.on('data', (data: Buffer) => {
        if (stderr.length < MAX_OUTPUT_BYTES) {
          stderr += data.toString()
          if (stderr.length > MAX_OUTPUT_BYTES) {
            stderr = stderr.slice(0, MAX_OUTPUT_BYTES)
            truncated = true
          }
        }
      })

      proc.on('close', (code: number | null) => {
        const output = [stdout, stderr].filter(Boolean).join('\n')
        const suffix = truncated ? '\n\n[Output truncated: exceeded 1MB limit]' : ''
        resolve({
          ok: code === 0,
          content: (output || '(no output)') + suffix,
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
