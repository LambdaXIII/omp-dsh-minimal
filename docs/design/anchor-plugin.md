# 两阶段锚定插件 — 设计（基于网络共识 + omp 技术约束 + 实测反馈）

> 状态：**决策已定（含两次设计迭代）**。依据 = ①社区网络共识（dsh minimal、pi-deepseek-anchor、awesome-deepseek-harness、CTOL 分析）+ ②omp 源码实证 + ③真实会话实测（发现「首个回复即 promote」过窄，改为仅工具调用）+ ④请求结构实证（锚定只调第一部分、上下文第一轮注入入历史）。

## 文档导航

**设计文档（行为全貌）**：本文档（`docs/design/anchor-plugin.md`）——两阶段状态机、技术事实、设计决策、约束、验证计划。它是行为规格的主文档。

**架构决策（ADR，`docs/adr/`）**：难以逆转、有真实权衡的决策记录：
- [ADR-0001](docs/adr/0001-two-phase-anchoring.md) — 两阶段锚定机制（anchor-then-promote）
- [ADR-0002](docs/adr/0002-explicit-switch.md) — 显式 opt-in（不默认自动，因 KV 缓存成本）
- [ADR-0003](docs/adr/0003-activation-condition.md) — 激活条件限定 DeepSeek V4 Pro + thinking High
- [ADR-0004](docs/adr/0004-promotion-once.md) — 一次性 promote（仅首次工具调用）+ 自动复位

**不进 ADR 的设计决策**（可逆，留在此设计文档）：锚定工具集选择（`bash`+`str_replace_editor`，空实现 promote 开关）、persona 文本（逐字节复刻 dsh minimal）、`/dspro-boost` 便利行为细节、widget 呈现细节、上下文披露（第一轮注入入历史，D9）。

## 1. 背景与动机

DeepSeek V4-Pro 0813 的后训练 RL 过度针对智能体基准，CoT 对训练分布过拟合：模型进入 `Let me` 式思维链时推理质量崩。第三方受控实验（CTOL Digital）确认这是过拟合症状。**工具锚定**是已验证最有效的缓解：模型按初始工具列表锚定推理轨迹，官方全量工具集基准 91–92，极简双工具集 99/96。

dsh「极简模式」据此设计：纯净 persona + 仅 `bash` + `str_replace_editor`，触发干净的 `We need` 式推理。社区共识（awesome-deepseek-harness、pi-deepseek-anchor）把极简模式推广为**两阶段锚定**：minimal 对齐的 bootstrap → 首个工具调用后切回 full Standard 工具。

## 2. 目标 / 非目标

**目标**
- omp 原生扩展，实现两阶段锚定：阶段 A 极简环境 → 阶段 B 完整能力
- **激活条件**：当前模型 = DeepSeek V4 Pro 且 thinking = High 时才后台生效
- **显式 opt-in**：用户主动触发，不默认自动生效（因 KV 缓存成本）
- 缓解 deepseek CoT 过拟合：初始规划在干净环境完成

**非目标**
- 不重实现 dsh 或 str_replace_editor 全部语义（见 D1）
- 不做渐进式多阶段（就两阶段，见 D1）
- 不做 CoT 关闭 / thinking effort 调节（那是另一类干预）

## 3. 核心机制：一次性锚定流程

**实测迭代**：第一版「首个回复或工具调用即 promote」在真实会话中发现**锚定只覆盖首个 turn**——主任务（如 README 检索）在首个简单回复后已 promote，没享受极简环境。改为**仅首次工具调用触发 promote**，让 thinking 全程在极简环境。

```
/dspro-boost（裸命令，开启一次）
   → 便利设模型/thinking = V4-Pro/High（setModel + setThinkingLevel）
   → 锚定（bootstrap）：工具切极简 ['bash','str_replace_editor']，systemPrompt 替换纯净 persona，
     第一轮注入完整提示词（event.systemPrompt）入历史（D9）
   → 模型 thinking + 纯文本回复（全程极简，不 promote）
   → ……直到第一次调用 str_replace_editor（编辑意图，promote 开关）……
   → promote：恢复完整工具集，停止 persona 覆盖（omp 恢复完整 base）
   → 自动复位（开关 off，widget 消失）——本次锚定生命周期结束
   → 后续输入完全无感
```

