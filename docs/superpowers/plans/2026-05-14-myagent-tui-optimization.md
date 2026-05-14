# myagent TUI 深度优化实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对齐 Claude Code 的 TUI 架构设计，对 myagent 的 TUI 进行核心架构优化，包括主题系统统一、useSession 拆分、键绑定完善、自动补全扩展、错误边界和消息渲染改进。

**Architecture:** 采用增量重构策略，分 5 个阶段逐步优化。每个阶段独立验证，确保功能连续性。

**Tech Stack:** TypeScript, React (Ink), Node.js fs/promises, chalk

---

## 文件结构

### 新增文件
- `src/tui/hooks/useSessionManager.ts` - 会话生命周期管理
- `src/tui/hooks/useQuery.ts` - 查询执行管理
- `src/tui/hooks/useMessageManager.ts` - 消息管理
- `src/tui/components/ErrorBoundary.tsx` - 错误边界组件
- `.myagent/keybindings.json` - 默认键绑定配置

### 修改文件
- `src/tui/design-system/ThemeProvider.tsx` - 统一主题系统
- `src/tui/hooks/useSession.ts` - 重构为协调器
- `src/tui/hooks/useKeyBindings.ts` - 异步配置加载
- `src/tui/keybindings/types.ts` - 启用 KeyBindingsConfig
- `src/tui/typeahead/suggestions.ts` - 扩展补全源
- `src/tui/typeahead/useTypeahead.ts` - 异步补全支持
- `src/tui/typeahead/TypeaheadPopup.tsx` - 改进 UI
- `src/tui/components/PromptInput.tsx` - 集成自动补全
- `src/tui/components/MessageList.tsx` - 虚拟滚动和焦点管理
- `src/tui/components/ToolUseMessage.tsx` - 键盘驱动的展开/折叠
- `src/tui/components/AssistantMessage.tsx` - 改进 markdown 渲染
- `src/tui/utils/markdown.ts` - 增强 markdown 渲染器
- `src/tui/app.tsx` - 集成 ErrorBoundary

### 删除文件
- `src/tui/theme.ts` - 旧版主题 re-export
- `src/tui/hooks/useTheme.ts` - 旧版主题 hook

---

## Task 1: 主题系统统一 - 移除旧版主题文件

**Files:**
- Delete: `src/tui/theme.ts`
- Delete: `src/tui/hooks/useTheme.ts`
- Modify: `src/tui/components/ToolUseMessage.tsx`
- Modify: `src/tui/components/PermissionPrompt.tsx`

- [ ] **Step 1: 查找所有使用旧版 useTheme 的文件**

```bash
grep -r "from.*hooks/useTheme" src/tui/ --include="*.tsx" --include="*.ts"
```

- [ ] **Step 2: 修改 ToolUseMessage.tsx 的导入**

将 `import { useTheme } from '../hooks/useTheme'` 改为 `import { useTheme } from '../design-system/ThemeProvider'`

- [ ] **Step 3: 修改 PermissionPrompt.tsx 的导入**

将 `import { useTheme } from '../hooks/useTheme'` 改为 `import { useTheme } from '../design-system/ThemeProvider'`

- [ ] **Step 4: 删除旧版主题文件**

```bash
rm src/tui/theme.ts
rm src/tui/hooks/useTheme.ts
```

- [ ] **Step 5: 验证编译通过**

```bash
npm run build
```

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "refactor: remove legacy theme system, unify useTheme import"
```

---

## Task 2: 主题系统统一 - 实现终端背景色检测

**Files:**
- Modify: `src/tui/design-system/ThemeProvider.tsx`

- [ ] **Step 1: 添加 detectTerminalTheme 函数**

在 `ThemeProvider.tsx` 中添加：

```typescript
function detectTerminalTheme(): 'light' | 'dark' {
  const colorfgbg = process.env.COLORFGBG;
  if (colorfgbg) {
    const bg = colorfgbg.split(';').pop();
    if (bg && parseInt(bg) < 6) return 'dark';
    if (bg && parseInt(bg) >= 6) return 'light';
  }
  return 'dark';
}
```

- [ ] **Step 2: 修改 resolvedTheme 初始化**

```typescript
const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => {
  if (mode === 'auto') return detectTerminalTheme();
  return mode;
});
```

- [ ] **Step 3: 验证主题切换**

启动 myagent，检查 `auto` 模式是否正确检测终端背景色

- [ ] **Step 4: 提交**

```bash
git add src/tui/design-system/ThemeProvider.tsx
git commit -m "feat: add terminal background color detection for auto theme"
```

---

## Task 3: 主题系统统一 - 扩展 ThemeColors 接口

**Files:**
- Modify: `src/tui/design-system/ThemeProvider.tsx`

- [ ] **Step 1: 扩展 ThemeColors 接口**

```typescript
export interface ThemeColors {
  // 现有颜色保持不变...
  accent: string;
  error: string;
  warning: string;
  success: string;
  border: string;
  spinner: string;
  prompt: string;
  dimmed: string;
  background: string;
  foreground: string;
  userMessage: string;
  assistantMessage: string;
  systemMessage: string;
  hoverBorder: string;
  selectedBackground: string;

