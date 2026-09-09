# Hanekawa 图像输入实现技术文档

日期：2026-09-08
配套设计稿：[MULTIMODAL_INPUT_DESIGN.md](./MULTIMODAL_INPUT_DESIGN.md)
状态：任务分解与实施计划；本文件不代表任何任务已经完成。

本文件把设计稿拆成 **27 个会话目标**（S01–S27），每个会话目标的规模按“一次会话内可以做完、跑绿窄测、提交一次”设计。设计决策以设计稿为准，本文件只负责“按什么顺序做、一次做多少、做到什么程度算完成”。

---

## 0. 使用方式

### 0.1 `[ ]` 是会话目标

方括号标在**会话**上，不标在更细的步骤上。一个方括号 = 一次会话 = 一个 commit。

- `[ ]` 未开始
- `[~]` 进行中（会话中途结束时用，必须同时在该会话的「本次进展」行写清做到哪一步）
- `[x]` 已完成并已提交
- `[-]` 已确认不做（必须写明原因）

第 2 节的总览表与各会话标题的方括号必须同步；只改一处视为未完成。

### 0.2 一次会话的工作流

1. 打开本文件，找到第一个 `[ ]` 的会话，从它的「目标 / 前置 / 涉及文件 / 工作项」开始——每个会话块都写成可以冷启动的形式，不需要先读完整份文档。
2. 读设计稿对应章节，再读「涉及文件」与最近的测试文件。
3. 按「工作项」顺序实现，保持无关工作区改动不被顺带修改。
4. 跑「验证」里的窄测试；跨层会话追加 `npm run typecheck`。
5. 全绿后把该会话的 `[ ]` 改成 `[x]`，总览表同步。
6. 提交：代码改动 + 本文件的标注放在**同一个 commit**：

   ```
   checkpoint: S07 thread UserInput through submission path
   ```

### 0.3 会话没做完怎么办

不要硬撑到上下文耗尽。规模标为「长」的会话都给了**建议断点**，到断点就：

1. 把该会话状态改成 `[~]`，在「本次进展」写明完成到第几个工作项、剩余项有没有前提变化。
2. 提交当前已通过测试的部分（`checkpoint: S20 (1/2) ...`）。
3. 下次会话从「本次进展」接着做，做完再改 `[x]`。

**每个 commit 之后仓库都必须 `npm run typecheck` 通过。** 允许功能未接通（类型已加、UI 未接），不允许留下类型错误或红测试。

### 0.4 工程约定（所有会话适用）

- 相对导入带 `.js` 扩展名；严格 schema 从 `zod/v3` 引入。
- `prompts/` 不得 import `harness/`；`services/` 可依赖 `tools/`，反向不可；renderer 不得 value-import `harness/`、`services/`、`sessions/`、`commands/`、`tui/`。
- 新增纯数据类型放 `src/media/types.ts`，供 config、protocol、budget、两端 UI 共同引用。
- 协议 wire 值必须能通过 `structuredClone`；命令用 strict schema，dispatch 用 `assertNever` 保持穷尽。
- 记录（JSONL）只写附件引用，不写 Base64 / `File` / `Blob` / `NativeImage` / 临时 URL。
- 新增字段一律可选；旧会话与旧配置按纯文本读取，不做批量迁移。

---

## 1. 会话总览

### 1.1 依赖链

```text
S01 ─┬─> S02 ─> S03 ────────────┐
     └─> S04 ─> S05 ─────┐      │
                         ├─> S06 ─> S07 ─> S08 ─┬─> S09 ─┐
                         │                       ├─> S10 ─┤
                         │                       ├─> S11 ─> S12
                         │                       └─> S13 ─> S14
                         └────────────> S15 ─> S16 ─> S17 ─> S18 ─> S19
                                                                    │
                                    S20 / S21 / S22 / S23 / S24 <───┘
                                                    │
                                    S25 ─> S26 ─> S27
```

S02 与 S04 在 S01 之后可并行（互不 import）。S09/S10/S11/S13 四条输入入口在 S08 之后互相独立，顺序可调。S15–S19 建议在 S11 之前完成，这样 Desktop 才能显示准确的阻止原因。

### 1.2 总览表

| # | 会话目标 | 前置 | 规模 | 状态 |
| --- | --- | --- | --- | --- |
| S01 | `sharp` 依赖验证与图像测试夹具 | — | 短 | `[x]` |
| S02 | 模型图像能力：配置字段、判定函数、运行时快照 | S01 | 中 | `[x]` |
| S03 | 两端模型设置开关与选择器能力标记 | S02 | 中 | `[x]` |
| S04 | 图像解码归一化与压缩阶梯 | S01 | 长 | `[x]` |
| S05 | 附件存储、解析、缩略图与回收 | S04 | 中 | `[x]` |
| S06 | 记录与上下文类型接入 `images`，持久化兼容 | S02, S05 | 中 | `[x]` |
| S07 | `UserInput` 贯穿提交路径与中断恢复 | S06 | 长 | `[x]` |
| S08 | 协议命令与 wire schema | S07 | 中 | `[x]` |
| S09 | `@` 图片引用 | S08 | 中 | `[x]` |
| S10 | `Read` 工具图片分流 | S06 | 中 | `[x]` |
| S11 | Desktop 采集与草稿状态机 | S08, S19 | 长 | `[x]` |
| S12 | Desktop 预览、缩略图与打开原图 | S11 | 短 | `[x]` |
| S13 | TUI 图片剪贴板采集（三平台） | S08 | 中 | `[x]` |
| S14 | TUI 路径粘贴、附件列表与 `/paste-image` | S13 | 中 | `[x]` |
| S15 | 当前轮/历史轮判定与历史降级投影 | S06 | 长 | `[x]` |
| S16 | `mediaStrip` 数量限制与图像 token 预算 | S15 | 中 | `[x]` |
| S17 | Anthropic payload 图像映射 | S16, S05 | 中 | `[x]` |
| S18 | OpenAI payload 图像映射与工具图片合成消息 | S16, S05 | 中 | `[x]` |
| S19 | 发送前最终校验与日志遮蔽 | S17, S18 | 中 | `[x]` |
| S20 | 消息队列持久化与交接改造 | S19, S11 | 长 | `[x]` |
| S21 | 模型切换、fallback 与 plan 路由 | S15, S02 | 中 | `[x]` |
| S22 | compact 与历史清理的图像投影 | S15, S16 | 长 | `[ ]` |
| S23 | 子代理继承与会话生命周期附件归属 | S05, S06 | 中 | `[ ]` |
| S24 | 错误分类与两端展示 | S09–S14, S19 | 中 | `[ ]` |
| S25 | 全量 typecheck / 测试 / 构建 | S20–S24 | 短 | `[ ]` |
| S26 | Desktop 冒烟与 TUI 三平台人工验证 | S25 | 中 | `[ ]` |
| S27 | `README.md` 与验收矩阵签收 | S26 | 短 | `[ ]` |

规模含义：短 = 半场会话即可；中 = 一次会话舒适完成；长 = 需要盯紧上下文，块内给了建议断点。

---

## S01 `[x]` `sharp` 依赖验证与图像测试夹具

**前置**：无 · **规模**：短 · **设计稿**：§8、§14.2
**涉及**：`package.json`、`scripts/copy-desktop-assets.mjs`、`tsconfig.build.json`、新增 `test/fixtures/images/`、`test/helpers/`

`sharp` 目前不在依赖里。它是整个 M2 的地基，必须先确认可行再往上叠功能，所以放在第一个会话。

**工作项**

1. 引入 `sharp`，验证三件事：Node 22 下可 `require`；Electron 43 主进程可加载（ABI 不同，必要时配平台包或 rebuild）；`npm run build:desktop` 后 dist 仍能找到原生二进制。
2. 确认处理只发生在 Node/主进程侧。**renderer 永远不 import `sharp`**，也不做浏览器 Canvas 后备实现。
3. 准备少量真实小图 fixture（每个数 KB）：透明 PNG、带 EXIF 方向的 JPEG、静态 WebP、单帧与多帧 GIF、伪扩展名文件（PNG 内容命名为 `.jpg`）、损坏文件。超限场景用程序生成，不提交大文件。
4. 增加测试 helper：构造 `ImageAttachmentRef`、创建临时附件目录、断言 payload 中图像块已被遮蔽。

**完成判据**：一个最小脚本能在 Node 与 Electron 两侧解码 fixture PNG 并打印尺寸；`npm run build:desktop` 成功；helper 可被后续测试直接引用。
**若某平台安装失败**：在本块下如实记录，并给出降级路径（该平台禁用图片采集入口而非静默出错），不要用 mock 掩盖。
**验证**：`npm run typecheck`、`npm run build:desktop`
**提交**：`checkpoint: S01 add sharp dependency and image fixtures`

**执行记录（2026-09-08，Windows x64）**

- `sharp@0.35.4`（vips 8.18.6）经 npm 安装，走 `@img/sharp-win32-x64` N-API 预编译包，Node 与 Electron 共用同一份二进制，无需 electron-rebuild。本机 Node 为 v24.18.1（满足 engines >= 22）。
- 两侧验证脚本：`npm run verify:sharp`（Node）与 `npm run verify:sharp:electron`（Electron 43.4.0 主进程），均成功解码 `test/fixtures/images/transparent.png`（64x64）并打印尺寸，退出码 0。
- `npm run build:desktop` 通过。主进程经 tsc 输出、不做 bundle，运行时从仓库根 `node_modules` 解析 `sharp`，`dist` 无需复制原生二进制——因此 `scripts/copy-desktop-assets.mjs` 与 `tsconfig.build.json` 本会话无需改动。
- 夹具 7 个（每个 ≤ 5 KB）：`transparent.png`、`exif-orientation.jpg`（EXIF orientation=6，刻意 64x48 非正方形，否则「是否已按 EXIF 旋转」无法从尺寸观测）、`static.webp`、`single-frame.gif`、`animated.gif`（3 帧）、`png-named-jpg.jpg`（PNG 内容、`.jpg` 文件名）、`corrupt.png`；由 `scripts/make-image-fixtures.mjs` 生成并可复现，动画 GIF 由脚本内嵌的极简 LZW 编码器打包（sharp 无法从 raw 输入直接构造多帧）。
- helper 位于 `test/helpers/imageFixtures.ts`：`fixtureImagePath` / `loadFixtureBytes` / `makeImageAttachmentRef` / `createTempAttachmentArea`（S05 布局）/ `assertNoImageBytes`（遮蔽断言）；`test/imageFixtures.test.ts` 覆盖夹具解码矩阵、helper 行为，以及「renderer 与 preload 不得引用 sharp」的源码扫描。
- macOS / Linux 的真实安装与运行验证留待 S26 平台矩阵；本会话仅 Windows x64 实测。

---

## S02 `[x]` 模型图像能力：配置字段、判定函数、运行时快照

**前置**：S01 · **规模**：中 · **设计稿**：§4.1、§5.1
**涉及**：新增 `src/media/types.ts`、`src/config/service.ts`、`src/config/providers/registry.ts`、`src/runtime/providerRuntime.ts`、`src/runtime/modelPicker.ts`、`src/runtime/types.ts`、`src/runtime/protocol/wire.ts`

**工作项**

1. 建 `src/media/types.ts`：`ImageAttachmentRef`、`UserInput`、`ImageBearingContent`，以及附件元数据类型（原始 MIME、原始文件名、原始尺寸、EXIF 方向、校验摘要、处理版本、发送版本尺寸、本地路径）。同时定义错误原因枚举：`model-not-capable`、`unsupported-format`、`decode-failed`、`file-missing`、`image-too-large`、`request-too-large`、`too-many-images`。
   纯类型 + 纯常量，**不 import** `harness/`、`services/`、`sharp`、`node:fs`，以便 renderer / `prompts/` / `config/` 都能安全引用。
2. `ModelConfig` 增加可选 `supportsImageInput`。缺省等价 `false`；只有严格 `=== true` 才算开启，字符串 `"true"` 不算。不从 endpoint、模型名、`contextWindow` 推断；同一 endpoint 下不同模型可不同。编辑模型其他字段不得重置该值；删除模型/endpoint 的引用修复不受影响。
3. 单一导出的判定函数（如 `resolveImageCapability(model, endpoint)`）= 模型开关 && Provider 适配器实现图像输入。运行时与 UI **只调它**，不各自维护白名单。Provider 适配器暴露能力标记（Anthropic Messages、OpenAI Chat Completions 首版为 true，其余 false）。该函数不读文件、不发网络、不做探测。
4. 能力进入 `ActiveModelRuntime`、运行时快照与模型选择项，wire 值保持可 `structuredClone`，change kind 唯一。

**关键约束**：图像能力**不属于**会话 scope 快照类字段（那是 `agent.contextManagement` 和 `permissions.mode`），必须按“实际请求时的模型”解析，不能在会话开始时固化。

**完成判据**：单测覆盖缺省关闭、显式开启、编辑其他字段后保留、非布尔值不算开启，以及“开关开但适配器不支持”“开关关但适配器支持”两种组合。
**验证**：`node --import tsx --test test/config.test.ts test/configMigration.test.ts test/modelPicker.test.ts`
**提交**：`checkpoint: S02 add model image capability config and resolution`

**执行记录（2026-09-08，Windows x64）**

- 新增 `src/media/types.ts`：`ImageAttachmentRef` / `UserInput` / `ImageBearingContent` / `ImageAttachmentMetadata`（原始 MIME、原始文件名、原始尺寸、EXIF 方向、校验摘要、处理版本、发送版本尺寸、本地路径）与 `IMAGE_INPUT_ERROR_REASONS`（7 个错误原因常量）。模块零 import，renderer / `prompts/` / `config/` 均可安全引用；`test/helpers/imageFixtures.ts` 的本地类型副本已改为从该模块导入（S01 留下的迁移点）。
- `ModelConfig.supportsImageInput`：可选布尔；`validateSettings` 对非布尔报错（与 `longContext1m` 同款）。缺省关闭、只有严格 `=== true` 开启；`resolveModel` 折叠 endpoint 时保留该字段；编辑其他字段按既有「spread 原配置再改」模式不丢；删除模型/endpoint 的引用修复不受影响（均有回归测试，含同 endpoint 两模型能力不同）。
- 判定函数 `resolveImageCapability(model, endpoint?)` 于 `src/config/providers/registry.ts` 单点导出（`providers/index.ts` 转发）：模型开关严格 `=== true` **且** Provider 适配器实现图像输入。适配器能力以类静态 `supportsImageInput` 暴露（Anthropic Messages、OpenAI Chat Completions 首版 true，其余 provider 名一律 false 不抛错），`ModelProvider` 接口同步增加可选实例方法供请求路径直查。函数不读文件、不发网络、不做探测。
- 能力进入 `ActiveModelRuntime.supportsImageInput?`：`createActiveModelRuntime` 工厂、主 loop（`AgentLoopOptions` → constructor → primary）、AgentTool 的 parentRuntime 与子代理 loop 均在构造时解析填充；fallback / compact / plan / 临时覆盖走同一工厂自动携带各自能力。`getActiveModel()` 带出该字段，经既有 `active-model` 事件到达两端。
- 运行时快照：`WireRuntimeSnapshot` 取 `loop.getActiveModel()` 的能力（与 `contextWindow` 同源、跟随实际服务模型）；`WireModelInfo` 与 `ModelPickerOption` 携带解析后的能力（仅 true 时出现在 wire 上，absent 即不支持），均为可 `structuredClone` 的纯布尔。设置变更沿用既有 `models` change kind，未新增 kind。三个伪造 loop 的测试桩（`protocolHost` / `protocolChildProcess` / `desktopMain`）按既有 `getContextBudget` 桩的同款理由补上 `getActiveModel`。
- 关键约束落实：能力不属于会话 scope 快照类字段（`SessionScope` / `PermissionGate` 不持有），每次构造 runtime 时按当时配置重新解析。`src/runtime/providerRuntime.ts` 与 `src/runtime/types.ts` 经核对无需改动：前者只负责配置变更后的模型 key 复位，后者无能力相关字段。
- 验证：三份窄测 90 项全绿；`npm run typecheck`（base / preload / renderer / domtest 四配置）通过；全量 `npm run test` 与改动前基线一致——本机（Windows x64）有 7 个 TUI Ink 渲染类测试在干净树上同样失败（InputBox 光标 / WelcomeBanner / 终端 resize），与 S02 无关，除此之外 2956 项全绿（含本会话新增 6 项）。「开关开但适配器不支持」组合用未注册 provider 名覆盖——两个现存适配器首版均为 true，该分支为未来适配器预留，测试已钉住。

---

## S03 `[x]` 两端模型设置开关与选择器能力标记

**前置**：S02 · **规模**：中 · **设计稿**：§4.2
**涉及**：`src/desktop/renderer/model/settings.ts`、`src/desktop/renderer/dom/settingsView.ts`、`src/desktop/shellHost.ts`、`src/desktop/shellProtocol.ts`、`src/tui/components/ProviderPanel.tsx`、`src/tui/components/ModelPickerDialog.tsx`、`src/runtime/modelPicker.ts`

**工作项**

1. Desktop 模型表单增加「支持图像输入：关闭 / 开启」，文案：`开启后，此模型可接收图片。请确认该模型及接入点支持当前协议的图像输入。`
2. **新建接入点时附带创建首个模型的路径也要有这个字段**，不能只在后续编辑里出现（两端都是）。
3. TUI `/provider` 模型表单同字段、同文案、同保存流程，不引入独立的配置写入路径。
4. 两端模型列表/选择器显示能力标记，标记来源是 S02 的判定函数结果，不是模型名匹配。

**遵守**：`mutate → save if config changed → reload → after-reload action → optional refresh` 流程，乐观 pending 状态、失败回退、单一 wire scope。纯决策放 `renderer/model/`，DOM 事件放 `renderer/dom/`。表单弹层遵守三种关闭方式（press outside / focusout / Escape），`relatedTarget === null` 的 focusout 是自身重绘，必须忽略。

**完成判据**：开关保存后 reload 一致；保存失败回到原值；两端设置互相可见且语义一致。
**验证**：`node --import tsx --test test/desktopShellHost.test.ts test/desktopUiRoundTrip.test.ts test/modelPicker.test.ts` + 手工 `npm run dev:tui`
**提交**：`checkpoint: S03 add image capability toggles to both frontends`

**执行记录（2026-09-08，Windows x64）**

- Desktop 模型表单新增「支持图像输入」开关（`关闭 / 开启`，`SettingsDraft.supportsImageInput`），说明文案逐字采用设计稿 §4.2；`SettingsFormField` 增加可选 `note`，由 `settingsView.ts` 以既有 `.settings-row-desc` 类渲染在标签下，未新增 CSS。新建接入点附带首模型的路径同样有该字段（`modelSupportsImageInput`），随 `draftToChanges` 的 `set-model` 批次一起提交。
- 开关语义与 `longContext1m` 完全同款：表单自持有、种子自快照、仅 `on` 时发 `supportsImageInput: true`，关闭即缺省；host 侧 `applyProviderChange` 重建 `ModelConfig` 时按缺省即移除。`supportsImageInput` 因此从 `JSON_ONLY_MODEL_FIELDS` 移出（carry 若继续接管，会把用户刚关掉的开关用旧值改回来）；「编辑其他字段不丢能力」改由表单种子保证，`test/config.test.ts` 原测试已改写为新契约并钉住「carry 不再搬该字段」。
- wire：`SettingsChange.set-model` 增加 `supportsImageInput?: boolean`（strict schema 同步，`_NoSettingsDrift` 守卫覆盖）；设置快照 `WireModelInfo` 增加两个互不相同的布尔——`supportsImageInput`（原始开关，仅 true 出现，编辑表单种子）与 `imageCapable`（host 在 `describeSettings` 里调 S02 的 `resolveImageCapability(model, endpoint)` 算出的有效能力，仅 true 出现，列表标记）。renderer 不 import registry（registry 传递依赖 harness/SDK，被渲染层禁令挡住），标记一律 host 算好走 wire。
- 乐观投影：`projectOne` 的 `set-model` 行携带原始开关；`imageCapable` 无法在 renderer 侧重算，仅在「开关保持开启且旧行已标记」时保留，关闭方向立即消失（宁可正向晚一拍到快照，不可负向滞后）。保存失败回退沿用既有「快照未变即回滚」语义，未另建路径。
- 两端标记（均来自判定函数结果，无模型名匹配）：Desktop 设置模型列表 detail 追加「支持图像」（`modelDetail`，读 `imageCapable`）；`/model` 选择器行 detail（`surfaces.ts`，读 `ModelPickerOption.supportsImageInput`）；composer 芯片 flyout（`runtimeMenu.ts` 保留标记为唯一 detail）。TUI：`ModelPickerDialog` 行内「支持图像」徽标；`/provider` 模型列表 secondary 追加「支持图像」（`ProviderPanel` 直接调 `resolveImageCapability`，TUI 侧无禁令）。
- TUI `/provider` 模型表单同字段（`FormState` 增 `supportsImageInput`，取值即文案 `关闭/开启`）、同说明文案（表单下方 dim 行）、同一 `persist → config.save() → onChange` 保存链，未引入独立配置写入路径。字段标签首次引入 CJK，`FieldRow`/`ChoiceFieldRow` 的 `padEnd(10)`（按码元）改为 `padFieldLabel`（按 `string-width` 显示宽度补到 12），ASCII 标签与 CJK 标签的值列对齐；既有测试的 `\\s+:` 断言不受影响。
- 验证：`desktopShellHost`（91）+ `desktopUiRoundTrip`/`modelPicker`/`tuiRender`（68）+ `rendererSettingsModel`/`rendererShellModel`/`rendererRuntimeMenu`（139）+ `providerPanel`/`providerPanelInput`/`config`（108）全绿；`npm run typecheck` 四配置通过；全量 `npm run test` 除本机既有 7 个 TUI Ink 渲染失败（S02 记录的基线）外全绿。新增覆盖：开关往返（种子→change→乐观投影→关闭即缺省）、新接入点首模型携带开关、开关开但 provider 适配器不支持时 raw/capable 分离、TUI 键盘走位（Tab/箭头切换、Enter 保存、编辑不重置）、选择器仅有效行有标记。`npm run dev:tui` 手工项留待 S26 一并验收。

