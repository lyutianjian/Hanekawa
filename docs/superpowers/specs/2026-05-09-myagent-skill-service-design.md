# MyAgent Skill 服务设计文档

**日期：** 2026-05-09  
**作者：** Claude (Kiro)  
**状态：** 待审查

---

## 概述

为 MyAgent CLI 实现 skill 服务，参考 Claude Code 的设计模式，将 skills 作为 tools 暴露给 API，让模型可以根据场景自主决定何时调用 skill。

## 背景

MyAgent 是一个受 Claude Code 启发的最小化 CLI 编码代理。当前已实现：
- 配置服务（config）
- 会话管理（sessions）
- 工具系统（tools）
- Agent 循环（harness/loop）

**缺失功能：** Skill 服务尚未实现。

**设计目标：** 实现 skill 服务并设计全面的测试方案，确保功能正确、健壮且易于维护。

---

## 核心设计

### 架构原则

**Skills 作为 Tools：**
- 每个 skill 是一个独立的 markdown 文件，包含 YAML frontmatter 和内容
- 启动时自动扫描并转换为 Tool 对象
- 所有 skill tools 包含在每次 API 请求中
- 模型根据场景自主决定是否调用 skill tool
- Skill 内容通过 tool_result 注入到对话上下文

**Why：** 这种设计让模型能够智能地选择合适的 skill，而不需要用户手动激活。符合 Claude Code 的设计理念。

**How to apply：** 在实现时，确保 skill tools 与内置 tools 使用相同的接口和执行流程。

### 组件设计

#### 1. SkillsService 类

**职责：** 扫描、加载、解析 skill 文件

**接口：**
```typescript
export interface SkillDefinition {
  name: string
  description: string
  content: string
}

export class SkillsService {
  constructor(private readonly cwd: string)
  
  async list(): Promise<SkillDefinition[]>
  async load(name: string): Promise<SkillDefinition>
  private parse(raw: string): SkillDefinition
}
```

**实现要点：**
- 扫描 `.myagent/skills/` 目录下的所有子目录
- 每个子目录包含一个 `SKILL.md` 文件
- 使用 `yaml` 包解析 frontmatter
- 使用正则表达式分离 frontmatter 和内容：`/^---\n([\s\S]*?)\n---\n([\s\S]*)$/`
- 验证必需字段：`name` 和 `description`
- 优雅处理 ENOENT 错误（目录或文件不存在）

**Why：** 将 skill 管理逻辑封装在独立的服务类中，便于测试和维护。

#### 2. Skill Tool 工厂

**职责：** 将 SkillDefinition 转换为 Tool 对象

**接口：**
```typescript
export function createSkillTool(skill: SkillDefinition): Tool {
  return {
    name: `skill_${skill.name}`,
    description: skill.description,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    riskLevel: 'safe',
    async execute() {
      return {
        ok: true,
        content: skill.content
      }
    }
  }
}
```

**实现要点：**
- Tool 名称使用 `skill_` 前缀避免与内置 tools 冲突
- riskLevel 设为 'safe'，无需用户确认即可执行
- inputSchema 为空对象，skill 不需要参数
- execute 方法直接返回 skill 的完整内容

**Why：** Skill tools 不需要用户确认，因为它们只是提供指导内容，不会修改系统状态。

#### 3. 工具注册

**职责：** 合并内置 tools 和 skill tools

**接口：**
```typescript
// 新增函数
export async function getAllTools(cwd: string): Promise<Tool[]> {
  const builtinTools = getBuiltinTools()
  
  const skillsService = new SkillsService(cwd)
  const skills = await skillsService.list()
  const skillTools = skills.map(createSkillTool)
  
  return [...builtinTools, ...skillTools]
}

// 保留原有函数用于测试
export function getBuiltinTools(): Tool[] {
  return [grepTool, readFileTool, writeFileTool, editFileTool, deleteFileTool]
}
```

**Why：** 提供异步的 `getAllTools()` 函数，在启动时加载所有可用的 tools。保留 `getBuiltinTools()` 用于不需要 skills 的测试场景。

**How to apply：** 在创建 AgentLoop 时使用 `getAllTools(cwd)` 而不是 `getBuiltinTools()`。

---

## 工作流程

### 启动流程

```
1. CLI 启动
   ↓
2. 调用 getAllTools(cwd)
   ↓
3. SkillsService 扫描 .myagent/skills/
   ↓
4. 解析每个 SKILL.md 文件
   ↓
5. 转换为 Tool 对象
   ↓
6. 合并内置 tools 和 skill tools
   ↓
7. 创建 AgentLoop（包含所有 tools）
```

### 运行时流程