  // 新增 Claude Code 风格颜色
  claude: string;
  claudeShimmer: string;
  subtle: string;
}
```

- [ ] **Step 2: 更新 darkColors 定义**

```typescript
export const darkColors: ThemeColors = {
  // 保持现有颜色...
  accent: '#89B4FA',
  error: '#F38BA8',
  warning: '#FAB387',
  success: '#A6E3A1',
  border: '#45475A',
  spinner: '#89B4FA',
  prompt: '#CDD6F4',
  dimmed: '#6C7086',
  background: '#1E1E2E',
  foreground: '#CDD6F4',
  userMessage: '#CDD6F4',
  assistantMessage: '#CDD6F4',
  systemMessage: '#A6ADC8',
  hoverBorder: '#89B4FA',
  selectedBackground: '#313244',

  // 新增
  claude: '#D4A574',
  claudeShimmer: '#E8C9A0',
  subtle: '#6C7086',
};
```

- [ ] **Step 3: 更新 lightColors 定义**

```typescript
export const lightColors: ThemeColors = {
  // 保持现有颜色...
  accent: '#1E66F5',
  error: '#D20F39',
  warning: '#DF8E1D',
  success: '#40A02B',
  border: '#CCD0DA',
  spinner: '#1E66F5',
  prompt: '#4C4F69',
  dimmed: '#9399B2',
  background: '#EFF1F5',
  foreground: '#4C4F69',
  userMessage: '#4C4F69',
  assistantMessage: '#4C4F69',
  systemMessage: '#6C6F85',
  hoverBorder: '#1E66F5',
  selectedBackground: '#E6E9EF',

  // 新增
  claude: '#8B6914',
  claudeShimmer: '#A67C00',
  subtle: '#9399B2',
};
```

- [ ] **Step 4: 验证编译通过**

```bash
npm run build
```

- [ ] **Step 5: 提交**

```bash
git add src/tui/design-system/ThemeProvider.tsx
git commit -m "feat: extend ThemeColors with Claude Code style colors"
```

---

## Task 4: 拆分 useSession - 创建 useSessionManager

**Files:**
- Create: `src/tui/hooks/useSessionManager.ts`

- [ ] **Step 1: 创建 useSessionManager.ts**

```typescript
import { useState, useEffect } from 'react';
import { SessionStore } from '../../sessions/service';
import { Config } from '../../config/types';

export function useSessionManager(config: Config, cwd: string, resumeSessionId?: string) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [store, setStore] = useState<SessionStore | null>(null);

  useEffect(() => {
    const newStore = new SessionStore(config.storageDir);
    setStore(newStore);

    if (resumeSessionId) {
      const session = newStore.resume(resumeSessionId);
      setSessionId(resumeSessionId);
    } else {
      const session = newStore.create(cwd);
      setSessionId(session.id);
    }

    return () => {
      setStore(null);
      setSessionId(null);
    };
  }, [config, cwd, resumeSessionId]);

  return {
    sessionId,
    store,
  };
}
```

- [ ] **Step 2: 验证编译通过**

```bash
npm run build
```

- [ ] **Step 3: 提交**

```bash
git add src/tui/hooks/useSessionManager.ts
git commit -m "feat: add useSessionManager hook for session lifecycle"
```

---

## Task 5: 拆分 useSession - 创建 useMessageManager

**Files:**
- Create: `src/tui/hooks/useMessageManager.ts`

- [ ] **Step 1: 创建 useMessageManager.ts**

```typescript
import { useState, useCallback, useRef } from 'react';
import { DisplayMessage, SystemMessageVariant } from '../types';

function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

