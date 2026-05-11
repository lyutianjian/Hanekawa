let previousSnapshot = null;
let pendingChanges = null;
export function recordPromptState(state) {
    const systemHash = hashString(state.system);
    const toolsHash = hashString(state.toolsJson);
    const changes = {
        systemPromptChanged: false,
        toolSchemasChanged: false,
        modelChanged: false,
        systemCharDelta: 0,
    };
    if (previousSnapshot) {
        if (previousSnapshot.systemHash !== systemHash) {
            changes.systemPromptChanged = true;
            changes.systemCharDelta = state.system.length - previousSnapshot.systemCharCount;
        }
        if (previousSnapshot.toolsHash !== toolsHash) {
            changes.toolSchemasChanged = true;
        }
        if (previousSnapshot.model !== state.model) {
            changes.modelChanged = true;
        }
    }
    pendingChanges = changes;
    previousSnapshot = {
        systemHash,
        toolsHash,
        model: state.model,
        systemCharCount: state.system.length,
        prevCacheReadTokens: previousSnapshot?.prevCacheReadTokens ?? null,
    };
}
export function checkResponseForCacheBreak(cacheReadTokens, inputTokens) {
    if (!previousSnapshot)
        return null;
    const prevCacheRead = previousSnapshot.prevCacheReadTokens;
    previousSnapshot.prevCacheReadTokens = cacheReadTokens;
    if (prevCacheRead === null)
        return null;
    const tokenDrop = prevCacheRead - cacheReadTokens;
    if (cacheReadTokens >= prevCacheRead * 0.95 || tokenDrop < 2000) {
        pendingChanges = null;
        return null;
    }
    const result = {
        tokenDrop,
        prevCacheRead,
        currentCacheRead: cacheReadTokens,
        reasons: [],
    };
    if (pendingChanges) {
        if (pendingChanges.systemPromptChanged) {
            result.reasons.push(`system_prompt_changed(+${pendingChanges.systemCharDelta} chars)`);
        }
        if (pendingChanges.toolSchemasChanged) {
            result.reasons.push('tool_schemas_changed');
        }
        if (pendingChanges.modelChanged) {
            result.reasons.push('model_changed');
        }
        pendingChanges = null;
    }
    if (result.reasons.length === 0) {
        result.reasons.push('server_side');
    }
    if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
        console.error(`[myagent][cache-break] drop=${tokenDrop} tokens prev=${prevCacheRead} current=${cacheReadTokens} reasons=${result.reasons.join(',')}`);
    }
    return result;
}
export function notifyCompaction() {
    if (previousSnapshot) {
        previousSnapshot.prevCacheReadTokens = null;
    }
}
export function resetCacheBreakDetection() {
    previousSnapshot = null;
    pendingChanges = null;
}
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash + char) | 0;
    }
    return hash;
}
