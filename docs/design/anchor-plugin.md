# 两阶段锚定插件 — 设计（基于网络共识 + omp 技术约束 + 实测反馈）

> 状态：**决策已定（含一次实测迭代）**。依据 = ①社区网络共识（dsh minimal、pi-deepseek-anchor、awesome-deepseek-harness、CTOL 分析）+ ②omp 源码实证 + ③真实会话实测（发现「首个回复即 promote」过窄，改为仅工具调用）。

## 文档导航

**设计文档（行为全貌）**：本文档（`docs/design/anchor-plugin.md`）——两阶段状态机、技术事实、设计决策、约束、验证计划。它是行为规格的主文档。

**架构决策（ADR，`docs/adr/`）**：难以逆转、有真实权衡的决策记录：
- [ADR-0001](docs/adr/0001-two-phase-anchoring.md) — 两阶段锚定机制（anchor-then-promote）
- [ADR-0002](docs/adr/0002-explicit-switch.md) — 显式 opt-in（不默认自动，因 KV 缓存成本）
- [ADR-0003](docs/adr/0003-activation-condition.md) — 激活条件限定 DeepSeek V4 Pro + thinking High
- [ADR-0004](docs/adr/0004-promotion-once.md) — 一次性 promote（仅首次工具调用）+ 自动复位

**不进 ADR 的设计决策**（可逆，留在此设计文档）：锚定工具集选择（`bash+edit` 起步、可换）、persona 文本（逐字节复刻 dsh minimal）、`/dspro-boost` 便利行为细节、widget 呈现细节。

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
   → 锚定（bootstrap）：工具切极简 ['bash','edit']，systemPrompt 替换纯净 persona
   → 模型 thinking + 纯文本回复（全程极简，不 promote）
   → ……直到第一次真正调用工具（bash 或 edit）……
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
- **锚定强成立**：`setActiveTools(['bash','edit'])` 全量替换会彻底移除 discoverable 工具——既无可调用 schema，也无系统提示词目录行。模型只看到 `bash` + `edit`，零污染。
- **检测时机**：插件无「用户切模型」事件，**唯一可靠检测点是 `before_agent_start`**（每次真实请求时触发）。配置变化在真实请求时被检测。
- **事件**：`tool_call`（首次工具调用 = promote 信号）、`before_agent_start`（锚定/检测/取消）；`message_end` **不再**作为 promote 信号。
- **模型/thinking 读取**：`ctx.models.current()` 拿模型；`getThinkingLevel` 拿 thinking 级别。

## 5. 设计决策（网络共识 + 技术事实 + 实测）

### D1. 锚定工具集 → `bash` + `edit`

网络共识：dsh minimal / pi-deepseek-anchor 用 `bash` + `str_replace_editor`。锚定核心价值是「少工具、无干扰」，非特定编辑器。omp 有原生 `edit`，用 `ctx.invokeTool` 委托，实现最简且达到同样「双工具纯净」效果。`str_replace_editor` 精确复刻是后续优化。

不额外给 `read`/`glob`——模型锚定阶段可用 bash `cat`/`ls` 侦察，更贴近 dsh「只有两个工具」的实验设定。

### D2. promote 触发 → 仅首次工具调用

实测发现「首个回复或工具调用（either）」过窄——主任务在首个简单回复后已 promote。改为**仅首次工具调用**触发 promote：模型 thinking + 纯文本回复全程极简，直到真动手调工具（bash/edit）才恢复完整。这修正「主任务没享受锚定」问题，让初始规划全程干净。

纯问答任务（永不调工具）会一直极简——可接受：极简环境够回答大多数纯咨询；任务需更多工具时模型自然先调 bash（侦察）→ 触发 promote。

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
2. promote 可靠检测点：`tool_call`（首次），`message_end` 已弃用
3. 一次性命令 + 自动复位 + 取消锚定：见 D6/D7/D8