export function useMessageManager() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const streamBufferRef = useRef<string>('');
  const flushTimerRef = useRef<NodeJS.Timeout | null>(null);
  const streamingMessageIdRef = useRef<string | null>(null);

  const addUserMessage = useCallback((content: string) => {
    const message: DisplayMessage = {
      id: generateId(),
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, message]);
    return message.id;
  }, []);

  const addAssistantPlaceholder = useCallback(() => {
    const message: DisplayMessage = {
      id: generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };
    setMessages(prev => [...prev, message]);
    streamingMessageIdRef.current = message.id;
    return message.id;
  }, []);

  const flushStreamBuffer = useCallback(() => {
    const text = streamBufferRef.current;
    if (!text || !streamingMessageIdRef.current) return;

    streamBufferRef.current = '';

    setMessages(prev => prev.map(msg =>
      msg.id === streamingMessageIdRef.current
        ? { ...msg, content: msg.content + text }
        : msg
    ));
  }, []);

  const appendStreamText = useCallback((text: string) => {
    streamBufferRef.current += text;

    if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(() => {
        flushStreamBuffer();
        flushTimerRef.current = null;
      }, 50);
    }
  }, [flushStreamBuffer]);

  const finalizeAssistantMessage = useCallback((finalContent: string) => {
    flushStreamBuffer();

    setMessages(prev => prev.map(msg =>
      msg.id === streamingMessageIdRef.current
        ? { ...msg, content: finalContent, isStreaming: false }
        : msg
    ));

    streamingMessageIdRef.current = null;
  }, [flushStreamBuffer]);

  const addToolMessage = useCallback((toolUse: any, toolResult: any) => {
    const message: DisplayMessage = {
      id: generateId(),
      role: 'tool_use',
      toolUse,
      toolResult,
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, message]);
  }, []);

  const addSystemMessage = useCallback((content: string, variant: SystemMessageVariant = 'info') => {
    const message: DisplayMessage = {
      id: generateId(),
      role: 'system',
      content,
      variant,
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, message]);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    streamBufferRef.current = '';
    streamingMessageIdRef.current = null;
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  return {
    messages,
    addUserMessage,
    addAssistantPlaceholder,
    appendStreamText,
    finalizeAssistantMessage,
    addToolMessage,
    addSystemMessage,
    clearMessages,
  };
}
```

- [ ] **Step 2: 验证编译通过**

```bash
npm run build
```

- [ ] **Step 3: 提交**

```bash
git add src/tui/hooks/useMessageManager.ts
git commit -m "feat: add useMessageManager hook for message state management"
```

---

## Task 6: 拆分 useSession - 创建 useQuery

**Files:**
- Create: `src/tui/hooks/useQuery.ts`

- [ ] **Step 1: 创建 useQuery.ts**

```typescript
import { useState, useCallback, useRef, useEffect } from 'react';
import { Config } from '../../config/types';
import { SessionStore } from '../../sessions/service';
import { AgentLoop } from '../../harness/loop';
import { Provider } from '../../providers';
import { ToolRunner } from '../../harness/toolRunner';
import { ContextBuilder } from '../../harness/contextBuilder';

export class AbortError extends Error {
  constructor() {
    super('Aborted');
    this.name = 'AbortError';
  }
}

export function useQuery(
  config: Config,
  cwd: string,
  sessionId: string | null,
  store: SessionStore | null
) {
  const loopRef = useRef<AgentLoop | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    if (!sessionId || !store) return;

    const session = store.getSession(sessionId);
    if (!session) return;

    const provider = new Provider(config);
    const toolRunner = new ToolRunner({
      cwd,
      session,
      permissionGate: session.permissionGate,
    });
    const contextBuilder = new ContextBuilder({
      cwd,
      session,
      config,
    });
    const loop = new AgentLoop(provider, toolRunner, contextBuilder);

    loopRef.current = loop;

    return () => {
      abortControllerRef.current?.abort();
      loopRef.current = null;
    };
  }, [config, cwd, sessionId, store]);

  const executeQuery = useCallback(async (
    input: string,
    onEvent: (event: any) => void
  ) => {
    if (!loopRef.current || !sessionId || !store) return;

    const session = store.getSession(sessionId);
    if (!session) return;

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsRunning(true);

    try {
      const result = await loopRef.current.run(
        input,
        controller.signal,
        onEvent
      );
      return result;
    } catch (error) {
      if (error instanceof AbortError) {
        return { interrupted: true };
      }
      throw error;
    } finally {
      setIsRunning(false);
      abortControllerRef.current = null;
    }
  }, [sessionId, store]);

  const abort = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  return {
    executeQuery,
    abort,
    isRunning,
  };
}
```

- [ ] **Step 2: 验证编译通过**

```bash
npm run build
```

- [ ] **Step 3: 提交**

```bash
git add src/tui/hooks/useQuery.ts
git commit -m "feat: add useQuery hook for agent loop execution"
```

---

## Task 7: 拆分 useSession - 重构 useSession 为协调器

**Files:**
- Modify: `src/tui/hooks/useSession.ts`
- Modify: `src/tui/screens/REPL.tsx`

- [ ] **Step 1: 重构 useSession.ts**

```typescript
import { useCallback } from 'react';
import { Config } from '../../config/types';
import { useSessionManager } from './useSessionManager';
import { useMessageManager } from './useMessageManager';
import { useQuery } from './useQuery';
import { getCommand } from '../../commands/registry';

