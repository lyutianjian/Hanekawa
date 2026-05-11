import fg from 'fast-glob';
export const globTool = {
    name: 'glob',
    description: 'Find files matching a glob pattern.',
    inputSchema: {
        type: 'object',
        properties: {
            pattern: { type: 'string' },
            path: { type: 'string' },
        },
        required: ['pattern'],
        additionalProperties: false,
    },
    riskLevel: 'safe',
    async execute(input, context) {
        const options = input;
        const cwd = options.path ?? context.cwd;
        const entries = await fg(options.pattern, { cwd, dot: false });
        return { ok: true, content: entries.join('\n') || 'No files found.' };
    },
};
