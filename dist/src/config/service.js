import { readJsonFile, writeJsonFile } from '../utils/json.js';
import { getConfigPath } from '../utils/paths.js';
const DEFAULT_CONFIG = {
    models: {
        anthropic: {
            provider: 'anthropic',
            model: 'claude-opus-4-7',
        },
    },
    defaultModel: 'anthropic',
    agent: {
        contextManagement: {
            contextWindow: 200_000,
            summaryOutputTokens: 20_000,
            autoCompactBufferTokens: 13_000,
            manualCompactBufferTokens: 3_000,
        },
    },
};
export class ConfigService {
    config;
    configPath;
    constructor(cwd) {
        this.configPath = getConfigPath(cwd);
        this.config = { ...DEFAULT_CONFIG };
    }
    async load() {
        this.config = await readJsonFile(this.configPath, DEFAULT_CONFIG);
    }
    async save() {
        await writeJsonFile(this.configPath, this.config);
    }
    get() {
        return this.config;
    }
    getModel(name) {
        return this.config.models[name];
    }
    getDefaultModel() {
        if (!this.config.defaultModel)
            return undefined;
        return this.config.models[this.config.defaultModel];
    }
    setDefaultModel(name) {
        if (this.config.models[name]) {
            this.config.defaultModel = name;
        }
    }
    addModel(name, model) {
        this.config.models[name] = model;
    }
}
