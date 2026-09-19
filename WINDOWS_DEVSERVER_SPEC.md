# Windows 下 dev server 不可达 + 子进程卫生 — 工程规格

- 状态:Draft
- 日期:2026-09-18
- 范围:`BashTool` 子进程 env / 进程清理、dev server 在 Windows 上的可达性
- 不含:模型提示词/技能层以外的产品行为变更

---

## 1. 背景与问题

在本机(Windows + FlClash TUN)上用 Hanekawa 起 Vite 项目时,`npm run dev` 后浏览器访问 `http://localhost:5173/` 被拒绝连接(ECONNREFUSED),且**每次稳定复现**。换用商用 agent(Claude Code,下称 CC)时未复现。

## 2. 根因分析(已实测核实)

### 2.1 IPv6-only 绑定 + 本机 IPv6 回环不通(主因)

- Vite 默认 `server.host = 'localhost'`。Node 17+(本机 v24.18.1)默认 DNS 顺序为 `verbatim`,Windows 上 `localhost` 先返回 `::1`,故 Vite 只在 `[::1]:5173` 监听,IPv4 `127.0.0.1:5173` 无 listener。
- 本机 IPv6 回环不可达:`netstat` 显示 `[::1]:5173 LISTENING`,但 `curl http://[::1]:5173/`、PowerShell `Test-NetConnection ::1 -Port 5173`、`Invoke-WebRequest http://[::1]:5173/` 三方均连不上。高度怀疑 FlClash TUN 干扰 IPv6 回环路由(`FlClash` 适配器在位、IPv6Connectivity=NoTraffic;未通过"关停 FlClash 再测"100% 坐实,但证据最强)。
- 排除项:Windows 防火墙排除端口仅 50000-50059,5173 未被排除;hosts 文件无 `localhost` 条目;系统代理 `ProxyEnable=0`(代理不是主因)。

### 2.2 可达性验证(已实测)

| 方案 | 结果 |
|---|---|
| 默认 `npm run dev` | 绑 `[::1]:5173`,不可达 |
| `NODE_OPTIONS=--dns-result-order=ipv4first npm run dev`(配置保持默认) | 绑 `127.0.0.1:5173`,`localhost`/`127.0.0.1` 均 HTTP 200 ✅ |
| `vite.config` 设 `server.host: '127.0.0.1'` | 绑 `127.0.0.1:5173`,HTTP 200 ✅ |

结论:**根因是 Vite 默认 IPv6 绑定撞上本机 IPv6 回环不通**,与具体哪个 agent 无关(纯命令行也复现)。`ipv4first` 或 `host: '127.0.0.1'` 任一即可绕开。

### 2.3 为何"CC 不复现、Hanekawa 每次复现"

差异**不在 IPv6 轴**(CC 也不强制 IPv4,见 §4),而在子进程卫生:

- Hanekawa 后台 shell 仅在 `shutdown`/`/clear` 清理,主 agent 跨轮次重跑 `npm run dev` 时旧 vite 仍占 5173 → 新 vite 跳端口 → 5173 不可达。
- CC 有 per-subagent 退出清理 + shutdown 清理,孤儿更少。

## 3. 现状(Hanekawa,已核实)

| 点 | 现状 | 位置 |
|---|---|---|
| spawn env | 不传 `env`,继承 `process.env`;不设 `--host`/`ipv4first` | `src/tools/BashTool/BashTool.ts:284-289, 319-328` |
| Windows `detached` | `process.platform !== 'win32'`(=false) | `BashTool.ts:286, 323` |
| 杀进程 | `taskkill /PID <pid> /T [/F]`(树杀) | `src/services/backgroundTasks/processTree.ts:7-23, 38-46` |
| `registerShell` | 仅 `{sessionId, command, proc}`,**无 owner** | `registry.ts:98` |
| `stopAll` 调用点 | 仅 `shutdown`、`/clear` | `bootstrap.ts:360`、`sessionSwitch.ts:91` |
| subagent 退出钩子 | `runSubagent` 有 finally,但 shell 任务挂在父 sessionId 下("filed under the parent session") | `AgentTool.ts:636, 900` |
| web 技能 host 指引 | 无 | grep `.myagent/skills` 零命中 |

### 3.1 近期改动(env 机制,已 review)

