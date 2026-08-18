# 极简锚定插件 — 设计（基于网络共识 + omp 技术约束 + 实测反馈）

> 状态：**决策已定（含两次设计迭代）**。依据 = ①社区网络共识（dsh minimal、pi-deepseek-anchor、awesome-deepseek-harness、CTOL 分析）+ ②omp 源码实证 + ③真实会话实测（发现「首个回复即 promote」过窄，改为仅工具调用）+ ④请求结构实证（锚定只调第一部分、上下文第一轮注入入历史）。

## 文档导航

**设计文档（行为全貌）**：本文档（`docs/design/anchor-plugin.md`）——极简锚定机制、技术事实、设计决策、约束、验证计划。它是行为规格的主文档。

**架构决策（ADR，`docs/adr/`）**：难以逆转、有真实权衡的决策记录：
- [ADR-0001](docs/adr/0001-two-phase-anchoring.md) — 两阶段锚定机制（anchor-then-promote）※**已由无 promote 设计取代**（D1/D2/D11）
- [ADR-0002](docs/adr/0002-explicit-switch.md) — 显式 opt-in（不默认自动，因 KV 缓存成本）
- [ADR-0003](docs/adr/0003-activation-condition.md) — 激活条件限定 DeepSeek V4 Pro + thinking High
- [ADR-0004](docs/adr/0004-promotion-once.md) — 一次性 promote（仅首次工具调用）+ 自动复位 ※**已由无 promote 设计取代**

**不进 ADR 的设计决策**（可逆，留在此设计文档）：锚定工具集（`bash`+`str_replace_editor`，2 schema 不变）、persona 文本（逐字节复刻 dsh minimal）、`/dspro-boost` 便利行为细节、widget 呈现细节、上下文披露（第一轮注入入历史，D9）、命令分派（工具能力包装为 bash 命令，D11）。

## 1. 背景与动机

DeepSeek V4-Pro 0813 的后训练 RL 过度针对智能体基准，CoT 对训练分布过拟合：模型进入 `Let me` 式思维链时推理质量崩。第三方受控实验（CTOL Digital）确认这是过拟合症状。**工具锚定**是已验证最有效的缓解：模型按初始工具列表锚定推理轨迹，官方全量工具集基准 91–92，极简双工具集 99/96。

dsh「极简模式」据此设计：纯净 persona + 仅 `bash` + `str_replace_editor`，触发干净的 `We need` 式推理。社区共识（awesome-deepseek-harness、pi-deepseek-anchor）把极简模式推广为**两阶段锚定**：minimal 对齐的 bootstrap → 首个工具调用后切回 full Standard 工具。

**本设计偏离两阶段**（2026-08-18）：用户实测 + 讨论确认「bash 是万能通道」——dsh minimal 里模型用 bash 命令（ls/cat/sed）即可读写文件/列目录/编辑，不需要其他工具 schema。因此锚定**全程保持** bash + str_replace_editor 双工具（CoT 锚定完整），工具能力通过**命令分派**（D11：工具名命令在 bash 内拦截/翻译）提供——无需 promote 切换。

## 2. 目标 / 非目标

**目标**
- omp 原生扩展，实现极简锚定：纯净 persona + 2 工具 schema（bash + str_replace_editor）+ 上下文披露 + 命令分派
- **激活条件**：当前模型 = DeepSeek V4 Pro 且 thinking = High 时才后台生效
- **显式 opt-in**：用户主动触发，不默认自动生效（因 KV 缓存成本）
- 缓解 deepseek CoT 过拟合：模型全程在极简环境思考与工作（bash 命令分派提供工具能力）

**非目标**
- 不重实现 dsh 或 str_replace_editor 全部语义（见 D1）
- 不做两阶段切换 / promote（无 promote，见 D2）
- 不做 CoT 关闭 / thinking effort 调节（那是另一类干预）

## 3. 核心机制：极简锚定流程（无 promote）