---

## S04 `[x]` 图像解码归一化与压缩阶梯

**前置**：S01 · **规模**：长 · **设计稿**：§2.2、§8
**涉及**：新增 `src/tools/imageFile.ts`、新增 `test/imageFile.test.ts`

职责：判定“是不是图片 / 什么格式 / 尺寸多少 / 能否解码”，并产出发送版本。**不依赖 `services/`**（架构约束）。

**工作项**

1. 识别与解码：扩展名只用于筛候选，真实格式由内容嗅探 + 解码确认。阈值——单张原始输入 20,000,000 B，单张解码像素 40,000,000。超限直接失败并给出可区分原因。
2. 格式边界：GIF / 动态 WebP 取第一帧并在结果里标注；直接导入 BMP / HEIC / TIFF / AVIF 返回“未承诺支持，请先转 PNG/JPEG”；SVG 保持文本语义，不走图像分支。
3. 归一化：应用 EXIF 方向、颜色归一化、剥离多余元数据，同时把原始方向变换存进元数据（§8 末段的坐标还原要用，不能只乘一个比例）。
4. **建议断点** —— 到此提交一次，剩余工作项下次继续。
5. 压缩阶梯：等比缩小到默认长边 2,000 px，**不放大小图**；优先 PNG 保留截图文字与透明度；PNG 优化后仍超标再考虑 JPEG；透明图转 JPEG 必须显式背景色，**禁止意外黑底**。目标单张发送文件 ≤ 3,750,000 B（Base64 约 ≤ 5,000,000 B）。
6. 阶梯要有下限：达到最低可读策略仍超标就拒绝该图并提示裁剪，**不无限降质**。
7. 返回结构带上「定向后原始尺寸 / 实际发送尺寸 / x 与 y 独立缩放比」，供后续上下文说明文本使用：

   ```text
   [Image 1: screenshot.png; cached original: <local-path>;
   oriented original 3840x2160; supplied image 1920x1080;
   scale to oriented original: x=2.00, y=2.00.]
   ```

**完成判据**：fixture 全覆盖——透明 PNG、EXIF JPEG、静态/动画 WebP、GIF 首帧、伪扩展名、损坏文件、超字节、超像素；大截图落到限额内且文字仍可读（人工抽查）；小图不被放大。
**验证**：`node --import tsx --test test/imageFile.test.ts`
**提交**：`checkpoint: S04 add image decode, normalization and compression ladder`

**执行记录（2026-09-08，Windows x64）**

- 新增 `src/tools/imageFile.ts`（零依赖 `services/`，符合架构约束），三个入口：
  - `sniffImage(bytes)` 内容嗅探——PNG/JPEG/GIF/WebP 为 supported；BMP/TIFF/HEIC（含 mif1 等 brand）/AVIF 识别但明确拒绝；SVG 显式分类为非栅格格式（返回 `{ format: 'svg', supported: false }`，由调用方保持文本语义）；完全不是图的字节返回 `null`。扩展名不在本模块职责内，由调用方筛候选。
  - `processImageBytes(bytes, { name, ...limits })`：输入字节 20,000,000 B、解码像素 40,000,000（动画按单帧计——本管线只解码首页）、发送长边 2,000 px、单张发送 ≤ 3,750,000 B，全部可通过 options 覆写（测试用小阈值触达各分支，不提交大文件）。失败按 `src/media/types.ts` 的原因枚举区分：`unsupported-format`（消息含「convert it to PNG or JPEG first」，SVG 单独说明保持文本语义）、`decode-failed`（损坏文件/非图字节/解码中途失败）、`image-too-large`（输入字节/像素/阶梯触底三种，触底时提示裁剪）。
  - `formatImageCaption(image, { index, localPath })`：逐字符复刻设计稿 §8 的 `[Image 1: …; cached original: …; oriented original …; supplied image …; scale to oriented original: x=…, y=….]` 模板，动画首帧有标注，localPath 由 S05 落盘后传入。
- 归一化：`.rotate()` 应用 EXIF 方向、`.toColourspace('srgb')` 颜色归一化、输出不带 `withMetadata`（元数据剥离）、GIF/动画 WebP 取第一帧（sharp 默认 `pages: 1`），结果带 `animated` 标注。方向变换存进结果（`exifOrientation` + 纯函数 `orientedPointFromStored`/`storedPointFromOriented`/`orientedDimensions`，8 个 tag 的坐标往返与 sharp 实际旋转互验），坐标还原不靠比例乘法。
- 压缩阶梯（有限且有下限）：无损 PNG → 调色板 PNG（「PNG 优化」档）→ JPEG q85 → q70 → q55 → q55@1500 → q55@1000（下限，仍超即拒绝并提示裁剪，不无限降质）。透明图落 JPEG 前显式 `flatten({ background: 白 })`，测试断言透明区像素为白而非黑底。不放大小图（`withoutEnlargement`）。实现上原图只解码一次：归一化中间产物即无损 PNG（第 1 档输出），后续档位从它再编码，避免最坏情况 7 次全量解码。
- 返回结构 `ProcessedImage`：发送字节与尺寸、原始格式/MIME/存储尺寸、定向后原始尺寸、`exifOrientation`、`animated`、x/y 独立缩放比（定向原始/实际发送，rounding 可能造成两轴不同）——S05 可直接映射到 `ImageAttachmentMetadata`。
- 新增 `test/imageFile.test.ts` 20 项：7 个 fixture 全覆盖（含伪扩展名、损坏文件）、BMP/HEIC/AVIF/SVG 拒绝、超字节/超像素/阶梯触底三 类超限、四档阶梯各自命中（种子噪声生成器保证档位尺寸逐次运行稳定，预算取在相邻档位尺寸中间留余量）、GIF/动画 WebP 首帧像素级断言（(40,100,200)）、EXIF 应用+剥离、caption 模板逐字符比对、8 tag 坐标往返 + 与 sharp 实测旋转一致。
- 人工抽查（大截图文字可读）：3840x2160 文字截图经默认阈值处理得 2000x1125 PNG（100,857 B），与按发送尺寸原生渲染的参考图平均像素差 0.19，标题行 ASCII 点阵可直接读出原文「Hanekawa commit 5757e70」。本会话模型环境无法直接目检图像，故以参考图对比 + 点阵识读代替；S26 真机人工验收时再复核。
- 验证：`test/imageFile.test.ts`（20）+ `test/imageFixtures.test.ts`（9）全绿；`npm run typecheck` 四配置通过；全量 `npm run test`：2988 项 2986 过、1 跳过、1 失败——失败是 `toolcall-integration.test.ts` 的 node:test IPC「deserialize cloned data」崩溃（非断言失败），单独重跑该文件 3 项全绿，判定为运行器偶发问题，与本会话无关（本次改动仅新增文件，无既有模块引用）。本次运行未复现 S02 记录的 7 个 TUI Ink 渲染失败。

---

## S05 `[x]` 附件存储、解析、缩略图与回收

**前置**：S04 · **规模**：中 · **设计稿**：§12.1、§12.2、§13
**涉及**：新增 `src/services/imageAttachments/`、新增 `test/imageAttachments.test.ts`

**工作项**

1. 存储布局：

   ```text
   <cwd>/.myagent/attachments/<ownerSessionId>/<imageId>/
     original.<ext>
     image.<ext>
     thumbnail.png
     metadata.json
   ```

   全局 workspace 的 cwd 是用户 home，因此自然落在 `~/.myagent/attachments/`。命名必须用**实际已创建的 session ID**，不用 lane ID、不用展示标题。
2. **先落盘再返回引用**；写入失败不得产生看似可用的引用。原图与已提交的发送版本不可变，裁剪/转换产出新文件与新 ID。路径由运行时依据可信 ID 生成，不接受外部传入路径。
3. 解析：按 `(ownerSessionId, imageId)` 解析，**只解析已登记的引用**，不接受任意路径。生成小缩略图；预览走大小受限的 data URL（复用现有 `img-src 'self' data:`），不把 Base64 混进每次快照。
4. 同会话内相同内容按摘要去重；首版不做跨项目全局去重与引用计数。
5. 恢复策略：源文件被删除仍可打开；发送版本损坏而原图在则重建；两者都缺失时只返回**该图的局部错误**，不让整个会话无法恢复。
6. 回收：未被消息、队列或活跃草稿引用的文件，在会话加载或关闭后按保留窗口清理。**不回收正在导入或正在发送中的文件。** 首版不承诺“崩溃后恢复所有未发送草稿”，但草稿附件仍先落盘以支持可靠预览与提交。

**完成判据**：导入→落盘→读回元数据往返通过；删源文件后仍能解析预览；删 `image.*` 后能重建；孤儿文件在窗口后被清理而在途文件不被清理。
**验证**：`node --import tsx --test test/imageAttachments.test.ts`
**提交**：`checkpoint: S05 add session image attachment storage service`

**执行记录（2026-09-08，Windows x64）**

- 新增 `src/services/imageAttachments/imageAttachmentService.ts`（`ImageAttachmentService`，按项目 cwd 构造），存储布局逐字落实设计稿 §12.1：`<cwd>/.myagent/attachments/<ownerSessionId>/<imageId>/{original.<ext>, image.<ext>, thumbnail.png, metadata.json}`，全局 workspace 因 cwd 是 home 自然落在 `~/.myagent/attachments/`。`attachmentsDirFor` / `sessionAttachmentsDir` 复用 `utils/paths.ts` 的 `getMyAgentDir`，与 `sessions/`、`fileHistory/` 同一套根路径。
- 落盘顺序即安全边界：`original` → `image` → `thumbnail` → `metadata.json` **最后写**（注册标记）；任何一步失败 `rm` 整个 image 目录并返回新错误原因 `store-write-failed`（在 7 个共享原因之外唯一新增的存储层原因），不会产生看似可用的引用。导入经 per-service 串行队列，同内容去重不会和自己竞态。
- 解析只按 `(ownerSessionId, imageId)`，无任何接受路径的 API；两个 ID 都用 `SessionStore` 的 `assertSafeSessionId` 作单一校验器（读路径把 throw 折叠成 `file-missing` 结果，不炸会话）。跨会话 ID、未注册 ID、损坏的 `metadata.json`、`image.*`+原图全缺失，一律返回**该图的局部错误**（`file-missing`），`resolveRef` / `readSendBytes` / `previewDataUrl` 三者一致。
- 发送版本读取带完整性检查（存在 + 字节数与 ref 一致 + 内容嗅探匹配格式），不满足且原图在则用**导入时存的 limits** 重跑 S04 管线重建（原图先验 sha256 校验和）；重建后尺寸/字节若与 ref 漂移，更新 `metadata.json` 让 ref 始终描述真实发送字节。`animated` 标志持久化在 `StoredMetadata` 并随 `StoredAttachment` 返回（S12/S14 列表标注用）。
- 预览：`previewDataUrl` 返回缩略图的 `data:image/png;base64,…`，缩略图缺失/损坏时从发送版本再生成并回写；上限 300,000 字符，超限报 `image-too-large`。这是全模块唯一产生 Base64 的出口，快照/记录不经过它。
- 回收：`collectGarbage(sessionId, keepRefs, { now })` 只由调用方显式触发（会话加载/关闭时），`keepRefs` 由调用方按消息/队列/活跃草稿供给；服务侧负责保留窗口（默认 24h，可配）、`retain`/`release` 在途守卫（导入内部自动持有）、以及无 metadata 的崩溃残留目录（以目录 mtime 为锚）。`removeSessionAttachments` 供删除会话路径整目录清理（S23 接线），绝不触碰 `attachments/<sessionId>` 之外。
- `src/tools/imageFile.ts` 增补 `renderThumbnailBytes` + `MAX_THUMBNAIL_BYTES`（256→128→64 阶梯、不放大），sharp 用法继续集中在该模块；服务本身不 import sharp。
- 新增 `test/imageAttachments.test.ts` 20 项：布局/元数据往返、EXIF（orientation=6，定向后 48x64）、动画首帧、伪扩展名、同会话去重/跨会话不去重、处理失败原因透传（corrupt→decode-failed、BMP→unsupported-format）、`.myagent` 为文件时 `store-write-failed`、删源文件后可解析、删 `image.*` 后按 ref 尺寸重建、双缺失/坏 metadata 只报该图、危险 ID 不触盘、跨会话 ID 拒绝、预览 data URL 格式+上限+缩略图再生、回收（窗口内保留/过窗清理/keep 与在途保护/孤儿目录/清理后再导入）。
- 验证：`test/imageAttachments.test.ts`（20）+ `test/imageFile.test.ts`/`imageFixtures.test.ts`（29）全绿；`npm run typecheck` 四配置通过；全量 `npm run test`：3009 项 3008 过、1 跳过、0 失败（S02 记录的 7 个 TUI Ink 渲染失败本次未复现，与 S04 观察一致）。

---

## S06 `[x]` 记录与上下文类型接入 `images`，持久化兼容

**前置**：S02、S05 · **规模**：中 · **设计稿**：§5.1
**涉及**：`src/harness/types.ts`、`src/harness/contextBuilder.ts`、`src/harness/recordStream.ts`、`src/sessions/`

**工作项**

1. 保留 `content: string`，**另加**可选 `images?: ImageAttachmentRef[]`，不改成字符串/数组联合类型。需要加字段的位置：`ChatMessage`、`ToolResultRecord`、`ToolResult`、对应的 `ModelContextItem`、持久化队列消息、输入恢复事件。
2. `AtMentionContextRecord` 保持只负责代码文本；图片引用归属本次用户消息，避免同一图片出现两次。
3. `content` / `displayContent` 继续用于展示、检索与既有命令。图片编号是界面信息，**不得**靠扫描 `[Image #1]` 文本恢复文件。纯图片消息是合法输入，标题可用「图片：文件名」作为文字后备。
4. `contextBuilder` 把 images 带到上下文项上。
5. JSONL 追加写入 `images` 可选字段；没有该字段的旧记录按纯文本读取，不做批量迁移。先文件落盘（S05）再提交引用到 `RecordStream` 或队列。harness 仍只经 `RecordStream`，不直接用 `SessionStore`。

**完成判据**：既有测试无回归；新旧记录混合的会话可正常加载；重启后图片引用仍可解析。
**验证**：`node --import tsx --test test/contextBuilder.test.ts test/loop.test.ts` + 会话持久化相关测试
**提交**：`checkpoint: S06 add optional image refs to records and context`

**执行记录（2026-09-08，Windows x64）**

- `src/harness/types.ts`（引用 `src/media/types.ts` 的 `ImageAttachmentRef`，`content: string` 全部保留、不做联合类型）：`ChatMessage`、`ToolResultRecord`、`ToolResult`（工具执行返回值）、`ContextToolResult`（对应 `ModelContextItem`）、`PersistedQueuedMessage`（持久化队列消息）、`TurnInterruptionRecord`（输入恢复事件）各加可选 `images?: ImageAttachmentRef[]`。`ContextChatMessage` 经 `ChatMessage` 自动携带；`AtMentionContextRecord` 按设计稿保持纯代码文本职责，不加字段（图片引用只归属用户消息，测试钉住 mention 上下文项无 `images`）。
- `ToolRunner`：成功执行路径把 `result.images` 透传到 `tool_result` 记录（空数组不落字段）；拒绝 / 中止 / hook 拦截等 ToolRunner 自行构造的失败路径不产生 `images`，配对结算语义不变。这是 S10 `Read` 图片分流落库的唯一入口。
- `contextBuilder.recordsToContextItems`：`message` 与 `tool_result` 分支显式带上 `images`；`prompts/composer.ts` 与 `budget.ts` 的选择函数按引用透传上下文项与消息，无需改动。token 计数保持纯文本（图像 token 属 S16）。
- 队列兼容（`src/runtime/messageQueue.ts`）：`isValidQueuedMessage` 对 `images` 做「缺省或数组且逐项字段形状正确」的宽松校验（replay 解析的是磁盘上的任意 JSONL，不可信）；`sameMessages` 增加按值比较的 `sameImages`——hydrate 重建数组不触发监听器、仅 images 变化也能被检测到。`enqueue` 签名未动（统一传 `UserInput` 属 S07/S20）。
- 纯图片消息标题后备：`deriveSessionTitle`（`src/sessions/service.ts`，SessionController 与索引共用同一规则）在展示文本为空 / 纯空白且带图时返回「图片：文件名」；无图旧行为逐分支不变（空文本仍为空标题）。后备仅用于标题，不写回 `content`。
- JSONL 持久化：`SessionStore.appendRecord` 按既有 `JSON.stringify` 序列化，`images` 作为可选字段自然落盘；旧记录无该字段按纯文本读取，不做迁移、无版本标记。harness 仍只经 `RecordStream`。wire 侧记录整体过线（可 `structuredClone` 的纯 JSON），协议命令属 S08 未动。
- 新增测试 5 项 + 扩展：`contextBuilder`（消息/工具结果上下文项与消息投影均携带 images、mention 无）、`sessions`（新旧记录混合落盘→新实例重载往返：消息/工具结果/队列/中断记录的引用逐字段还原、旧记录无 `images` 键、纯图片首消息标题 `图片：prompt.png`；`deriveSessionTitle` 四分支）、`messageQueue`（replay 保留 images、非数组与字段坏形状被拒、相同 images 的 hydrate 不通知）、`toolRunner`（成功携带 / 空数组不落 / 拒绝路径无）。
- 验证：窄测 `contextBuilder`/`loop`/`sessions`/`messageQueue`/`toolRunner` 121 项全绿；`npm run typecheck` 四配置通过；全量 `npm run test`：3015 项 3014 过、1 跳过（既有）、0 失败（S02 记录的 7 个 TUI Ink 渲染失败本次未复现，与 S04/S05 观察一致）。

---

## S07 `[x]` `UserInput` 贯穿提交路径与中断恢复

**前置**：S06 · **规模**：长 · **设计稿**：§5.1、§12.3
**涉及**：`src/runtime/sessionController.ts`、`src/runtime/messageQueue.ts`、`src/harness/loop.ts`、`src/runtime/interruptRollback.ts`

这是整个计划里改动面最宽的一次——所有传裸字符串的提交调用点都要改。**先做工作项 1–3，绿了就提交**，不要和第 4 项混在一起。

**工作项**

1. 提交、排队、撤回、恢复统一传 `UserInput`（`{ text, images? }`）而非裸字符串。
2. 只传字符串的调用点包装成 `{ text }`，一次性改完，**不留双通道**。
3. 保持 `AgentLoop.run()` / `runTool()` 的共享 enqueue 路径与单一在途守卫；**不为图像另开执行链**。
4. **建议断点** —— 到此提交一次。
5. 中断回滚：用户中断且本轮被回滚时，`restore-input` 恢复**文字与图片引用**。已产生工作后中断时，图片随已存在的用户消息保留，沿用当前中断记录语义。恢复不得覆盖用户此后输入的新草稿。

**完成判据**：纯文本行为无回归；带图输入能到达 loop；中断→恢复往返后草稿完整（文字 + 附件顺序）。
**验证**：`node --import tsx --test test/loop.test.ts test/loopAbort.test.ts test/messageQueue.test.ts` + sessionController / interruptRollback 相关测试；跨层改动追加 `npm run typecheck`
**提交**：`checkpoint: S07 thread UserInput through submission path`

**执行记录（2026-09-08，Windows x64）**