- `BashTool.ts` 新增 `env?` 入参 + `buildSubprocessEnv()` + `SENSITIVE_ENV_VARS` 清单;两处 spawn 接入 `env: spawnEnv`;`prompt.ts` 补 `env` 说明;`test/bashShell.test.ts` 加 3 测试。
- **缺口**(详见前次 review):
  - 无 `ipv4first` 注入 → **未修掉 §2.1 根因**;
  - 脱敏**无条件全量**,清单不全(缺 `NPM_TOKEN`/`AZURE_*`/`HF_TOKEN`/`STRIPE_SECRET_KEY`/`DATABASE_URL` 等 + `*_TOKEN/_KEY/_SECRET` 模式),会误伤 `gh`/`aws`/`npm publish`;
  - 测试缺 `NODE_OPTIONS` 合并用例与 IPv4 回归覆盖。

## 4. CC 设计对照(已核实源码)

| 维度 | CC | 位置 |
|---|---|---|
| spawn env | `{...subprocessEnv(), SHELL, GIT_EDITOR:'true', CLAUDECODE:'1', ...envOverrides}`,**无 ipv4/host** | `ClaudeCode/src/utils/Shell.ts:316-337` |
| 子进程 env | 近乎原样 `process.env`,不强制 IPv4 | `utils/subprocessEnv.ts:79-99` |
| 敏感 env 脱敏 | **门控**(`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`),仅 GHA 不可信上下文生效;本地不脱敏;**故意保留 `GH_TOKEN`/`GITHUB_TOKEN`** | `subprocessEnv.ts:15-53, 86-98` |
| Windows 杀进程 | `tree-kill` 包 → `taskkill /pid <pid> /T /F`(与 Hanekawa 同) | `node_modules/tree-kill/index.js:27-30` |
| `detached`(bash) | **`true`**(不分平台) | `utils/shell/bashProvider.ts:75` |
| 后台 shell 清理 | TaskStop 显式 + **subagent 退出 `killShellTasksForAgent`** + shutdown;每轮 interrupt **转后台不杀** | `tasks/LocalShellTask/killShellTasks.ts:53-76`、`utils/gracefulShutdown.ts:447` |
| dev server 专用工具 | 无,走通用 BashTool,不 scaffold `vite.config`、不注入 `--host` | — |

**关键结论:CC 也不强制 IPv4,IPv6 根因非 agent 差异;CC 的真优势在进程卫生(per-subagent 清理)与脱敏门控。**

## 5. 目标 / 非目标

### 目标
1. **修掉根因**:让 agent 起的 node 系 dev server 在 Windows 上默认绑 IPv4 可达。
2. **对齐 CC 的子进程卫生**:`detached`、脱敏门控、shell 清理时机。
3. 不误伤 `gh`/`aws`/`npm publish` 等合法工具。

### 非目标
- 不改模型提示词/技能层(另案;但 W0 给出建议)。
- 不引入 Windows Job Object / `wmic` 递归杀(`taskkill /T /F` 与 CC 一致即可)。
- 不改 subagent "filed under parent session" 的归属设计(§9 W4 用 owner 字段绕开,不动 sessionId 归属)。

## 6. 工作项

### W0(P0)— IPv4 绑定:修掉根因

> (a)(b)(c) 三项**都不修这个 bug**,CC 也没修。必须单独立项。

**动机**:§2.1。

**方案二选一**:

- **W0a(推荐,一处生效)**:在 `buildSubprocessEnv` 里 win32-only 注入 `NODE_OPTIONS=--dns-result-order=ipv4first`,与已有 `NODE_OPTIONS` **合并(追加,不覆盖)**。所有 node 系 dev server 自动绑 IPv4。
- **W0b(模型层)**:在 `web-design-engineer` 技能里强制/教模型写 `server.host: '127.0.0.1'`。不如 W0a 可靠(依赖模型)。

**改动点**:`src/tools/BashTool/BashTool.ts` `buildSubprocessEnv()`(当前 55-78 行)。

**签名建议**:
```ts
const IPV4FIRST = '--dns-result-order=ipv4first'
function withIpv4Dns(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return env
  const cur = env.NODE_OPTIONS?.trim()
  env.NODE_OPTIONS = !cur ? IPV4FIRST
    : cur.includes(IPV4FIRST) ? cur
    : `${cur} ${IPV4FIRST}`
  return env
}
// buildSubprocessEnv 末尾:return withIpv4Dns(env)
```

