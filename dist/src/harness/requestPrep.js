import { countSessionRecordTokens, getEffectiveContextWindowSize, } from '../prompts/budget.js';
const SINGLE_TOOL_RESULT_TOKEN_LIMIT = 20_000;
const TOOL_RESULTS_CONTEXT_RATIO = 0.5;
export function tokenCountFromUsage(usage) {
    if (!usage)
        return undefined;
    return usage.inputTokens
        + usage.cacheReadInputTokens
        + usage.outputTokens;
}
export function prepareRecordsForRequest(records, contextManagement = {}) {
    const recordsAfterCompact = getRecordsAfterLastCompact(records);
    const latestToolResultByTool = findLatestToolResultByTool(recordsAfterCompact);
    const toolResultLimit = Math.floor(getEffectiveContextWindowSize(contextManagement) * TOOL_RESULTS_CONTEXT_RATIO);
    let toolResultTokens = recordsAfterCompact.reduce((sum, record) => {
        return record.type === 'tool_result' ? sum + countSessionRecordTokens(record) : sum;
    }, 0);
    const prepared = recordsAfterCompact.map((record) => {
        if (record.type !== 'tool_result')
            return record;
        if (latestToolResultByTool.get(record.tool) === record.id)
            return record;
        const tokens = countSessionRecordTokens(record);
        if (tokens <= SINGLE_TOOL_RESULT_TOKEN_LIMIT && toolResultTokens <= toolResultLimit) {
            return record;
        }
        toolResultTokens -= tokens;
        const compacted = compactToolResult(record, tokens);
        toolResultTokens += countSessionRecordTokens(compacted);
        return compacted;
    });
    return repairToolPairing(prepared);
}
function getRecordsAfterLastCompact(records) {
    for (let index = records.length - 1; index >= 0; index--) {
        if (records[index]?.type === 'compact_boundary')
            return records.slice(index);
    }
    return [...records];
}
function findLatestToolResultByTool(records) {
    const latest = new Map();
    for (let index = records.length - 1; index >= 0; index--) {
        const record = records[index];
        if (record?.type === 'tool_result' && !latest.has(record.tool)) {
            latest.set(record.tool, record.id);
        }
    }
    return latest;
}
function compactToolResult(record, tokens) {
    return {
        ...record,
        content: [
            `[tool result compacted: ${record.tool} output was approximately ${tokens} tokens]`,
            `status: ${record.ok ? 'ok' : 'error'}`,
            'The original output was removed from this request to stay within the context budget.',
        ].join('\n'),
    };
}
function repairToolPairing(records) {
    const toolUseIds = new Set(records.filter((record) => record.type === 'tool_use').map((record) => record.id));
    const toolResultIds = new Set(records.filter((record) => record.type === 'tool_result').map((record) => record.toolUseId));
    return records.filter((record) => {
        if (record.type === 'tool_use')
            return toolResultIds.has(record.id);
        if (record.type === 'tool_result')
            return toolUseIds.has(record.toolUseId);
        return true;
    });
}