export function useSession(config: Config, cwd: string, resumeSessionId?: string) {
  const { sessionId, store } = useSessionManager(config, cwd, resumeSessionId);

  const {
    messages,
    addUserMessage,
    addAssistantPlaceholder,
    appendStreamText,
    finalizeAssistantMessage,
    addToolMessage,
    addSystemMessage,
    clearMessages,
  } = useMessageManager();

  const { executeQuery, abort, isRunning } = useQuery(config, cwd, sessionId, store);

  const query = useCallback(async (input: string) => {
    if (input.startsWith('/')) {
      const commandName = input.slice(1).split(' ')[0];
      const command = getCommand(commandName);
      if (command) {
        await command.run({
          args: input.slice(1).split(' ').slice(1),
          clearMessages,
          setModel: (model: string) => { /* TODO */ },
          writeLine: (text: string) => addSystemMessage(text),
        });
        return;
      }
    }

    addUserMessage(input);
    addAssistantPlaceholder();

    const result = await executeQuery(input, (event) => {
      if (event.type === 'text_delta') {
        appendStreamText(event.text);
      }
    });

    if (result?.interrupted) {
      addSystemMessage('[Interrupted]', 'warning');
    } else if (result?.content) {
      finalizeAssistantMessage(result.content);

      if (result.toolUses) {
        for (const toolUse of result.toolUses) {
          addToolMessage(toolUse, toolUse.result);
        }
      }

      if (result.usage) {
        const usageText = `Tokens: ${result.usage.input_tokens} in / ${result.usage.output_tokens} out`;
        addSystemMessage(usageText, 'info');
      }
    }
  }, [
    addUserMessage,
    addAssistantPlaceholder,
    appendStreamText,
    finalizeAssistantMessage,
    addToolMessage,
    addSystemMessage,
    clearMessages,
    executeQuery,
  ]);

  return {
    sessionId,
    messages,
    query,
    abort,
    clearMessages,
    isRunning,
  };
}
```

- [ ] **Step 2: 更新 REPL.tsx 使用新的 useSession 接口**

检查 REPL.tsx 是否需要适配新的 `isRunning` 返回值（现在是 useState 而非 useRef）

- [ ] **Step 3: 验证编译通过**

```bash
npm run build
```

- [ ] **Step 4: 提交**

```bash
git add src/tui/hooks/useSession.ts src/tui/screens/REPL.tsx
git commit -m "refactor: split useSession into modular hooks"
```

---

## Task 8: 完善键绑定系统 - 启用 KeyBindingsConfig

**Files:**
- Modify: `src/tui/keybindings/types.ts`

- [ ] **Step 1: 扩展 KeyBindingsConfig 接口**

```typescript
export interface KeyBindingsConfig {
  global?: {
    interrupt?: string;
    exit?: string;
    clear?: string;
    toggleTodo?: string;
    toggleTranscript?: string;
    historySearch?: string;
  };

  chat?: {
    cancel?: string;
    submit?: string;
    historyUp?: string;
    historyDown?: string;
    undo?: string;
    externalEditor?: string;
    stage?: string;
    imagePaste?: string;
  };

  editing?: {
    lineStart?: string;
    lineEnd?: string;
    killLine?: string;
    killLineBackward?: string;
    killWord?: string;
    yank?: string;
    deleteToken?: string;
    wordBackward?: string;
    wordForward?: string;
    deleteWordForward?: string;
    yankPop?: string;
  };

