export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000;
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000;
export const DEFAULT_CONTEXT_MANAGEMENT = {
    contextWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
    summaryOutputTokens: MAX_OUTPUT_TOKENS_FOR_SUMMARY,
    autoCompactBufferTokens: AUTOCOMPACT_BUFFER_TOKENS,
    manualCompactBufferTokens: MANUAL_COMPACT_BUFFER_TOKENS,
};
export function getEffectiveContextWindowSize(config = {}) {
    const merged = { ...DEFAULT_CONTEXT_MANAGEMENT, ...config };
    return Math.max(0, merged.contextWindow - merged.summaryOutputTokens);
}
export function getAutoCompactThreshold(config = {}) {
    const merged = { ...DEFAULT_CONTEXT_MANAGEMENT, ...config };
    return Math.max(0, getEffectiveContextWindowSize(merged) - merged.autoCompactBufferTokens);
}
export function getManualCompactThreshold(config = {}) {
    const merged = { ...DEFAULT_CONTEXT_MANAGEMENT, ...config };
    return Math.max(0, getEffectiveContextWindowSize(merged) - merged.manualCompactBufferTokens);
}
export function countTextTokens(text) {
    // Rough estimate: ~4 chars per token for English, more for CJK
    // This is a simplified approximation for the MVP
    let count = 0;
    for (const char of text) {
        if (char.charCodeAt(0) > 127) {
            count += 2; // CJK characters
        }
        else {
            count += 0.25; // English/ASCII
        }
    }
    return Math.ceil(count);
}
export function countMessageTokens(message) {
    return countTextTokens(message.content);
}
export function countMessagesTokens(messages) {
    const counts = messages.map(countMessageTokens);
    return {
        total: counts.reduce((a, b) => a + b, 0),
        messages: counts,
    };
}
export function getAvailableContextTokens(config = {}, system) {
    const systemTokens = system ? countTextTokens(system) : 0;
    return getEffectiveContextWindowSize(config) - systemTokens - 1000;
}
export function selectMessagesForContext(messages, config = {}, system) {
    const availableTokens = getAvailableContextTokens(config, system);
    if (availableTokens <= 0) {
        return [];
    }
    const result = [];
    let used = 0;
    for (const message of messages) {
        const tokens = countMessageTokens(message);
        if (used + tokens > availableTokens) {
            break;
        }
        result.push(message);
        used += tokens;
    }
    return result;
}
export function selectContextItemsForContext(items, config = {}, system) {
    const availableTokens = getAvailableContextTokens(config, system);
    if (availableTokens <= 0) {
        return [];
    }
    const result = [];
    let used = 0;
    for (const item of [...items].reverse()) {
        const tokens = countContextItemTokens(item);
        if (used + tokens > availableTokens) {
            if (result.length > 0)
                break;
            continue;
        }
        result.push(item);
        used += tokens;
    }
    return repairToolPairing(result.reverse());
}
export function countContextItemTokens(item) {
    if (item.kind === 'message') {
        return countMessageTokens(item.message);
    }
    if (item.kind === 'tool_use') {
        return countTextTokens(`${item.tool}\n${JSON.stringify(item.input ?? {})}`);
    }
    return countTextTokens(`${item.tool}\n${item.content}`);
}
export function countSessionRecordTokens(record) {
    if (record.type === 'message') {
        return countMessageTokens(record);
    }
    if (record.type === 'tool_use') {
        return countTextTokens(`${record.tool}\n${JSON.stringify(record.input ?? {})}`);
    }
    if (record.type === 'tool_result') {
        return countTextTokens(`${record.tool}\n${record.content}`);
    }
    if (record.type === 'compact_boundary') {
        return countTextTokens(record.summary);
    }
    return countTextTokens(`${record.tool}\n${JSON.stringify(record.input ?? {})}`);
}
export function countSessionRecordsTokens(records, system) {
    return records.reduce((sum, record) => sum + countSessionRecordTokens(record), system ? countTextTokens(system) : 0);
}
function repairToolPairing(items) {
    const toolUseIds = new Set(items
        .filter((item) => item.kind === 'tool_use')
        .map((item) => item.id));
    const toolResultIds = new Set(items
        .filter((item) => item.kind === 'tool_result')
        .map((item) => item.toolUseId));
    return items.filter((item) => {
        if (item.kind === 'tool_use')
            return toolResultIds.has(item.id);
        if (item.kind === 'tool_result')
            return toolUseIds.has(item.toolUseId);
        return true;
    });
}