**设计迭代**：①两阶段锚定（promote 恢复完整工具）→ ②promote 开关（str_replace_editor 触发）→ ③**无 promote**（2026-08-18 定稿）：模型全程只有 bash + str_replace_editor，工具能力通过 bash 命令分派（D11）提供，无需切换。

```
/dspro-boost（裸命令，开启一次）
   → 便利设模型/thinking = V4-Pro/High（setModel + setThinkingLevel）
   → 锚定：systemPrompt 替换纯净 persona，第一轮注入完整提示词（event.systemPrompt）+ 命令告知（D11）入历史（D9）
   → 模型全程面对 bash + str_replace_editor（2 schema 不变）
   → 用 bash 命令使用全部能力：read/write/edit/glob/grep/xd（命令分派 D11）+ bash 原生命令（ls/cat/sed/curl）
   → 持续锚定（配置仍 pro+high 时），无 promote、无工具切换
   → 配置变化（用户切走模型）→ 停止 persona 覆盖，恢复完整环境
```

**取消保护**：真实请求时（`before_agent_start`）检测到模型配置不再是 pro+high → **停止锚定**（不再覆盖 systemPrompt），恢复完整环境。无「工具卡极简」问题（工具从未切换）。

**omp per-turn 特性**：`before_agent_start` 的 systemPrompt 覆盖是 per-turn 的——插件在配置匹配时每轮返回纯净覆盖，配置变化时不返回（omp 自动恢复完整 base）。

## 4. 技术事实（omp 源码实证，决定实现形态）

- **`before_agent_start`** 返回 `{ systemPrompt: string[] }` 整段替换，**per-turn**（`finally` 自动 `clearTurnSystemPromptOverride`）。返回 string 自动包成数组。多扩展链式。
- **`setActiveTools`** 异步 `Promise<void>`，带 registration barrier，**必须 `await`**。
- **turn 内生效语义**：`setActiveTools` 立即改 agent 内部 state，但工具 schema 在**每次 model call 前**才由 `syncContextBeforeModelCall` 快照进请求 → 对当前正在 stream 的请求不生效，**下一个 model call / 下一 turn 生效**。
- **锚定强成立**：`setActiveTools(['bash','str_replace_editor'])` 全量替换会彻底移除 discoverable 工具——既无可调用 schema，也无系统提示词目录行。模型只看到 `bash` + `str_replace_editor`，零污染。
- **检测时机**：插件无「用户切模型」事件，**唯一可靠检测点是 `before_agent_start`**（每次真实请求时触发）。配置变化在真实请求时被检测。
- **事件**：`before_agent_start`（锚定/检测/取消）、`tool_call`（命令分派 D11，检查 bash 调用参数）；`message_end` 不使用。
- **模型/thinking 读取**：`ctx.models.current()` 拿模型；`getThinkingLevel` 拿 thinking 级别。
- **注入消息入历史**：`before_agent_start` 返回 `{ messages }` 加入本轮请求消息 → `emitInputMessages`（message_start/end 事件）→ `agent.appendMessage`（无过滤 push）→ **进入 `state.messages` 历史**。第一轮注入一次，后续轮次历史自动带上（仿 `eager-todo-prelude`：历史无 user 消息时才构建）。
- **工具 schema 无法消息注入**：模型只能调用 `tools` 参数（函数定义）里的工具；消息里的 schema 文字描述不可调用。工具能力通过 bash 命令分派提供（D11），不依赖 schema。

## 5. 设计决策（网络共识 + 技术事实 + 实测）

### D1. 锚定工具集 → `bash` + `str_replace_editor`（2 schema 不变，无 promote）

网络共识：dsh minimal / pi-deepseek-anchor 用 `bash` + `str_replace_editor`。用户实测确认：**同一模型在 dsh 下会输出 `We need`，omp 下不会**——差距来自工具命名 + 上下文污染，而非模型。因此锚定工具**必须**命名对齐 dsh minimal：`['bash','str_replace_editor']`。

