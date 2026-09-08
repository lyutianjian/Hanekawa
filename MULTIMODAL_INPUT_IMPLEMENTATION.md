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
| S05 | 附件存储、解析、缩略图与回收 | S04 | 中 | `[ ]` |
| S06 | 记录与上下文类型接入 `images`，持久化兼容 | S02, S05 | 中 | `[ ]` |
| S07 | `UserInput` 贯穿提交路径与中断恢复 | S06 | 长 | `[ ]` |
| S08 | 协议命令与 wire schema | S07 | 中 | `[ ]` |
| S09 | `@` 图片引用 | S08 | 中 | `[ ]` |
| S10 | `Read` 工具图片分流 | S06 | 中 | `[ ]` |
| S11 | Desktop 采集与草稿状态机 | S08, S19 | 长 | `[ ]` |
| S12 | Desktop 预览、缩略图与打开原图 | S11 | 短 | `[ ]` |
| S13 | TUI 图片剪贴板采集（三平台） | S08 | 中 | `[ ]` |
| S14 | TUI 路径粘贴、附件列表与 `/paste-image` | S13 | 中 | `[ ]` |
| S15 | 当前轮/历史轮判定与历史降级投影 | S06 | 长 | `[ ]` |
| S16 | `mediaStrip` 数量限制与图像 token 预算 | S15 | 中 | `[ ]` |
| S17 | Anthropic payload 图像映射 | S16, S05 | 中 | `[ ]` |
| S18 | OpenAI payload 图像映射与工具图片合成消息 | S16, S05 | 中 | `[ ]` |
| S19 | 发送前最终校验与日志遮蔽 | S17, S18 | 中 | `[ ]` |
| S20 | 消息队列持久化与交接改造 | S19, S11 | 长 | `[ ]` |
| S21 | 模型切换、fallback 与 plan 路由 | S15, S02 | 中 | `[ ]` |
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

## S05 `[ ]` 附件存储、解析、缩略图与回收

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

---

## S06 `[ ]` 记录与上下文类型接入 `images`，持久化兼容

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

---

## S07 `[ ]` `UserInput` 贯穿提交路径与中断恢复

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

---

## S08 `[ ]` 协议命令与 wire schema

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

---

## S09 `[ ]` `@` 图片引用

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

---

## S10 `[ ]` `Read` 工具图片分流

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

---

## S11 `[ ]` Desktop 采集与草稿状态机

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

---

## S12 `[ ]` Desktop 预览、缩略图与打开原图

**前置**：S11 · **规模**：短 · **设计稿**：§6.3、§14.2
**涉及**：`src/desktop/renderer/dom/composerView.ts`、`transcriptView.ts`、`src/desktop/shellHost.ts`

**工作项**

1. 缩略图按需取得受限 data URL；**不要**把原始 Base64 混进每次快照。
2. 打开原图由 host 依据已登记附件定位文件；越权 ID 拒绝。
3. **流式输出期间缩略图不得反复重传**，保持帧/渲染签名工作有界。
4. 预览弹层遵守三种关闭方式与 focus 规则；paint 内的 `focus()` 放最后（它会同步触发 `focusout`）。

**完成判据**：流式过程中缩略图请求次数有界；点击可打开原图；越权 ID 被拒。
**验证**：`node --import tsx --test test/desktopShellHost.test.ts` + 手工
**提交**：`checkpoint: S12 add desktop attachment previews`

---

## S13 `[ ]` TUI 图片剪贴板采集（三平台）

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

---

## S14 `[ ]` TUI 路径粘贴、附件列表与 `/paste-image`

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

---

## S15 `[ ]` 当前轮/历史轮判定与历史降级投影

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

---

## S16 `[ ]` `mediaStrip` 数量限制与图像 token 预算

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

---

## S17 `[ ]` Anthropic payload 图像映射

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

---

## S18 `[ ]` OpenAI payload 图像映射与工具图片合成消息

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

---

## S19 `[ ]` 发送前最终校验与日志遮蔽

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

---

## S20 `[ ]` 消息队列持久化与交接改造

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

---

## S21 `[ ]` 模型切换、fallback 与 plan 路由

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
