import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
export async function readJsonFile(filePath, fallback) {
    try {
        const raw = await readFile(filePath, 'utf8');
        return JSON.parse(raw);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return fallback;
        throw error;
    }
}
export async function writeJsonFile(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