- 提交路径统一为 `UserInput`，无双通道：`SessionController.submit(input: UserInput)`、`AgentLoop.run(userInput: UserInput)`、`AgentSession.run`（`src/runtime/types.ts` 签名同步）、`MessageQueue.enqueue(input: UserInput)` 一次改完——四个 API 只收 `{ text, images? }`，不再接受裸字符串。`run()`/`runTool()` 的共享 enqueue 与单一在途守卫未动，不为图像另开执行链。
- 只传字符串的调用点全部包装 `{ text }`：host 的 `submit` 命令与 `enqueue-message`（wire 仍是字符串，附件 ID 属 S08）、`commandContext.submitQuery`（命令/技能只产生文本）、TUI `useAgentLoop.submit`（composer 文本在 hook 边界入列）、TUI `App.tsx` 两个排队入口（`handleSubmit`、`initialQueuedPrompt`）、AgentTool 子代理 loop 的两处 `run`（task 与 continuation）。
- 队列交接共用同一映射：新增 `queuedMessageToInput(message)`（`messageQueue.ts` 导出，`enqueue` 的逆运算），Desktop host pump 与 TUI App pump 的交接都经它把 `content`/`images` 还原成 `text`/`images`，两个 shell 不会各自维护一份字段搬运。TUI 的 `executeQueuedInput` 改收 `UserInput` 并直接提交 controller，排队消息不再退化成纯文本。
- loop 内部：用户消息记录携带 `images`（空数组不落字段，与 S06 工具结果同款）；`appendTurnInterruption` 把 `images` 从用户消息带到中断记录——S06 加在 `TurnInterruptionRecord` 上的字段首次有了写入方；@-mention 门控、`userPromptSubmit` hooks、中断意图分类、skillInvocation prompt、`displayInput` 比较全部改用 `userInput.text`。纯文本行为逐分支不变。
- 中断恢复（工作项 5）：`restore-input` 事件增加可选 `images`，`tryRestoreInterruptedPrompt` 原样带回文字与引用及顺序；TUI `onRestoreInput` 改收完整 `UserInput`（App 目前只回填文本，引用对象留在入参上供 S14 附件列表消费）；已产生工作的中断沿用既有记录语义，图片随已存在的用户消息保留。恢复不覆盖用户新草稿的既有语义不变（事件只发一次，由 shell 决定写入时机）。
- 测试改造：6 个测试文件 90 处 `run`/`submit`/`enqueue` 调用点机械包装 `{ text }`；修正三处松散类型的 fake controller（`protocolHost` / `desktopUiRoundTrip` / `protocolChildProcess`，均改为解包 `.text`）——其中 `protocolChildProcess` 的崩溃顺带验证了包装的必要性：子进程 fake 把 UserInput 对象当 `content` 写进记录后，host 快照的 `countSessionRecordsTokens` 对 message 记录调 `countTextTokens(record.content)` 会真实炸掉，说明真实路径确实收到对象而非字符串。`sessionController` 测试的 `LoopRun` 桩类型同步为 `UserInput`。
- 新增回归 5 项：loop 用户消息携带 images（含空数组不落键）、user-cancel 中断记录携带 images、`enqueue`/`queuedMessageToInput` 往返（content+images 落盘、纯文本不落 images 键）、controller 把完整 UserInput 透传到 loop、带图回滚后 `restore-input` 按序带回文字与引用（并断言用户记录确已从 JSONL 删除）。
- 验证：窄测 `loop`（48）/`loopAbort`（11）/`messageQueue`（10）/`sessionController`（20）/`sessionWorkspace`+`runToolIsolation`（23）/`protocolHost`（75）/`protocolChildProcess`+`desktopUiRoundTrip`+`desktopMain`（18）/`commands`+`skills`+`agentTool`+`toolcall-integration`（152）全绿；`npm run typecheck` 四配置通过；全量 `npm run test`：3020 项 3017 过、1 跳过（既有）、2 失败——`configTool` 的 `EPERM rename ~/.myagent/settings.json`（Windows 文件锁）与 `backgroundTasks` 的后台 Bash 时序，两文件单独重跑均全绿，判定为全量并发下的环境抖动，与 S07 无关（本次改动不触碰 ConfigTool 与后台任务）。S02 记录的 7 个 TUI Ink 渲染失败本次未复现，与 S04–S06 观察一致。

---

## S08 `[x]` 协议命令与 wire schema

**前置**：S07 · **规模**：中 · **设计稿**：§6.3
**涉及**：`src/runtime/protocol/commandSchema.ts`、`wire.ts`、`host.ts`、`client.ts`、`src/desktop/preload.ts`

**工作项**

1. `submit` 目前是 `input: z.string()`，扩展为携带图片引用。**只传附件 ID**；host 核验其属于当前会话或显式继承集合，**不信任 renderer 给的存储路径或尺寸**。
2. 新增命令：导入附件、移除草稿引用、获取预览、打开原图。全部 strict schema，走现有 lane transport，返回值可 `structuredClone`，dispatch 保持 `assertNever` 穷尽。
3. 本地文件选择由 host 直接导入；renderer 粘贴产生的字节以**受大小限制的** `Uint8Array` / `ArrayBuffer` 传输，**禁止传 DOM 对象**。
4. 打开原图由 host 根据已登记附件定位文件，不开放任意 `file://` 读取。

**完成判据**：wire 往返测试覆盖新命令；超大字节被拒；跨会话 ID 被拒。
**验证**：`node --import tsx --test test/desktopUiRoundTrip.test.ts test/laneChannel.test.ts test/electronChannel.test.ts`
**提交**：`checkpoint: S08 add attachment protocol commands`

**执行记录（2026-09-08，Windows x64）**

- `submit` 只带附件 ID：`HostCommand['submit']` 增加可选 `imageIds?: string[]`（strict schema 同步，`_NoDrift` 守卫覆盖），host 在 `execute` 里按「当前会话 id + imageId」逐个 `resolveRef` 后组装 `UserInput` 交给 controller——ref 的 MIME、尺寸、字节全部来自存储层登记值，renderer 给的路径或尺寸没有任何入口可写。跨会话或未登记 ID 让整个 submit 以 `fail` 拒绝（轮次未开始，client promise reject 是 S11 做「移除该图/切模型」出口的挂点）；同 ID 重复按首次出现去重、顺序稳定；`imageIds: []` 等价缺省。`enqueue-message` 未动（队列带图属 S20）。
- 四个新命令，全部 strict schema、走既有 lane transport、返回值可 `structuredClone`、dispatch 经 `assertNever` 保持穷尽：
  - `import-attachment`：`source` 为 `{ kind: 'bytes', name, bytes: Uint8Array }`（粘贴字节，无任何 DOM 对象）或 `{ kind: 'path', path, name? }`（host 自己读文件，`name` 缺省取 basename）。字节在 schema 层以 `MAX_ATTACHMENT_WIRE_BYTES = 20_000_000`（设计稿单张原始输入同值）封顶，超限在边界即拒并带回 id，不挂起发送方。实现细节：`z.custom<Uint8Array>` 而非 `z.instanceof(Uint8Array)`——后者在本仓库 TS lib 下推断为 `Uint8Array<ArrayBuffer>`，比 wire 的 `Uint8Array`（ArrayBufferLike）窄，drift 守卫会误报。导入失败返回结构化 `{ ok: false, reason, message }`（reason 为 S05 的 `ImageStoreErrorReason`），是答案不是协议错误；本地文件选择的实际 UI 入口（原生 picker / 拖放路径解析）属 S11，协议侧两种 source 均已就绪。
  - `remove-attachment`：幂等释放草稿持有（`release`）；文件留给保留窗口（可能仍被消息或队列引用），GC 触发点属 S23。
  - `get-attachment-preview`：S05 的 `previewDataUrl`，按需取受限 data URL，不进快照。
  - `open-attachment`：host 按 `(当前会话, imageId)` 解析出 `metadata.localPath` 后交给 shell 回调 `onOpenAttachment`；协议模块保持 Electron-free，`main.ts` 接 `shell.openPath`（与 `open-project` 同款 fire-and-forget 契约：`{ ok: true }` 表示 shell 接手）。未登记/越权 ID 返回 `file-missing` 结构化失败，不开放任何 `file://` 读取。
- 「显式继承集合」核验暂为「当前会话」单一归属：继承集合（子代理 fork、`/clear` 队列迁移）到 S23 才有构造方，届时 host 的 `attachmentLookup` 是唯一改点。
- 附件服务归属：`ProjectRuntime.attachments`（`bootstrap()` 每 cwd 构造一个，与 `backgroundTasks` 同款注释同款理由），桌面 lane 的 host 经 `attach.project.project` 自动拿到；`SessionHost.requireAttachments()` 做存在性守卫——测试里大量 `as unknown as ProjectRuntime` 假件没有该成员，缺件时附件命令报可读的 `fail` 而非 TypeError。TUI 不经协议（进程内直连 runtime），S13/S14 直接使用。
- client：`submit(text, { imageIds?, overrides? })`（第二参可选，既有调用点零改动）；新增 `importAttachment` / `removeAttachment` / `getAttachmentPreview` / `openAttachment`。`protocolClientParity` 的 `NON_PROP_COVERAGE` 加 image attachments 条目，钉住「renderer 只持 client 即可完成附件全流程」。`preload.ts` 无需改动：桥面本就是泛化 post/listen，`Uint8Array` 经 `ipcRenderer.send` 的 structured clone 原样过线（`electronChannel` 测试补了过线断言）。
- 测试：`protocolCommandSchema` +3（samples 表覆盖四变体；submit 只收 ID、两种 source、超限边界含 ArrayBuffer 视图与非字节对象拒绝、三个 ID 命令的 strict）；`desktopUiRoundTrip` +6（harness 换真 `ImageAttachmentService` + 真夹具：粘贴字节导入→submit 带引用到 controller（去重 + ref 字段断言）、path 导入含文件名推导与非图片/缺文件的 `decode-failed`/`file-missing` 答案、跨会话 ID 与未登记 ID 拒绝且轮次未开始、超限字节在 schema 拒绝、预览 data URL 与结构化失败、remove 幂等 + open 把 host 解析的 localPath 交给 shell；`assertNoImageBytes` 钉住 import 回复无图片字节）；`laneChannel` / `electronChannel` 各 +1（Uint8Array 过线）。顺带修复 S07 遗留：`desktopUiRoundTrip.test.ts` 使用 `UserInput` 却未 import，干净树上 typecheck 即红。
- 验证：窄测 `desktopUiRoundTrip`/`laneChannel`/`electronChannel`/`protocolCommandSchema`/`protocolClientParity`/`protocolHost`/`protocolClient`/`protocolWire`/`desktopMain` 223 项 + `protocolChildProcess` 5 项全绿；`npm run typecheck` 四配置通过；全量 `npm run test`：3035 项 3034 过、1 跳过（既有）、0 失败——S02 记录的 7 个 TUI Ink 渲染失败本次未复现（与 S04–S07 观察一致），S07 记录的 `configTool`/`backgroundTasks` 环境抖动本次也未出现。

---

## S09 `[x]` `@` 图片引用

**前置**：S08 · **规模**：中 · **设计稿**：§7.1
**涉及**：`src/harness/atMentions.ts`、`test/atMentions.test.ts`

**工作项**

1. 沿用现有 mention 语法与纯解析器，支持项目内相对路径、绝对路径、带空格的引号路径。
2. **额度分离**：代码文本维持 `atMentions.ts:57` 的 `MAX_AT_MENTION_FILES = 5`，图片走自己的额度（单次输入最多 10 张，含显式附件）。**先识别各类引用再分别限制**，避免现有 `slice(0, MAX_AT_MENTION_FILES)` 静默吞掉图片。
3. `@目录` 不递归收集图片；图片上的 `#L` 行号范围明确报「不适用」。
4. 图片在输入准备阶段导入并绑定到本次用户消息；提交后重放使用缓存副本，不重读可能已变化的源文件。
5. 明确的图片引用出错（缺失 / 解码失败 / 超额）必须反馈给用户并保留草稿，**不得悄悄退回普通文本**。
6. 同次解析中相同路径去重，附件顺序稳定。项目外图片不通过 `@` 自动引入——那条路径只由用户显式选取/拖入/独立路径导入，不扩大模型自主读取项目外文件的权限。

**完成判据**：测试覆盖额度分离、去重、`#L` 报错、目录不递归、失败不降级为文本。
**验证**：`node --import tsx --test test/atMentions.test.ts`
**提交**：`checkpoint: S09 support image references in @ mentions`

**执行记录（2026-09-08，Windows x64）**

- 额度分离（工作项 2）：新增 `classifyAtMentions` —— 先经共享的 `collectRawMentions`（沿用 atToken 的 quoted/regular 两种模式与既有「路径#行范围」去重键）识别**全部**引用，再分别限制：代码文本维持 `MAX_AT_MENTION_FILES = 5`，图片走 `MAX_AT_MENTION_IMAGES = 10`（收集时按 `existingImageCount` 扣减显式附件）。`extractAtMentionedFiles` 相应改为无额度的语法层视图（原 `slice(0, 5)` 移除，额度只存在于 classify 一处），与 renderer 的一致性测试不受影响。图片候选按扩展名提名（`IMAGE_MENTION_EXTENSIONS`，含 BMP/HEIC/TIFF/AVIF 这类已知不支持的格式——让它们经管线大声失败而非像非代码文本一样被静默跳过），真实格式仍由 S04 管线内容嗅探确认。
- 去重与顺序（工作项 1、6）：图片 mention 按**路径**去重（`#L` 后缀不产生第二份），附件顺序按文本位置（quoted pass 先于 regular 的既有解析顺序不再影响附件顺序）；引号路径、项目内绝对路径沿用既有解析。
- 收集函数 `collectAtMentionImages`：输入准备阶段读取项目内文件字节，经 `AtMentionImageImporter`（结构上即 S05 的 `ImageAttachmentService`，无第二导入路径）导入。错误全部结构化返回：`#L` 报「不适用」（`line-range-not-applicable`）、项目外报 `outside-project` 并提示改走显式导入（粘贴/拖入/选择，不扩大模型自主读取项目外文件的权限）、缺失报 `file-missing`、超额报 `too-many-images`（单次输入上限含显式附件）、导入失败原样透传（`unsupported-format` / `decode-failed` / `image-too-large` / `store-write-failed`）。静默跳过的只剩与代码文本路径一致的 protected / gitignored 路径与目录。
- loop 接线（工作项 4、5）：`AgentLoopOptions.imageAttachments?` 接收 importer；`runInternal` 在**追加用户记录之前**收集 @ 图片——任一失败即 `formatAtMentionImageErrors` 抛错（无用户记录、无 at-mention 记录、轮次未开始；SessionController 既有 catch 以 error notice 反馈，草稿留在 shell，不悄悄退回普通文本），全部成功则引用并入用户消息的 `images`（显式附件在前、mention 图在后），中断恢复随 `appendTurnInterruption` 自然带回完整草稿。`/` 开头的命令输入沿用 at-mention 门控不收集。提交后重放经 S06 的 ref 路径解析缓存副本，不重读源文件。
- 附件服务自 `bootstrap → SessionScopeDeps → CreateRuntimeDeps → AgentLoop` 逐层可选传入（service 本就是 S08 挂在 `ProjectRuntime.attachments` 的每项目单例）。子代理 loop 首版不接线（附件归属规则属 S23）：无 importer 时图片 mention 行为与之前完全一致（纯文本）。
- `@目录` 不递归（工作项 3）：目录在分类层就走代码文本分支，目录展开只收代码扩展名；`@目录` 即便内含图片也不产生图片附件或错误（分类、收集、record 三层各有断言）。`buildAtMentionContextRecord` 只消费 classify 的 codeFiles——图片引用不进 `at_mention_context` 记录，归属用户消息，同一张图不会出现两次。
- 测试：`atMentions.test.ts` 17 项（新增 10：额度分离不吞图、图片按路径去重+文本顺序、导入成功（字节/会话 ID/文件名过线）、`#L` 报错、缺失+项目外双失败、超额含显式附件计数、导入失败透传+错误文案格式、gitignored 跳过、目录三层不递归、code record 不含图片）；`loop.test.ts` 新增 2（@ 图导入并绑定用户消息、at-mention 记录缺席；失败 mention 阻止轮次且零记录落盘）。
- 验证：窄测 `atMentions`（17）/`loop`（50）/`loopAbort`+`messageQueue`+`sessionController`+`sessionWorkspace`（55）全绿；`npm run typecheck` 四配置通过；全量 `npm run test`：3047 项 3046 过、1 跳过（既有）、0 失败。

---

## S10 `[x]` `Read` 工具图片分流

**前置**：S06 · **规模**：中 · **设计稿**：§7.2
**涉及**：`src/tools/FileReadTool/FileReadTool.ts`、`src/tools/FileReadTool/prompt.ts`、`src/tools/inputAliases.ts`

**工作项**

1. 在 `readFileAndRemember` **之前**分流图像；扩展名只筛候选，格式由内容与解码确认。
2. 文本路径完全不变：仍经 `textFile.ts`，编码与换行语义不变，`readFileState` 行为不回归。
3. 图片成功：返回文字说明 + `images` 引用，文字含原始尺寸、发送尺寸、本地缓存路径。**图片内容不得进入 `readFileState`**，防止 `Edit` 把二进制当已读文本编辑。
4. 当前模型不支持图像：返回 `ok: false` + `errorCode: 'precondition_failed'` + 可理解原因，**不返回乱码或 Base64**。`ToolRunner` 仍完整结算，保持调用配对。
5. 首版不加 `pages` / 裁剪参数；对图片传 `offset` / `limit` 明确报不适用。原始缓存不原地修改。
6. 权限规则不变：明确 deny 不能被图片分支绕过，也不把写入保护错误扩展成新的通用读取禁令。
7. `prompt.ts` 同步说明支持格式、能力限制、每个参数与 PDF 等未支持能力（CLAUDE.md 对工具描述的硬性要求）。

**完成判据**：文本读取测试全绿；图片成功/失败都有配对 tool_result；不支持的参数与格式有明确错误。
**验证**：`node --import tsx --test test/fileToolLineEndings.test.ts test/fileToolPreview.test.ts` + toolRunner 相关测试
**提交**：`checkpoint: S10 read images through the Read tool`

**执行记录（2026-09-08，Windows x64）**

- 分流位置（工作项 1、2）：`execute` 在 blocked-device 检查之后、`readFileAndRemember` 之前调用 `tryReadImage`；返回 `undefined` 即落回文本路径。扩展名只提名候选——候选集 `IMAGE_FILE_EXTENSIONS` 新增于 `src/tools/imageFile.ts` 单一来源导出，`atMentions.IMAGE_MENTION_EXTENSIONS` 改为同源别名（消除两份相同列表）；真实格式由 `sniffImage` 内容嗅探 + 导入管线解码确认：非图字节与 SVG（即使顶着图片扩展名）都保持文本语义，文本路径的编码、换行与 `readFileState` 行为逐字不变（文本回归测试全绿）。
- 成功路径（工作项 3）：经 `context.imageAttachments.importImage` 导入（结构上就是 S05 的 `ImageAttachmentService`，无第二导入路径），返回 S04 的 caption 模板 + `images: [ref]`——`formatImageCaption` 参数泛化为 `ImageCaptionFacts`，`ProcessedImage` 与存储元数据两个来源共用同一模板；文字含定向后原始尺寸、发送尺寸、本地缓存路径，并明确告知「图像以像素附在本工具结果上，未提取文字」。图片路径不进 `readFiles`/`readFileState`（测试钉住）——图片读取不构成「已读可编辑」，`Edit` 不会把二进制当已读文本匹配；原始缓存沿用 S05 不可变语义，不原地修改。
- 能力检查（工作项 4）：`ToolContext` 新增 `getSupportsImageInput?()`，由 `AgentLoop` 构造时安装、闭包读 `activeModel`——fallback / plan / 临时覆盖跟随**实际服务模型**，不是会话快照；probe 缺失即视为不支持。不支持时返回 `ok: false` + `errorCode: 'precondition_failed'` + `errorDetails.reason: 'model-not-capable'`，内容绝不携带乱码或 Base64（`assertNoImageBytes` 钉住）。无附件存储（子代理 S23 接线前的首版、测试 loop）同为 `precondition_failed`，reason `attachment-store-unavailable`。
- 参数与格式边界（工作项 5）：`offset > 1` 或 `limit` → `invalid_input` + `line-range-not-applicable`；BMP/HEIC/TIFF/AVIF → `invalid_input` + `unsupported-format`（透传 S04 的转换提示）；损坏文件 → `decode-failed`；存储写失败 → `execution_failed`。错误码全部复用既有集合，可区分原因放 `errorDetails`（S24 约定的形状）。首版无 `pages`/裁剪参数。
- 权限（工作项 6）：分支在 `execute` 内部，`ToolRunner.approveDetailed` 在其之前运行——显式 deny 不可能被图片分支绕过（测试：deny 规则下导入零调用），也没有把写入保护错误扩展成新的通用读取禁令（未触碰该层）。
- ToolRunner 配对：成功与拒绝路径都完整结算 `tool_use`/`tool_approval`/`tool_result`，成功结果经 S06 的透传把 `images` 落到 `tool_result` 记录——该入口首次有了真实写入方。
- 接线：`harness/types.ts` 新增 `ImageAttachmentImporter`（`importImage` 返回 ref + 元数据 + animated，`ImageAttachmentService` 结构性满足；`AtMentionImageImporter` 是它的窄化消费方，at-mention 路径未动）；`createRuntime` 把同一份 store 同时挂到 loop option（S09 路径）与 `toolContext.imageAttachments`（Read 路径），`SessionScopeDeps`/`CreateRuntimeDeps` 类型随之放宽；`forkToolContext` 保留两个新字段，`runTool` 隔离调度不会把图片读降级成 precondition。子代理 toolContext 为全新构造（`createSubAgentToolContext`），首版不带 store——子代理读图得到明确的 `attachment-store-unavailable` 而非二进制文本，归属规则属 S23。
- `inputAliases.ts` 无需改动：`pages` 既有 drop、`offset`/`limit` 数字 coercion 维持，提示词已声明无 `pages` 参数。`prompt.ts` 重写描述：逐项说明支持格式（PNG/JPEG/GIF/WebP、内容嗅探纠正错误扩展名、动画首帧、EXIF）、纯文本模型 `precondition_failed`、`offset`/`limit` 不适用、BMP/HEIC/TIFF/AVIF 需转换、SVG 按文本读、PDF 不支持、图片读取不算「已读可编辑」（对齐 CLAUDE.md 对工具描述的硬性要求）。
- 测试：新增 `test/fileReadImage.test.ts` 14 项（真 `ImageAttachmentService` + 真夹具，scratch 项目）：成功 caption/引用/零 read state、EXIF 定向后 48x64、动画首帧标注、伪扩展名双向（PNG 命名 `.jpg` 走图片、文本命名 `.png` 走文本）、SVG 保持文本语义、纯文本模型 `precondition_failed`（显式 false 与 probe 缺失两态）、无存储 `precondition_failed`、`offset`/`limit` 拒绝、BMP/损坏文件双原因、ToolRunner 配对结算（成功带 `images`、拒绝带结构化原因且无字节）、deny 规则零导入、loop 安装 live probe、`runTool` fork 保留 store 与 probe、无能力 loop 的 probe 返回 false。
- 验证：窄测 `fileReadImage`（14）+ `fileToolLineEndings`/`fileToolPreview`/`toolRunner`/`atMentions`/`imageFile`/`imageAttachments`（106）+ `loop`/`permissions`/`tools`/`sessionWorkspace`（248）全绿；`npm run typecheck` 四配置通过；全量 `npm run test`：3061 项 3060 过、1 跳过（既有）、0 失败——首次全量运行时 `toolcall-integration` 出现 S04 已记录的 node:test IPC「deserialize cloned data」偶发崩溃，单独重跑 3 项全绿，再次全量未复现。