```
用户输入
   ↓
Agent Loop 构建上下文
   ↓
API 请求（包含所有 tools 定义）
   ↓
模型分析场景和可用 tools
   ↓
决定是否调用 skill tool
   ↓
[如果调用] ToolRunner 执行 skill tool
   ↓
返回 skill 内容作为 tool_result
   ↓
tool_result 记录到 session
   ↓
下一轮请求包含 skill 内容
   ↓
模型基于 skill 内容生成回复
```

---

## Skill 文件格式

### 标准格式

```markdown
---
name: debugging
description: Use when diagnosing bugs or test failures
---

# Systematic Debugging Workflow

1. **Reproduce**: Confirm the issue exists
2. **Isolate**: Narrow down the cause
3. **Fix**: Apply the solution
4. **Verify**: Test the fix works
```

### 字段说明

- **name** (必需): Skill 的唯一标识符，用于生成 tool 名称
- **description** (必需): Skill 的简短描述，作为 tool 的 description
- **content** (frontmatter 后的所有内容): Skill 的完整指导内容

### 文件位置

```
.myagent/
└── skills/
    ├── debugging/
    │   └── SKILL.md
    ├── tdd/
    │   └── SKILL.md
    └── security/
        └── SKILL.md
```

---

## 测试策略

### 测试层次

#### 1. 单元测试 (`test/skills.test.ts`)

**测试目标：** SkillsService 类的所有方法

**测试用例：**
- ✅ 列出空目录（返回空数组）
- ✅ 列出包含多个 skills 的目录
- ✅ 成功加载单个 skill
- ✅ 正确解析 YAML frontmatter 和 markdown 内容
- ✅ 将 skills 转换为 Tool 对象
- ✅ Tool 名称格式为 `skill_<name>`
- ✅ Tool 的 riskLevel 为 'safe'
- ✅ 目录不存在时返回空数组
- ✅ SKILL.md 不存在时跳过该 skill
- ✅ 无效 YAML 时抛出错误
- ✅ 缺少必需字段时抛出错误

#### 2. 工具集成测试 (`test/skills-tool-integration.test.ts`)

**测试目标：** Skill tools 与工具系统的集成

**测试用例：**
- ✅ Skill tools 正确添加到工具列表
- ✅ Skill tools 与内置 tools 共存
- ✅ Tool 名称不冲突
- ✅ 调用 skill tool 返回正确内容
- ✅ Tool result 格式正确
- ✅ 多次调用同一 skill tool 结果一致
- ✅ Skill tools 的 riskLevel 为 'safe'
- ✅ 不需要用户确认即可执行

#### 3. API 集成测试 (`test/skills-api-integration.test.ts`)

**测试目标：** Skills 在 API 请求中的行为

**测试用例：**
- ✅ Skill tools 包含在 API 请求的 tools 参数中
- ✅ Tool schema 格式符合 API 要求
- ✅ 模拟模型返回 skill tool call
- ✅ ToolRunner 正确执行 skill tool
- ✅ Skill 内容作为 tool_result 返回
- ✅ Tool result 记录到 session
- ✅ 后续请求可以看到 skill 内容
- ✅ 多个 skills 可以在同一对话中调用

#### 4. 端到端测试 (`test/skills-e2e.test.ts`)

**测试目标：** 从 CLI 启动到模型使用 skill 的完整流程

**测试用例：**
- ✅ 创建测试 skill 文件
- ✅ 启动 agent loop
- ✅ 模拟用户请求（触发 skill 使用场景）
- ✅ 验证模型自主调用了相应的 skill tool
- ✅ 验证 skill 内容在后续回复中生效
- ✅ 创建多个 skills（debugging, tdd, security）
- ✅ 模拟不同场景的用户请求
- ✅ 验证模型根据场景选择正确的 skill
- ✅ 验证可以在同一对话中调用多个 skills

#### 5. 错误处理测试 (`test/skills-errors.test.ts`)

**测试目标：** 各种异常情况的处理

**测试用例：**
- ✅ 目录不存在时优雅降级（返回空列表）
- ✅ 文件不可读时跳过该 skill
- ✅ 部分 skills 损坏不影响其他 skills
- ✅ 损坏的 YAML 时跳过该 skill
- ✅ 不完整的 frontmatter 时报错
- ✅ 特殊字符正确处理
- ✅ Skill tool 执行失败时返回错误信息
- ✅ 不会导致整个 agent loop 崩溃
- ✅ 错误信息对调试有帮助

### 测试数据

**测试 skills 示例：**

**debugging.md:**
```markdown
---
name: debugging
description: Use when diagnosing bugs or test failures
---

# Systematic Debugging Workflow

1. **Reproduce**: Confirm the issue exists
2. **Isolate**: Narrow down the cause
3. **Fix**: Apply the solution
4. **Verify**: Test the fix works
```

**tdd.md:**
```markdown
---
name: tdd
description: Test-driven development workflow
---

# TDD Process

1. Write a failing test
2. Implement the minimum code to pass
3. Refactor while keeping tests green
```