**范围注记**:`NODE_OPTIONS` 会对该 spawn 出来的所有 node 调用生效(含 `npm install`/build),`ipv4first` 对这些基本无害。若要更精准,把 `options.command` 传入 `buildSubprocessEnv`,仅在匹配 dev server 模式(`vite`/`next dev`/`nuxt dev`/`astro dev`/`npm run dev`/`npm run preview`)时注入。

**验收**:
- Win 上默认 `npm run dev` 起 vite → `netstat` 显示 `127.0.0.1:5173 LISTENING`,`curl http://localhost:5173/` HTTP 200。
- 已有 `NODE_OPTIONS` 值被保留且 `ipv4first` 被追加(不覆盖)。
- macOS/Linux 行为不变(`process.env.NODE_OPTIONS` 不被注入)。

---

### W1 — Windows `detached: true`(对齐 CC)

**动机**:§4,`bashProvider.ts:75` CC 无条件 `true`;Hanekawa `false`。配合 tree-kill 自管终止,own console 更干净。

**改动点**:`BashTool.ts:286` 与 `:323`,把 `detached: process.platform !== 'win32'` 改为 `detached: true`。`windowsHide: true` 已在位。

**验收**:两处 spawn `detached: true`;`taskkill /T` 仍能树杀;全量测试通过。

**风险**:低。`detached: true` 在 Windows 创建新 console,`windowsHide` 已隐藏。

---

### W2 — env 脱敏门控 + 清单补全(对齐 CC + 修误伤)

**动机**:§3.1,当前无条件全量脱敏会误伤 `gh`/`aws`/`npm publish`;CC 是门控 + 精细清单 + 保留 `GH_TOKEN`。

**改动点**:`BashTool.ts` `SENSITIVE_ENV_VARS` 与 `buildSubprocessEnv`。

**设计**:
- 加开关 `HANEKAWA_SUBPROCESS_ENV_SCRUB`(读 `process.env`,默认 falsy = **本地不脱敏**,子进程拿完整 env)。
- 仅当开关为真时执行 scrub 循环;否则跳过(只保留 `GIT_EDITOR`/`GIT_SEQUENCE_EDITOR` 与 customEnv 合并)。
- 清单补全:`NPM_TOKEN`、`NPM_AUTH_TOKEN`、`AZURE_CLIENT_SECRET`、`AZURE_CLIENT_CERTIFICATE_PATH`、`GOOGLE_APPLICATION_CREDENTIALS`、`HF_TOKEN`、`HUGGING_FACE_TOKEN`、`STRIPE_SECRET_KEY`、`DATABASE_URL`、`OTEL_EXPORTER_OTLP_HEADERS`、`ACTIONS_*` 等 + 通配 `/.*(_TOKEN|_KEY|_SECRET|_PASSWORD|_CREDENTIAL.*)$/i`。
- **`GH_TOKEN`/`GITHUB_TOKEN` 不进清单**(gh wrapper 需要)。
- 可选:未来加"不可信上下文"探测(如 `GITHUB_ACTIONS=true`),但当前 Hanekawa 不跑在 GHA,默认关即可。

**验收**:
- 默认(开关关):子进程 env 含 `ANTHROPIC_API_KEY` 等原值(不脱敏);`gh`/`aws` 可用。
- 开关开:清单内 key 被删,通配模式命中 `MY_API_KEY`;`GH_TOKEN` 保留。
- 现有两个 scrub 测试改为先置开关,新增"默认关=完整 env"测试。

---

### W3 — dev server 重启卫生(便宜、直击主因)

> 这是 §2.3 主复现路径(主 agent 跨轮次重跑 `npm run dev`)的对症修复,**比 W4 更该先做**。

**动机**:主 agent 在后续轮次再起 `npm run dev`,旧 vite 仍占 5173 → 跳端口。

**方案**:registry 加 `killShellsByCommandPattern(sessionId, pattern)`,在 BashTool 起一个匹配 dev server 模式的后台命令前,先杀同 session 内匹配的旧任务;或暴露给模型经 `KillShellTool` 调用。可叠加技能层提示"重启 dev server 前先 KillShell 旧的"。