---

## S11 `[x]` Desktop 采集与草稿状态机

**前置**：S08、S19 · **规模**：长 · **设计稿**：§6.1
**涉及**：`src/desktop/renderer/model/composer.ts`、`src/desktop/renderer/dom/composerView.ts`、`src/desktop/renderer/paneSession.ts`、`src/desktop/shellHost.ts`

现在的附件按钮只插入 `@`（见 `composer.ts:229` 注释），要补上真实入口。**建议在工作项 3 之后断一次**。

**工作项**

1. 附件控件同时提供「选择图片」与原有「引用项目文件」。文件选择与必要的原生剪贴板读取由 Electron 边界承接，**处理规则仍留在运行时**。
2. 粘贴优先处理事件中实际携带的图片；拖放阻止页面导航后把本地文件交给导入服务。
3. 草稿状态机：`处理中 → 可发送` 或 `失败`。一个失败不影响其他成功项，可移除失败项或重试。存在待处理/失败附件时，不允许把其余内容当完整输入静默发送。
4. **建议断点** —— 到此提交一次。
5. **每个 pane 独立草稿**；异步导入绑定发起时的 lane + session，完成后不得落到用户刚切过去的另一个会话。
6. 提交被接受后清理草稿；若沿用乐观清空，必须先保存完整输入，且失败恢复不得覆盖用户随后输入的新草稿。
7. 当前模型不支持图像时仍可添加/查看/删除附件，但发送按钮给出明确原因与切换入口（原因来自 S19 的统一规则）。

**遵守**：纯决策进 `renderer/model/`，DOM/事件进 `renderer/dom/`；`hasOverlay` / `isStreaming` 变化要调 `onShellChanged`；DOM 测试用 `test/helpers/domStub.ts`。

**完成判据**：纯模型测试覆盖状态机与 pane 隔离；导入完成不串会话；失败恢复不覆盖新输入。
**验证**：`node --import tsx --test test/desktopShellHost.test.ts` + 新增 composer 模型测试
**提交**：`checkpoint: S11 add desktop image attachment composer`

**执行记录（2026-09-09，Windows x64）**

- **前置说明**：S15–S19 已按建议顺序全部完成，S11 的前置（S08、S19）满足，本会话回到文档顺序的第一个 `[ ]`。规模为「长」，但一次会话内完成全部 7 个工作项，未启用建议断点。
- 新增 `src/desktop/renderer/model/composerAttachments.ts`（纯模块，只引用 `media/types`）：草稿状态机 `importing → ready | failed`（`beginAttachmentImport` / `settleAttachmentImport` / `retryAttachmentImport` / `removeAttachmentImport`）、`readyAttachmentRefs`（出序 = 到达序）、`attachmentDraftsIncomplete`（pending/失败即不完整）、`restoredAttachmentDrafts`（中断恢复重建，无 source 故不可重试）、`attachmentStripView`（行标签 + 发送门原因）、`imagePasteSources`（纯函数读结构化 `File` 形状）。配额 `MAX_DRAFT_IMAGES = 10` 与 `MAX_AT_MENTION_IMAGES` 同数同义（显式附件计入单次输入上限，两端入口不会 disagree）；行文案 `图片 N：name，W×H（，动画首帧）` 与 TUI `imageDrafts.ts` 逐字一致——双胞而非 import（renderer 不得 value-import `tui/`）。
- 采集入口（工作项 1、2）：`+` 变为双入口本地菜单——「选择图片」与「引用项目文件（@）」，后者原样保留 caret 插入与 `onAttach` 补全回调；菜单按弹层三规则关闭（press outside / focusout / Escape），`closeMenus` 一并收它。**「选择图片」走新命令 `pick-images`**（`ShellCommand` 联合新增，strict schema + `_NoDrift` 钉住）：renderer 只传可选 `projectRoot`（lane 拓扑的 normalized key），`shellHost` 把它解析成真实 cwd 作为 dialog 的 `defaultPath`（锚定失败不打断——锚点不改变答案含义，逐 pane 的 host 导入自会重新落项目），`main.ts` 的 `dialog.showOpenDialog`（multiSelection、图片过滤器来自 `IMAGE_FILE_EXTENSIONS`——已知不支持格式也让管线大声拒绝）承接 Electron 边界；**路径由 host 读**（`import-attachment` 的 `path` source），renderer 全程不触文件。粘贴：`composerView` 监听 `input` 的 `paste`，事件携带 image 文件即 `preventDefault` 并交给 pane（文本粘贴原样透传，路径粘贴是 TUI 的规则、不在 Desktop 复刻）；拖放：`app.ts` 在 `form` 上拦 `dragenter/over/leave/drop` 全部 `preventDefault`（Electron 会把 drop 变页面导航），仅 image 文件交给导入，非图片 drop 落空而非变成路径文本。
- 草稿状态机（工作项 3）：每个 draft 有稳定 `draftId`（pane 单调序列）；失败项保留 `source` 以支持重试（粘贴字节离开事件即不可再得，列表是唯一来源）；一项失败不影响其他项；`sendBlockNote` 在存在 pending/失败草稿时阻止「其余内容当完整输入静默发送」——`send()` 在分类为 prompt 且有 note 时直接 note 错误返回，composer 不清空。strip 渲染带 signature 防抖（快照 tick 每流式 chunk 一次，行在指针下不可重建）；行内 ✕ 删除（ready 项同时调 `remove-attachment` 释放 host 侧持有）、失败项「重试」、ready 项标签点击 `open-attachment` 打开原图（host 解析路径，fire-and-forget）。
- pane 隔离（工作项 5）：`draftImages` 是 paneSession 的 per-pane 状态（与 `draftText` 同层）；`deactivate` 用空视图清掉单例 strip 的**画**（如同 overlay/rewind/surface 的既有规则），`activate` 从本 pane 状态重画；`renderAttachments` 全部走 `if (!active) return`。**导入绑定发起时的 lane + session**：`importOneSource` 在 await 前记录 `client.getSession()?.id`，settle 时 session 已变（`/clear`/`/resume` rebind）即丢弃结果——id 属于旧会话的 store，落进新草稿会挂出不可解析引用；rebind 本身清空草稿列表（旧附件留在旧会话，完整归属规则属 S23）。
- 提交与恢复（工作项 6）：prompt 类输入提交时带 `imageIds`（S08 host 侧按当前会话核验并组装 ref）；命令输入**保留草稿**（与 TUI `keepsDraftAttachments` 同规则——`/model` 中途切模型不吃图片）；提交前把完整输入（text + drafts）存入局部变量，失败时**仅在 composer 仍为空**时恢复文本并把草稿原样放回（用户在 submit 往返期间继续输入即拥有新草稿，恢复不覆盖）；纯图片输入（文本空但有草稿）是合法输入——`shellState().inputEmpty` 纳入 `readyAttachmentRefs` 非空，但发送被 note 阻止，与「pending/失败不发送」同一出口。`restore-input` 的 images 经 `transcript.ts` 的 `TranscriptOutcome.restoreImages` 透出（空数组不落键），pane 侧只把**尚未在草稿里的 id** 追加回去（同一 once-only、不覆盖规则）。`queueMessage` 暂拒带图排队（`enqueue-message` wire 尚不带 imageIds，S20 接通），note 说明等本轮结束或先移除图片。
- 能力原因（工作项 7）：添加/查看/删除从不看能力（S08 命令 host 侧只认会话归属）；`attachmentStripView` 在 ready 数 > 0 且快照 `supportsImageInput !== true` 时给 `sendBlockNote`「当前模型不支持图像输入。可点击输入栏的模型芯片（或 /model）切换到支持图像的模型，或移除图片。」——措辞与 S15/S19 的统一规则同源（成因：模型开关，出路：切模型/移除图）。按钮**不禁用**（`requestSubmit()` 会吞掉 disabled 按钮的点击），note 走 `title`/`aria-label`，点击仍到达 pane 由 transcript 错误解释。无快照不拦（host 提交门是权威）；`renderStatus` 每快照 tick 重算门（模型切换/能力变化即更新）。
- domStub 增补：`StubElement.parentElement` getter 与 `StubEvent.clipboardData`（`dispatch` 可注入）——均进文件头的成员清单。
- 测试：新增 `test/rendererComposerAttachments.test.ts` 11 项（状态机三态、失败保源、重试、mid-flight 移除后 settle 无害、ready 删除回报 imageId、配额 10、恢复草稿不可重试、行文案/renumber、text-only note 含出路、纯文本无 note、粘贴源过滤与字节拷贝）；`test/rendererComposerView.test.ts` +6（+ 菜单双入口与 @ 路径保真、菜单三关法、strip 三态行与逐行动作、signature 防重绘 + note 上按钮、空 strip 清空、图片粘贴 preventDefault/文本粘贴透传）；`test/desktopShellHost.test.ts` +3（pick-images 路径往返与锚定、取消答空 + 未知 root 不锚定不打断、无 picker 拒绝）+ samples 表与命令清单各补 `pick-images`；`test/rendererTranscriptModel.test.ts` 既有用例零改动（restoreImages 只在非空时落键）。
- 验证：窄测 `rendererComposerAttachments`（11）/`rendererComposerView`（35）/`rendererComposerChip`/`rendererTranscriptModel`/`rendererShellModel`（149 项）+ `desktopShellHost`（94 项）+ `desktopUiRoundTrip`/`rendererImports`/`rendererBoot`/`protocolClientParity`/`rendererRepaint`（33 项）全绿；`npm run typecheck` 四配置通过；全量 `npm run test`：3247 项 3246 过、1 跳过（既有）、0 失败。缩略图预览、流式期间有界传输与点击打开原图的 UI 层按计划属 S12；真实粘贴/拖放/选择的手工项属 S26。

---

## S12 `[x]` Desktop 预览、缩略图与打开原图

**前置**：S11 · **规模**：短 · **设计稿**：§6.3、§14.2
**涉及**：`src/desktop/renderer/dom/composerView.ts`、`transcriptView.ts`、`src/desktop/shellHost.ts`

**工作项**

1. 缩略图按需取得受限 data URL；**不要**把原始 Base64 混进每次快照。
2. 打开原图由 host 依据已登记附件定位文件；越权 ID 被拒。
3. **流式输出期间缩略图不得反复重传**，保持帧/渲染签名工作有界。
4. 预览弹层遵守三种关闭方式与 focus 规则；paint 内的 `focus()` 放最后（它会同步触发 `focusout`）。

**完成判据**：流式过程中缩略图请求次数有界；点击可打开原图；越权 ID 被拒。
**验证**：`node --import tsx --test test/desktopShellHost.test.ts` + 手工
**提交**：`checkpoint: S12 add desktop attachment previews`

**执行记录（2026-09-09，Windows x64）**

- **前置说明**：本文件中第一个 `[ ]` 是 S12（前置 S11 已完成）。`src/desktop/shellHost.ts` 经核对无需改动：S08 的 `get-attachment-preview`（S05 `previewDataUrl`，300,000 字符上限的受限 data URL）与 `open-attachment`（host 按已登记 ID 解析 `metadata.localPath`，越权/未登记 ID 结构化 `file-missing` 拒绝）就是本会话要消费的全部 host 半边——S12 是把 renderer 侧真正画出来并保持请求有界。
- **按需取得（工作项 1）**：新增纯模块 `src/desktop/renderer/model/attachmentPreviews.ts`（「涉及文件」之外的新文件——请求状态机与 LRU 需要单一归属，且要能进 base 程序被纯测试）：`beginPreviewLoad`（自动路径：缓存有 id 即 `started: false`，无论 loading/ready/failed）、`retryPreviewLoad`（显式路径：仅 failed 可重跑）、`settlePreviewLoad`（settle 即移到 LRU 最近端）+ `failPreviewLoad` + `previewDataUrl`；`MAX_ATTACHMENT_PREVIEWS = 16` 上限（10 张草稿条满额 + 余量，是安全网不是正常路径）。`get-attachment-preview` 从此有了 renderer 侧消费者；快照仍只携带 ref（S06/S08 结构保证），Base64 从不进任何快照。
- **流式期间不重传（工作项 3）**：三重防线。协议侧本就不重发（预览是命令不是快照字段）；paneSession `loadMissingThumbnails` 在 strip paint 后对无缓存的 ready 行逐 id `beginPreviewLoad`，缓存有记录即不再发请求，与 `previewLoads` 在途集合共同保证「每 id 一次」；视图侧 `renderAttachments` 的 signature 纳入 `thumbUrl`——无 URL 的重绘不重建行（节点复用断言钉住），URL 到达是真实内容变化恰重绘一次，之后的流式重绘又因 signature 相同而零成本。transcript 侧刻意**不画缩略图**：transcript 是 `aria-live` 区域且每流式 chunk 重绘，是唯一会让按需 data URL 反复请求的地方——用户消息的图片画成纯文字行 `[图片 1：name，W×H]`（与 TUI `UserMessage` 同款措辞），painter signature 含 `images` 引用（未变即同一数组，`===` 命中零重绘）。
- **预览弹层（工作项 4）**：`composerView` 新增 `showAttachmentPreview` / `closeAttachmentPreview`：弹层挂在 `+` 所在的 composer bar（`.composer-menu` 同款宿主与锚定），`role="dialog"`，内容 = 文件名 + 关闭 ✕ + **缩略图自己的 data URL 放大**（设计稿的预览就是受限 data URL，不是原图字节、不按另一尺寸重取）+ 尺寸行（含「，动画首帧」）+「打开原图」。三关法：press outside 经 `onPressOutside([panel])`（scope 只有弹层自身——点开它的缩略图在 scope 外，先关弹层，随后的 click 再开，正好是切换语义）；`focusout` 的 `relatedTarget === null` 判定为自身重绘忽略（`closeButton.focus()` 放在 paint 最后，它同步触发 focusout）；Escape 在弹层上 `preventDefault + stopPropagation` 后关闭并把焦点还给 composer。`closeMenus` 一并收它——背景 pane 不留下悬空弹层。缩略图点击走 pane 的 `previewDraftImage`：缓存命中立即打开，未命中在显式路径请求一次；draft 在 settle 前被移除则不点亮弹层；预览失败是 strip 边的 note，不是空弹层。
- **打开原图（工作项 2）**：草稿条缩略图 → 预览弹层「打开原图」与标签点击 → S11 `openDraftImage`；transcript 用户消息图片行点击 → paneSession 新入口 `openImageById`（`client.openAttachment` 按 ID，host 解析路径；失败为该图局部 note）——发送后的消息不再依赖草稿行也存在。「越权 ID 被拒」由 S08 既有 host 侧核验 + 测试承担（本会话全部经 client 命令，无任何 `file://` 或路径入口）。
- **接线**：`attachmentStripView` 增可选 `previews` 查询函数（默认恒 undefined，既有调用点零改动；两处调用点——`attachmentsView` 与 deactivate 清空——传入 `previewDataUrl(previewCache, …)`）；`AttachmentRowView` 增 `imageId` / `thumbUrl`（仅 ready 行携带）；`TranscriptHandlers` 增 `onOpenImage`；`TranscriptItem` 增可选 `images`（`applySessionEvent` turn-start 与 `recordItems` 用户 message 分支分别从事件与记录透传，空数组不落键，旧记录无该键保持 absent）；`app.ts` 增 `onPreviewAttachment` 路由到活动 pane。CSS：`.attachment-thumb`（28×28、object-fit cover、alt 文本承担加载前事实）、`.attachment-preview*`（z-index 5 与菜单同层、宽 `min(24rem, …)`、`--shadow-float`）、`.user-image-line`（quiet 行、hover 提亮）。domStub 无需增补：`el('img')` 走 `createElement` 通用路径，`alt`/`src` 用 `setAttribute`（stub 的 `attributes` Map 即可断言）。
- **测试**：新增 `test/rendererAttachmentPreviews.test.ts` 3 项（自动路径单次请求 + settle 终止、失败显式可重试而自动路径不重试、LRU 上限与 refresh 存活/最旧驱逐）；`rendererComposerAttachments` +1（ready 行带 id/URL 或都不带、importing/failed 不 claim id）；`rendererComposerView` +3（缩略图 src/alt/点击预览不打开原图 + 无 URL 行不重建而有 URL 恰重绘一次 + 预览弹层三关法/`relatedTarget === null` 忽略/Escape 消费/closeMenus 收走/打开原图路由/focus 回 composer）；`rendererTranscriptView` +2（图片行逐字文案 + 点击与 Enter 路由 `onOpenImage`、无图消息零图片行 + 未变重绘节点复用）；既有「strip draws every state」适配 ready 行子节点序（[thumbnail, label, remove]）。
- **验证**：窄测 `rendererAttachmentPreviews`（3）/`rendererComposerAttachments`（12）/`rendererComposerView`（38）/`rendererTranscriptView`（62）/`rendererTranscriptModel`/`rendererShellModel`/`rendererImports`/`desktopShellHost` 297 项全绿；`npm run typecheck` 四配置通过；全量 `npm run test`：3256 项 3255 过、1 跳过（既有）、0 失败。真实粘贴/拖放/选择/预览弹层的手工项按计划属 S26。

---

## S13 `[x]` TUI 图片剪贴板采集（三平台）

**前置**：S08 · **规模**：中 · **设计稿**：§6.2
**涉及**：新增 `src/tui/utils/imageClipboard.ts`、`src/tui/components/InputBox.tsx`

**工作项**

1. 采集方式：
   - **Windows**：用系统 Windows PowerShell 的 **STA 进程**读取图像剪贴板并导出 PNG，避开不同 PowerShell 版本 `Get-Clipboard` 的参数差异。
   - **macOS**：系统 AppleScript 导出 PNG；环境有 `pngpaste` 时可用，但首版不维护自定义原生模块。
   - **Linux Wayland**：`wl-paste`；**Linux X11**：`xclip`。
2. **只在用户触发粘贴图片动作时读取**，首版不做焦点轮询。
3. 采集端输出 PNG 后统一交给 S04 的管线；系统剪贴板里的 BMP 等位图由采集端转 PNG。
4. 依赖缺失、无图片、读取失败要显示**具体原因**，并提示改用完整图片路径或项目内 `@图片`。
5. WSL / SSH 取不到宿主剪贴板时走路径入口，不承诺跨机器同步。

**完成判据**：三平台成功路径与无依赖路径都有明确行为；命令拼装不经 shell 字符串执行。
**验证**：新增 `test/imageClipboard.test.ts`（对命令构造与输出解析做纯测试）；真机验证留到 S26
**提交**：`checkpoint: S13 add TUI image clipboard capture`

**执行记录（2026-09-08，Windows x64）**

- 新增 `src/tui/utils/imageClipboard.ts`：纯采集层。`captureClipboardImage()` 是唯一入口，只被用户显式动作调用（Ctrl+V 与 `/paste-image` 的接线按计划属 S14 工作项 4），模块自身不轮询、不采样、不在任何后台时机读剪贴板——「只在用户触发时读取」由 API 形状保证。**InputBox.tsx 经评估未改动**：触发动作与附件列表都在 S14 的工作项里，本会话接线会与之重复；采集结果（结构化原因 + 统一后备提示文案）已可供 S14 直接渲染。
- 三平台采集（设计稿 §6.2 表）：
  - **Windows**：系统 `powershell.exe`（非 pwsh），`-NoProfile -NonInteractive -STA -Command` + 固定脚本；**不使用 `Get-Clipboard`**（避开版本差异），走 .NET `[System.Windows.Forms.Clipboard]::GetImage()`。剪贴板里的 DIB/BMP 由 System.Drawing 落成 PNG 后经 `[Console]::OpenStandardOutput()` 原样写字节——**位图→PNG 的转换发生在采集端**，Node 侧永远收到 PNG。`exit 3` 保留为「可读但无图」。
  - **macOS**：`osascript -e <固定 AppleScript> <临时路径>`。PNGf 优先、TIFFf 回退，写到 `mkdtemp` 临时文件（osascript 无法在 stdout 输出二进制）；临时路径是独立的 `on run argv` 参数，**不插值进脚本**；无图时脚本 `error "HANEKAWA_NO_CLIPBOARD_IMAGE"`，Node 按 stderr marker 区分 no-image 与 read-failed；TIFF 字节走转换桥。pngpaste 首版未接（设计稿「可按环境使用」，osascript 即系统路径，不为此维护依赖）。
  - **Linux**：`WAYLAND_DISPLAY` 优先 → `wl-paste --list-types` / `--type <mime>`；否则 `DISPLAY` → `xclip -selection clipboard -output -target TARGETS` / `-target <mime>`。先列类型再择优读取：PNG > JPEG > WebP > GIF 直通管线，TIFF/AVIF/HEIC 由转换桥转 PNG；两者都无显示服务器（SSH/WSL 无 X）→ `dependency-missing`，文案明说「不做跨机器同步」并指向路径入口。