---

## 实现计划

### Phase 1: 核心实现

1. **实现 SkillsService 类** (`src/services/skills/skillsService.ts`)
   - 实现 `list()`, `load()`, `parse()` 方法
   - 处理文件系统错误
   - 验证 frontmatter 字段

2. **创建 Skill Tool 工厂** (`src/tools/skillTool.ts`)
   - 实现 `createSkillTool()` 函数
   - 确保 tool 名称格式正确
   - 设置正确的 riskLevel

3. **集成到工具系统** (`src/tools/index.ts`)
   - 实现 `getAllTools()` 函数
   - 合并内置 tools 和 skill tools

### Phase 2: 测试实现

4. **编写单元测试** (`test/skills.test.ts`)
   - 测试 SkillsService 的所有方法
   - 覆盖正常、边界、错误情况

5. **编写工具集成测试** (`test/skills-tool-integration.test.ts`)
   - 测试 tool 注册和执行

6. **编写 API 集成测试** (`test/skills-api-integration.test.ts`)
   - 测试 skills 在 API 请求中的行为

7. **编写端到端测试** (`test/skills-e2e.test.ts`)
   - 测试完整的用户工作流

8. **编写错误处理测试** (`test/skills-errors.test.ts`)
   - 测试各种异常情况

### Phase 3: 可选功能

9. **添加命令支持** (`src/commands/index.ts`)
   - 实现 `/skills list` 命令
   - 显示所有可用 skills

### Phase 4: 验证

10. **运行测试套件**
    - `npm test` - 所有测试通过
    - `npm run typecheck` - 无 TypeScript 错误

11. **手动验证**
    - 创建测试 skill 文件
    - 启动 CLI 并测试
    - 验证模型自主调用 skills

---

## 验证标准

### 功能完整性

- ✅ 可以扫描并加载所有可用的 skills
- ✅ 每个 skill 自动转换为一个 Tool
- ✅ Skill tools 包含在每次 API 请求中
- ✅ 模型可以根据场景自主决定调用哪个 skill
- ✅ Skill 内容通过 tool_result 注入到对话

### 健壮性

- ✅ 优雅处理各种错误情况（目录不存在、文件损坏等）
- ✅ 部分 skills 损坏不影响其他 skills
- ✅ 提供清晰的错误消息
- ✅ 不会因为异常而崩溃

### 代码质量

- ✅ TypeScript 类型检查通过
- ✅ 所有测试用例通过
- ✅ 测试覆盖率 > 90%
- ✅ 代码符合项目风格

### 用户体验

- ✅ Skills 自动可用，无需手动激活
- ✅ 模型智能选择合适的 skill
- ✅ `/skills list` 命令可查看所有可用 skills
- ✅ 符合 MyAgent 的整体设计风格

---

## 关键文件

**实现文件：**
- `src/services/skills/skillsService.ts` - Skill 服务实现
- `src/tools/skillTool.ts` - Skill 到 Tool 的转换工厂
- `src/tools/index.ts` - 工具注册（修改）
- `src/commands/index.ts` - 命令集成（可选）

**测试文件：**
- `test/skills.test.ts` - 单元测试
- `test/skills-tool-integration.test.ts` - 工具集成测试
- `test/skills-api-integration.test.ts` - API 集成测试
- `test/skills-e2e.test.ts` - 端到端测试
- `test/skills-errors.test.ts` - 错误处理测试

---

## 风险和缓解

### 风险 1: Skill 文件格式不一致

**描述：** 用户可能创建格式不正确的 skill 文件

**缓解：**
- 严格验证 frontmatter 字段
- 提供清晰的错误消息
- 在文档中提供标准模板

### 风险 2: Skill 内容过大

**描述：** 某些 skill 可能包含大量内容，影响 token 预算

**缓解：**
- 在文档中建议 skill 内容保持简洁
- 未来可以考虑添加内容长度限制
- 当前不实施限制，依赖用户自行控制

### 风险 3: Skill 名称冲突

**描述：** 多个 skills 可能使用相同的名称

**缓解：**
- Skill 名称由目录名决定，文件系统保证唯一性
- 如果 frontmatter 中的 name 与目录名不一致，使用目录名

---

## 未来扩展

### 可能的增强功能

1. **Skill 版本管理**
   - 支持多个版本的 skill
   - 允许用户选择特定版本

2. **Skill 市场**
   - 从远程仓库下载 skills
   - 分享和发布 skills

3. **Skill 参数化**
   - 允许 skills 接受参数
   - 更灵活的 skill 定制

4. **Skill 统计**
   - 记录 skill 使用频率
   - 分析哪些 skills 最有用

5. **Skill 热加载**
   - 无需重启即可加载新 skills
   - 支持 skill 文件的实时更新

**注意：** 这些功能不在当前 MVP 范围内，仅作为未来参考。