**取消锚定保护**：锚定中（promote 前）若真实请求时检测到模型配置不再是 pro+high（用户切走模型/改 thinking）→ **取消本次锚定**，恢复完整工具，widget 消失。工具永不卡在极简。

**omp per-turn 特性**：`before_agent_start` 的 systemPrompt 覆盖是 per-turn 的。promote 后插件**不再返回覆盖**，完整 persona 与工具上下文由 omp 自动恢复。

## 4. 技术事实（omp 源码实证，决定实现形态）

- **`before_agent_start`** 返回 `{ systemPrompt: string[] }` 整段替换，**per-turn**（`finally` 自动 `clearTurnSystemPromptOverride`）。返回 string 自动包成数组。多扩展链式。
- **`setActiveTools`** 异步 `Promise<void>`，带 registration barrier，**必须 `await`**。
- **turn 内生效语义**：`setActiveTools` 立即改 agent 内部 state，但工具 schema 在**每次 model call 前**才由 `syncContextBeforeModelCall` 快照进请求 → 对当前正在 stream 的请求不生效，**下一个 model call / 下一 turn 生效**。
- **锚定强成立**：`setActiveTools(['bash','str_replace_editor'])` 全量替换会彻底移除 discoverable 工具——既无可调用 schema，也无系统提示词目录行。模型只看到 `bash` + `str_replace_editor`，零污染。
- **检测时机**：插件无「用户切模型」事件，**唯一可靠检测点是 `before_agent_start`**（每次真实请求时触发）。配置变化在真实请求时被检测。
- **事件**：`tool_call`（首次工具调用 = promote 信号）、`before_agent_start`（锚定/检测/取消）；`message_end` **不再**作为 promote 信号。
- **模型/thinking 读取**：`ctx.models.current()` 拿模型；`getThinkingLevel` 拿 thinking 级别。
- **注入消息入历史**：`before_agent_start` 返回 `{ messages }` 加入本轮请求消息 → `emitInputMessages`（message_start/end 事件）→ `agent.appendMessage`（无过滤 push）→ **进入 `state.messages` 历史**。第一轮注入一次，后续轮次历史自动带上（仿 `eager-todo-prelude`：历史无 user 消息时才构建）。
- **工具 schema 无法消息注入**：模型只能调用 `tools` 参数（函数定义）里的工具；消息里的 schema 文字描述不可调用。全套工具唯一提供方式 = promote 后恢复完整 `tools`。

## 5. 设计决策（网络共识 + 技术事实 + 实测）

### D1. 锚定工具集 → `bash` + `str_replace_editor`（命名对齐 dsh minimal）

网络共识：dsh minimal / pi-deepseek-anchor 用 `bash` + `str_replace_editor`。用户实测确认：**同一模型在 dsh 下会输出 `We need`，omp 下不会**——差距来自工具命名 + 上下文污染，而非模型。因此锚定工具**必须**命名对齐 dsh minimal：`['bash','str_replace_editor']`，不能用 `bash` + `edit`（模型基于工具*命名*锚定推理轨迹）。

**`str_replace_editor` 是空实现 + promote 开关**（用户方案，2026-08-18 确定）：
- 注册为工具（名字对齐 dsh minimal），**内部实现为空**（不做任何编辑）
- **调用它即触发 promote**（唯一 promote 信号）
- 模型锚定期想编辑 → 调 `str_replace_editor` → 触发 promote → 空返回 → 模型用完整工具集重试编辑
- 不实现 str_replace_editor 语义（omp edit 用法是 apply_patch，与 dsh 字符串替换不同，无法委托）——彻底绕开该难题

**`bash` 正常可用，不触发 promote**——模型锚定期能用 bash 侦察/运行（不被完整工具干扰），直到编辑意图（调 str_replace_editor）才 promote。

