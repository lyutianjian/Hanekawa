// TUI 入口点 — 集成 AgentLoop

import React from 'react'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '../ink.js'
import { AppStateProvider } from '../state/AppState.js'
import { createStore } from '../state/store.js'
import { getDefaultAppState, type AppState } from '../state/AppStateStore.js'
import { REPL } from '../screens/REPL.js'

// Agent 核心
import { ConfigService } from '../../config/service.js'
import { createProvider } from '../../config/providers.js'
import { SessionStore } from '../../sessions/service.js'
import { getAllTools } from '../../tools/index.js'
import { ToolRunner } from '../../harness/toolRunner.js'
import { PermissionGate } from '../../harness/permissions.js'
import { ContextBuilder } from '../../harness/contextBuilder.js'
import { AgentLoop } from '../../harness/loop.js'
import { SkillsService } from '../../services/skills/skillsService.js'
import { getHighlightFn } from '../utils/cliHighlight.js'

async function main() {
  await getHighlightFn() // 预加载语法高亮

  const cwd = process.cwd()

  // 初始化配置
  const config = new ConfigService(cwd)
  await config.load()

  const modelConfig = config.getDefaultModel()
  if (!modelConfig) {
    console.error('No default model configured.')
    process.exit(1)
  }

  const provider = createProvider(modelConfig)
  if (!provider) {
    console.error(`Failed to create provider for: ${modelConfig.provider}`)
    process.exit(1)
  }

  // 初始化 session
  const store = new SessionStore(cwd)
  await store.init()
  const session = await store.create()

  // 初始化 tools 和 skills
  const tools = await getAllTools(cwd)
  const skills = await new SkillsService(cwd).list()

  // 创建共享 store — PermissionGate 回调和 TUI 组件都需要访问
  const appStore = createStore<AppState>(getDefaultAppState())

  // 权限 — 通过 TUI Dialog 让用户确认
  const permissionGate = new PermissionGate(async (request) => {
    return new Promise<boolean>((resolve) => {
      appStore.setState(prev => ({
        ...prev,
        pendingPermission: {
          toolName: request.tool.name || 'unknown',
          input: request.input,
          reason: request.reason,
          riskLevel: request.tool.riskLevel || 'confirm',
          resolve,
          onAlwaysAllow: request.onAlwaysAllow,
        },
      }))
    })
  })

  const toolRunner = new ToolRunner(tools, permissionGate, {
    onRecord: async (record) => {
      await store.appendRecord(session.id, record)
    },
  })

  const contextManagement = config.get().agent.contextManagement
  const isGitRepo = existsSync(join(cwd, '.git'))

  // 创建 AgentLoop
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
  })

  // 渲染 TUI
  render(
    <AppStateProvider externalStore={appStore}>
      <REPL loop={loop} session={session} appStore={appStore} sessionStore={store} />
    </AppStateProvider>,
  )
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
