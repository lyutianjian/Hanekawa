import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfigPath, getMyAgentDir } from '../src/utils/paths.js';
import { readJsonFile, writeJsonFile } from '../src/utils/json.js';
test('path helpers resolve .myagent paths under cwd', () => {
    const cwd = path.join('tmp', 'project');
    assert.equal(getMyAgentDir(cwd), path.join(cwd, '.myagent'));
    assert.equal(getConfigPath(cwd), path.join(cwd, '.myagent', 'config.json'));
});
test('json helpers read fallback and write formatted json', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-json-'));
    try {
        const file = path.join(dir, 'nested', 'config.json');
        assert.deepEqual(await readJsonFile(file, { ok: false }), { ok: false });
        await writeJsonFile(file, { ok: true });
        assert.deepEqual(await readJsonFile(file, { ok: false }), { ok: true });
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