### D2. promote 触发 → 调用 `str_replace_editor`（promote 开关）

**演进**：①首版「首个回复或工具调用」→ 实测过窄（主任务首个简单回复后已 promote）→ ②「仅首次工具调用」（bash/edit）→ ③用户方案（2026-08-18）：**仅调用 `str_replace_editor` 触发 promote**，bash 不触发。

理由：
- 锚定期 bash **正常可用**（侦察/运行），不打断锚定——模型能在极简环境真正做事
- `str_replace_editor` 是**编辑意图**的信号：模型一调它（想编辑）→ promote → 恢复完整工具 → 用真正的 edit 完成编辑
- 空实现：promote 后模型自然用完整工具重试，无需实现编辑语义

纯问答 + bash 侦察任务（永不调 str_replace_editor）会一直极简——可接受：需要编辑时模型自然调 str_replace_editor → promote。

### D3. 激活范围 → DeepSeek V4 Pro + thinking High 双条件

用户指定。非匹配配置完全透明（插件不干预）。判定用 `ctx.models.current()` + `getThinkingLevel`。

### D4. discoverable 污染 → 不存在（强锚定成立）

技术事实：锚定全量替换彻底移除 discoverable 工具的 schema 与目录行。无需额外白名单手段。

### D5. persona 作用域 → 仅 bootstrap 阶段

promote 后恢复完整 base prompt（omp per-turn 自动）。persona 文本逐字节复刻 dsh minimal 的 `You are a helpful software engineer assistant.`。

### D6. 状态模型 → 一次性动作，无持久开关

锚定是**瞬态动作**（开启 → 自动完成 → 复位），不是持久开关状态。promote 后自动复位，后续无感。不持久化开关（无持久状态要管理）；promote 后已自动复位，session 重启后默认未开启（用户重新触发）。

### D7. 命令 → 裸 `/dspro-boost`（开启一次）+ `/dspro-boost status`

因一次性语义，on/off 子命令取消。**裸 `/dspro-boost` = 开启本轮锚定**（替代 on，自动完成生命周期）；`/dspro-boost status` 查看阶段状态。**无 off**（promote 自动复位；锚定期很短无需中途取消）。

裸命令的**便利行为**：开启时顺带 `setModel` + `setThinkingLevel(High)` 设为 V4-Pro/High。这是纯便利，不改变激活逻辑（仍每真实请求检测实际配置）。

**TUI 呈现（widget）**：开启时显示 `boost` 状态条（编辑器上方），组件工厂 + 主题色：
- 锚定中（条件符合）→ 绿色 `boost: active`
- promote 自动复位 → widget 消失
- 取消锚定（配置变化）→ widget 消失
- 调试 `PI_ANCHOR_DEBUG=1` 输出阶段/实际工具目录/systemPrompt。

### D8. 取消锚定保护（配置变化）

锚定中（promote 前），真实请求时（`before_agent_start`）检测到模型配置不再是 pro+high → **取消本次锚定**：恢复完整工具（fullTools 快照）、widget 消失。工具永不卡在极简。promote 后已自动复位，无此问题。

### D9. 上下文披露 → 第一轮注入必要信息，自然入历史（2026-08-18 确定）

**问题**：锚定替换 systemPrompt 为纯净 persona 后，模型丢失完整提示词（AGENTS.md、工作约定）——「极简到几乎没用」。历史里也没有它们（systemPrompt 不在 messages 里）。

**解法**（用户洞察）：**第一轮把必要信息作为消息注入 → 自然变成对话历史 → 后续轮次自动带上**。与 omp 内置 `eager-todo-prelude` 同构（历史无 user 消息时注入一次 → 入历史 → 之后不再构建）。

