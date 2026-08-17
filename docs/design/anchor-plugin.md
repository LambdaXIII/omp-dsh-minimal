# 两阶段锚定插件 — 设计（基于网络共识 + omp 技术约束）

> 状态：**决策已定**。依据 = ①社区网络共识（dsh minimal、pi-deepseek-anchor、awesome-deepseek-harness、CTOL 分析）+ ②omp 源码实证。

## 文档导航

**设计文档（行为全貌）**：本文档（`docs/design/anchor-plugin.md`）——两阶段状态机、技术事实、设计决策、约束、验证计划。它是行为规格的主文档。

**架构决策（ADR，`docs/adr/`）**：难以逆转、有真实权衡的决策记录（决策 + 理由，供未来读者理解「为什么这么做」）：
- [ADR-0001](docs/adr/0001-two-phase-anchoring.md) — 两阶段锚定机制（anchor-then-promote）
- [ADR-0002](docs/adr/0002-explicit-switch.md) — 显式开关（默认关，因 KV 缓存成本）
- [ADR-0003](docs/adr/0003-activation-condition.md) — 激活条件限定 DeepSeek V4 Pro + thinking High
- [ADR-0004](docs/adr/0004-promotion-once.md) — promote 一次性 + 配置中断重置

**不进 ADR 的设计决策**（可逆，留在此设计文档）：锚定工具集选择（`bash+edit` 起步、可换）、persona 文本（逐字节复刻 dsh minimal）、`on` 便利行为细节、widget 呈现细节。这些容易改，写成 ADR 会过度记录。

## 1. 背景与动机

DeepSeek V4-Pro 0813 的后训练 RL 过度针对智能体基准，CoT 对训练分布过拟合：模型进入 `Let me` 式思维链时推理质量崩。第三方受控实验（CTOL Digital）确认这是过拟合症状。**工具锚定**是已验证最有效的缓解：模型按初始工具列表锚定推理轨迹，官方全量工具集基准 91–92，极简双工具集 99/96。

dsh「极简模式」据此设计：纯净 persona + 仅 `bash` + `str_replace_editor`，触发干净的 `We need` 式推理。社区共识（awesome-deepseek-harness、pi-deepseek-anchor）把极简模式推广为**两阶段锚定**：minimal 对齐的 bootstrap → 首个工具调用或回复后切回 full Standard 工具。

## 2. 目标 / 非目标

**目标**
- omp 原生扩展，实现两阶段锚定：阶段 A 极简环境 → 阶段 B 完整能力
- **激活条件**：当前模型 = DeepSeek V4 Pro 且 thinking = High 时才后台生效
- **前台无感**：切换对用户透明，默认无任何显示
- 缓解 deepseek CoT 过拟合：初始规划在干净环境完成

**非目标**
- 不重实现 dsh 或 str_replace_editor 全部语义（见 D1）
- 不做渐进式多阶段（就两阶段，见 D1）
- 不做 CoT 关闭 / thinking effort 调节（那是另一类干预）

## 3. 核心机制：两阶段状态机

```
              用户提交 prompt
                    │
        before_agent_start（每 turn 判断：当前处于锚定还是完全阶段）
                    │
   ┌────────────────┴─────────────────┐
   │  阶段 A（bootstrap / 锚定）        │  阶段 B（promoted / 完全）
   │  systemPrompt → 纯净 persona      │  systemPrompt → 完整 base prompt（不覆盖）
   │  工具集 → ['bash','edit']         │  工具集 → 完整
   │  模型完成初始分析/规划             │  模型执行
   └────────────────┬─────────────────┘
                    │ promote 触发（首个 tool_call 或首个 assistant 文本）
                    └──────────────────→ 阶段 B
```

**omp per-turn 特性**：`before_agent_start` 的 systemPrompt 覆盖是 per-turn 的（每 turn 自动重置，不覆盖就恢复完整 base）。promote 后插件**不再返回 systemPrompt 覆盖**，完整 persona 与工具上下文由 omp 自动恢复——无需像 Pi 版手动回填。

## 4. 技术事实（omp 源码实证，决定实现形态）

- **`before_agent_start`** 返回 `{ systemPrompt: string[] }` 整段替换，**per-turn**（`finally` 自动 `clearTurnSystemPromptOverride`）。返回 string 自动包成数组。多扩展链式。
- **`setActiveTools`** 异步 `Promise<void>`，带 registration barrier，**必须 `await`**。
- **turn 内生效语义**：`setActiveTools` 立即改 agent 内部 state，但工具 schema 在**每次 model call 前**才由 `syncContextBeforeModelCall` 快照进请求 → 对当前正在 stream 的请求不生效，**下一个 model call / 下一 turn 生效**。同一逻辑 turn 内 tool-result 后的再次调用也会拿到新 schema。
- **锚定强成立**：`setActiveTools(['bash','edit'])` 全量替换会按新的 active 集合重算 mounted 集合，**彻底移除 discoverable 工具**——既无可调用 schema，也无系统提示词目录行。模型只看到 `bash` + `edit`，零污染。
- **工具委托**：注册同名字段用 `ctx.invokeTool` 跑原生内置（委托原生 bash/edit）。
- **事件**：`message_end`（assistant 消息完成）、`tool_call`（首调）可作 promote 信号；`session_start` 可恢复。
- **模型/thinking 读取**：`ctx.models.current()` / `ctx.model` 拿模型；`getThinkingLevel` 拿 thinking 级别——激活双条件可判定。

