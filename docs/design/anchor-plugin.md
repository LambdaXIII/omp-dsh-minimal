# 两阶段锚定插件 — 初步设计（待 grill 打磨）

> 状态：**初步构思**。本文档是我的思考过程，不是定案。每个决策点列出选项、权衡、我的倾向与开放问题，供 `/grill-with-docs` 逐项打磨。打磨后的结论落 `docs/adr/`，收敛的行为规格另成 spec。

## 1. 背景与动机

DeepSeek V4-Pro 0813 的后训练 RL 过度针对智能体基准，导致 CoT 对训练分布过拟合：模型一旦进入 `Let me` 式思维链，推理质量崩（用户原话「就是个傻子」）。第三方受控实验（CTOL Digital）确认这不是话术风格，而是过拟合症状。

关键缓解手段是**工具锚定**：模型按初始工具列表锚定推理轨迹。官方全量工具集下基准 91–92，极简双工具集下升到 99/96。DeepSeek Harness 的「极简模式」（minimal preset）据此设计：纯净 persona（一句 `You are a helpful software engineer assistant.`）+ 仅 `bash` + `str_replace_editor`，模型输出变成干净的 `We need` 式推理。

第三方插件 `pi-deepseek-anchor` 把「极简模式」做成了**两阶段**（anchor-then-promote）：先锚定在极简环境完成初始规划，再恢复完整工具目录执行。但它是 **Pi 插件**，与 omp 不兼容（同名 API 语义分叉），需在 omp 上**原生实现**。

## 2. 目标 / 非目标

**目标**
- 一个 omp 原生扩展，实现两阶段锚定：阶段 A 极简环境 → 阶段 B 完整能力
- 缓解 deepseek CoT 过拟合：让初始规划在干净环境完成
- 可配置、可开关、对其他模型透明

**非目标**
- 不重实现 dsh 或 str_replace_editor 的全部语义（除非 grill 裁定必要）
- 不做渐进式多阶段（就两个阶段：锚定 → 完全）
- 不做 CoT 关闭/thinking effort 调节（那是另一类干预）

## 3. 核心机制：两阶段状态机

```
              用户提交 prompt
                    │
        before_agent_start（每 turn 判断当前阶段）
                    │
   ┌────────────────┴─────────────────┐
   │  阶段 A（bootstrap / 锚定）        │  阶段 B（promoted / 完全）
   │  systemPrompt → 纯净 persona      │  systemPrompt → 完整 base prompt（不覆盖）
   │  工具集 → 极简（bash + 编辑器）     │  工具集 → 完整
   │  模型完成初始分析/规划              │  模型执行
   └────────────────┬─────────────────┘
                    │ promote 触发（首个实质输出）
                    └──────────────────→ 阶段 B
```

关键特性：**omp 的 `before_agent_start` systemPrompt 覆盖是 per-turn 的**（每 turn 自动重置，不设覆盖就恢复完整 base prompt）。这带来一个简洁性收益：promote 之后，插件只需**不再返回 systemPrompt 覆盖**，完整 persona 和工具上下文由 omp 自动恢复——不必像 Pi 版那样手动回填被剥离的上下文。

## 4. 决策点（供 grill 逐项打磨）

### D1. 锚定阶段的工具集

**选项**
- **a. omp 原生 `bash` + `edit`**：最小实现，用 `ctx.invokeTool` 委托原生工具。锚定核心是「工具数量少 + 类型纯净」，不一定要精确复刻 dsh。
- **b. `bash` + 重实现 `str_replace_editor`**：逐字节复刻 dsh 编辑器语义（view/create/str_replace/insert），最贴近验证过的 dsh minimal 实验。

**我的倾向**：先走 **a** 起步验证锚定假设——锚定的价值在「少工具、无干扰」，而非特定编辑器实现。若实测 a 不够（模型在锚定阶段仍被 edit 干扰，或 edit 语义本身诱发过拟合），再升级到 b。`str_replace_editor` 复刻是优化，不是第一版必需。

**开放问题**：锚定阶段是否连 `read`/`glob` 也不给？——那就只剩 bash 一个侦察工具，模型被迫用 bash `cat`/`ls`，可能更贴近 dsh minimal（它只有 bash + editor，无独立 read）。

### D2. promote 触发条件

**选项**
- **首个 `tool_call`**：模型第一次调用工具即提升（说明规划结束、开始执行）
- **首个 assistant 文本**：模型第一次产出实质回复即提升
- **both（either）**：两者任一（pi-deepseek-anchor 的 `promoteOn: "either"` 默认）

**我的倾向**：**首个 `tool_call` 或首个 assistant 文本（either）**，与 Pi 版一致。但有一个 omp 时序风险必须先验证：**`setActiveTools` 的切换是否对当前 turn 生效**？若只在下一 turn 生效，则触发后模型当前 turn 仍用锚定工具集——这可能是可接受的（锚定阶段的核心工具 `bash` 全程可用），但影响设计判断。

**开放问题**：promote 的精确语义——是「触发后立即切」，还是「下一个自然边界切」？

### D3. 激活范围（模型过滤）

**选项**
- **仅 deepseek 触发**：检测当前模型归属，非 deepseek 直接放行（透明、零干预）
- **全部模型触发**：所有模型都走两阶段
- **可配置**：默认仅 deepseek，flag/env 可强制或禁用

