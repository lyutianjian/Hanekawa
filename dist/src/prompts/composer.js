import { selectContextItemsForContext, selectMessagesForContext, } from './budget.js';
export class PromptComposer {
    compose(messages, options) {
        const { system, contextManagement, includeHistory = true } = options;
        if (!includeHistory) {
            return { system, messages: [] };
        }
        const truncatedMessages = selectMessagesForContext(messages, contextManagement, system);
        return { system, messages: truncatedMessages };
    }
    buildRequestMessages(messages, options) {
        return this.compose(messages, options);
    }
    composeContextItems(items, options) {
        const { system, contextManagement, includeHistory = true } = options;
        if (!includeHistory) {
            return { system, contextItems: [], messages: [] };
        }
        const contextItems = selectContextItemsForContext(items, contextManagement, system);
        const messages = contextItems
            .filter((item) => item.kind === 'message')
            .map((item) => item.message);
        return { system, contextItems, messages };
    }
}