**改动点**:`registry.ts`(新方法)、`BashTool.ts`(起后台 dev server 前调用)、可选 `KillShellTool`。

**验收**:同 session 内已有一个 `npm run dev`(占 5173),再起一个时旧的被先杀,新的稳定绑 5173,不跳端口。

---

### W4(可选,较重)— subagent 退出清理(owner 追踪)

**动机**:对齐 CC `killShellTasksForAgent`;subagent 退出时清理其 shell。**注意:不做"每轮清理"——那会每条消息杀掉 dev server,是回归。** 正确范围是 per-subagent-exit。

**为何贵**:§3,`registerShell` 无 owner,subagent shell 挂父 sessionId,`stopAll(parentSessionId)` 会误杀主 agent 的 dev server。需加 owner 追踪。

**改动点**:
1. `registry.ts`:`registerShell` 入参加 `ownerAgentId?`;`InternalTask`/`BackgroundTaskSnapshot` 加字段(注意持久化结构同步)。
2. `registry.ts`:新增 `stopShellsForAgent(sessionId, agentId)`(只杀 `kind==='shell' && ownerAgentId===agentId`)。
3. `BashTool` tool context:把 agentId 透下去(确认 `ToolRunner` 给 tool 的 context 是否含 agentId,无则加)。
4. `AgentTool.ts:900` finally:调 `stopShellsForAgent`。
5. 测试:owner 隔离、subagent 退出只杀自身 shell、主 agent shell 不受影响。

**验收**:subagent 起的后台 shell 在 subagent 结束后被杀;主 agent 的后台 shell 不受影响;持久化快照含 owner 字段且向前兼容。

**风险**:中,碰快照/持久化。

## 7. 工作量汇总

| 项 | 工作量 | 风险 | 优先级 |
|---|---|---|---|
| W0 IPv4first | ~2-4h | 低 | P0(修根因) |
| W1 detached | ~0.5-1h | 低 | P1 |
| W2 脱敏门控 | ~2-4h | 低 | P1(修误伤) |
| W3 重启卫生 | ~2-4h | 低 | P1(直击主因) |
| W4 owner 追踪 | ~0.5-1d | 中 | 可选 |

**建议顺序**:W0 → W2 → W1 → W3 →(可选)W4。W0+W2+W1+W3 约 1-1.5 天,可闭环"连不上"+"误伤"+"主因跳端口";W4 是 CC 对齐的完整性补齐,可后置。

## 8. 整体验收

- Windows 上 `npm run dev`(默认配置)→ `http://localhost:5173/` HTTP 200。
- 连续两轮 `npm run dev` 不跳端口(W3)。
- `gh auth status` / `aws ...` / `npm publish`(需 token)在默认脱敏设置下不被误伤(W2)。
- `taskkill`/退出清理行为在 macOS/Linux 不回归。
- `npm test` 全绿,typecheck 0 错。

## 9. 非目标 / 未来工作

- Windows Job Object / `wmic` 递归杀(比 `taskkill /T` 更稳,但当前与 CC 一致即可)。
- 真正的"不可信上下文"探测(GHA/`allowed_non_write_users` 等价物),Hanekawa 暂无此场景。
- 技能层 `server.host` 指引(W0b),可与 W0a 并行作为模型层兜底。

## 10. 参考证据

- 根因实测:见 §2.2 表(`ipv4first` 与 `host` 均验证 HTTP 200)。
- Hanekawa 源码:`BashTool.ts:55-78`(buildSubprocessEnv)、`:286,323`(detached)、`processTree.ts:7-46`、`registry.ts:98`(registerShell)、`bootstrap.ts:360`/`sessionSwitch.ts:91`(stopAll 调用点)、`AgentTool.ts:636,900`(subagent 归属+finally)。
- CC 源码:`ClaudeCode/src/utils/Shell.ts:316-337`、`utils/subprocessEnv.ts:15-99`、`utils/shell/bashProvider.ts:75`、`tasks/LocalShellTask/killShellTasks.ts:53-76`、`node_modules/tree-kill/index.js:27-30`。
- 本机环境:Node v24.18.1(verbatim DNS 默认);FlClash TUN 适配器在位(IPv6 NoTraffic);网络配置文件 Public;防火墙排除端口仅 50000-50059。