**关键洞察（2026-08-18 定稿）**：2 工具 schema ≠ 模型能力受限——**bash 是万能通道**。`ls`/`cat`/`sed`/`curl` 等都是 bash 命令，**不需要 schema**。dsh minimal 里模型用 bash 就能读写文件/列目录/编辑/网络——不需要 read/write/edit 工具的 schema，**不需要 promote**（bash 一直可用，模型从第一轮就能干活）。

**str_replace_editor**：保留注册（命名对齐 dsh minimal），编辑能力并入命令分派（D11 的 `edit` 命令）。

### D2. 无 promote（2026-08-18 定稿）

**演进**：①两阶段锚定（promote 恢复完整工具）→ ②promote 开关（str_replace_editor 调用触发）→ ③**删除 promote**：模型全程只有 bash + str_replace_editor，靠 bash 原生命令 + 命令分派（D11）完成所有工作。

理由：
- bash 万能通道覆盖 read/write/edit/glob/grep/xd:// 等能力（原生命令 + 命令分派），模型不需要「恢复完整工具集」
- 删除 promote 连带消灭：KV 缓存破坏、切换时机、边界条件（compact/handoff/plan/子代理与 promote 的交互）全部消失
- 【极简提示 + 2 schema】全程不变，CoT 锚定完整保持

### D3. 激活范围 → DeepSeek V4 Pro + thinking High 双条件

用户指定。非匹配配置完全透明（插件不干预）。判定用 `ctx.models.current()` + `getThinkingLevel`。

### D4. discoverable 污染 → 不存在（强锚定成立）

技术事实：锚定全量替换彻底移除 discoverable 工具的 schema 与目录行。无需额外白名单手段。

### D5. persona 作用域 → 锚定期全程

配置仍 pro+high 时，每轮 `before_agent_start` 返回纯净覆盖；配置变化时不再返回（omp 自动恢复完整 base）。persona 文本逐字节复刻 dsh minimal 的 `You are a helpful software engineer assistant.`。

### D6. 状态模型 → 持续性锚定，无持久开关

锚定是**持续状态**（开启后，配置匹配期间每轮生效），不是一次性动作。**无 promote、无自动复位**——配置变化（D8）或用户停止时才结束。不持久化开关（session 重启后默认未开启，用户重新触发）。

### D7. 命令 → 裸 `/dspro-boost`（开启）+ `/dspro-boost status`

**裸 `/dspro-boost` = 开启锚定**（配置匹配期间持续生效）；`/dspro-boost status` 查看锚定状态。**无 off**（配置变化时自动停止，见 D8）。

裸命令的**便利行为**：开启时顺带 `setModel` + `setThinkingLevel(High)` 设为 V4-Pro/High。这是纯便利，不改变激活逻辑（仍每真实请求检测实际配置）。

**TUI 呈现（widget）**：开启时显示 `boost` 状态条（编辑器上方），组件工厂 + 主题色。**widget = 注入状态指示灯**（用户确认 2026-08-18）：
- **绿色** = 已注入（新会话注入完成，上下文完整）
- **红色** = 未注入（新会话开启注入前、中途开启、compact 后——仅 minimal 环境）
- 配置变化停止锚定 → widget 消失
- 调试 `PI_ANCHOR_DEBUG=1` 输出阶段/实际工具目录/systemPrompt。

### D8. 停止锚定（配置变化）

真实请求时（`before_agent_start`）检测到模型配置不再是 pro+high → **停止锚定**：不再覆盖 systemPrompt（omp 恢复完整 base）、widget 消失。工具从未切换（始终 bash + str_replace_editor），无「卡极简」问题。

### D9. 上下文披露 → 第一轮注入必要信息，自然入历史（2026-08-18 确定）

**问题**：锚定替换 systemPrompt 为纯净 persona 后，模型丢失完整提示词（AGENTS.md、工作约定）——「极简到几乎没用」。历史里也没有它们（systemPrompt 不在 messages 里）。

