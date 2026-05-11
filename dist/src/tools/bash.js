import { exec } from 'node:child_process';
import { promisify } from 'node:util';
const execAsync = promisify(exec);
export const bashTool = {
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
        const options = input;
        const timeout = options.timeout ?? 30_000;
        try {
            const { stdout, stderr } = await execAsync(options.command, {
                cwd: context.cwd,
                timeout,
            });
            const output = [stdout, stderr].filter(Boolean).join('\n');
            return { ok: true, content: output || '(no output)' };
        }
        catch (err) {
            const error = err;
            const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
            return { ok: false, content: output || 'Command failed.' };
        }
    },
};
