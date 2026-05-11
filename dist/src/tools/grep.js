import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
export const grepTool = {
    name: 'grep',
    description: 'Search text files for a regular expression pattern.',
    inputSchema: {
        type: 'object',
        properties: {
            pattern: { type: 'string' },
            path: { type: 'string' },
            glob: { type: 'string' },
            caseInsensitive: { type: 'boolean' },
            headLimit: { type: 'number' },
        },
        required: ['pattern'],
        additionalProperties: false,
    },
    riskLevel: 'safe',
    async execute(input, context) {
        const options = input;
        const root = path.resolve(context.cwd, options.path ?? '.');
        const entries = await fg(options.glob ?? '**/*', { cwd: root, onlyFiles: true, dot: false });
        const flags = options.caseInsensitive ? 'i' : '';
        const regex = new RegExp(options.pattern, flags);
        const limit = options.headLimit ?? 50;
        const matches = [];
        for (const entry of entries) {
            if (matches.length >= limit)
                break;
            const filePath = path.join(root, entry);
            let raw;
            try {
                raw = await readFile(filePath, 'utf8');
            }
            catch {
                continue;
            }
            const lines = raw.split('\n');
            for (const [index, line] of lines.entries()) {
                regex.lastIndex = 0;
                if (matches.length < limit && regex.test(line)) {
                    matches.push(`${path.relative(context.cwd, filePath)}:${index + 1}: ${line}`);
                }
            }
        }
        return { ok: true, content: matches.join('\n') || 'No matches found.' };
    },
};