**omp 机制实证**：
- 请求结构 = `[systemPrompt + tools] + messages`，systemPrompt/tools 每轮重新发送
- **锚定只调第一部分**（systemPrompt 极简 + tools 极简），历史（messages）不动
- `before_agent_start` 注入的消息 → 本轮请求消息 → `emitInputMessages`（message_end 事件）→ `agent.appendMessage`（无过滤 push）→ **进入 `state.messages` 历史**
- 佐证：`createEagerTodoPrelude` 检查 `state.messages.some(role === "user")`——历史有 user 消息后不再构建（第一轮注入模式）

**注入内容**：`event.systemPrompt` 全文（AGENTS.md、系统指令、工作约定——工具 schema 在 tools 参数不在 systemPrompt，天然不含工具说明）。工具 schema 无法通过消息注入（模型只能调 tools 参数里的工具，消息文字描述不可调用）——**全套工具唯一提供方式 = promote 后恢复完整 tools**。

**注入时机**：第一轮（历史无 user 消息时，仿 eager-todo 检查）。后续轮次历史自动带上，零成本。compact/handoff 后需重新注入（见边界条件）。

### D10. 边界条件（2026-08-18 调查确认）

| 边界 | 机制事实 | 处理 |
|---|---|---|
| **compact 之后** | `session_compact` 事件（含 compactionEntry）；注入的历史消息被压缩成摘要，内容可能丢失/变形 | 监听 `session_compact` → 重置「已注入」标志 → 下一轮 before_agent_start 重新注入 |
| **handoff 之后** | handoff = session 切换（`session_switch` reason: "handoff"）→ 新会话，注入消息不在 | 监听 `session_start` / `session_switch`(handoff) → 重置标志 → 新会话第一轮重新注入 |
| **/plan 命令** | plan mode 注入 `plan-mode-context`（每轮），依赖 ask/write/edit/task 等工具 | **plan mode 激活时跳过锚定**（极简工具集会破坏 plan mode 的工具需求） |
| **子代理会话** | 子代理（agentKind: "sub"）也初始化 extensionRunner 并触发 before_agent_start（task/executor.ts 实证）；继承父会话模型/thinking 配置 | **只应用于主会话**（`ctx.agentKind() === "main"`），子代理跳过（任务委派需完整工具） |

## 6. 技术约束与风险

- **`tool_call` 拦截 fail-closed**：promote 判定逻辑必须稳，handler 抛错会阻断工具。
- **背景回调隔离**：任何定时/异步用 `ctx.setTimeout`/`ctx.setInterval`，禁用裸 timer（会崩 session）。
- **`before_agent_start` 多扩展链式**：锚定期纯净覆盖会暂时代替其他扩展的 systemPrompt 块，promote 后放行恢复。
- **激活判定的模型名匹配**：deepseek-v4-pro 的精确标识已在真实环境核对（测试通过）。
- **promote 前工具卡极简**：由 D8 取消锚定保护解决（真实请求时检测并恢复）。

## 7. 验证计划

完整测试方法见 **[docs/design/testing.md](docs/design/testing.md)**。摘要：

- **L1 单元测试**（必做）：激活判定、阶段转换、promote 仅工具调用、取消锚定
- **L2 冒烟**（必做）：`omp --extension ./src/index.ts` 加载，验证命令/widget/生命周期
- **L3 效果验证**（用户执行，必做一次）：真实 DeepSeek 会话，开/关插件跑同一任务，对比工具目录、thinking 聚焦度、耗时

## 8. 已确认的实现要点

1. deepseek-v4-pro 模型标识 + thinking High 枚举：已确认（测试通过）
2. promote 可靠检测点：调用 `str_replace_editor`（promote 开关，bash 不触发）
3. 一次性命令 + 自动复位 + 取消锚定：见 D6/D7/D8
4. 锚定工具 = `['bash','str_replace_editor']`，命名对齐 dsh minimal；str_replace_editor 空实现
5. 上下文披露：第一轮注入 `event.systemPrompt` 全文入历史（D9），仿 eager-todo 检查
6. 边界条件：compact/handoff 后重新注入；plan mode 跳过锚定；子代理跳过锚定（D10）
7. 全套工具 schema 无法注入——promote 恢复完整 tools 是唯一提供方式（D9）