  autocomplete?: {
    accept?: string;
    next?: string;
    previous?: string;
    close?: string;
  };
}
```

- [ ] **Step 2: 验证编译通过**

```bash
npm run build
```

- [ ] **Step 3: 提交**

```bash
git add src/tui/keybindings/types.ts
git commit -m "feat: enable KeyBindingsConfig interface"
```

---

## Task 9: 完善键绑定系统 - 实现异步配置加载

**Files:**
- Modify: `src/tui/keybindings/useKeyBindings.ts`

- [ ] **Step 1: 重构 useKeyBindings.ts**

```typescript
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { KeyBinding, KeyBindingsConfig } from './types';
import { defaultBindings } from './defaultBindings';

async function loadKeyBindingsConfig(): Promise<KeyBindingsConfig> {
  const configPath = path.join(os.homedir(), '.myagent', 'keybindings.json');

  try {
    const exists = await fs.access(configPath).then(() => true).catch(() => false);
    if (exists) {
      const content = await fs.readFile(configPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.error('Failed to load keybindings config:', error);
  }

  return {};
}

function mergeBindings(config: KeyBindingsConfig): KeyBinding[] {
  const bindings: KeyBinding[] = [];

  bindings.push({
    key: config.global?.interrupt ?? 'c',
    modifiers: { ctrl: true },
    action: 'interrupt',
    context: 'global',
  });

  bindings.push({
    key: config.global?.exit ?? 'd',
    modifiers: { ctrl: true },
    action: 'exit',
    context: 'global',
  });

  bindings.push({
    key: config.global?.clear ?? 'l',
    modifiers: { ctrl: true },
    action: 'clear',
    context: 'global',
  });

  bindings.push({
    key: config.chat?.cancel ?? 'escape',
    action: 'cancel',
    context: 'chat',
  });

  bindings.push({
    key: config.chat?.submit ?? 'return',
    action: 'submit',
    context: 'chat',
  });

  return bindings;
}

export function useKeyBindings(context: string, customBindings?: KeyBinding[]) {
  const [bindings, setBindings] = useState<KeyBinding[]>([]);
  const [pendingChord, setPendingChord] = useState<any>(null);
  const chordTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    let cancelled = false;

    loadKeyBindingsConfig().then(config => {
      if (!cancelled) {
        const merged = mergeBindings(config);
        setBindings(merged);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const allBindings = useMemo(() => [
    ...bindings,
    ...(customBindings ?? []),
  ], [bindings, customBindings]);

  const findBinding = useCallback((input: string, key: any) => {
    return allBindings.find(binding => {
      if (binding.context !== context && binding.context !== 'global') return false;

      const keyMatch = binding.key === input ||
        (binding.key === 'escape' && key.escape) ||
        (binding.key === 'return' && key.return) ||
        (binding.key === 'up' && key.upArrow) ||
        (binding.key === 'down' && key.downArrow);

      if (!keyMatch) return false;

      if (binding.modifiers) {
        if (binding.modifiers.ctrl && !key.ctrl) return false;
        if (binding.modifiers.shift && !key.shift) return false;
        if (binding.modifiers.meta && !key.meta) return false;
      } else {
        if (key.ctrl || key.shift || key.meta) return false;
      }

      return true;
    });
  }, [allBindings, context]);

  return {
    bindings: allBindings,
    findBinding,
    pendingChord,
    setPendingChord,
  };
}
```

- [ ] **Step 2: 创建默认配置文件**

创建 `.myagent/keybindings.json`：

```json
{
  "global": {
    "interrupt": "c",
    "exit": "d",
    "clear": "l"
  },
  "chat": {
    "cancel": "escape",
    "submit": "return",
    "historyUp": "up",
    "historyDown": "down"
  },
  "editing": {
    "lineStart": "a",
    "lineEnd": "e",
    "killLine": "k",
    "killLineBackward": "u",
    "killWord": "w"
  },
  "autocomplete": {
    "accept": "tab",
    "next": "down",
    "previous": "up",
    "close": "escape"
  }
}
```

- [ ] **Step 3: 验证编译通过**

```bash
npm run build
```

- [ ] **Step 4: 提交**

```bash
git add src/tui/keybindings/useKeyBindings.ts .myagent/keybindings.json
git commit -m "feat: implement async keybindings config loading"
```

---

## Task 10: 扩展自动补全 - 扩展补全源

**Files:**
- Modify: `src/tui/typeahead/suggestions.ts`

- [ ] **Step 1: 重构 suggestions.ts**

```typescript
import { promises as fs } from 'fs';
import path from 'path';
import { listCommands } from '../../commands/registry';
import { getBuiltinTools } from '../../tools';

export interface Suggestion {
  label: string;
  description: string;
  value: string;
  type: 'command' | 'file' | 'tool' | 'model' | 'skill' | 'variable';
}

const fileCache = new Map<string, { entries: any[]; timestamp: number }>();
const CACHE_TTL = 5000;

function getCommandSuggestions(input: string): Suggestion[] {
  const commands = listCommands();
  const query = input.slice(1).toLowerCase();

  return commands
    .filter(cmd => cmd.name.toLowerCase().startsWith(query))
    .map(cmd => ({
      label: `/${cmd.name}`,
      description: cmd.description,
      value: `/${cmd.name}`,
      type: 'command' as const,
    }));
}

async function getFileSuggestions(input: string, cwd: string): Promise<Suggestion[]> {
  const match = input.match(/@([\w./-]*)$/);
  if (!match) return [];

  const query = match[1];
  const dir = path.dirname(query) || '.';
  const prefix = path.basename(query);

  try {
    const resolvedDir = path.resolve(cwd, dir);

    const cached = fileCache.get(resolvedDir);
    let entries: any[];

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      entries = cached.entries;
    } else {
      entries = await fs.readdir(resolvedDir, { withFileTypes: true });
      fileCache.set(resolvedDir, { entries, timestamp: Date.now() });
    }

    return entries
      .filter((entry: any) => entry.name.startsWith(prefix))
      .slice(0, 10)
      .map((entry: any) => ({
        label: entry.isDirectory() ? `${entry.name}/` : entry.name,
        description: entry.isDirectory() ? 'Directory' : 'File',
        value: `@${path.join(dir, entry.name)}`,
        type: 'file' as const,
      }));
  } catch {
    return [];
  }
}

function getToolSuggestions(input: string): Suggestion[] {
  const match = input.match(/\/(\w*)$/);
  if (!match) return [];

  const query = match[1].toLowerCase();
  const tools = getBuiltinTools();

  return tools
    .filter(tool => tool.name.toLowerCase().startsWith(query))
    .map(tool => ({
      label: tool.name,
      description: tool.description,
      value: tool.name,
      type: 'tool' as const,
    }));
}

function getModelSuggestions(input: string): Suggestion[] {
  const match = input.match(/model\s+(\w*)$/i);
  if (!match) return [];

  const query = match[1].toLowerCase();
  const models = [
    'claude-3-opus',
    'claude-3-sonnet',
    'claude-3-haiku',
    'gpt-4',
    'gpt-3.5-turbo',
  ];

  return models
    .filter(model => model.toLowerCase().startsWith(query))
    .map(model => ({
      label: model,
      description: `Switch to ${model}`,
      value: model,
      type: 'model' as const,
    }));
}

function getVariableSuggestions(input: string): Suggestion[] {
  const match = input.match(/\$(\w*)$/);
  if (!match) return [];

  const query = match[1].toUpperCase();
  const variables = Object.keys(process.env);

  return variables
    .filter(variable => variable.startsWith(query))
    .slice(0, 10)
    .map(variable => ({
      label: `$${variable}`,
      description: process.env[variable]?.slice(0, 50) ?? '',
      value: `$${variable}`,
      type: 'variable' as const,
    }));
}

export async function getSuggestions(input: string, cwd: string): Promise<Suggestion[]> {
  if (input.startsWith('/')) {
    return getCommandSuggestions(input);
  }

  if (input.includes('@')) {
    const fileSuggestions = await getFileSuggestions(input, cwd);
    if (fileSuggestions.length > 0) return fileSuggestions;
  }

  if (input.match(/model\s+\w*$/i)) {
    return getModelSuggestions(input);
  }

  if (input.includes('$')) {
    return getVariableSuggestions(input);
  }

  return [];
}
```

- [ ] **Step 2: 验证编译通过**

```bash
npm run build
```

- [ ] **Step 3: 提交**

```bash
git add src/tui/typeahead/suggestions.ts
git commit -m "feat: extend typeahead with file, tool, model, variable suggestions"
```

---

## Task 11: 扩展自动补全 - 改进 useTypeahead

**Files:**
- Modify: `src/tui/typeahead/useTypeahead.ts`

- [ ] **Step 1: 重构 useTypeahead.ts**

```typescript
import { useState, useEffect, useCallback, useRef } from 'react';
import { getSuggestions, Suggestion } from './suggestions';

const DEBOUNCE_MS = 150;

export function useTypeahead(input: string, cwd: string) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    if (!input.trim()) {
      setSuggestions([]);
      setIsOpen(false);
      return;
    }

    debounceTimerRef.current = setTimeout(async () => {
      const newSuggestions = await getSuggestions(input, cwd);
      setSuggestions(newSuggestions);
      setIsOpen(newSuggestions.length > 0);
      setSelectedIndex(0);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [input, cwd]);

  const navigateUp = useCallback(() => {
    setSelectedIndex(prev =>
      prev > 0 ? prev - 1 : suggestions.length - 1
    );
  }, [suggestions.length]);

  const navigateDown = useCallback(() => {
    setSelectedIndex(prev =>
      prev < suggestions.length - 1 ? prev + 1 : 0
    );
  }, [suggestions.length]);

  const acceptSuggestion = useCallback(() => {
    if (suggestions[selectedIndex]) {
      return suggestions[selectedIndex].value;
    }
    return null;
  }, [suggestions, selectedIndex]);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  return {
    suggestions,
    isOpen,
    selectedIndex,
    navigateUp,
    navigateDown,
    acceptSuggestion,
    close,
  };
}
```

- [ ] **Step 2: 验证编译通过**

```bash
npm run build
```

- [ ] **Step 3: 提交**

```bash
git add src/tui/typeahead/useTypeahead.ts
git commit -m "feat: add async support and debounce to useTypeahead"
```

---

## Task 12: 扩展自动补全 - 改进 TypeaheadPopup

**Files:**
- Modify: `src/tui/typeahead/TypeaheadPopup.tsx`

- [ ] **Step 1: 重构 TypeaheadPopup.tsx**

```typescript
import React from 'react';
import { Box, Text } from 'ink';
import { Suggestion } from './suggestions';

interface TypeaheadPopupProps {
  suggestions: Suggestion[];
  selectedIndex: number;
  onSelect: (suggestion: Suggestion) => void;
}

export function TypeaheadPopup({ suggestions, selectedIndex, onSelect }: TypeaheadPopupProps) {
  if (suggestions.length === 0) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="accent"
      paddingX={1}
    >
      {suggestions.map((suggestion, index) => (
        <Box key={suggestion.value} flexDirection="row">
          <Text color={index === selectedIndex ? 'accent' : 'dimmed'}>
            {index === selectedIndex ? '> ' : '  '}
          </Text>
          <Text
            color={index === selectedIndex ? 'foreground' : 'dimmed'}
            bold={index === selectedIndex}
          >
            {suggestion.label}
          </Text>
          <Text color="dimmed" marginLeft={1}>
            {suggestion.description}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
```

- [ ] **Step 2: 验证编译通过**

```bash
npm run build
```

- [ ] **Step 3: 提交**

```bash
git add src/tui/typeahead/TypeaheadPopup.tsx
git commit -m "feat: improve TypeaheadPopup with better styling"
```

---

## Task 13: 扩展自动补全 - 集成到 PromptInput

**Files:**
- Modify: `src/tui/components/PromptInput.tsx`

- [ ] **Step 1: 更新 PromptInput 集成 useTypeahead**

检查并更新 PromptInput.tsx，确保正确集成新的 `useTypeahead` 钩子，包括：
- 传递 `cwd` 参数
- 处理异步补全的导航和选择
- 正确处理键盘事件

- [ ] **Step 2: 验证编译通过**

```bash
npm run build
```

- [ ] **Step 3: 提交**

```bash
git add src/tui/components/PromptInput.tsx
git commit -m "feat: integrate async typeahead into PromptInput"
```

---

## Task 14: 错误边界 - 创建 ErrorBoundary 组件

**Files:**
- Create: `src/tui/components/ErrorBoundary.tsx`

- [ ] **Step 1: 创建 ErrorBoundary.tsx**

```typescript
import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  retryCount: number;
}

function ErrorFallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
  useInput((input, key) => {
    if (key.return || input === 'r') {
      onRetry();
    }
  });

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="error">
      <Text color="error" bold>
        ⚠ Something went wrong
      </Text>
      <Text color="error" dimColor>
        {error.message}
      </Text>
      <Box marginTop={1}>
        <Text color="dimmed">
          Press Enter or 'r' to retry, or type /clear to reset
        </Text>
      </Box>
    </Box>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      retryCount: 0,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({
      errorInfo,
    });
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  handleRetry = () => {
    this.setState(prevState => ({
      hasError: false,
      error: null,
      errorInfo: null,
      retryCount: prevState.retryCount + 1,
    }));
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <ErrorFallback
          error={this.state.error!}
          onRetry={this.handleRetry}
        />
      );
    }

    return this.props.children;
  }
}
```

- [ ] **Step 2: 验证编译通过**

```bash
npm run build
```

- [ ] **Step 3: 提交**

```bash
git add src/tui/components/ErrorBoundary.tsx
git commit -m "feat: add ErrorBoundary component with retry support"
```

---

## Task 15: 错误边界 - 集成到应用

**Files:**
- Modify: `src/tui/app.tsx`
- Modify: `src/tui/components/MessageList.tsx`

- [ ] **Step 1: 更新 app.tsx**

```typescript
import React from 'react';
import { Box } from 'ink';
import { ThemeProvider } from './design-system/ThemeProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { REPL } from './screens/REPL';

export function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <REPL />
      </ThemeProvider>
    </ErrorBoundary>
  );
}
```

- [ ] **Step 2: 更新 MessageList.tsx 添加 ErrorBoundary**

为每条消息添加 ErrorBoundary 包装

- [ ] **Step 3: 验证编译通过**

```bash
npm run build
```

- [ ] **Step 4: 提交**

```bash
git add src/tui/app.tsx src/tui/components/MessageList.tsx
git commit -m "feat: integrate ErrorBoundary into app and message list"
```

---

## Task 16: 消息渲染改进 - 改进 ToolUseMessage

**Files:**
- Modify: `src/tui/components/ToolUseMessage.tsx`

- [ ] **Step 1: 重构 ToolUseMessage 为键盘驱动**

更新 ToolUseMessage.tsx，添加 `isFocused`、`isExpanded`、`onToggleExpand` 属性，实现键盘驱动的展开/折叠

- [ ] **Step 2: 验证编译通过**

```bash
npm run build
```

- [ ] **Step 3: 提交**

```bash
git add src/tui/components/ToolUseMessage.tsx
git commit -m "feat: implement keyboard-driven tool use expand/collapse"
```

---

## Task 17: 消息渲染改进 - 更新 MessageList 焦点管理

**Files:**
- Modify: `src/tui/components/MessageList.tsx`

- [ ] **Step 1: 添加焦点管理和键盘导航**

更新 MessageList.tsx，实现：
- `focusedIndex` 状态管理
- `expandedMessages` Set 管理
- `↑/↓` 键盘导航
- `Enter`/`Space` 展开/折叠
- 虚拟滚动支持

- [ ] **Step 2: 验证编译通过**

```bash
npm run build
```

- [ ] **Step 3: 提交**

```bash
git add src/tui/components/MessageList.tsx
git commit -m "feat: add focus management and virtual scrolling to MessageList"
```

---

## Task 18: 消息渲染改进 - 改进 Markdown 渲染

**Files:**
- Modify: `src/tui/utils/markdown.ts`
- Modify: `src/tui/components/AssistantMessage.tsx`

- [ ] **Step 1: 增强 markdown.ts 渲染器**

更新 markdown.ts，添加：
- 代码块语法高亮
- 内联代码样式
- 标题、粗体、斜体
- 链接、列表、引用块
- 水平线

- [ ] **Step 2: 更新 AssistantMessage.tsx**

使用新的 `renderMarkdown` 函数，传递 `colors` 参数

- [ ] **Step 3: 验证编译通过**

```bash
npm run build
```

- [ ] **Step 4: 提交**

```bash
git add src/tui/utils/markdown.ts src/tui/components/AssistantMessage.tsx
git commit -m "feat: enhance markdown rendering with syntax highlighting"
```

---

## Task 19: 最终验证

- [ ] **Step 1: 运行完整构建**

```bash
npm run build
```

- [ ] **Step 2: 运行测试**

```bash
npm test
```

- [ ] **Step 3: 启动应用验证**

```bash
npm start
```

验证以下功能：
1. 主题切换（dark/light/auto）
2. 会话创建和恢复
3. 消息流式渲染
4. 斜杠命令执行
5. 自动补全（/, @, model, $）
6. 工具调用展开/折叠
7. 错误边界重试
8. 键绑定配置

- [ ] **Step 4: 最终提交**

```bash
git add -A
git commit -m "feat: complete TUI optimization aligned with Claude Code architecture"
```

---

## 总结

本实现计划包含 19 个任务，涵盖：
- 主题系统统一（Task 1-3）
- useSession 拆分（Task 4-7）
- 键绑定系统完善（Task 8-9）
- 自动补全扩展（Task 10-13）
- 错误边界和消息渲染改进（Task 14-18）
- 最终验证（Task 19）

每个任务都是独立的、可验证的，确保增量重构的稳定性。
