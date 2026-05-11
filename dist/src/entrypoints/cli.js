#!/usr/bin/env node
import { existsSync, readFileSync, appendFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import readline from 'node:readline';
import { ConfigService } from '../config/service.js';
import { createProvider } from '../config/providers.js';
import { SessionStore } from '../sessions/service.js';
import { getAllTools } from '../tools/index.js';
import { PermissionGate } from '../harness/permissions.js';
import { ToolRunner } from '../harness/toolRunner.js';
import { ContextBuilder } from '../harness/contextBuilder.js';
import { AgentLoop } from '../harness/loop.js';
import { SkillsService } from '../services/skills/skillsService.js';
import { formatUsageLine } from '../harness/usage.js';
import { getMyAgentDir } from '../utils/paths.js';
const cwd = process.cwd();
const HISTORY_MAX = 1000;
async function main() {
    const args = process.argv.slice(2);
    const command = args[0] ?? 'help';
    switch (command) {
        case 'help':
            printHelp();
            break;
        case 'new':
            await runNewSession();
            break;
        case 'list':
            await listSessions();
            break;
        case 'resume': {
            const sessionId = args[1];
            if (!sessionId) {
                console.error('Usage: myagent resume <session-id-or-prefix>');
                process.exit(1);
            }
            await resumeSession(sessionId);
            break;
        }
        default:
            console.error(`Unknown command: ${command}`);
            console.error('Run "myagent help" for usage information');
            process.exit(1);
    }
}
function printHelp() {
    console.log(`
MyAgent CLI

Usage:
  myagent [command]

Commands:
  new             Start a new interactive session
  list            List saved sessions with usable IDs
  resume <id>     Resume a session by full ID or unambiguous prefix
  help            Show this help message

During a session:
  - type your prompt and press Enter
  - Shift+Enter or Meta+Enter for multi-line input
  - Ctrl+C to interrupt the agent (press twice to exit)
  - Escape to clear the current line
  - Ctrl+L to clear the screen
  - Up/Down to browse command history
  - Tab for file path completion
  - type /exit to quit
`);
}
async function runNewSession() {
    const store = new SessionStore(cwd);
    await store.init();
    const session = await store.create();
    await startInteractiveSession(session);
}
async function resumeSession(sessionId) {
    const store = new SessionStore(cwd);
    await store.init();
    const session = await store.resolve(sessionId);
    if (!session) {
        console.error(`Session not found or ambiguous: ${sessionId}`);
        process.exit(1);
    }
    await startInteractiveSession(session);
}
// ─── History persistence ────────────────────────────────────────────────
function getHistoryPath() {
    const dir = getMyAgentDir(cwd);
    return join(dir, 'history');
}
function loadHistoryFile() {
    try {
        const path = getHistoryPath();
        if (!existsSync(path))
            return [];
        const content = readFileSync(path, 'utf-8');
        return content.split('\n').filter((l) => l.trim());
    }
    catch {
        return [];
    }
}
function appendHistoryLine(line) {
    try {
        const dir = getMyAgentDir(cwd);
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        appendFileSync(getHistoryPath(), line + '\n', 'utf-8');
    }
    catch {
        // silently ignore history write failures
    }
}
function saveHistoryFile(lines) {
    try {
        const dir = getMyAgentDir(cwd);
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        writeFileSync(getHistoryPath(), [...new Set(lines)].slice(-HISTORY_MAX).join('\n') + '\n');
    }
    catch {
        // silently ignore history write failures
    }
}
// ─── Tab file path completer ────────────────────────────────────────────
function filePathCompleter(line) {
    const lastSpaceIdx = line.lastIndexOf(' ');
    const prefix = lastSpaceIdx >= 0 ? line.slice(0, lastSpaceIdx + 1) : '';
    const token = lastSpaceIdx >= 0 ? line.slice(lastSpaceIdx + 1) : line;
    if (!token)
        return [[], line];
    const dir = dirname(token) || '.';
    const base = basename(token);
    try {
        const entries = readdirSync(dir);
        const hits = entries.filter((e) => e.startsWith(base));
        if (hits.length === 0)
            return [[], line];
        const completions = hits.map((entry) => {
            const full = dir === '.' ? entry : dir + '/' + entry;
            try {
                if (statSync(full).isDirectory())
                    return prefix + full + '/';
            }
            catch {
                // stat failed, treat as regular file
            }
            return prefix + full;
        });
        return [completions, line];
    }
    catch {
        return [[], line];
    }
}
// ─── Interactive session ────────────────────────────────────────────────
async function startInteractiveSession(session) {
    const config = new ConfigService(cwd);
    await config.load();
    const modelConfig = config.getDefaultModel();
    if (!modelConfig) {
        console.error('No default model configured.');
        process.exit(1);
    }
    const provider = createProvider(modelConfig);
    if (!provider) {
        console.error(`Failed to create provider for: ${modelConfig.provider}`);
        process.exit(1);
    }
    const store = new SessionStore(cwd);
    await store.init();
    const tools = await getAllTools(cwd);
    const skills = await new SkillsService(cwd).list();
    // Enable keypress events BEFORE creating readline so keypress fires before 'line'
    readline.emitKeypressEvents(process.stdin);
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        completer: filePathCompleter,
        historySize: HISTORY_MAX,
        terminal: true,
    });
    // Load persisted history into readline's internal history array
    const savedHistory = loadHistoryFile();
    const history = rl.history;
    for (const h of savedHistory) {
        history.push(h);
    }
    // ── Tier 2 state ──
    let multilineBuffer = [];
    let pendingNewline = false;
    let isRunning = false;
    let abortController = null;
    let lastCtrlCTime = 0;
    // ── Keypress handler (for Escape, Ctrl+L, Shift+Enter) ──
    process.stdin.on('keypress', (_str, key) => {
        if (!key)
            return;
        // Escape: clear current line and multi-line buffer
        if (key.name === 'escape') {
            rl.write(null, { ctrl: true, name: 'u' });
            multilineBuffer = [];
            return;
        }
        // Ctrl+L: clear screen and repaint prompt
        if (key.ctrl && key.name === 'l') {
            process.stdout.write('\x1b[2J\x1b[H');
            if (multilineBuffer.length > 0) {
                for (const l of multilineBuffer) {
                    process.stdout.write(`... ${l}\n`);
                }
            }
            rl.prompt(true);
            return;
        }
        // Shift+Enter or Meta+Enter: insert newline in multi-line mode
        if (key.name === 'return' && (key.shift || key.meta)) {
            pendingNewline = true;
        }
    });
    // ── Ctrl+C handler ──
    rl.on('SIGINT', () => {
        if (isRunning && abortController) {
            abortController.abort();
            isRunning = false;
            console.log('\n[Interrupted]');
            multilineBuffer = [];
            rl.setPrompt('> ');
            rl.prompt();
            return;
        }
        const now = Date.now();
        if (now - lastCtrlCTime < 2000) {
            console.log('\nExiting...');
            saveHistoryFile(history);
            process.exit(0);
        }
        lastCtrlCTime = now;
        console.log('\nPress Ctrl+C again to exit');
        multilineBuffer = [];
        rl.setPrompt('> ');
        rl.prompt();
    });
    const permissionGate = new PermissionGate((request) => promptPermission(rl, request));
    const toolRunner = new ToolRunner(tools, permissionGate, {
        onRecord: async (record) => {
            await store.appendRecord(session.id, record);
        },
    });
    const contextManagement = config.get().agent.contextManagement;
    const isGitRepo = existsSync(join(cwd, '.git'));
    const loop = new AgentLoop({
        provider,
        model: modelConfig.model,
        tools,
        contextBuilder: new ContextBuilder(undefined, contextManagement),
        toolRunner,
        toolContext: {
            cwd,
            sessionId: session.id,
            readFiles: new Set(),
            readFileState: new Map(),
            invokedSkills: new Map(),
            taskState: new Map(),
        },
        system: config.get().agent.system,
        skills,
        promptCacheRetention: modelConfig.promptCacheRetention,
        contextManagement,
        isGitRepo,
        loadRecords: async () => store.loadRecords(session.id),
        appendRecord: async (record) => store.appendRecord(session.id, record),
    });
    const records = await store.loadRecords(session.id);
    const messageCount = records.filter((record) => record.type === 'message').length;
    console.log(`Session: ${session.shortId} (${session.id})`);
    console.log(`Using model: ${modelConfig.model} (${provider.name} format)`);
    if (modelConfig.baseUrl) {
        console.log(`Provider wire format: ${provider.name}`);
    }
    if (messageCount > 0) {
        console.log(`Loaded ${messageCount} previous messages.`);
    }
    console.log('Type /exit to quit, Ctrl+C to interrupt.\n');
    // ── Main input handler ──
    rl.on('line', async (line) => {
        if (pendingNewline) {
            pendingNewline = false;
            multilineBuffer.push(line);
            rl.setPrompt('... ');
            rl.prompt();
            return;
        }
        // Build the full input: combine multi-line buffer with current line
        let input;
        if (multilineBuffer.length > 0) {
            multilineBuffer.push(line);
            input = multilineBuffer.join('\n');
            multilineBuffer = [];
        }
        else {
            input = line;
        }
        const trimmed = input.trim();
        if (trimmed === '/exit' || trimmed === 'exit') {
            saveHistoryFile(history);
            rl.close();
            return;
        }
        if (!trimmed) {
            rl.setPrompt('> ');
            rl.prompt();
            return;
        }
        // Persist to history file
        appendHistoryLine(trimmed);
        // Start agent processing
        isRunning = true;
        abortController = new AbortController();
        try {
            console.log('\nThinking...\n');
            const result = await loop.run(trimmed, abortController.signal);
            if (result.content)
                console.log(result.content);
            console.log(formatUsageLine(result.usage, modelConfig.pricing));
        }
        catch (error) {
            const err = error;
            if (err.name === 'AbortError') {
                // Interrupted — message already printed by SIGINT handler
            }
            else {
                console.error(err.message ?? String(error));
            }
        }
        isRunning = false;
        abortController = null;
        console.log();
        rl.setPrompt('> ');
        rl.prompt();
    });
    rl.setPrompt('> ');
    rl.prompt();
}
async function promptPermission(rl, request) {
    const summary = JSON.stringify(request.input);
    const answer = await askQuestion(rl, `[permission] ${request.tool.name}: ${request.reason}\ninput: ${summary}\nAllow? (y/N) `);
    return /^(y|yes)$/i.test(answer.trim());
}
function askQuestion(rl, question) {
    return new Promise((resolve) => {
        rl.question(question, resolve);
    });
}
async function listSessions() {
    const store = new SessionStore(cwd);
    await store.init();
    const sessions = await store.list();
    if (sessions.length === 0) {
        console.log('No sessions found.');
        return;
    }
    console.log('Sessions:\n');
    for (const session of sessions) {
        const date = new Date(session.updatedAt).toLocaleString();
        const title = session.title ?? '(untitled)';
        console.log(`  ${session.shortId}  ${session.id}  ${session.messageCount} msgs  ${date}  ${title}`);
    }
}
main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
