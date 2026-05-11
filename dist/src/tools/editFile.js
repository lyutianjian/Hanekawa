import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
export const editFileTool = {
    name: 'editFile',
    description: 'Replace an exact string in an existing UTF-8 text file.',
    inputSchema: {
        type: 'object',
        properties: {
            filePath: { type: 'string' },
            oldString: { type: 'string' },
            newString: { type: 'string' },
        },
        required: ['filePath', 'oldString', 'newString'],
        additionalProperties: false,
    },
    riskLevel: 'confirm',
    async execute(input, context) {
        const { filePath, oldString, newString } = input;
        const absolute = path.resolve(context.cwd, filePath);
        if (!context.readFiles.has(absolute)) {
            return { ok: false, content: `Refusing to edit ${filePath}: file must be read first.` };
        }
        const original = await readFile(absolute, 'utf8');
        const occurrences = original.split(oldString).length - 1;
        if (occurrences !== 1) {
            return { ok: false, content: `Expected exactly one match for oldString, found ${occurrences}.` };
        }
        await writeFile(absolute, original.replace(oldString, newString), 'utf8');
        return { ok: true, content: `Edited ${filePath}` };
    },
};
