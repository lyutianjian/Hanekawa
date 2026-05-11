import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
export const writeFileTool = {
    name: 'writeFile',
    description: 'Write a UTF-8 text file. Existing-file overwrites require confirmation from the harness.',
    inputSchema: {
        type: 'object',
        properties: {
            filePath: { type: 'string' },
            content: { type: 'string' },
        },
        required: ['filePath', 'content'],
        additionalProperties: false,
    },
    riskLevel: 'confirm',
    async execute(input, context) {
        const { filePath, content } = input;
        const absolute = path.resolve(context.cwd, filePath);
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, content, 'utf8');
        return { ok: true, content: `Wrote ${filePath}` };
    },
};