**解法**（用户洞察）：**第一轮把必要信息作为消息注入 → 自然变成对话历史 → 后续轮次自动带上**。与 omp 内置 `eager-todo-prelude` 同构（历史无 user 消息时注入一次 → 入历史 → 之后不再构建）。

**omp 机制实证**：
- 请求结构 = `[systemPrompt + tools] + messages`，systemPrompt/tools 每轮重新发送
- **锚定只调第一部分**（systemPrompt 极简 + tools 极简），历史（messages）不动
- `before_agent_start` 注入的消息 → 本轮请求消息 → `emitInputMessages`（message_end 事件）→ `agent.appendMessage`（无过滤 push）→ **进入 `state.messages` 历史**
- 佐证：`createEagerTodoPrelude` 检查 `state.messages.some(role === "user")`——历史有 user 消息后不再构建（第一轮注入模式）

**注入内容**：`event.systemPrompt` 全文（AGENTS.md、系统指令、工作约定——工具 schema 在 tools 参数不在 systemPrompt，天然不含工具说明）+ **命令告知**（D11：各工具能力作为 bash 命令的用法）。工具 schema 无法通过消息注入（模型只能调 tools 参数里的工具，消息文字描述不可调用）——**工具能力通过 bash 命令分派提供（D11），不依赖工具 schema**。

**注入时机**：**仅新会话**（`session_start` 触发，含 handoff 后的新会话）。实现用插件状态机（不依赖读历史）：

```
session_start → pendingNewSession = true（新会话标记）
第一个真实请求（before_agent_start）：
  pendingNewSession = true → 注入 → pendingNewSession = false → widget 绿
  pendingNewSession = false（会话已进行，如中途开启）→ 不注入 → widget 红
compact（无 session_start）→ 标记不变 → 不注入
handoff 后新 session_start → 标记重置 → 注入
```

**中途开启（会话已进行）→ 不注入**，仅切换 minimal 环境（纯净 persona + 2 schema），widget 红（用户确认 2026-08-18）。注入内容在历史里丢失的场景（compact）**不重新注入**——widget 红反映真实状态（不包含注入）。

### D10. 边界条件（2026-08-18 调查确认）

| 边界 | 机制事实 | 处理 |
|---|---|---|
| **compact 之后** | `session_compact` 事件；注入的历史消息被压缩成摘要，内容丢失/变形 | **不重新注入**（compact 不是新会话，自然行为）——widget 变红反映真实状态 |
| **handoff 之后** | handoff = session 切换（`session_switch` reason: "handoff"）→ **新会话**（session_start 触发） | **需要注入**——session_start 重置 pendingNewSession 标记 → 新会话第一轮注入 → widget 绿 |
| **/plan 命令** | plan mode 注入 `plan-mode-context`（每轮），依赖 ask/write/edit/task 等工具 | **plan mode 激活时跳过锚定**（极简工具集会破坏 plan mode 的工具需求） |
| **子代理会话** | 子代理（agentKind: "sub"）也初始化 extensionRunner 并触发 before_agent_start（task/executor.ts 实证）；继承父会话模型/thinking 配置 | **只应用于主会话**（`ctx.agentKind() === "main"`），子代理跳过（任务委派需完整工具） |

### D11. 命令分派 → 工具能力包装为 bash 命令（2026-08-18 定稿）

**问题**：锚定期只有 bash + str_replace_editor 两个 schema，模型如何「使用全部工具能力」（读/写/编辑/搜索/列文件/xd:// 发现）？

**解法**（用户方案）：**告知 + 分派**——把各工具能力包装为 bash 命令告知模型；模型调用 bash 时，插件按命令分派：