**我的倾向**：**默认仅 deepseek**，通过环境变量/flag 控制。CoT 过拟合是 deepseek 特有现象，对 Claude/GPT 强加锚定无必要且有风险。

**开放问题**：模型检测用什么？（`ctx.models.current()` / `ctx.model`）；deepseek 的判定依据是 provider id 还是 family token。

### D4. discoverable 工具污染（技术风险最高）

**已确认的 omp 语义**：`getEnabledToolNames()` = **active 集 + xdev mounted（discoverable）**。`setActiveTools` 只控制 active 集，**discoverable 工具可能仍暴露给模型**。

**风险**：若 discoverable 工具仍以可调用形式进 prompt，锚定就不纯粹——模型仍看到大量工具 schema，锚定假设被破坏。

**我的倾向**：**先实测确认 discoverable 工具进 prompt 的形式**（是完整 schema 直接可调，还是仅 catalog 披露一行）。若是 catalog 披露（不直接给 schema），污染程度低，锚定仍成立；若直接暴露，需要额外手段（可能注册白名单或干预 prompt 渲染）。

**开放问题**：这是整个设计成立与否的地基，grill 中应优先钉死。

### D5. persona 内容与作用域

**选项**
- **persona 仅 bootstrap 阶段**：锚定时纯净 persona，promote 后恢复完整 base prompt（omp 自动）
- **persona 全程保持（personaScope: always）**：promote 后仍覆盖纯净 persona

**我的倾向**：**persona 仅 bootstrap 阶段**——这与 omp 的 per-turn 特性天然契合（promote 后不覆盖即恢复完整），且更符合「两阶段」语义：锚定规划用纯净环境，执行恢复完整上下文。但这偏离了 dsh minimal「全程纯净」的实验设定，需 grill 确认是否损失锚定收益。

**persona 文本**：先逐字节复刻 dsh minimal 的 `You are a helpful software engineer assistant.`（验证过的有效锚定），不自行发挥。

**开放问题**：promote 后恢复完整 base prompt，是否会让「规划期」和「执行期」的思维风格不一致，导致执行期又退回 `Let me`？

### D6. 状态持久化

**选项**
- **纯 per-turn 决策**：阶段在每 turn 的 `before_agent_start` 里独立判断（是否需要锚定），不跨 turn 存状态
- **appendEntry 持久化**：阶段写进 session，`session_start` 恢复

**我的倾向**：**以 per-turn 决策为主**。阶段本质可由「当前 turn 是否已发生 promote 信号」推导，无需显式持久化；appendEntry 只作为 session 恢复时的辅助（可延后）。

**开放问题**：session 中途 /compact /分支时阶段如何保持语义？

## 5. 与 omp 扩展机制的对齐

已核实的 omp 语义（决定实现形态）：

- **`before_agent_start`** 返回 `{ systemPrompt: string[] }` 整段替换，**per-turn**（`finally` 自动 `clearTurnSystemPromptOverride`）。返回 string 自动包成数组。多个扩展链式。
- **`setActiveTools`** 是**异步** `Promise<void>`，带 registration barrier，**必须 `await`**。
- **`getEnabledToolNames()`** = active + xdev mounted；**`getAllToolInfos()`** 返回 `ToolInfo[]`。
- **工具委托**：注册同名字段可用 `ctx.invokeTool` 跑原生内置（委托原生 bash/edit）。
- **事件**：`message_end`（assistant 消息完成）、`tool_call`（首调）可作 promote 信号；`session_start` 可恢复。

## 6. 技术约束与风险

- **时序风险（最高）**：`setActiveTools` 的 turn 内生效语义未验证——决定 promote 是「立即切」还是「下轮切」。
- **discoverable 污染**：D4，决定锚定是否纯粹。
- **per-turn 语义**：每次 turn 都要重设 persona，不能假设阶段状态在 turn 间自动保持。
- **`tool_call` 拦截是 fail-closed**：handler 抛错会阻断工具，promote 逻辑必须稳。
- **背景回调隔离**：任何定时/异步工作用 `ctx.setTimeout`/`ctx.setInterval`，禁用裸 timer（会崩 session）。

## 7. 验证计划

- **单元**：阶段状态机转换（bootstrap→promoted）、触发条件、模型过滤分支
- **集成**：真实 omp 会话里跑一个 deepseek prompt，观察：首轮 systemPrompt 是否纯净、工具目录是否极简、promote 后是否恢复、推理风格是否从 `Let me` 变 `We need`
- **对照**：同一 prompt 开/关插件，对比工具目录与推理风格（用 `PI_DSH_ANCHOR_DEBUG` 式调试输出）

## 8. 开放问题清单（grill 起点）

1. D4 优先：discoverable 工具到底怎么进 prompt？锚定能否在 omp 真正成立？
2. D2：`setActiveTools` 的 turn 内生效语义——promote 是立即切还是下轮切？
3. D1：锚定工具集——`bash+edit` 够吗？要不要 `read`/`glob`？要不要复刻 str_replace_editor？
4. D5：persona 仅 bootstrap 还是全程？promote 后恢复完整 base 会不会退回 `Let me`？
5. D3：激活范围——默认仅 deepseek？检测依据？
6. D6：阶段持久化需要吗，还是纯 per-turn 决策？