## 5. 设计决策（网络共识 + 技术事实）

### D1. 锚定工具集 → `bash` + `edit`

网络共识：dsh minimal / pi-deepseek-anchor 用 `bash` + `str_replace_editor`。但锚定核心价值是「少工具、无干扰」，非特定编辑器。omp 有原生 `edit`，用 `ctx.invokeTool` 委托，实现最简且达到同样「双工具纯净」效果。`str_replace_editor` 精确复刻是后续优化，非第一版必需。

不额外给 `read`/`glob`——模型锚定阶段可用 bash `cat`/`ls` 侦察，更贴近 dsh「只有两个工具」的实验设定。

### D2. promote 触发 → either（首个 tool_call 或首个 assistant 文本）

网络共识（awesome-deepseek-harness「after the first tool call or reply」、pi-deepseek-anchor `promoteOn: "either"`）一致。技术事实支撑：setActiveTools 下个 model call 生效，模型锚定阶段输出首个规划或调一次 bash 后，下一次调用即全量——行为正确，无中间失真。

### D3. 激活范围 → DeepSeek V4 Pro + thinking High 双条件

用户指定。非匹配配置完全透明（插件不干预）。判定用 `ctx.models.current()` + `getThinkingLevel`。

### D4. discoverable 污染 → 不存在（强锚定成立）

技术事实：锚定全量替换彻底移除 discoverable 工具的 schema 与目录行。无需额外白名单手段。

### D5. persona 作用域 → 仅 bootstrap 阶段

promote 后恢复完整 base prompt（omp per-turn 自动）。与「两阶段」语义契合：锚定规划用纯净 persona，执行恢复完整上下文。persona 文本逐字节复刻 dsh minimal 的 `You are a helpful software engineer assistant.`（验证过的有效锚定）。

### D6. 状态持久化 → per-turn 决策为主

阶段由「当前 turn 是否已发生 promote 信号」推导，每 turn 的 `before_agent_start` 独立判断，无需显式持久化。session 中途 compact/分支时，因阶段可推导，语义自然保持。

### D7. 开关控制 → 命令 `/dspro-boost`，默认关闭，切换过程无感

**命令**：`/dspro-boost on|off|status`（+ 配置持久化）。

- **开关是总闸**：off → 永不锚定；on → 允许锚定。因切换破坏 KV 缓存，**不默认自动生效**。
- **`on` 的便利行为**：`on` 时顺带把模型自动设为 DeepSeek V4 Pro、thinking 设为 High（`setModel` + `setThinkingLevel`）。这是**纯便利**（帮用户省事），**不改变触发条件的运行逻辑**——触发条件仍每 turn 检测实际状态（pro ∧ high），不管模型是自动设的还是用户手动设的。
- **开关与触发条件独立**：锚定生效 ⇔ 开关 on ∧ 模型=pro ∧ thinking=high。条件逻辑不被 `on` 的便利行为改变。
- **切换过程无感**：开启后锚定→执行的切换不在 TUI 显示、不打扰。

**TUI 呈现（widget，编辑器上方常驻）**：`/dspro-boost on` 时显示 `boost` 状态条，用组件工厂 + 主题色着色：
- 开关 on 且条件符合（实际 pro+high）→ **绿色**（正在生效）
- 开关 on 但条件不符合（用户改了模型/thinking 或设置失败）→ **红色**（开了但没在生效）
- 开关 off → 不显示或灰显
- 调试用 `PI_ANCHOR_DEBUG=1` 输出当前阶段/实际工具目录/systemPrompt。

## 6. 技术约束与风险

- **`tool_call` 拦截 fail-closed**：promote 判定逻辑必须稳，handler 抛错会阻断工具。
- **背景回调隔离**：任何定时/异步用 `ctx.setTimeout`/`ctx.setInterval`，禁用裸 timer（会崩 session）。
- **`before_agent_start` 多扩展链式**：若用户装了其他改 systemPrompt 的扩展，会互相叠加——需注意。
- **激活判定的模型名匹配**：deepseek-v4-pro 的精确标识需在真实环境核对（provider id / model id）。

## 7. 验证计划

完整测试方法见 **[docs/design/testing.md](docs/design/testing.md)**（锚定：局部引入方式、log 机制、观察指标、L1/L2/L3 步骤）。摘要：

- **L1 单元测试**（必做）：抽取纯逻辑（激活判定、阶段转换）用 bun test 测
- **L2 冒烟**（必做）：`omp --extension ./src/index.ts` 加载，验证命令/widget/开关
- **L3 效果验证**（用户执行，必做一次）：真实 DeepSeek 会话，开/关插件跑同一任务，对比推理风格（`Let me` → `We need`）、工具目录、耗时

## 8. 待确认（实现中钉死）

1. omp 中「DeepSeek V4 Pro + thinking High」的精确检测——模型标识、thinking level 枚举值
2. 是否需要在 `before_provider_request` 强制 persona（omp per-turn 机制下可能不需要，需实测）
3. promote 信号在 omp 的可靠检测点（`message_end` vs `tool_call` 的触发时序）