```
告知（注入消息，第一轮）：
  「bash 支持以下命令：
   read <path>           → 读文件
   write <path> <内容>    → 写文件
   edit <path> <修改>     → 编辑文件
   glob <pattern>        → 列文件
   grep <pattern> <path> → 搜索
   xd <tool>             → 工具文档/发现（xd:// 能力）
   ……」

模型调 bash，参数：「read src/foo.ts」
→ 命令分派（tool_call 拦截或自定义 bash 工具实现——两者本质相同，都是处理函数）
→ 匹配 read 命令 → 翻译/处理 → 返回文件内容
→ 正常 bash 命令 → 放行执行
```

**实现路径**：`tool_call` 拦截（检查 bash 调用参数，匹配命令 → block + 返回处理结果）或**自定义 bash 工具**（插件注册 bash，内部分派 + `invokeTool` 委托原生 bash）——用户确认二者无实质区别（都是函数处理命令）。

**转调约束**：扩展无任意工具调用 API（`invokeTool` same-tool only）——命令分派用**翻译**（read→cat、write→echo/cat、edit→sed、glob→ls/find、grep→grep）或**插件自实现**（fs 操作）完成，不依赖转调 API。

**xd:// 不需要额外判断**（用户确认 2026-08-18）：xd:// 的调用路径 = read/write 工具（`read xd://<tool>` 读文档、`write xd://<tool>` 执行）——锚定期 read/write **不在 schema**（只有 bash + str_replace_editor）→ 模型无法调 read/write → **xd:// 路径天然不可达**。模型的一切工具意图只能通过包装 bash 表达（`read <path>` 翻译命令、`xd <tool>` 工具发现），不存在绕过 bash 直接使用 xd:// 的路径。`xd <tool>` 命令在分派中处理（`getAllTools()` 返回工具文档），无需对 xd:// 协议做特判。

## 6. 技术约束与风险

- **命令分派 fail-closed**：分派逻辑必须稳，handler 抛错会阻断 bash 工具。
- **背景回调隔离**：任何定时/异步用 `ctx.setTimeout`/`ctx.setInterval`，禁用裸 timer（会崩 session）。
- **`before_agent_start` 多扩展链式**：锚定期纯净覆盖会暂时代替其他扩展的 systemPrompt 块，需协调。
- **激活判定的模型名匹配**：deepseek-v4-pro 的精确标识已在真实环境核对（测试通过）。
- **无 promote 后工具永不切换**：模型全程 bash + str_replace_editor，命令分派（D11）覆盖工具能力——无「工具卡极简」问题（D8 取消保护随之删除，配置变化时只影响是否继续锚定 systemPrompt）。

## 7. 验证计划

完整测试方法见 **[docs/design/testing.md](docs/design/testing.md)**。摘要：

- **L1 单元测试**（必做）：激活判定、命令分派（read/write/edit/glob/grep/xd）、第一轮注入、边界条件（compact/handoff/plan/子代理）
- **L2 冒烟**（必做）：`omp --extension ./src/index.ts` 加载，验证命令/widget/注入/分派
- **L3 效果验证**（用户执行，必做一次）：真实 DeepSeek 会话，开/关插件跑同一任务，对比工具目录、thinking 聚焦度、耗时——验证「极简提示 + 2 schema + bash 命令分派」是否复现 `We need`

## 8. 已确认的实现要点

1. deepseek-v4-pro 模型标识 + thinking High 枚举：已确认（测试通过）
2. **无 promote**：全程 bash + str_replace_editor（2 schema 不变），无工具切换（D1/D2）
3. 锚定工具 = `['bash','str_replace_editor']`，命名对齐 dsh minimal
4. 上下文披露：**仅新会话注入**（session_start，含 handoff），pendingNewSession 状态机判定（D9）；中途开启/compact 后不注入（widget 红）
5. 命令分派：工具能力包装为 bash 命令（read/write/edit/glob/grep/xd），分派逻辑 = tool_call 拦截或自定义 bash 工具（D11）
6. 边界条件：handoff 注入（新会话）；compact 不注入（同会话）；plan mode 跳过锚定；子代理跳过锚定（D10）
7. 工具 schema 无法消息注入——工具能力通过 bash 命令分派提供（D11），不依赖 schema
