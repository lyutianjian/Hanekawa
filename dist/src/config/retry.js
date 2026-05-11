export async function withRetry(operation, options = {}) {
    const maxRetries = options.maxRetries ?? 3;
    const baseDelayMs = options.baseDelayMs ?? 500;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        if (options.signal?.aborted) {
            const err = new Error('Request aborted');
            err.aborted = true;
            throw err;
        }
        try {
            return await operation(attempt);
        }
        catch (error) {
            if (attempt > maxRetries)
                throw error;
            if (options.shouldRetry && !options.shouldRetry(error, attempt))
                throw error;
            const delay = baseDelayMs * Math.pow(2, attempt - 1);
            await sleep(delay);
        }
    }
    throw new Error('Unreachable');
}
export function isRetryableError(error) {
    if (error instanceof Error) {
        if (error.status === 429)
            return true;
        if (error.status === 529)
            return true;
        const status = error.status;
        if (status !== undefined && status >= 500 && status < 600)
            return true;
        const msg = error.message.toLowerCase();
        if (msg.includes('rate') || msg.includes('429'))
            return true;
        if (msg.includes('529') || msg.includes('overload'))
            return true;
        if (msg.includes('timeout'))
            return true;
        if (msg.includes('econnreset') || msg.includes('econnrefused'))
            return true;
    }
    return false;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