- **命令拼装不经 shell 字符串**：全部 `spawn(file, args)` 参数向量，无任何 `shell:`；源码扫描测试钉住（不得出现 `shell:` / `execSync` / `spawnSync` / `exec(`）。进程 15s 超时杀掉，报 read-failed。
- 转换桥 `convertImageBytesToPng` 加在 `src/tools/imageFile.ts`（sharp 用法继续集中该模块）：TIFF/AVIF/HEIC → `.rotate().toColourspace('srgb').png()`，与管线第一档同款归一化但不做尺寸/压缩（那是管线的职责，避免第二条处理路径）。**BMP 实测不可转**：预编译 libvips（vips 8.18.6）无 BMP loader——Windows 的 BMP 已在 PowerShell 侧转掉，Linux 上 BMP-only 剪贴板如实报 `unsupported-clipboard-format` 并列出剪贴板实际提供的 image/* 类型（实测验证：sharp 解 BMP 报 unsupported image format，TIFF/AVIF 解码正常）。
- 结构化原因 5 类：`no-image` / `dependency-missing` / `read-failed` / `unsupported-clipboard-format` / `image-too-large`，全部可区分、不塌缩成一种报错；每条失败文案统一以后备提示结尾（「粘贴完整图片路径，或用项目内 @图片 引用」）。尺寸上限直接复用管线的原始输入上限 `IMAGE_PROCESS_DEFAULTS.maxInputBytes`（20 MB），转换出的 PNG 也复查——注定进不了管线的字节在采集层就给出明确原因。
- 真机验证：按计划 macOS/Linux 留待 S26，但本机（Windows x64）顺带做了**真实往返**（非 mock）：PowerShell `SetImage` 放入剪贴板 → `captureClipboardImage()` 返回 PNG 字节（sniff 通过）；纯文本剪贴板 → exit 3 → `no-image` + 后备提示。Linux 列表工具的「空剪贴板」stderr（`not available` / `nothing to paste`）归类为 no-image 而非 read-failed，由 `isClipboardEmptyError` 纯函数测试钉住。
- 测试：新增 `test/imageClipboard.test.ts` 36 项（平台判定含 Wayland 优先、五组命令构造逐项断言、类型解析/选择/空剪贴板分类、Windows 9 项、macOS 5 项含临时文件清理断言、Linux 11 项含 wayland/x11 双路径与 SSH/WSL 提示、其他平台不 spawn、shell 源码扫描）；`test/imageFile.test.ts` +3（TIFF 像素级往返、AVIF、拒 BMP/已支持格式/垃圾字节）；helper 增 `makeBmpBytes`（内存构造 24-bit BMP，无 BMP fixture 入库——该格式本就不被支持）。
- 验证：窄测 `imageClipboard`（36）/`imageFile`（23）/`imageFixtures`（9）67 项全绿；`npm run typecheck` 四配置通过；全量 `npm run test`：3099 项 3098 过、1 跳过（既有）、0 失败。

---

## S14 `[x]` TUI 路径粘贴、附件列表与 `/paste-image`

**前置**：S13 · **规模**：中 · **设计稿**：§6.2、§13
**涉及**：`src/tui/components/InputBox.tsx`、`src/tui/components/UserMessage.tsx`、`src/tui/hyperlink.ts`、`src/commands/`

**工作项**

1. 路径识别：终端拖入文件通常得到路径文本。**只对独立的、可完整解析的路径粘贴**做附件识别，处理外层引号、空格与平台转义。普通句子、代码块、含路径的长文本保持文本语义。**路径解析不得通过执行 shell 字符串完成。**
2. 附件列表：展示 `[图片 1：screenshot.png，1920×1080]`，支持按编号删除，删除后重新编号；动画首帧要标注。
3. 支持 OSC 8 的终端提供文件链接（复用 `hyperlink.ts`），其余终端显示可复制路径。纯图片消息在 transcript 中有合理文字后备标题。
4. 新增显式 `/paste-image` 动作，作为终端快捷键不透传时的后备；终端允许时 `Ctrl+V` 触发同一动作。
5. **控制类命令保留附件草稿**：`/model`、`/provider`、`/effort`、`/paste-image` 只执行对应动作，不清空附件——用户必须能带着待发送图片切换模型。`/clear`、`/resume` 按会话切换规则处理归属（S23）。技能生成的真实用户输入保留图像引用并进入同一预检。

**完成判据**：纯解析测试覆盖带引号路径、含空格路径、Windows 反斜杠、明显不是路径的文本；执行控制命令后草稿附件仍在。
**验证**：`node --import tsx --test test/commands.test.ts test/commandUi.test.ts` + 新增路径解析与 transcript 渲染测试
**提交**：`checkpoint: S14 add TUI path paste, attachment list and paste-image`

**执行记录（2026-09-08，Windows x64）**

- **前置说明**：本文件中第一个 `[ ]` 是 S11，但其前置 S19 未完成且 §1.1 建议 S15–S19 先于 S11；故按「前置全部满足」顺序执行 S14（前置 S13 已完成）。
- 路径识别（工作项 1）：新增 `src/tui/utils/pastedImagePath.ts` 纯解析器 `parseStandaloneImagePath(pasted, {platform})`。只认「整体就是一条可完整解析的图片路径」的粘贴：外层成对引号剥离（引号内允许空格，引号内再出现引号即拒绝）；win32 下反斜杠恒为分隔符、不做转义处理（UNC `\\server\share` 的双反斜杠原样保留），非 win32 先合并 `\ `/`\"`/`\'`/`\\` 转义再判空白——**未转义的空白在 raw 上判定**（转义合并前），故 `my\ screenshot.png` 通过、`my shot.png` 拒绝；候选必须含路径分隔符（裸文件名 `foo.png` 保持文本）、扩展名在 `IMAGE_FILE_EXTENSIONS`（含 BMP/HEIC 等已知不支持格式——让管线大声失败，与 S09/S10 同一原则）。普通句子、代码块、含路径长文本、多行粘贴、超长粘贴全部返回 `null` 保持文本语义。**全程不执行 shell 字符串**（无 child_process，源码扫描测试钉住）；`expandHomePath`/`resolvePastedPath` 负责 `~` 展开与按 cwd 锚定，之后由调用方直接 `node:fs` 读取。入口在 `useKeyboardShortcuts` 的普通字符分支：多字符输入（= 终端粘贴）先问 `onPastedText`，被认领则不进 composer；导入失败时仅当 composer 与认领时逐字节一致才把粘贴文本插回光标处，**不覆盖用户随后输入的新草稿**。
- 附件列表（工作项 2）：草稿状态在 App（`draftImages: DraftImage[]`，`{ref, animated?}` + 导入在途计数），展示组件 `DraftAttachments`（`[图片 1：screenshot.png，1920×1080]`，动画首帧追加「，动画首帧」，导入中显示 Importing image…，空闲时不渲染任何行）；编号即列表位置，删除后自动重编号。删除/清空走新命令 `/attachments [list | remove <n> | clear]`（`src/commands/attachments.ts`，`removeDraftImageAt` 纯函数）。`/attachments` 与 `/paste-image` 一并进 `registerBuiltinCommands`。
- `/paste-image` 与 Ctrl+V（工作项 4）：`src/commands/pasteImage.ts` 调 `CommandContext.pasteImageFromClipboard`（App 提供：S13 `captureClipboardImage` → S05 `importImage`，剪贴板图命名 `clipboard.png/jpg/webp/gif`）；`useKeyboardShortcuts` 新增 `onPasteImage`——`key.ctrl && input === 'v'` 触发**同一动作**（多数终端自行粘贴文本、该分支根本不会到达；透传 Ctrl+V 的终端由此走剪贴板采集）。capture 的结构化失败原因 + 后备提示文案原样经 system message 呈现。
- transcript 渲染（工作项 3）：`SessionEvent turn-start` 增可选 `images`（`sessionController.submit` 从 `input.images` 透传，空数组不落键）；`useAgentLoop` 把它带上用户显示项，`recordsToDisplayItems` 从用户记录透传 `images`（旧记录无该键保持 absent，测试钉住）。`UserMessage` 在消息体下逐张渲染 `[图片 1：name，W×H]`：OSC 8 终端整行链接到发送版本文件（`attachmentSendVersionPath(cwd, ref)`——ref 自身完全决定文件名 `image.<ext>` 的唯一路径，新导出于服务模块；经 `AnsiText` 走既有 OSC 8 通道，与 Markdown 链接同一机制），其余终端后缀可复制路径；纯图片消息显示后备标题 `图片：first.png（共 N 张）`（与 `deriveSessionTitle` 同规则）。排队消息预览显示 `(+N images)` 与同款纯图片后备标题。
- 草稿归属与提交（工作项 5）：`keepsDraftAttachments` = 输入以 `/` 开头即保留草稿——控制命令（/model /provider /effort /paste-image /attachments 及别名）只执行动作、查看类命令（/cost /help…）同样不动草稿，唯一把草稿带出 composer 的是**真实用户输入**：普通消息经 `handleSubmit` → `enqueue({text, images})`（S06 队列已支持）成功后清空；技能与 `/plan` 生成的输入经 `submitQuery`（`submitPlainInput`）携带草稿引用提交并消费（「技能生成的真实用户输入保留图像引用」），`useAgentLoop.submit` 签名随之从 `string` 改为 `UserInput`。`/clear`、`/resume`（切换会话时）清空草稿列表但**不删文件**——旧附件留在旧会话（完整归属规则属 S23）。跨会话导入竞态：导入完成时会话已切则不落入新会话草稿，提示图片留在原会话。中断恢复：`restore-input` 现在同时回填文字与引用（引用恢复为草稿，animated 标注是导入时知识、bare ref 不携带故省略）。
- 协议边界：`CommandContext` 新增四个可选成员（pasteImageFromClipboard / listDraftAttachments / removeDraftAttachment / clearDraftAttachments）；`COMMAND_CONTEXT_COVERAGE` 增加 `'shell'` 类别声明它们为视图侧状态——desktop host 工厂刻意不实现（desktop 草稿属 S11/S12），两端 `/paste-image`、`/attachments` 在无草稿 composer 的 shell 打印「not available in this shell」。`protocolClientParity` 的 COVERAGE 表为 App 新 prop `attachments` 补 client 侧对应（四个附件命令，S08 已有）。
- 测试：新增 `test/pastedImagePath.test.ts` 20 项（引号/转义空格/UNC/裸文件名/句子/代码块/多行/超长/大小写扩展名/已知不支持格式候选/shell 扫描/`~` 与 resolve）；`test/imageDrafts.test.ts` 5 项（控制命令保留 vs 普通消息消费、行格式含动画标注、按编号删除重编号、越界与空列表）；`test/userMessageImages.test.ts` 7 项（OSC 8 行构造纯函数两种模式、渲染带路径行、纯图片后备标题、recordsToDisplayItems 新旧记录、排队预览）；`test/commands.test.ts` +4（注册、/paste-image 双态、/attachments list/remove/clear/usage/不可用）。
- 验证：窄测 62 项全绿；邻接套件（commandUi/tuiTranscript/transcriptOrdering/tuiRender/sessionController/messageQueue/protocolHost/protocolClientParity/protocolCommandSchema/desktopShellHost/desktopUiRoundTrip/useKeyboardShortcuts×2/commandSuggestions×2/commandAnalysis/tuiAutocomplete/skills）505 项全绿；`npm run typecheck` 四配置通过；全量 `npm run test`：3130 项 3129 过、1 跳过（既有）、0 失败。Ctrl+V 真机行为依赖终端透传，与三平台采集真机验证一并在 S26 收口。

---

## S15 `[x]` 当前轮/历史轮判定与历史降级投影

**前置**：S06 · **规模**：长 · **设计稿**：§9.1、§9.2、§11.1
**涉及**：`src/harness/requestPrep.ts`、`src/harness/loop.ts`

**工作项**

1. 定义「新图」= 本轮用户附件 + 本轮 `@` 图片 + 本轮成功的 `Read` 图片结果；更早轮次仍在有效上下文中的是历史图。**用消息 ID 与 turn ID 判定，不看数组位置。**
2. 排队输入在**出队执行时**才成为当前输入，不能因为等待过就被当作可降级历史。对已开始轮次的重试保持原轮次身份，不能借重试把新图变成历史绕过阻止规则。
3. 校验分层：UI 预检 → 运行时提交准备（在发出 `turn-start`、创建用户记录**之前**）→ loop 在实际模型选择/工具结果/fallback/请求重建之后再检查 → Provider 最终校验。四处**复用同一份规则**。准备与提交受现有单轮互斥保护，不依赖过期模型信息。
4. **建议断点** —— 到此提交一次。
5. 历史降级投影：不支持图像的模型 + 仅历史图时，历史图变成带路径的文字占位符继续请求，**会话中的原图保留**。占位符必须诚实表达当前没有视觉内容：

   ```text
   [Historical image omitted for this text-only model:
   screenshot.png, original 3840x2160, cached at <local-path>.
   The pixels are not present in this request.]
   ```

6. **不得**把占位符描述成图片的识别结果；可以携带此前模型已写下的分析，但**不额外调用视觉模型生成 OCR 或描述**。
7. 缺失的历史文件用明确的「文件缺失」占位符；缺失的是当前输入则阻止发送。降级只作用于请求投影，**不修改 JSONL 与原始图片**。
8. 通知而非弹窗确认。同一能力状态与图片集合避免每个工具步骤重复提示；新增降级或切回后恢复要更新状态。文案参考：

   > 当前模型不支持图像，本次请求中的 3 张历史图片将以文件路径代替。原图仍保留，切换到支持图像的模型后可继续查看。

**完成判据**：测试覆盖排队消息出队后算新图、重试保持轮次身份、并行工具结果归属；payload 中无历史图字节而 JSONL 与文件不变。
**验证**：`node --import tsx --test test/loop.test.ts` + 新增 requestPrep 测试
**提交**：`checkpoint: S15 classify turn images and project history as text`

**执行记录（2026-09-08，Windows x64）**

- **前置说明**：本文件中第一个 `[ ]` 仍是 S11（前置 S19 未完成、§1.1 建议 S15–S19 先行），按 S14 确立的「前置全部满足」顺序执行 S15（前置 S06 已完成）。规模为「长」但一次会话内完成全部 8 个工作项，无需启用建议断点。
- 新增 `src/harness/turnImages.ts`（「涉及文件」之外的新模块——「四处复用同一份规则」需要单一归属，requestPrep 的职责是既有记录整形，规则另立门户更清晰）：`assertNewImagesAllowed`（新图 gate，UI 预检 / 提交准备 / loop 再检查 / S19 Provider 终检共用）、`assertCurrentImagesAvailable`（当前输入文件缺失阻止）、`projectTurnImagesForRequest`（分类 + 历史降级投影）、`TurnImageBlockError`（`imageInputBlock: 'model-not-capable' | 'file-missing'` + 完整 ref 列表）、占位符与通知文案格式化、以及 `(能力 × 图片集合)` signature 去重键。
- 工作项 1（判定）：新图 = `turnId === 当前轮` 的 message（用户附件 + @ 图片）与成功的 `tool_result`（本轮 Read 图片）；判定只看记录身份（turn ID + 消息 ID 双保险——恢复场景下记录可能丢了 turnId 但保住了消息 ID），**不看数组位置**（测试把当前轮消息放在历史消息之前钉住）。无 turnId 的旧记录一律历史；`turn_interruption`/队列记录不经上下文，天然不参与。
- 工作项 2（排队与重试）：排队输入在出队执行时才经 `submit → run` 创建带**新 turnId** 的用户记录——等待本身不产生记录，排队图在新轮开始瞬间即新图（loop 测试以「queued earlier, executing now」钉住）；轮内重试（max_tokens 续写、fallback `continue`、retry-primary）共享同一 turnId，新图身份不因请求重建改变——fallback 测试证明**模型中途切换不能把新图变历史绕过阻止**（见工作项 3）。
- 工作项 3（分层）：
  - **提交准备**（turn-start 之前、用户记录之前）：`SessionController.submit` 在 emit `turn-start` 前调用新方法 `loop.assertImagesAllowedForSubmission(input, overrides)`（显式附件 + overrides 模型能力，同步读取、无异步窗口）——阻止时 submit 直接 reject，两端既有错误通道呈现（TUI system message / desktop host fail 响应，即 S11「移除该图/切模型」出口的挂点），轮次从未开始（测试断言零 turn-start/turn-end/快照/记录）。@ 图片在 `run()` 内收集，紧随其后由 loop 权威 gate 覆盖。
  - **loop 权威 gate**：`runInternal` 在 mention 收集后、`appendRecord(userMessage)` 前执行同一 `assertNewImagesAllowed`（显式 + mention 合并后的 turnImages）+ `assertCurrentImagesAvailable`——阻止时零记录落盘，草稿留在 shell。
  - **loop 再检查**：`loadPreparedRecords(turnId, userMessage.id)` 每次请求重建都跑 `projectTurnImagesForRequest`，用**当次迭代实际服务模型**（fallback / plan / retry-primary 切换后重算）；中途切到纯文本模型且本轮有新图 → 抛 `TurnImageBlockError`（fallback 测试：primary 可用 + fallback 纯文本 + 带图输入 → fallback 请求被阻止、provider 只收到 primary 的一次调用）。Provider 终检属 S19、UI 预检属 S11，均直接复用本模块。
  - 单轮互斥：controller `streaming` 标志 + loop `enqueue` 在飞槽；所有检查同步读 `activeModel`，不依赖过期模型信息。
- 工作项 5（投影）：`projectTurnImagesForRequest` 对纯文本模型 + 仅历史图的记录做**纯投影副本**——`images` 键移除、占位符追加到 `content`，输入数组与 recordsCache/JSONL 完全不动（deepEqual 快照钉住）；capable 或无历史图时恒等返回（同一数组引用，零开销）。占位符逐字复刻设计稿模板：`[Historical image omitted for this text-only model:\n<name>, original <WxH>, cached at <path>.\nThe pixels are not present in this request.]`——定向后原始尺寸复用 S04 的 `orientedDimensions`（EXIF 6 的 64x48 → 48x64），localPath 来自存储层登记值。纯图片历史消息 content 恰为占位符（非空前缀零 `\n\n`）。投影在配对修复之后、compact 之前运行——压缩摘要因此看到的是占位符文字（§11.3 的先声，S22 复用同一投影）。
- 工作项 6（诚实性）：占位符只陈述「无视觉内容」，不描述图片内容；不调用任何视觉模型生成 OCR/描述；既有分析只存在于它本来所在的 assistant 消息里，投影不搬运。
- 工作项 7（缺失分层）：历史图解析失败（未登记 / 原图与发送版皆失）→ `[Historical image missing: …]` 占位符保位；**当前输入**缺失 → `assertCurrentImagesAvailable` 在任何记录之前以 `file-missing` 阻止（测试钉住零记录）。事实解析经新接口 `AttachmentFactsResolver`：bootstrap 用 `ImageAttachmentService.resolveRef`（metadata，不读图像字节）+ `fs.stat` 存在性构造（原图或发送版任一存活即可用，两者皆失才算缺失；原图已失时占位符路径改用发送版路径），经 `SessionScopeDeps → CreateRuntimeDeps → AgentLoopOptions.attachmentFacts` 逐层可选传入；无 resolver 时当前输入不做提交期复查、历史图一律按缺失占位（测试两种态都覆盖）。子代理 loop 不接线（归属规则属 S23）。
- 工作项 8（通知）：`ModelStreamEvent` 新增 `{ type: 'image_capability_notice', message, omittedImageCount, missingImageCount? }`（纯文本，可 structuredClone，经既有 onStreamEvent → wire `session-event` 通道到达两端）。loop 按 signature（`capable|new|hist|miss` 各自的排序 ID 串）去重：同一能力状态与图片集合跨工具步骤、跨轮次不重复提示；切回 capable 静默更新状态、再降级同集合会再次通知；新增图片（含中途新 Read 图）改变集合即重新通知。TUI `useAgentLoop` 增加渲染 case（system 行）；desktop renderer 对未知流事件安全忽略，其文案与出口留待 S24。
- 既有测试适配（gate 缺省关闭的必然结果）：`loop.test.ts` 两处图像测试（S06/S09）与 `loopAbort.test.ts` 中断恢复测试补 `supportsImageInput: true`；三个 fake loop 桩（`sessionController` / `sessionWorkspace`）补 `assertImagesAllowedForSubmission`——controller 桩实现真规则并新增 `imageCapable` 选项（缺省 capable，其他测试零改动）。
- 测试：新增 `test/turnImages.test.ts` 16 项（gate 三态、file-missing 阻止、无 resolver 直通、capable 恒等、按身份不按位置分类、新图阻止不降级、当前轮工具结果归新图/历史工具结果降级、legacy 无 turnId + 消息 ID 命中、占位符逐字模板、缺失占位、无 resolver 缺失路径、多图逐块投影、输入零突变、signature 稳定/变化/切回再降级、占位符不宣称视觉内容）；`loop.test.ts` +4（纯文本模型阻止新图零记录（排队语义）、当前输入缺失零记录、历史投影端到端——占位符逐字断言 + 两个 provider 迭代（含工具往返）的 messages/contextItems 全部无 images + 落盘记录原样保留 + 通知恰一次、fallback 中途切换阻止且 provider 未收到 fallback 请求）；`sessionController.test.ts` +1（text-only 提交在 turn-start 之前拒绝：零事件、零快照、零记录）。
- 验证：窄测 `turnImages`（16）/`loop`（54）/`loopAbort`/`sessionController`（21）/`sessionWorkspace`/`messageQueue`/`atMentions`/`requestPrep`/`contextBuilder`/`sessions`/`protocolHost`/`desktopMain`/`protocolChildProcess`/`desktopShellHost`/`desktopUiRoundTrip` 385 项全绿 + TUI 套件（tuiRender/tuiTranscript/tuiAutocomplete/commandUi）85 项全绿；`npm run typecheck` 四配置通过；全量 `npm run test`：3151 项 3150 过、1 跳过（既有）、0 失败——首次运行曾在输出中闪现 S07 已记录的 `backgroundTasks` 后台 Bash 时序抖动（退出码仍为 0），复跑全量与单文件重跑（8/8）均全绿，与本会话改动无关（不触碰后台任务）。

---

## S16 `[x]` `mediaStrip` 数量限制与图像 token 预算

**前置**：S15 · **规模**：中 · **设计稿**：§8、§11.2
**涉及**：`src/harness/mediaStrip.ts`、`src/prompts/budget.ts`、`src/harness/usage.ts`

**工作项**

1. `mediaStrip.ts` 目前是 no-op（`DEFAULT_MAX_MEDIA_ITEMS = 100` 已在文件里）。把它落实为真正的数量限制处理，**不另建重复入口**——设计稿 §3 明确点名此文件。
2. 上限：单次请求本地 100 张，计入历史 + 当前输入 + 工具图片；**更低的适配器限制优先**。超额时**优先省略最早的历史图**，当前轮新图受保护。返回诊断信息（省略几张、原因）供通知与日志使用。
3. 图像 token 按**实际发送尺寸**与模型/Provider 估算策略计算，文本继续用既有估算。**禁止**用文件路径长度或对 Base64 调 `countTextTokens` 估计图像 token。
4. 未知自定义模型用保守估算并标注近似值，不把某厂商像素公式宣称为通用精确成本。
5. 覆盖点：`countMessageTokens`、`countContextItemTokens`、`countSessionRecordTokens`、工具结果的 `_tokens` 缓存。旧的纯文本 token 缓存在**能力变化、模型切换、发送版本变化、历史省略、compact** 之后不能直接沿用。
6. `prompts/budget.ts` 只接收元数据/估算成本，**不读文件、不加载图像库**，保持 `prompts/` 不依赖 `harness/` 实现层。上下文占用分母继续用 `getContextBudget().usableContextWindow`；服务端真实 usage 到达后仍是消费统计依据。

**完成判据**：测试覆盖「最旧优先省略」「当前图不被丢弃」「适配器更低限额生效」；带图消息 token 明显区别于纯文本；缓存在上述五种变化后失效重算。
**验证**：`node --import tsx --test test/paneBudget.test.ts` + 新增 `test/mediaStrip.test.ts`
**提交**：`checkpoint: S16 enforce media cap and account for image tokens`

**执行记录（2026-09-09，Windows x64）**

- **前置说明**：本文件中第一个 `[ ]` 仍是 S11（前置 S19 未完成、§1.1 建议 S15–S19 先行），按 S14/S15 确立的「前置全部满足」顺序执行 S16（前置 S15 已完成）。
- 工作项 1–2（mediaStrip 落实）：`stripExcessMediaItems` 由 no-op 变为真正的数量限制，仍是唯一入口。调用点按设计稿 §11.1 的顺序（投影在预算之前）从 `requestPrep` 挪到 `loadPreparedRecords` 中 `projectTurnImagesForRequest` **之后**——纯文本模型的全部历史图已被投影成占位符，计数预算只花在真正会发送的图上；requestPrep 中原 no-op 调用移除（该层不知轮次身份与适配器限额，留在原位要么成为第二入口要么漏判）。超额省略次序：最早的历史图 → 本轮工具图（历史全部耗尽后才轮到）→ 本轮用户输入图**永不省略**，输入自身超额直接 `TurnImageBlockError('too-many-images')` 阻止（`TurnImageBlockReason` 相应扩展，对应设计稿 §11.1「仅当前输入就超限时拒绝发送，不静默丢当前图片」）。轮次身份复用 S15 的规则：`recordIsCurrentTurn` 自 turnImages 导出，mediaStrip 与能力投影共用同一判定，「新图」不会两处含义不同。适配器限额经新增可选方法 `ModelProvider.maxImagesPerRequest?()` 声明（两个现存适配器首版均不声明——机制按 S02 先例预留，测试用假 provider 钉住），`resolveMaxMediaItems` 单点取 `min(本地 100, 适配器值)`，垃圾值降级不反转规则。诊断信息（省略几张、每张的 recordId/refId/name、是否历史）与 `(cap × 保留集合)` signature 一并返回；新流事件 `media_limit_notice`（纯文本、可 structuredClone、经既有 stream 通道原样过线）按 signature 去重——同一 (cap, kept set) 状态跨工具步骤只提示一次，TUI 渲染为 system 行（desktop 对未知流事件安全忽略）。占位符沿用 S15 的诚实措辞（`[Historical image omitted to stay within the N-image request limit: … The pixels are not present in this request.]`，本轮工具图省略去掉 Historical 限定词），纯投影不动 JSONL 与缓存文件，同一上限内的后续请求自动恢复像素。同一附件在多条记录出现按**出现**计数与省略（旧出现先走），同记录多图可部分省略、全省略时 `images` 键整体移除。
- 工作项 3–4（图像 token 估算）：新增纯模块 `src/media/imageTokens.ts`（「涉及文件」之外的新文件；只引用 media/types，renderer/prompts/config 均可安全引用）。四种策略：`anthropic`（文档公式 `(w×h)/750`）、`openai`（高细节分块公式 `85 + 170×tiles`，含 2048/768 两步缩放；首版不发 `detail`、auto 对大图取高细节，故按高细节估算）、`conservative`（两公式取大，刻意上界，经 `imageTokenEstimateIsApproximate` / `describeImageTokenStrategy` 标注「approximate」并在 debug 日志 `[hanekawa][image-tokens]` 中现形——不把某厂商像素公式宣称为通用精确成本）、`none`（纯文本模型：像素被投影为占位符，图像 token 为 0）。`resolveImageTokenStrategy(providerName, supportsImageInput)` 单点解析：能力优先（不 capable 即 none），已知 provider 用自家公式，未知自定义模型保守估算。估算只读 ref 的发送尺寸——测试钉住「成本与文件名/路径长度无关」，全链路无任何对 Base64 调 `countTextTokens` 的路径。
- 工作项 5（覆盖点与缓存失效）：`countMessageTokens` / `countMessagesTokens` / `countContextItemTokens` / `countSessionRecordTokens` / `countSessionRecordsTokens` 全部带可选策略参数（缺省 conservative，任何不知模型的调用点也不会低估），message 与 tool_result 分支计入图像 token。`_tokens` 缓存语义明确为**文本缓存**：读取时在其上现算图像 token（纯算术、随当次策略变化），旧会话/旧模型下写入的纯文本缓存永远不会被当成完整计数直接沿用——这一结构性修复覆盖五种变化情形，无需逐情形失效；requestPrep 的 `getToolResultTokens` 同步收敛为直接委托 budget 计数器（自带的缓存读取分支删除，单一来源）。usage 基线（`lastResponseTokenCount`）失效：**模型切换/能力变化**——`resetModelRequestState` 扩展为同时清基线（syncRoleModel、retryPrimary、fallback 激活三处既有调用自动覆盖，能力随模型解析）；**历史省略/能力翻转/限额变化**——`loadPreparedRecords` 每次把 `(投影 signature × strip signature)` 与上次比较，变化即置 `imageRequestStateChanged`，runInternal 在压缩检查前消费并丢弃基线强制全量重算（两处调用点：迭代内与 retry-primary 重载后）；**compact** 沿用既有 `!compactResult.compacted`。服务端真实 usage 仍是消费统计依据（基线是它的投影，只在上下文仍匹配时复用）。
- 工作项 6（budget 纯度）：`prompts/budget.ts` 只新增对纯模块 `media/imageTokens` 的引用（元数据进、数字出，不读文件、不加载图像库、不依赖 harness 实现层）；策略的精确透传只发生在 loop 知道模型的三处（requestPrep options、progressiveCompact、autoCompactIfNeeded 输入各新增可选 `imageTokenStrategy` 字段），无模型知识的调用点（protocol host 占用估计、sessionMemory、AgentTool fork 预载）缺省 conservative——宁可高估早压缩，绝不低估。上下文占用分母 `getContextBudget().usableContextWindow` 未动。`src/harness/usage.ts` 经核对无需改动：usage/成本投影走 response.usage，图像 token 的真实成本自然包含其中。
- 测试：新增 `test/imageTokens.test.ts` 13 项（两厂商公式逐值钉住含缩放步骤、conservative=max、none=0、垃圾尺寸不为 NaN、策略解析矩阵、approximate 标注、带图消息 token 显著高于纯文本、成本与路径长度无关、contextItem 双分支、`_tokens` 文本缓存+现算图像（旧缓存与策略切换两态）、聚合一致性）；`test/mediaStrip.test.ts` 11 项（cap 解析六态、cap 内恒等引用、最旧历史优先+占位符逐字+键移除、纯投影零突变、同记录多图部分省略、同 ref 双出现按出现省略、本轮工具图仅在历史耗尽后省略+措辞区分、输入自身超额阻止、无轮次即全历史、诊断与通知文案、cap 0 空请求）；`test/loop.test.ts` +4（适配器更低限额端到端——provider 请求恰带 cap 张、最旧省略、JSONL 原样、`media_limit_notice` 恰一次且 capability 通知不误发；本地 100 上限端到端（102 张 → 省 2 保 100）；提交门槛——限额内放行、超额零记录阻止、文案含数量与出路；基线失效可观测——text-only primary 小 usage 基线 + fallback 切到 capable 后全量重算跨过阈值触发 compact_boundary，旧基线复用则不会压缩）。
- 验证：窄测 `mediaStrip`+`imageTokens`（24）/`loop`（58）全绿；邻接套件 `paneBudget`/`requestPrep`/`compact`/`progressiveCompact`/`loopAbort`/`sessionController`/`turnImages`/`messageQueue`/`toolRunner`/`contextBuilder`（173）、`protocolHost`/`desktopMain`/`desktopUiRoundTrip`/`desktopShellHost`/`sessions`/`agentTool`/`sessionMemory`（303）、`protocolWire`/`protocolClientParity`/`protocolCommandSchema`/`protocolClient`/`rendererImports`（108）、TUI+prompts（80）、图像特性八件套（128）全绿；`npm run typecheck` 四配置通过；全量 `npm run test`：3178 项 3176 过、1 跳过（既有）、1 失败——`toolcall-integration` 的 node:test IPC「deserialize cloned data」崩溃，S04/S10 已记录的运行器偶发问题，单独重跑 3 项全绿，与本会话改动无关（不触碰工具调用集成）。

---

## S17 `[x]` Anthropic payload 图像映射

**前置**：S16、S05 · **规模**：中 · **设计稿**：§10.1
**涉及**：`src/config/providers/anthropicPayload.ts`、`test/anthropicProvider.test.ts`

**工作项**

1. 用户消息映射为 text + image 块，`source` 用 `{ type: 'base64', media_type, data }`。
2. `Read` 图片放入对应 `tool_result.content` 的图像块，保留正确 `tool_use_id` 与 `is_error`。
3. 既有 `apiResultBlock` 的 ToolSearch / tool_reference 分支保留；**图片不能借该优先分支绕过共用能力与限额检查**。
4. 沿用连续工具结果合并、thinking 清理、cache breakpoint 逻辑；加图后**仍要检查缓存标记数量**。
5. **纯图片用户消息不得被「空字符串」过滤掉。**
6. 只在最终确定发送后才加载图像字节。

**完成判据**：测试覆盖纯图片消息、文字+多图、工具结果图片、缓存标记数量不变、未匹配 tool_use/tool_result 修复仍生效。
**验证**：`node --import tsx --test test/anthropicProvider.test.ts test/cacheControl.test.ts test/cacheControl.invariant.test.ts`
**提交**：`checkpoint: S17 map images into Anthropic payloads`

**执行记录（2026-09-09，Windows x64）**

- **前置说明**：本文件中第一个 `[ ]` 仍是 S11（前置 S19 未完成、§1.1 建议 S15–S19 先行），按 S14–S16 确立的「前置全部满足」顺序执行 S17（前置 S16、S05 均已完成）。
- 字节加载边界（工作项 6）：`ModelRequest` 新增可选 `imageBytes: Map<imageId, RequestImageBytes>`，值是 `{ bytes, mimeType }` 的**原始字节**——Base64 编码是各协议 payload 的职责（S18 的 data URL、S19 的请求体计量都要原始字节），不在加载层提前烧死。加载器接口 `AttachmentBytesLoader`（`readSendBytes`）定义于 `src/harness/types.ts`，结构性满足者就是 S05 的 `ImageAttachmentService`，bootstrap 把同一服务实例直接挂为第三个视图（`imageAttachments` 导入 / `attachmentFacts` 事实 / `attachmentBytes` 字节），经 `SessionScopeDeps → CreateRuntimeDeps → AgentLoopOptions` 逐层可选传入。loop 新增 `prepareRequestImages`，调用点严格落在 §11.1 五步的最后一步——配对修复、能力投影、数量上限、compact 全部决策之后、`contextBuilder.build` 之前：对最终保留的 ref 按 id 去重并行加载，每次请求构建各加载一次（fallback / retry-primary 重建请求时随新 map 重载，不跨请求共享实例）。投影选在 records 层而非 contextItems 层：`ContextToolResult` 不携带记录身份，而缺失分层需要 turn ID；records 级投影同时让 `built.messages` 与 `built.contextItems` 两个视图从同一份投影记录派生、天然一致。辅助请求（compact 摘要、toolUseSummary、sessionMemory）全部是纯文本构造，不经此路径、不受影响。
- 缺失分层（补齐 §11.1 在 capable 模型上的分支）：加载失败沿用 S15 的分层——**当前轮** ref（含本轮工具图）抛 `TurnImageBlockError('file-missing')` 阻止该次请求（此时用户记录已存在，错误经既有轮次错误通道呈现，provider 零调用）；**历史** ref 降级为 S15 的 `formatMissingHistoricalImagePlaceholder` 占位符（该措辞原本只服务 text-only 投影，现在 capable 模型遇上文件双失也走同一占位——设计稿「缺失的历史文件用明确的文件缺失占位符」由此完整），同一 ref 在多条记录出现时逐出现投影，纯投影不动 JSONL 与 records 缓存（测试钉住）。无 loader（测试 loop、S23 前的子代理）时 map 缺省、ref 原样随请求——真 payload 构建器会拒绝（见下），假 provider 不受影响。
- payload 映射（工作项 1、2、5）：`anthropicPayload.ts` 新增单一助手 `anthropicImageBlocks`，把 ref + bytes 映射为 `{ type: 'image', source: { type: 'base64', media_type, data } }`；`media_type` 取加载时嗅探的实际 MIME（S05 读路径已做完整性校验），不信任 ref 的声明值。用户消息 = 既有空文本过滤后的 text 块 + image 块（**纯图片消息因 image 块非空而在「空字符串过滤」中存活**，工作项 5）；`tool_result` 无图时 `content` 保持字符串逐字不变，带图时升级为 `[text?, ...images]` 块数组（空文本不产生空 text 块），`tool_use_id` 与 `is_error` 原样保留（ok / error 两态均有断言）；连续工具结果合并、thinking 合并、`(context truncated)` 兜底逻辑零改动，只是 content 数组可能多出 image 块。
- 缺字节即拒绝（不变量兜底）：payload 构建器遇到无 bytes 的 ref 直接抛错（消息含文件名与附件 ID），**不静默丢图**。loop 在上游保证「存活 ref 要么有 bytes 要么已被投影」，此分支只在未来接线遗漏（例如 S23 子代理继承历史）时大声失败而非悄悄发出缺图请求。
- apiResultBlock 分支（工作项 3）：优先分支逐字未动（ToolSearch 的 `tool_reference` 块照旧 spread + `is_error`），分支内注释钉住「图片只走普通 tool_result 分支，不能借优先分支绕过共用能力与限额检查」——该分支的输入是 ToolSearch 结果，天然不产生 `images`。
- 缓存标记与配对修复（工作项 4）：`addCacheBreakpoints` / `enforceAnthropicCacheControlLimit` / `finalizeAnthropicCacheControl` 逻辑零改动；image 块是普通 content 块，最后消息的最后块若是 image，标记落在其上（API 接受，`collectCacheControlTelemetry` 计数不变）。测试断言带图与无图请求的 marker 分布逐位相同（system 1 / tools 1 / messages 1）。配对修复未触碰——`repairToolResultPairing` 在 requestPrep 上游运行，payload 侧的合并 / 分组对图片透明（带图工具结果照常合并进同一 user 消息）。
- 测试：`test/anthropicProvider.test.ts` +7（文字+多图 base64 逐值含 MIME 区分、纯图片消息存活且无空 text 块、工具结果图三态（图+文 / 图+错误 / 纯文本保持字符串）+ 连续合并、纯图片工具结果、缺字节双态抛错（无 map 与 map 缺项）、apiResultBlock 优先分支逐字、缓存标记分布相同 + 标记落在 image 块、provider 端到端——captureRequests 证明字节经 `createMessage` 到达最终 payload）；`test/loop.test.ts` +3（字节按请求构建逐 ref 加载一次并随 modelRequest 下发、第二轮请求是新 map 实例、历史缺失 → 占位符投影 + 当前图照发 + JSONL 原样、当前轮缺失 → `TurnImageBlockError('file-missing')` 阻止且 provider 零调用）。形状断言的测试用 `MYAGENT_DISABLE_PROMPT_CACHING` 隔离最后消息的 cache breakpoint 标记（既有 afterEach 恢复环境）。
- 验证：窄测 `anthropicProvider`（27）+ `cacheControl`/`cacheControl.invariant`（42）全绿；邻接 `requestPrep`/`turnImages`/`mediaStrip`/`imageTokens`/`contextBuilder`/`loopAbort`/`sessionController`/`messageQueue`（129）、`desktopShellHost`/`desktopUiRoundTrip`/`protocolHost`/`agentTool`/`sessionWorkspace`/`sessionMemory`/`sessions`（312）、`loop`（61）全绿；`npm run typecheck` 四配置通过；全量 `npm run test`：3189 项 3188 过、1 跳过（既有）、0 失败。后台首次全量曾出现 `backgroundTasks` 的后台 Bash 时序断言失败（S07/S15 已记录的本机环境抖动，exit code 仍为 0），前台复跑未复现，与本会话改动无关（不触碰后台任务）。

---

## S18 `[x]` OpenAI payload 图像映射与工具图片合成消息

**前置**：S16、S05 · **规模**：中 · **设计稿**：§10.2
**涉及**：`src/config/providers/openaiPayload.ts`、`test/openaiProvider.test.ts`

**工作项**

1. 用户消息用 `image_url` + `data:image/...;base64,...`；首版**不发 `detail`**（减少兼容端点的参数要求；后续若加质量选项须同时进入 token 预算）。
2. **工具图片不能放进 `role: tool`**——官方 Chat Completions 的 tool 消息内容只接受字符串或 text 数组。正确顺序：

   ```text
   assistant: tool_calls [Read-A, Read-B]
   tool: Read-A 的文字结果，tool_call_id=A
   tool: Read-B 的文字结果，tool_call_id=B
   user: 来自工具结果 A/B 的图像与对应来源标签
   ```

3. 合成消息标明「工具输出数据」与对应调用 ID，不伪装成用户新指令。它**只存在于协议适配结果**，不写成真实用户轮次，不改变队列、turn ID 或 compaction 对「最新用户消息」的判定。
4. **不得插在尚未齐备的 tool 结果之间**——必须等同一批次全部 tool 消息输出完再追加。
5. 无图请求保持当前字符串格式（逐字节不变）。
6. 自定义端点即使声明支持视觉也可能不接受标准 data URL：失败时显示端点、模型与不兼容原因，**不静默切协议、不删图、不自动改能力开关**。

**完成判据**：多工具结果批次的消息顺序测试通过；无图请求 payload 与现状一致。
**验证**：`node --import tsx --test test/openaiProvider.test.ts`
**提交**：`checkpoint: S18 map images into OpenAI payloads`

**执行记录（2026-09-09，Windows x64）**

- **前置说明**：本文件中第一个 `[ ]` 仍是 S11（前置 S19 未完成、§1.1 建议 S15–S19 先行），按 S14–S17 确立的「前置全部满足」顺序执行 S18（前置 S16、S05 均已完成）。
- 工作项 1（用户消息）：`openaiPayload.ts` 新增单一助手 `openAIImageParts`，把 ref + bytes 映射为 `{ type: 'image_url', image_url: { url: 'data:<mime>;base64,<b64>' } }`——MIME 取加载时嗅探的实际值（不信任 ref 声明，测试用 ref 声明 PNG / 加载 JPEG 钉住），**不发 `detail`**（deepEqual 严格比较钉住无该键；注释写明后续加质量选项须同时进 token 预算）。带图用户消息 content 升级为 `[text?, ...image_url]` 数组，空/纯空白文本不产生空 text 块，**纯图片消息以仅含 image_url 的数组存活**；assistant 消息带图属于不变量违背（管线从不产生：S06 只给用户消息与工具结果挂 images），构建器抛错而非发出 Chat Completions 不接受的 assistant image_url content。缺 bytes 的 ref 与 S17 同款「拒绝构建、绝不静默丢图」，用户消息与合成消息两条路径都有测试。
- 工作项 2–4（工具图片合成消息）：Chat Completions 的 `role: tool` content 只接受文本，图片经 `pendingToolImages` 按批次缓冲，**等同一批次全部 tool 消息输出完**（下一个非 tool_result 项到达或迭代结束时 flush）再追加一条合成 user 消息：`[Tool output data, not user input. Images returned by tool calls: Read (tool call call-1): shot.png; Read (tool call call-2): diagram.png, photo.jpg.]` + image_url 块（收尾句点与 S15/S16 占位符同款风格）。顺序测试逐字钉住设计稿示例排列：assistant tool_calls 批 → 全部 tool 消息（content 保持字符串、图片绝不在其中）→ 合成消息；双批次测试钉住「不插在批次中间」（合成消息在下一 assistant 回复之前、其后批次的 tool_use 照常合并进该 assistant）与「请求以 tool 结果收尾时最后一条是合成消息」。合成消息只存在于 payload 投影——不写记录、不动队列/turn ID/compaction 的「最新用户消息」判定（这些都在 records 层，本函数不触碰）；纯图片工具结果的 tool 消息保持空字符串 content，图只走合成消息。`apiResultBlock` 优先分支逐字未动（ToolSearch 结果天然无 images，与 Anthropic builder 同款优先级与理由——不能借该分支绕过共用的能力与限额检查）。
- 工作项 5（无图逐字节不变）：无图请求不产生任何合成消息（flush 为 no-op）、用户/assistant 消息 content 保持字符串、tool 消息字符串 content 原样——golden 测试对整个 messages 数组 deepEqual 旧形状（含 tool_calls 合并逻辑未变）。`buildOpenAIPromptCacheKey` 只哈希 system+tools+model，图片不进缓存键，不受影响。
- 工作项 6（自定义端点拒绝）：`OpenAIProvider.createMessage` 把 client 调用包进 try/catch，`augmentImageEndpointRejection` 在**带图请求遭遇 4xx（401/403/429 除外）**时包装错误：消息含端点（`client.baseURL`）、模型、图片张数、原始错误文本、data URL 不兼容的解释与出路（关闭该模型的图像能力开关），并明说「未切协议、未删图、未自动改能力开关」。`status` 与 `cause` 保留在包装错误上，retry 分类语义不变——400 类仍归 `unknown` 类别不重试（测试以 `maxRetries: 3` + 调用计数 == 1 钉住对不兼容端点无重试风暴）；auth/429/5xx/网络错误与不带图请求的失败原样透传（401 与纯文本 400 两态各有测试，不把认证问题误报成图像不兼容）。debug 日志（`debugProviderPayload`）的 Base64/data URL 遮蔽按计划属 S19 工作项 5，本会话未动。
- 测试：`test/openaiProvider.test.ts` +8（用户消息双 MIME data URL + 纯图片存活 + 无 detail 键、多工具批次消息顺序 + label 逐字 + tool 消息纯文本、双批次各自合成 + 批次中不插入 + 纯图片工具结果、无图 golden 整数组 deepEqual、缺 bytes 三态抛错（无 map / 空 map / 合成消息路径）、assistant 带图抛错、端点拒绝包装（端点/模型/张数/原始错误/无副作用语句 + status 与 cause 保留 + 单次调用无重试）、auth 与纯文本 400 透传）；`installFakeClient` 增加可选 `baseURL` 参数（provider 错误路径读取 `client.baseURL`，假件需提供）。
- 验证：窄测 `openaiProvider`（11）全绿；邻接 `loop`/`requestPrep`/`turnImages`/`mediaStrip`/`imageTokens`（123）与 `anthropicProvider`/`cacheControl`/`cacheControl.invariant`/`contextBuilder`/`config`/`providers`（142）全绿；`npm run typecheck` 四配置通过；全量 `npm run test`：3197 项 3196 过、1 跳过（既有）、0 失败（S02 记录的 7 个 TUI Ink 渲染失败与 S07/S15 记录的环境抖动本次均未出现）。

---

## S19 `[x]` 发送前最终校验与日志遮蔽

**前置**：S17、S18 · **规模**：中 · **设计稿**：§11.1、§13
**涉及**：`src/config/providers/registry.ts`、两个 payload 模块、`src/harness/requestPrep.ts`、`src/config/providers/debug.ts`、`src/harness/hooks.ts`

**工作项**

1. 请求准备严格按五步执行：记录与工具配对修复 → 能力判定与历史投影 → 选发送版本并估算预算 → 按既有流程压缩并重算 → 只加载最终保留的字节，映射后做最终检查。
2. 最终检查三层都要有：单图字节、请求图片总数、**完整请求体序列化后的 UTF-8 字节**（本地初值 25,000,000 B）。**不能只查每张图不查整包。** Provider 已知限制与本地策略取**较严格者**。
3. Provider 在实际发送前**再次检查图像能力**，防止绕过 UI 的调用漏检。
4. 仅当前输入就超限时**拒绝发送**并提示减少图片或裁剪，不静默丢当前图片。工具在可预见的预算不足时返回明确工具错误。**任何失败都不能留下未结算的工具调用。**
5. `debugProviderPayload` 目前序列化完整 payload，接入图片后**必须遮蔽 Base64 / data URL**，只记录 MIME、尺寸、字节数、附件 ID。
6. 会话事件、hooks、运行时快照、错误信息同样不得携带图片正文。文本 hooks 继续收到文本，可额外提供附件元数据，**不自动把路径占位符写回用户原话**。

**完成判据**：超限用例走拒绝路径且原因明确；tool_use/tool_result 仍配对；测试断言调试输出中不出现 Base64 片段。
**验证**：`node --import tsx --test test/anthropicProvider.test.ts test/openaiProvider.test.ts test/loop.test.ts` + 新增 debug 遮蔽测试
**提交**：`checkpoint: S19 enforce request limits and redact image bytes`

**执行记录（2026-09-09，Windows x64）**

- **前置说明**：本文件中第一个 `[ ]` 仍是 S11（前置 S19 未完成、§1.1 建议 S15–S19 先行），按 S14–S18 确立的「前置全部满足」顺序执行 S19（前置 S17、S18 均已完成）。
- 工作项 1（五步顺序）：经核对 S15–S18 已把顺序落定在 loop 的 `loadPreparedRecords`/`prepareRequestImages`（配对修复 → 能力投影 → 数量上限 → compact → 只加载最终保留字节），本会话在数量上限之后补上**体积预算**的省略 pass（见工作项 4），不新增第二入口。`src/harness/requestPrep.ts` 经核对无需改动——其职责是记录整形（配对修复、thinking 清理、预算压缩），五步编排在 loop；`src/harness/hooks.ts` 模块本身也无需改动（hooks 输入的组装方在 loop/ToolRunner，见工作项 6）。
- 工作项 2（三层最终检查）：新增 `src/config/providers/imageRequestGuard.ts` 单一归属——`assertFinalImageRequestLimits(payload, request, limits)` 在 payload 映射完成后逐层检查：**单图字节**（`request.imageBytes` 的实际字节数 vs 限额）、**请求图片总数**（遍历 payload 数 image 块，Anthropic base64 块与 OpenAI `image_url` data URL 同一 walker 计数）、**完整请求体序列化后的 UTF-8 字节**（`JSON.stringify(payload)` 实测，不只查每张图）。失败抛 `TurnImageBlockError`（`TurnImageBlockReason` 扩展 `image-too-large` / `request-too-large`），消息带文件名、字节数、限额与出路（裁剪 / 减图 / 清旧轮次）；整包超限时消息区分「其中约 N 字节是图像数据」与「无图像即纯文本超限」。retry 分类读作 `unknown`（无 status）→ 预算 0，超限请求只拒绝一次、绝不重试（测试以 `maxRetries: 3` 钉住客户端零调用）。**限额策略单一来源**：新增纯模块 `src/media/imageRequestLimits.ts`（`MAX_IMAGE_SEND_BYTES = 3,750,000`——`IMAGE_PROCESS_DEFAULTS.maxSendBytes` 改为引用同一常量，导入管线与请求终检是同一个数；`MAX_REQUEST_BODY_BYTES = 25,000,000` 本地初值；`estimateImageBlockBytes` = base64(4/3) + 128 B 块开销），`resolveMaxImageBytes` / `resolveMaxRequestBodyBytes` 与 S16 的 `resolveMaxMediaItems` 同款：**适配器已知限制与本地策略取较严格者**，垃圾值降级不反转。适配器声明经 `ModelProvider` 两个新可选方法 `maxImageBytes?()` / `maxRequestBodyBytes?()`（与 S16 的 `maxImagesPerRequest?()` 同款机制；两个现存适配器首版均不声明，测试用子类钉住）。
- 工作项 3（Provider 发送前能力复查）：两个 provider 的 `createMessage` 在任何 attempt 之前调 `assertRequestImageCapability(request, capable)`——`capable` = 构造时快照的模型开关（`config.supportsImageInput === true`，provider 每次模型切换重建）**且**适配器自身旗标（实例方法，测试可打桩）；带图请求 + 不可用 → `TurnImageBlockError('model-not-capable')`，端点零调用。这是绕过 UI / 提交门 / loop 投影之后最后一道（S23 子代理继承接线时同样受它保护）。`resolveImageCapability` 不能直接 import（registry ↔ provider 环依赖），provider 内联的正是它读的同两个事实（类静态 + 严格 `=== true`），注释互相指向。
- 工作项 4（超限拒绝，不静默丢当前图）：设计稿 §11.1 第 3 步的**体积预算**由 `mediaStrip.ts` 新增 `stripExcessImageBytes` 落实——预算 = `resolveMaxRequestBodyBytes` − `estimateRequestTextBytes`（system + 各记录 content + 每记录 256 B 结构开销 + 工具 schema JSON，纯估算、不加载任何东西），**只用 ref.byteLength 元数据**估算每出现 ≈ base64+块开销。省略次序与数量上限完全同款：最早历史图 → 本轮工具图，输入自身受保护；**仅当前输入就超预算**时抛 `request-too-large`（消息含「减少图片或 crop/downscale」），不静默丢当前图。loop 在 `loadPreparedRecords` 数量上限之后调用（无图请求零开销直返，文本估算只在有图时才发生），省略后 `prepareRequestImages` 只加载存活 ref——「先决定后加载」由测试钉住（被省略图零加载调用）。提交门双保险：`assertImagesAllowedForSubmission` 与 `runInternal` 的记录前 gate 均调 `assertInputImagesWithinRequestBody`（输入自身估算 vs 完整 body 限额，不含历史/文本——那只有请求构建才知道）。「可预见预算不足的工具错误」为既有行为：S04 阶梯触底拒绝（`image-too-large` + 裁剪提示）、S10 纯文本模型 `precondition_failed`；本会话补齐的是并行工具合并后的最终预检与「失败不留未结算工具调用」——loop 测试证明终检在工具结果落盘后抛错时，每个 tool_use 都有配对 tool_result。新流事件 `request_size_notice`（纯文本、经既有 stream 通道过线）按 (预算 × 保留集合) signature 去重，TUI 渲染为 system 行（desktop 对未知流事件安全忽略）；`noteImageRequestState` 签名并入 byte strip——省略集合变化同样使 usage 基线失效重算。
- 工作项 5（debug 遮蔽）：`debugProviderPayload(label, payload, request?)` 现在写时遮蔽——copy-on-write 深走 payload，Anthropic `source.data` → `<redacted base64: N chars, ~M bytes>`、OpenAI data URL 保留 `data:<mime>;base64,` 前缀后遮蔽本体，原 payload 对象零突变；附件事实（**附件 ID、文件名、MIME、尺寸、字节数**、加载字节数）走独立的 `payload images` 摘要行，不进 payload 结构。`debugProviderSummary` 的 `previewContent` 对 image / image_url 块输出 `image:<mime>` / `image_url:<mime>` 标签。四个调用点（两 provider × 正常/retry）全部带上 request。
- 工作项 6（事件/hooks/快照/错误不带图片正文）：会话事件、运行时快照、记录本就只携带 ref（S06 起的结构保证），本会话核对无新增泄漏路径。**文本 hooks 继续收到纯文本**：`runUserPromptSubmitHooks` 改收完整 `UserInput`，hook stdin 里 `prompt` 逐字是用户原话（不自动把路径占位符写回），`images` 以元数据数组（id/name/mime/宽高/字节数，无 bytes）附加——覆盖显式附件 + 本轮 @ 图（mention 收集在 hook 之前完成）；postToolUse hook 的 `result` 同样附加工具结果图片的元数据。**错误信息遮蔽**：`redactImageBytesFromText`（imageRequestGuard 导出）把 `data:image/...;base64,<run>` 与 400+ 字符 base64 长跑替换为 `[redacted image data]`（短内容——校验和、id、普通词——不受影响；正则刻意不用 `\b`，`+`/`/`/`=` 是非词字符会让尾部逃逸）；S18 的 `augmentImageEndpointRejection` 在嵌入端点回显的原始错误文本前先行遮蔽——代理会把请求体回显进 HTTP 错误。
- 测试：新增 `test/imageRequestGuard.test.ts` 10 项（限额解析矩阵含适配器收紧/放宽/垃圾值、单图出现估算、ref 收集去重、能力检查三态、终检三层各自命中与通过边界、tool schema 不误计数、整包消息的图像份额/纯文本两态、文本遮蔽四态含校验和存活）；`test/providerDebugRedaction.test.ts` 4 项（遮蔽 + 事实行 + 原 payload 零突变、无图直出、env 门、summary 标签）；`test/mediaStrip.test.ts` +7（预算内恒等引用、最旧历史优先 + 占位符逐字 + 键移除 + 纯投影、本轮工具图仅在历史耗尽后、输入自身超额阻止、提交门双态、通知文案、文本估算逐项）；`test/anthropicProvider.test.ts` +4 与 `test/openaiProvider.test.ts` +4（能力复查双态——开关关/适配器桩关——端点零调用且纯文本不受影响、单图超限在客户端调用前拒绝且无重试、适配器声明计数/整包限额收紧生效、端点回显 data URL 被遮蔽且保留 status/cause）；`test/loop.test.ts` +4（字节预算端到端——历史省略成占位符、被省略图零加载、通知恰一次、JSONL 原样；输入自身超 body 限额在记录前拒绝零记录；终检拒绝后 tool_use/tool_result 全配对；userPromptSubmit 收到逐字 prompt + 图片元数据——真实 hook 子进程读 stdin 回显两半）。既有测试适配：S17/S18 的三个带图 provider 端到端测试补 `supportsImageInput: true`（provider 现在强制能力复查，这正是该检查存在的意义）。
- 验证：窄测 `imageRequestGuard`+`mediaStrip`+`providerDebugRedaction`（30）/`anthropicProvider`+`openaiProvider`（46）/`loop`（65）全绿；邻接 `turnImages`/`requestPrep`/`sessionController`/`messageQueue`/`toolRunner`/`contextBuilder`/`imageFile`/`imageAttachments`/`imageTokens`（169）、`compact`/`progressiveCompact`/`cacheControl`×2/`protocolHost`/`desktopShellHost`/`desktopUiRoundTrip`/`skills`/`loopAbort`/`sessionWorkspace`（295）、`tuiRender`/`tuiTranscript`/`agentTool`/`rendererImports`/`protocolClientParity`/`protocolWire`/`protocolCommandSchema`（232）全绿；`npm run typecheck` 四配置通过；全量 `npm run test`：3228 项 3227 过、1 跳过（既有）、0 失败——S02 记录的 TUI Ink 渲染失败与 S07/S15 记录的环境抖动本次均未出现。

---

## S20 `[x]` 消息队列持久化与交接改造

**前置**：S19、S11 · **规模**：长 · **设计稿**：§12.2
**涉及**：`src/runtime/messageQueue.ts`、`src/runtime/queuePump.ts`、`test/messageQueue.test.ts`

整个计划里最容易出错的一次——涉及重复用户消息的风险。**工作项 1–2 与 3–6 分两段做。**

**工作项**

1. 队列持久化「文字 + 附件引用」，**不能只存源路径**。
2. 排队接受前完成导入与新图能力检查；轮到执行时按当时实际模型**再次**检查。
3. **建议断点** —— 到此提交一次。
4. 交接改造：现有 pump 是先 `dequeue()` 再 `submit()`。改为**先验证队首完整输入，运行时接受后再消费**；未接受则保持队首或可靠恢复该项。
5. 「已接受」以**用户消息落盘**为界，与轮次结束分开通知；现有 `submit()` 等待整轮完成的返回值**不能**当接受确认。
6. 队列提交的用户记录带 `sourceQueuedMessageId`；重放时把已有对应用户记录的项视为已消费，避免进程恰好在写入与 dequeue 之间退出造成重复发送。该关联随正常会话回滚规则处理。
7. 模型不兼容或附件缺失时**暂停自动推进**并显示原因，等切模型/移除该项后重试；**禁止在 `finally` 里无限重试**。
8. 用户消息已落盘后的失败遵守既有已提交轮次语义，不重新入队制造重复消息；能力检查与附件准备失败属于提交前失败，与之区分。

**完成判据**：测试覆盖「交接中断不重复发送」「重启后队列仍有图」「不兼容时暂停而非重试风暴」。
**验证**：`node --import tsx --test test/messageQueue.test.ts` + queuePump 相关测试
**提交**：`checkpoint: S20 persist and hand off queued image messages`

**执行记录（2026-09-09，Windows x64）—— 工作项 4–8（承接上一次会话的 1–2）**

- 工作项 4（先验证后消费）：`MessageQueue.dequeue()` 拆成 `peek()`（同步、不改状态）+ `consume(messageId)`（按 id 删，不在队列里就零写入，双重消费不会为不存在的消息补一条 dequeue 记录）。交接编排提到 `queuePump.ts` 的 `handOffQueuedMessage({ peek, consume, deliver })`——两个 shell 共用同一份，`host.ts pumpQueue` 与 `App.tsx` 的 pump effect 只剩「取结果、画提示、记住阻塞项」。顺带修掉旧注释里承认的那个「lesser evil」：dequeue 先行时 `dispose()` 落在磁盘写里会丢消息，改成 peek 先行后，host 的 `deliver` 在 disposed 时直接抛错，消息留在队列里。
- 工作项 5（「已接受」= 用户消息落盘）：`SessionController.submit` 增加第三参 `QueuedSubmissionHandoff { queuedMessageId, onAccepted }`。`onAccepted` 由 `handleRecord` 里新增的 `noteQueuedSubmissionAccepted` 触发——匹配本轮 `messageId` 的那条 `message` 记录，即 `AgentLoop.appendRecord` 已 await 完追加之后，一轮只触发一次（轮内合成的 user 记录 id 不同，不会误触）。`submit()` 返回值仍是整轮结束，**不**作为接受确认；`handOffQueuedMessage` 的 `consume` 只挂在 `onAccepted` 上，两者的时序差有测试逐帧钉住。
- 工作项 6（`sourceQueuedMessageId`）：`ChatMessage` 新增可选字段，经 `AgentRunOverrides` → `ActiveRunOverrides` → 用户消息记录写入（controller 在有 handoff 时注入，其余调用点不受影响）。`replayMessageQueue` 先扫一遍所有 `message` 记录收集已发送的队列 id，再回放队列事件——覆盖「用户记录已落盘、dequeue 记录未落盘」的崩溃窗口。回滚会连同用户记录一起删掉该标记，队列项因此正常复活，与设计稿「随正常会话回滚规则处理」一致。
- 工作项 7（不兼容时暂停而非重试风暴）：`QueuePumpState` 增加 `headMessageId` / `blockedMessageId`，`canPumpQueue` 在两者相等时返回 false。被拒的队首记进 shell 侧的 `queueBlock`，**与当时的 `AgentSession` 对象绑定**——`RuntimeSlot.replace`/`patchModel` 都会换对象，所以切模型、改 provider 配置（同一 model key 打开图像开关）都会自动释放；移除该项或它不再是队首同样自动释放，无需显式清理。`finally` 里的 `pumpQueue()` 保持原样，重试由这道 gate 挡住，不是靠去掉自我触发。后面排一条新消息**不**释放（队首没变），否则会把用户消息的顺序打乱。
- 工作项 8（接受前/接受后的失败分开）：`QueueHandoffOutcome` 三态——`blocked`（未接受，留在队列，暂停并显示原因）、`failed`（已接受，用户消息已在会话里，按既有已提交轮次语义处理，绝不重新入队）、`sent`。第三种边界单独处理：已接受但 `consume` 落盘失败时归入 `blocked` 并说明原因——继续推进会重发，停下来更安全，且重启后有工作项 6 的重放规则兜底。斜杠命令没有用户记录，`deliver` 正常返回即视为已处理并消费一次。
- 测试：`queuePump` +8（阻塞 gate 的头部比较；交接的六种结局：空队列、接受即消费且发生在轮次结束之前、接受前拒绝零消费、接受后失败仍消费、斜杠命令恰好消费一次、consume 落盘失败转为暂停）；`messageQueue` +3（peek 不消费 / 按 id 消费 / 重复消费零写入、崩溃窗口按 `sourceQueuedMessageId` 去重、回滚后队列项复活）；`sessionController` +2（接受时序与 `sourceQueuedMessageId` 落到记录上、接受前被拒绝时 `onAccepted` 不触发且 loop 未运行）；`protocolHost` 把原「失败即消失」的用例拆成两条（接受前拒绝→留在队列+暂停+新消息不释放+切模型后按序排空；接受后失败→不重新入队）。`protocolHost` 的伪 runtimeSlot 现在真的会换 `current`（`replace` 生效、`createRuntime` 返回新对象），否则切模型释放这条无法验证。
- 验证：窄测 `queuePump`/`messageQueue`/`sessionController`/`protocolHost`/`desktopUiRoundTrip`/`loop` 全绿；`npm run typecheck` 四配置通过；全量 `npm run test`：3276 项 3275 过、1 跳过（既有）、0 失败。
- 仍未做（不属本会话）：设计稿 §12.3 的 `/clear` 迁移时复制附件并重绑定引用，归 S23；TUI 侧 pump 无直接自动化测试（App.tsx 无测试宿主），逻辑已尽量下沉到 `queuePump.ts`，人工验收留待 S26。

**上一次进展（2026-09-09，Windows x64）—— 工作项 1–2 完成，停在工作项 3 的建议断点**

剩余工作项 4–8（交接改造、`sourceQueuedMessageId` 关联、不兼容时暂停推进）前提未变：pump 仍是「先 `dequeue()` 再 `submit()`」，两端各一处（`host.ts pumpQueue`、`App.tsx` 的 pump effect），下次会话从这两处接着改。

- 工作项 1（持久化文字 + 附件引用）：`MessageQueue.enqueue` 自 S06/S07 起已接受 `UserInput` 并把 `images` 落进 `message_queue` 记录，**TUI 侧本就完整**；缺口在 Desktop——`enqueue-message` 命令只带 `content`，S11 因此在 `queueMessage()` 里显式拒绝带图排队。本次把 `imageIds?: string[]` 加进 wire 命令、strict schema 与 `SessionClient.enqueueMessage(content, options)`（第二参数由 `priority` 改为 `{ imageIds?, priority? }`，既有调用点均未传 priority）；host 用 **`submit` 同一个** `resolveAttachmentRefs` 解析——落进队列的是存储层背书的 ref，绝不是 renderer 给的路径，跨会话/未登记 id 直接 reject 该次 enqueue。
- 工作项 2（排队接受前的能力检查 + 执行时再检查）：`MessageQueue` 构造函数新增可选第 4 参 `validateInput`（`ValidateQueuedInput`），在 `enqueue` 内**先于 persist** 调用——单一归属，两个 shell 不会各写一份规则；抛错即「未落盘、快照未变」，正是两端把草稿还给用户所需的语义。`hydrate`/`replayMessageQueue`/`migrateTo` **不跑**该门（在 capable 模型下接受的队列必须能在纯文本模型下重启存活，怎么处置属工作项 7），有测试钉住。规则本身复用既有 gate：新增 `SessionController.assertInputAcceptable(input)` → `loop.assertImagesAllowedForSubmission(input)`（能力 + 数量上限 + 输入自身体积，S15/S19 同一份），两端构造 `MessageQueue` 时注入。**「轮到执行时按当时实际模型再次检查」已由既有链路覆盖**：pump 的 `controller.submit` 会再跑一次同一 gate（读当次 `modelState.current`），loop 每次请求重建再投影一次，provider 发送前还有终检——本次未新增第四道；缺的是「被拒时队首怎么办」，那是工作项 4/7。
- Desktop 采集端接线：`paneSession.queueMessage()` 删掉 S11 的拒绝文案，改为与 `send()` 同一道 gate（`attachmentsView().sendBlockNote`：导入未完成 / 纯文本模型），带上 `readyAttachmentRefs` 的 id，失败时 `restoreDraftImages` 把文字与附件一起还回。顺带修 S11 遗留：`send()` 成功后从不清空 `draftImages`（`restoreDraftImages` 的注释已假定「上面乐观清空过」，实际没有），会导致同一批图随下一条消息重发；现由共用的 `clearDraftImages()` 在非命令分支清空，命令分支照旧保留草稿。
- 队列条目展示：`queuedMessagesView` 的行标签补上图片——有文字时追加 `· N 张图片`，纯图片消息按 `deriveSessionTitle` 同款 `图片：文件名` 兜底（否则一条合法的纯图片排队消息画成空行），兜底同样过 `summarize` 受 `QUEUED_LABEL_MAX_CHARS` 约束。
- 未做（不属本次两个工作项）：设计稿 §12.3 的「`/clear` 迁移队列前先复制附件并重绑定引用」。当前 `migrateTo` 后 ref 仍指向旧 session，而发送路径（`bootstrap.ts` 的 `resolveAttachmentFacts`、loop 的 `readSendBytes`）按 **ref 自带的 `ownerSessionId`** 解析，因此迁移后的队列图仍可正常发送；真正的归属复制与回收保护属 S23。
- 测试：`messageQueue` +2（accept gate 拒绝时零落盘零快照变化、文本仍可入队；replay 与 `migrateTo` 不跑 gate 且 ref 原样保留）；`rendererQueuedMessages` +3（图片计数、纯图片文件名兜底、兜底长度受限）；`desktopUiRoundTrip` +2（带图排队往返：ref 过线、去重、`structuredClone` 安全、无字节泄漏、轮次结束后交接仍带 ref；未登记 id 与纯文本模型两种拒绝均不入队，同一模型下纯文本照常排队）。两个假 controller 桩（`desktopUiRoundTrip` 真规则 + `setImageCapable`、`protocolHost` 空实现）按既有桩惯例补 `assertInputAcceptable`。
- 验证：窄测 `messageQueue`/`rendererQueuedMessages`/`desktopUiRoundTrip`/`protocolHost`/`sessionController` 全绿；`npm run typecheck` 四配置通过；全量 `npm run test`：3263 项 3262 过、1 跳过（既有）、0 失败。

---

## S21 `[x]` 模型切换、fallback 与 plan 路由

**前置**：S15、S02 · **规模**：中 · **设计稿**：§9.1
**涉及**：`src/runtime/modelSwitch.ts`、`src/config/`（重试与 fallback）、`src/harness/planModeManager.ts`

**工作项** —— 按下表逐条实现并测试：

| 场景 | 行为 |
| --- | --- |
| 支持图像 + 新图 | 正常发送 |
| 不支持 + 新图 | **提交前阻止**，保留完整草稿；有历史图也不能只丢新图继续 |
| 不支持 + 仅历史图 | 提示后降级为占位符 |
| 切回支持图像的模型 | 有效上下文中的历史图恢复发送；已被摘要替代的旧轮次不自动重新展开 |
| 自动 fallback 到纯文本模型 + 本轮有新图 | **该 fallback 不适用**，保留原失败与不兼容原因；不降级新图，不对同一不兼容目标循环重试 |
| 自动 fallback + 只有历史图 | 按历史策略降级并显示原因 |
| Plan 路由、临时模型覆盖 | 按**实际请求模型**判断，不看输入栏原先显示的模型 |

另外：普通手动切换**不因历史图被禁止**，切换时告知影响、发送前再次验证；模型切换会使模型相关的 prompt/cache 状态失效，变化的 compaction 上下文需要重新计数。

**完成判据**：上表七种场景均有测试；fallback 不产生重试循环。
**验证**：`node --import tsx --test test/modelSwitch.test.ts test/modelRouting.test.ts test/planMode.integration.test.ts test/planCacheIsolation.test.ts`
**提交**：`checkpoint: S21 handle image capability across model switches`

**执行记录（2026-09-09，Windows x64）**

- 表格七行按「已由 S15 覆盖 / 本会话新增」分两类。**已覆盖**：第 1 行（支持+新图正常发送，S17/S18 payload 测试）、第 2 行（不支持+新图提交前阻止，`assertNewImagesAllowed` 三道 gate）、第 3 行（不支持+仅历史图降级为占位符，`projectTurnImagesForRequest`）、第 4 行（切回支持图像的模型恢复发送——投影是纯请求投影，JSONL 与缓存文件未改；「已被摘要替代的旧轮次不重新展开」是 compact 的既有语义，本会话只在切换提示里明说）。**本会话新增**：第 5、6、7 行与「手动切换告知影响」。
- 第 5 行（fallback 不适用）：`activateFallback` 的返回值从 `boolean` 改为 `'activated' | 'unavailable' | 'blocked-by-images'`——fallback 模型不支持图像且本轮有新图时返回第三态，**不切模型**。loop 的 catch 据此抛 `FallbackNotApplicableForImagesError`（`extends TurnImageBlockError`，reason 仍是 `model-not-capable`，所以既有的错误分类与 S24 的展示路径不受影响），message 里**同时**保留原始失败文本与图像不兼容原因，`cause` 指向 `FallbackTriggeredError.originalError`。「不对同一不兼容目标循环重试」由「压根不切」保证，不是靠计数器：primary 只被调一次，fallback provider 一次都不会被调。
  - 改动前的行为是「先切到 fallback，再由下一次请求构建的投影抛 `TurnImageBlockError`」——阻止是对的，但原始 529 失败被丢掉了，用户只看到图像原因。原测试（`a mid-run fallback to a text-only model still blocks the new images`）改名为 `an automatic fallback to a text-only model does not apply to a turn with new images` 并补上「原失败被保留」的断言。
  - 判定用的「本轮新图」直接取 `RequestImageProjection.newImages`（本会话给该结构新增的字段，就是投影里已经算好的 `current` 数组），存进 `AgentLoop.currentRequestNewImages`，每轮开头清空。这样「新图」在 fallback 判定与投影判定里不可能是两套规则；工具轮里 `Read` 产生的图片也自然算进来。
- 第 6 行（fallback + 仅历史图）：不受新 gate 影响，照常切换并按历史策略降级 + 发 `image_capability_notice`，新增回归测试钉住。
- 第 7 行（plan 路由 / 临时覆盖按实际请求模型判断）：新增 `AgentLoop.nextRoleModel()`——「下一次请求真正会用的模型」，与 `syncRoleModel` 共用同一份解析（fallback 生效中保持 fallback，否则 plan 模式取 `planModel`，其余取 primary），`requestModel` 再叠加临时覆盖。三处改为读它：
  - `getActiveModel().supportsImageInput`：此前读 `activeModel`，而 `syncRoleModel` 只在 loop 迭代内跑，所以**轮次之间**处于 plan 模式时报的是 primary 的能力——两端 UI 会放行一张纯文本 plan 模型收不下的图。这正是设计稿第 7 行点名的「看输入栏原先显示的模型」。展示用的 `model` 标签仍按既有策略显示 primary，未改。
  - `assertImagesAllowedForSubmission`（controller 在 turn-start 之前的预检）与 `runInternal` 里创建用户记录前的那道 gate：都改成按 `requestModel` 判断，因此 plan 路由下的阻止发生在**任何记录落盘之前**，草稿完整保留；错误文案里出现的是 plan 模型名。
  - 代价是一个已知的保守边界：若 `planModeManager.beforeTurn()` 恰好在本轮排空一个 approve 请求而退出 plan 模式，这道预检会按 plan 模型多拦一次。宁可保守拦下并给出可操作提示，也不要放行到「用户记录已落盘再失败」。
- 手动切换告知影响：`turnImages.ts` 新增 `collectImageRefsInRecords` 与 `describeModelSwitchImageImpact`（两个方向各一句话：切到纯文本模型说「N 张图改用文件路径、原图保留」，切回支持图像的模型说「重新发送、已被摘要替代的旧轮次不重新展开」；无图返回 `undefined`）。`activateModelKey` 成功后调它，能力取自**新 runtime 的 `loop.getActiveModel().supportsImageInput`**（即 S02 判定函数的结果），绝不按模型名猜。
  - `SetModelResult` 的 ok 分支新增可选 `notice`。**历史图永远不阻止手动切换**——只是通知，不新增确认弹窗；发送前的再次校验仍由既有三道 gate 负责。
  - 两端都覆盖：Desktop 的模型选择器走 `run-command /model <key>`（见 `surfaces.ts` 的注释），所以 `src/commands/model.ts` 把 notice 附在成功行下面即可同时覆盖 Desktop 与 TUI 的 `/model`；TUI 的 `ModelPickerDialog` 走 `App.tsx` 的 `activateModel`，那里单独把 notice 追加进系统消息。
- 测试：`modelSwitch` +3（切纯文本模型不被拒且给出提示、切回支持图像的模型的提示、无图不提示；伪 `AgentSession` 补了 `loop.getActiveModel`）、`loop` +4（fallback 不适用并保留原失败、fallback 仅历史图仍生效、plan 路由三层 gate 且零记录 + 退出 plan 后自动恢复、临时覆盖决定本次运行的能力）、`commands` +1（`/model` 把 notice 打在成功行下一行）。
- 验证：窄测 `modelSwitch`/`modelRouting`/`planMode.integration`/`planCacheIsolation`/`commands`/`loop`/`turnImages`（172）全绿；`npm run typecheck` 四配置通过；全量 `npm run test`：3283 项 3282 过、1 跳过（既有）、0 失败。

---

## S22 `[ ]` compact 与历史清理的图像投影

**前置**：S15、S16 · **规模**：长 · **设计稿**：§11.3
**涉及**：`src/harness/compact.ts`、`src/harness/progressiveCompact.ts`、`src/services/sessionMemory/`、`src/runtime/rewindSummary.ts`

要改五处，且必须共用同一份投影。**建议在工作项 4 后断一次。**

**工作项**

1. 摘要请求**只用文字**：图片用户消息与图片工具结果都格式化为含附件名、缓存位置、尺寸的占位符，与已存在的视觉分析一起摘要。因此 **compact 模型可以不支持图像**。
2. 压缩不得虚构未被观察到的图像内容。
3. 最新用户消息的**文字与图片共同保留**（既有「保留最新用户消息」规则的延伸）。
4. **建议断点** —— `compact.ts` 通过后提交一次。
5. 已进入摘要的旧图片不再自动占用后续上下文，但原文件保留，视觉模型可按路径用 `Read` 重新加载。
6. `progressiveCompact.ts`、旧工具结果清理、单结果截断、session memory、rewind 摘要**必须用同一份图像文字投影**。
7. **关键陷阱：不能只改 `content` 而把 `images` 留在被清理的工具结果上**，否则图片会继续上传。
8. 自动压缩失败仍按既有 fail-open 与每会话熔断处理。

**完成判据**：测试断言被清理的工具结果上 `images` 一并移除；纯文本 compact 模型可用；最新用户图保留。
**验证**：`node --import tsx --test test/compact.test.ts test/progressiveCompact.test.ts`
**提交**：`checkpoint: S22 project images as text during compaction`

---

## S23 `[ ]` 子代理继承与会话生命周期附件归属

**前置**：S05、S06 · **规模**：中 · **设计稿**：§12.3
**涉及**：`src/tools/AgentTool/`、`src/harness/sidechainRecordStream.ts`、`src/runtime/deleteSession.ts`、`src/runtime/sessionSwitch.ts`、`src/runtime/sessionScope.ts`

**工作项**

1. 子代理有**独立**的工具上下文、附件服务句柄与请求缓存；缓存与模块状态不跨会话/流/项目。
2. fork 继承历史时显式提供继承图片的**只读解析权限**；子代理按自己的模型能力发送或降级，**不继承主模型的能力结论**。
3. 子代理新生成的附件归属父会话产物树，随其 transcript 管理，避免清理子工作树时丢失历史图片。工作树外的继承附件只能通过**已登记的精确引用**解析。
4. 生命周期按下表：

| 操作 | 附件行为 |
| --- | --- |
| `/resume`、重启恢复 | 从 JSONL 与队列引用重建图片列表与预览 |
| `/rewind` | 原图缓存**不参与工作区文件回滚**；保留仍可恢复记录所需的附件。工具对其他图片文件的修改仍走现有 file history |
| `/clear` 或新会话 | 旧附件留在旧会话；若既有流程迁移待执行队列，**先复制附件并重绑引用，再迁移队列记录** |
| 关闭 pane / 释放 runtime | 释放内存与临时预览，已提交与排队的附件继续保留 |
| 删除会话 / 项目 | 在既有停止活动与删除产物流程中清理归属附件，**绝不删除用户选择的源文件** |

5. 首版只需保证不产生悬空引用；未来若复制为独立会话，必须复制附件并改写归属。

**完成判据**：测试覆盖「子代理用纯文本模型时历史图降级」「继承引用可解析、非继承引用被拒」「删除会话后附件目录清空」「关闭 pane 后附件仍在」「`/clear` 队列迁移无悬空引用」。
**验证**：`node --import tsx --test test/agentTool.test.ts test/deleteSession.test.ts test/fileHistoryService.test.ts` + sessionSwitch 相关测试
**提交**：`checkpoint: S23 manage attachment ownership across subagents and sessions`

---

## S24 `[ ]` 错误分类与两端展示

**前置**：S09–S14、S19 · **规模**：中 · **设计稿**：§13
**涉及**：`src/runtime/errors.ts`、两端展示层

**工作项**

1. 用**可区分的原因**展示：模型未启用图像、格式不支持、文件缺失、解码失败、图片超限、请求超限。**不把所有问题显示成 HTTP 400。**
2. 工具结果复用既有 `invalid_input` / `not_found` / `precondition_failed` 等错误码，详细原因放结构化详情，**不另建一套工具错误系统**。
3. 每类原因在两端都要有对应文案与可操作出口（切模型 / 移除该图 / 裁剪）。
4. 能力开关只拦截已知不兼容请求；配置错误、端点私有限额、服务端故障导致的 HTTP 错误仍要如实呈现，不谎称已避免。

**完成判据**：六类原因逐一在 Desktop 与 TUI 走通，且都有可操作出口。
**验证**：新增错误分类测试 + 两端手工
**提交**：`checkpoint: S24 add distinct image error reasons`

---

## S25 `[ ]` 全量 typecheck / 测试 / 构建

**前置**：S20–S24 · **规模**：短

```bash
npm run typecheck
npm run test
npm run build
npm run build:desktop
```

**完成判据**：四条命令全绿；base / build / preload / renderer / DOM 测试五个 tsconfig 的 `rootDir` / `exclude` 边界未被破坏；`ink+7.0.6.patch` 与 `wrap-ansi+10.0.0.patch` 仍配对。
**提交**：`checkpoint: S25 full typecheck, test and build pass`

---

## S26 `[ ]` Desktop 冒烟与 TUI 三平台人工验证

**前置**：S25 · **规模**：中 · **设计稿**：§14.2
**涉及**：`scripts/smoke-desktop.mjs`

**工作项**

1. `npm run smoke:desktop`：用 scratch 项目跑真实 Electron 行为，teardown 恢复 renderer 偏好、`~/.myagent/config.json`、`~/.myagent/projects.json` 且**永不抛错**。
2. Desktop 人工项：截图粘贴、拖放导入、多图列表、删除、纯图片发送、两 pane 草稿隔离、导入完成不串会话、失败恢复不覆盖新输入、流式期间缩略图不反复传输。
3. TUI 平台矩阵：Windows / macOS / Linux(Wayland + X11) 各跑成功路径与依赖缺失路径；验证 Electron 与 Node 两侧图像处理结果一致。
4. **当前机器无法验证的平台如实记录为「待验收」，不用 mock 结果冒充。** 在本块下留一张平台 × 结论表。

**完成判据**：冒烟通过 + 上述人工项逐条确认 + 平台矩阵已填。
**提交**：`checkpoint: S26 desktop smoke and platform verification`

---

## S27 `[ ]` `README.md` 与验收矩阵签收

**前置**：S26 · **规模**：短
**涉及**：`README.md`

**工作项**

1. README 写入用户可见行为：模型能力配置位置、支持与不支持的格式、Desktop/TUI 快捷入口与 `/paste-image`、自动缩放策略、历史图降级行为、附件存储位置与删除语义。实现细节留在本文件与设计稿，不搬进 README。
2. 对照下表逐项打勾。**任何一项未过则回到对应会话，不得以「接口能发出一张图」代替交付。**

| 类别 | 必须验证的行为 | 会话 | 状态 |
| --- | --- | --- | --- |
| 配置 | 缺省关闭；两端开关保存/reload 一致；改其他字段不丢能力；同端点模型能力可不同 | S02, S03 | `[ ]` |
| 新图阻止 | UI、直接协议调用、队列、临时模型覆盖都不能向纯文本模型发新图；失败后输入完整 | S15, S20, S21 | `[ ]` |
| 历史降级 | 明确通知；payload 无历史图字节；JSONL 与文件不变；切回视觉模型恢复有效图片 | S15, S21 | `[ ]` |
| Provider | 两条接口都有真实 image 块；纯图片消息有效；OpenAI 多工具结果全部结算后再插图片上下文 | S17, S18 | `[ ]` |
| 工具 | `Read` 文本编辑状态不回归；图片成功/失败均有配对结果；不支持的参数与格式明确报错 | S10 | `[ ]` |
| 处理 | EXIF、透明 PNG、大截图、动画首帧、伪扩展名、损坏文件、字节与像素超限 | S04 | `[ ]` |
| 预算 | 用户附件 + mention + 工具图片合计；最旧历史优先省略；当前图不静默丢弃；不计 Base64 文本 token | S16 | `[ ]` |
| 持久化 | 删源文件后可恢复；队列重启后仍有图；队列交接中断不重复发送；`/clear` 迁移无悬空引用；中断恢复完整草稿 | S05, S07, S20, S23 | `[ ]` |
| 模型与压缩 | fallback/plan/子代理按实际能力处理；纯文本 compact 可用；最新用户图保留；被清理工具图不继续上传 | S21, S22, S23 | `[ ]` |
| 界面 | 两 pane 草稿隔离；导入完成不串会话；失败恢复不覆盖新输入；缩略图不随流式输出反复传输 | S11, S12 | `[ ]` |
| 清理 | 关闭 pane 保留会话附件；删除会话清理全部所属附件；不删源图片及其他会话资源 | S05, S23 | `[ ]` |
| 平台 | Windows/macOS/Linux 成功路径与无依赖路径；Electron 与 Node 处理结果一致 | S13, S26 | `[ ]` |

**提交**：`checkpoint: S27 document image input and sign off acceptance`

---

## 附录 A 风险与需要在实施中确认的项

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| `sharp` 在 Electron 43 / Node 22 的 ABI 与打包 | 阻塞 S04 之后全部工作 | S01 第一个做；失败则先在文档里记录替代方案再开工 |
| 各端点对 data URL / image 块的实际支持 | 用户开了开关仍可能 400 | 设计稿已声明开关不保证成功；S24 保证错误可读 |
| 图像 token 估算精度 | 预算偏差导致过早/过晚压缩 | 保守估算 + 标注近似；以服务端真实 usage 为消费依据 |
| S20 队列交接语义改造 | 可能引入重复用户消息 | 用 `sourceQueuedMessageId` 幂等；重点补测试 |
| 附件目录增长 | 磁盘占用 | S05 保留窗口回收；首版不做全局去重 |
| 三平台剪贴板依赖缺失 | 部分环境不可用 | 明确降级到路径入口并给出具体原因，不静默失败 |

## 附录 B 首版明确不做

远程 URL 图片下载、PDF、OCR 服务、图片生成工具、权限弹窗与 `AskUserQuestion` 的图片能力、MCP 图片入口、跨项目附件转发、端点专用限额 UI、通用音视频框架。

任何一项若在实施中被要求加入，**先更新设计稿，再更新本文件的会话划分**，不要直接塞进某个会话。
