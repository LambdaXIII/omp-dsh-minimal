# 极简锚定插件 — 设计（基于网络共识 + omp 技术约束 + 实测反馈）

> 状态：**决策已定（三次设计迭代）**。依据 = ①社区网络共识（dsh minimal、pi-deepseek-anchor、awesome-deepseek-harness、CTOL 分析）+ ②omp 源码实证 + ③真实会话实测（「首个回复即 promote」过窄 → 一次性 promote → 无 promote）+ ④请求结构实证 + ⑤grill/推演收敛（2026-08-18：JSON 序列化调用形态、会话头部注入判定、compact 内容流转）。

## 文档导航

**设计文档（行为全貌）**：本文档（`docs/design/anchor-plugin.md`）——极简锚定机制、技术事实、设计决策、约束、验证计划。它是行为规格的主文档。

**架构决策（ADR，`docs/adr/`）**：难以逆转、有真实权衡的决策记录：
- [ADR-0001](docs/adr/0001-two-phase-anchoring.md) — 两阶段锚定机制（anchor-then-promote）※**已由 ADR-0005 取代**
- [ADR-0002](docs/adr/0002-explicit-switch.md) — 显式 opt-in（不默认自动，因 KV 缓存成本）
- [ADR-0003](docs/adr/0003-activation-condition.md) — 激活条件限定 DeepSeek V4 Pro + thinking High
- [ADR-0004](docs/adr/0004-promotion-once.md) — 一次性 promote（仅首次工具调用）+ 自动复位 ※**已由 ADR-0005 取代**
- [ADR-0005](docs/adr/0005-no-promote-minimal-anchoring.md) — 无 promote 极简锚定（取代 0001/0004）
- [ADR-0006](docs/adr/0006-tool-capability-via-bash-command-string.md) — 工具能力通过 bash JSON 序列化调用提供（schema 符合 dsh，tool_call 拦截 + 分派）
- [ADR-0007](docs/adr/0007-injection-new-session-only-widget-semantics.md) — 上下文注入仅会话头部 + 内容随标准流程流转 + widget 消费真实状态

**不进 ADR 的设计决策**（可逆，留在此设计文档）：锚定工具集（`bash`+`str_replace_editor`，2 schema 不变）、persona 文本（逐字节复刻 dsh minimal）、`/dspro-boost` 便利行为细节、widget 呈现细节、注入内容构成（系统约定 + 工具 schema + JSON 告知，D9）、命令分派细节（D11）。

## 1. 背景与动机

DeepSeek V4-Pro 0813 的后训练 RL 过度针对智能体基准，CoT 对训练分布过拟合：模型进入 `Let me` 式思维链时推理质量崩。第三方受控实验（CTOL Digital）确认这是过拟合症状。**工具锚定**是已验证最有效的缓解：模型按初始工具列表锚定推理轨迹，官方全量工具集基准 91–92，极简双工具集 99/96。

dsh「极简模式」据此设计：纯净 persona + 仅 `bash` + `str_replace_editor`，触发干净的 `We need` 式推理。社区共识（awesome-deepseek-harness、pi-deepseek-anchor）把极简模式推广为**两阶段锚定**：minimal 对齐的 bootstrap → 首个工具调用后切回 full Standard 工具。

**本设计偏离两阶段**（2026-08-18）：用户实测 + 讨论确认「bash 是万能通道」——dsh minimal 里模型用 bash 命令（ls/cat/sed）即可读写文件/列目录/编辑，不需要其他工具 schema。因此锚定**全程保持** bash + str_replace_editor 双工具（CoT 锚定完整），工具能力通过 **bash JSON 序列化调用 + 分派**（D11/ADR-0006：模型在 bash 的 `command: string` 里写 JSON 序列化的工具调用，插件解析分派）提供——无需 promote 切换。

## 2. 目标 / 非目标

**目标**
- omp 原生扩展，实现极简锚定：纯净 persona + 2 工具 schema（bash + str_replace_editor）+ 上下文披露 + JSON 序列化调用分派
- **激活条件**：检测开关（opt-in，默认关）+ 当前模型 = DeepSeek V4 Pro 且 thinking = High
- **显式 opt-in**：`/dspro-boost` 打开检测开关（KV 缓存成本），默认完全透明
- 缓解 deepseek CoT 过拟合：模型全程在极简环境思考与工作（bash JSON 调用提供全部工具能力）

**非目标**
- 不重实现 dsh 或 str_replace_editor 的底层 PTY/沙箱（str_replace_editor 按 dsh 语义实现四子命令，见 D1）
- 不做两阶段切换 / promote（无 promote，见 D2）
- 不做 CoT 关闭 / thinking effort 调节（那是另一类干预）

## 3. 核心机制：极简锚定流程（无 promote）

**设计迭代**：①两阶段锚定（promote 恢复完整工具）→ ②promote 开关（str_replace_editor 触发）→ ③无 promote（全程 2 schema）→ ④**grill 收敛定稿**（2026-08-18）：注入判定 = 会话头部标记；工具调用 = bash JSON 序列化；compact 内容经官方钩子流转。

```
/dspro-boost（裸命令，打开检测开关 + 便利设模型/thinking = V4-Pro/High）
   → 首次真实请求（before_agent_start）：检测开关开 + pro+high
       → setActiveTools(['bash','str_replace_editor'])（进入极简工具集，一次）
       → systemPrompt 替换纯净 persona
       → 会话头部（历史无 user 消息）→ 注入：系统约定全文 + 全套工具 schema（getAllTools 实时状态）+ JSON 调用告知，入历史（D9）
   → 模型全程面对 bash + str_replace_editor（2 schema 不变）
   → 用 bash 的 command 字符串以 JSON 序列化调用各工具（{"name":"read","arguments":{...}}，D11）+ bash 原生命令（ls/cat/sed/curl）
   → 持续锚定（配置仍 pro+high 时），无 promote、无中途工具切换
   → 配置变化（用户切走模型）→ 真实请求时停止：setActiveTools(完整快照) 恢复 + 不再覆盖 persona + widget 消失
```

**取消保护**：真实请求时（`before_agent_start`）检测到模型配置不再是 pro+high → **停止锚定**（不再覆盖 systemPrompt），恢复完整环境。无「工具卡极简」问题（工具从未切换）。

**omp per-turn 特性**：`before_agent_start` 的 systemPrompt 覆盖是 per-turn 的——插件在配置匹配时每轮返回纯净覆盖，配置变化时不返回（omp 自动恢复完整 base）。

## 4. 技术事实（omp 源码实证，决定实现形态）

- **`before_agent_start`** 返回 `{ systemPrompt: string[] }` 整段替换，**per-turn**（`finally` 自动 `clearTurnSystemPromptOverride`）。返回 string 自动包成数组。多扩展链式。
- **`setActiveTools`** 异步 `Promise<void>`，带 registration barrier，**必须 `await`**。
- **turn 内生效语义**：`setActiveTools` 立即改 agent 内部 state，但工具 schema 在**每次 model call 前**才由 `syncContextBeforeModelCall` 快照进请求 → 对当前正在 stream 的请求不生效，**下一个 model call / 下一 turn 生效**。
- **锚定强成立**：`setActiveTools(['bash','str_replace_editor'])` 全量替换会彻底移除 discoverable 工具——既无可调用 schema，也无系统提示词目录行。模型只看到 `bash` + `str_replace_editor`，零污染。
- **str_replace_editor 注册**：插件 `registerTool` 且 `defaultInactive: true`——完整环境（未锚定）不 active、不进工具清单；锚定开启时 `setActiveTools(['bash','str_replace_editor'])` 激活。bash 用 omp 内置（不注册自定义 bash，ADR-0006）。
- **扩展实例隔离**：扩展每次加载 = 新模块实例（`import ?mtime=<tag>`，loader.ts 实证）——子代理/多会话实例状态独立，未执行命令的实例天然不锚定。
- **检测时机**：插件无「用户切模型」事件，**唯一可靠检测点是 `before_agent_start`**（每次真实请求时触发）。配置变化在真实请求时被检测。
- **事件**：`before_agent_start`（锚定/检测/取消）、`tool_call`（命令分派 D11，检查 bash 调用参数）；`message_end` 不使用。
- **模型/thinking 读取**：`ctx.models.current()` 拿模型；`getThinkingLevel` 拿 thinking 级别。
- **注入消息入历史**：`before_agent_start` 返回 `{ messages }` 加入本轮请求消息 → `emitInputMessages`（message_start/end 事件）→ `agent.appendMessage`（无过滤 push）→ **进入 `state.messages` 历史**。第一轮注入一次，后续轮次历史自动带上（仿 `eager-todo-prelude`：历史无 user 消息时才构建）。
- **注入消息 role 转换**：custom 消息经 `convertMessageToLlm` 转为 **role="developer"** 进入 LLM 请求（pi-agent-core messages.ts 实证）——模型把注入内容视为系统级指令，权威性高，不会与用户消息混淆。
- **工具 schema 无法消息注入**：模型只能调用 `tools` 参数（函数定义）里的工具；消息里的 schema 文字描述不可调用。**但**：消息里的 schema 文字 + 告知「bash 以 JSON 序列化形式调用」→ 模型在 bash 的 command 字符串里表达工具调用（D11），插件解析分派——工具能力通过该通道提供，不依赖 tools 参数。
- **会话切换消息行为**（`agent.reset()` 实证）：`newSession`/`handoff` 清空全部消息（fresh conversation）；`fork` 保留消息（源码注释实证）；`switchSession`(resume) 替换为目标会话内容。`session_start` 只在 runner 初始化时发射（handoff/new/fork 复用 runner，**无新 session_start**）。
- **compact 官方钩子**：`session.compacting` 事件返回 `{ context?: string[] }`（「Additional context lines to include in summary」）——扩展可把注入内容附加进压缩摘要，随标准流程保留。

## 5. 设计决策（网络共识 + 技术事实 + 实测）

### D1. 锚定工具集 → `bash` + `str_replace_editor`（2 schema 不变，无 promote）

网络共识：dsh minimal / pi-deepseek-anchor 用 `bash` + `str_replace_editor`。用户实测确认：**同一模型在 dsh 下会输出 `We need`，omp 下不会**——差距来自工具命名 + 上下文污染，而非模型。因此锚定工具**必须**命名对齐 dsh minimal：`['bash','str_replace_editor']`。

**关键洞察（2026-08-18 定稿）**：2 工具 schema ≠ 模型能力受限——**bash 是万能通道**。`ls`/`cat`/`sed`/`curl` 等都是 bash 命令，**不需要 schema**。dsh minimal 里模型用 bash 就能读写文件/列目录/编辑/网络——不需要 read/write/edit 工具的 schema，**不需要 promote**（bash 一直可用，模型从第一轮就能干活）。

**str_replace_editor**：插件 `registerTool`（`defaultInactive: true`），**按 dsh 官方语义真实现**——description 逐字节复刻 `@deepseek-ai/dsh-tool-str-replace-editor` 原文，四子命令 `view`（`cat -n` 显示/目录列 2 层）/`create`（新建，不覆盖）/`str_replace`（精确唯一匹配替换）/`insert`（行后插入），参数 `command`/`path`/`file_text`/`insert_line`/`new_str`/`old_str`/`view_range` 与官方一致（已从 dsh npm 包实证）。模型直接结构化调用它编辑文件；其他工具能力走 bash JSON 序列化调用（D11）。

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

### D6. 状态模型 → 检测开关 + 条件检测 + 会话头部标记

插件状态分三层，各司其职：
- **检测开关**（`/dspro-boost` 打开，默认关，无 off）：控制**是否检测 pro+High 条件**——开关关 = 完全透明（后台工作仍进行：str_replace_editor 注册、会话头部标记维护、分派准备）
- **锚定激活**（每真实请求判定）= 检测开关开 ∧ 当前模型 pro+High：匹配 → 极简环境（工具 + persona）；不匹配 → 恢复完整环境。无「锚定开关」——条件即状态，配置变化自然停止（D8）
- **会话头部标记**（`hasUserMessage`，注入判定用）：`session_start`/`session_switch`(handoff|new) → 重置为「无」；首个真实请求 → 「有」；`fork`/`compact` → 保持（ADR-0007）

不持久化开关（session 重启后默认关，用户重新 `/dspro-boost`）。

### D7. 命令 → 裸 `/dspro-boost`（开启）+ `/dspro-boost status`

**裸 `/dspro-boost` = 开启锚定**（配置匹配期间持续生效）；`/dspro-boost status` 查看锚定状态。**无 off**（配置变化时自动停止，见 D8）。

裸命令的**便利行为**：开启时顺带 `setModel` + `setThinkingLevel(High)` 设为 V4-Pro/High。这是纯便利，不改变激活逻辑（仍每真实请求检测实际配置）。

**TUI 呈现（widget）**：极简环境激活时显示 `boost` 状态条（编辑器上方），组件工厂 + 主题色。**widget 消费真实状态，非状态机自造**（用户确认 2026-08-18）——颜色由「注入内容是否真实存在于当前上下文」计算：
- **绿色** = 注入内容在上下文（注入完成；compact 拼接成功经摘要保留）
- **红色** = 注入内容不在（会话头部尚未注入；中途开启已过头部；compact 拼接失败）
- 显示/隐藏 = 极简环境激活（检测开关开 + pro+High 匹配）；配置不匹配 → 消失
- 调试 `PI_ANCHOR_DEBUG=1` 输出阶段/实际工具目录/systemPrompt。

### D8. 停止锚定（配置变化）

真实请求时（`before_agent_start`）检测到模型配置不再是 pro+high → **停止锚定**：不再覆盖 systemPrompt（omp 恢复完整 base）、widget 消失。工具从未切换（始终 bash + str_replace_editor），无「卡极简」问题。

### D9. 上下文披露 → 会话头部注入，内容随标准流程流转（2026-08-18 grill 收敛）

**问题**：锚定替换 systemPrompt 为纯净 persona 后，模型丢失完整提示词（AGENTS.md、工作约定）——「极简到几乎没用」。历史里也没有它们（systemPrompt 不在 messages 里）。

**解法**（用户洞察）：**会话头部（历史尚无 user 消息）把必要信息作为消息注入 → 自然变成对话历史 → 后续轮次自动带上**。与 omp 内置 `eager-todo-prelude` 同构（历史无 user 消息时注入一次 → 入历史 → 之后不再构建）。

**注入内容**（构成，全部来自 omp 运行时状态，零硬编码）：
1. **系统约定全文**：`event.systemPrompt` 原样（AGENTS.md、系统指令、工作约定）
2. **全套工具介绍 + 各自 schema 原文**：`getAllTools()` 实时获取（name + description + parameters JSON）——omp 有哪些工具就告知哪些，无特例（xd 等非工具不在其列，天然不含）
3. **一句告知**：bash 的 `command` 参数可直接以 **JSON 序列化形式**调用上述工具（`{"name": "...", "arguments": {...}}`）；非 JSON 内容按普通 shell 命令执行

**注入消息形态**：custom 消息（customType `dspro-boost-inject`，display: false，attribution: "agent"）→ 实证转 role="developer" 进入 LLM 请求（模型视为系统级指令）+ 入历史持久携带。

**注入时机 = 会话头部判定**（不依赖插件自造状态）：

```
会话头部标记 hasUserMessage（事件维护，ADR-0007）：
  session_start / session_switch(handoff|new) → false（消息清空 → 回到头部）
  首个真实请求 → true（本轮 user 消息进入历史）
  session_switch(fork) / session_compact → 保持

before_agent_start（检测开关开 + pro+High 匹配）：
  检查 hasUserMessage 更新前值：
    false（会话头部）→ 注入 → widget 绿
    true（会话已进行，中途开启）→ 不注入 → widget 红
```

**compact 流转**：`session.compacting` 返回 `context: [注入内容]`（官方钩子）→ 注入内容拼进压缩摘要 → 随标准流程保留 → widget 绿。不重新注入。

**handoff/new 流转**：消息清空（`agent.reset()` 实证）→ `session_switch`(handoff|new) 重置标记为 false → 下一个匹配请求自然注入——**无需专门钩子**（与 omp 标准会话流程自洽）。

**中途开启（会话已进行）→ 不注入**，仅切换 minimal 环境（纯净 persona + 2 schema），widget 红如实反映（用户确认 2026-08-18）。

### D10. 边界条件（2026-08-18 调查确认）

| 边界 | 机制事实 | 处理 |
|---|---|---|
| **compact 之后** | `session.compacting` 事件返回 `context`（官方钩子，附加进摘要）；注入内容可拼进摘要随流程保留 | **拼接保留，不重新注入**：注入内容经 context 钩子进压缩摘要 → 内容仍在 → widget 绿；拼接失败才红 |
| **handoff 之后** | handoff 调 `agent.reset()` 清空消息（源码实证）；runner 复用**无新 session_start**；`session_switch`(handoff) 事件 | **标记重置覆盖**：`session_switch`(handoff|new) 置头部标记 false → 下一匹配请求自然注入——无需专门钩子（ADR-0007） |
| **/plan 命令** | plan mode 注入 `plan-mode-context`（每轮），依赖 ask/write/edit/task 等工具；**扩展 API 无 plan mode 状态入口**（无 API、无事件；plan 上下文是 custom 消息不在 systemPrompt，插件读不到） | **放弃特判**（ADR-0006）：无法检测 plan mode。触发面窄（须在 plan mode 下主动开启锚定），文档/status 说明即可 |
| **子代理会话** | 子代理也初始化 extensionRunner 并触发 session_start/before_agent_start（task/executor.ts 实证）；继承父会话模型/thinking 配置；扩展 API **无 agentKind**；扩展每次加载为**新模块实例**（`?mtime=` tag，loader.ts 实证） | **天然隔离，无需特判**：子代理实例未执行过 `/dspro-boost` → 检测开关关 → 不锚定（模块状态独立，不共享） |

### D11. 命令分派 → bash JSON 序列化工具调用（2026-08-18 grill 收敛定稿）

**问题**：锚定期只有 bash + str_replace_editor 两个 schema，模型如何「使用全部工具能力」（读/写/编辑/搜索/列目录）？

**解法**（用户方案）：**告知 + 分派**——注入消息里给模型 omp 全套工具介绍 + 各工具 schema 原文（getAllTools 实时状态），并告知「bash 的 `command` 参数可直接以 JSON 序列化形式调用这些工具」。模型看到 schema + 告知 → 输出 JSON 序列化的工具调用（LLM 对工具调用格式是本能）：

```
模型调 bash：{"command": "{\"name\": \"read\", \"arguments\": {\"path\": \"src/foo.ts\"}}"}

→ tool_call 拦截，取 command 字符串
→ JSON.parse 成功且含 name + arguments → 按 name 分派：
     可翻译工具（read/write/edit/glob/grep 等）→ 插件自实现 fs 处理（读文件/写文件/替换/列目录/搜索）
     不可翻译工具（ask/task 等）→ 返回不可用提示（该工具在极简环境不可用，用 bash 表达）
→ 非 JSON（普通 shell 命令 ls/cat/sed/curl）→ 放行原生 bash
```

**实现路径 = `tool_call` 拦截**（ADR-0006 锚定）。候选方案排除的实证：①**自定义 bash 工具（嵌套 schema）**——registry 无条件覆盖 + 无注销 API → 完整环境 bash schema 永久被改；`invokeTool` same-tool only 无法转调其他内置；bash 形态偏离 dsh 的纯 `command: string`；②**字符串文本语法（首词解析）**——bash 内置 `read` 命令字面冲突、write 多行无法表达、文本解析固有歧义；③**schema 消息注入（不通过 bash）**——模型只能调用 tools 参数里声明的工具，消息里的 schema 不能直接调。JSON 序列化是唯一同时满足：schema 符合 dsh（command 是字符串）+ 结构化可靠解析（JSON 语法硬边界）+ 零环境污染 + 模型调用自然。

**分派规则**（按 name）：
- `read` → fs 读文件（带行号，对齐 omp read 语义）
- `write` → fs 写文件（content 字段 JSON 字符串，多行天然支持）
- `edit` → fs 精确字符串替换（对齐 omp edit 语义）
- `glob`/`grep` 等文件操作类 → fs/遍历实现
- 交互类（ask/task 等）→ 不可用提示（schema 不在 active 工具，模型无法真调）
- 非 JSON 命令 → 放行原生 bash

**判定边界**：JSON.parse 成功且含 `name`（字符串）与 `arguments`（对象）→ 工具调用；否则视为 shell 命令放行。注入告知明示此边界，模型行为可预期。

**fail-closed**：`JSON.parse` 或 handler 抛错不阻断 bash 工具执行（回退放行原生）。

**xd:// 不需要额外判断**（用户确认 2026-08-18）：xd:// 的调用路径 = read/write 工具（`read xd://<tool>` 读文档、`write xd://<tool>` 执行）——锚定期 read/write 不在 schema，模型无法直接调；工具列表来自 getAllTools 实时状态，xd 不是工具、不在告知之列，无特例。

## 6. 技术约束与风险

- **命令分派 fail-closed**：分派逻辑必须稳，handler 抛错会阻断 bash 工具。
- **背景回调隔离**：任何定时/异步用 `ctx.setTimeout`/`ctx.setInterval`，禁用裸 timer（会崩 session）。
- **`before_agent_start` 多扩展链式**：锚定期纯净覆盖会暂时代替其他扩展的 systemPrompt 块，需协调。
- **激活判定的模型名匹配**：deepseek-v4-pro 的精确标识已在真实环境核对（测试通过）。
- **无 promote 后工具永不切换**：模型全程 bash + str_replace_editor，命令分派（D11）覆盖工具能力——无「工具卡极简」问题（D8 取消保护随之删除，配置变化时只影响是否继续锚定 systemPrompt）。

## 7. 验证计划

完整测试方法见 **[docs/design/testing.md](docs/design/testing.md)**。摘要：

- **L1 单元测试**（必做）：激活判定（检测开关 + pro+High）、会话头部标记状态机（session_start/switch/请求消费/fork/compact 保持）、JSON 序列化分派（parse 成功含 name/arguments → 分派；非 JSON → 放行；各工具 name 分支）、注入内容构成
- **L2 冒烟**（必做）：`omp --extension ./src/index.ts` 加载，验证命令/widget/注入/JSON 分派/停止
- **L3 效果验证**（用户执行，必做一次）：真实 DeepSeek 会话，开/关插件跑同一任务，对比工具目录、thinking 聚焦度、耗时——验证「极简提示 + 2 schema + bash JSON 调用 + 注入（含全套工具 schema）」是否复现 `We need`；同时验证注入体积对锚定纯净度的影响

## 8. 已确认的实现要点

1. deepseek-v4-pro 模型标识 + thinking High 枚举：已确认（测试通过）
2. **无 promote**：全程 bash + str_replace_editor（2 schema 不变），无工具切换（D1/D2）
3. 锚定工具 = `['bash','str_replace_editor']`，命名对齐 dsh minimal；str_replace_editor 按 dsh 官方 schema/description 真实现（D1）
4. 上下文披露：**会话头部注入**（hasUserMessage 标记，事件维护：session_start/switch(handoff|new) 重置、首请求消费、fork/compact 保持）；注入 = 系统约定全文 + 全套工具 schema（getAllTools 实时）+ JSON 调用告知（D9，ADR-0007）
5. 命令分派：bash `command: string` 内 **JSON 序列化工具调用**（`{"name":..., "arguments":...}`），tool_call 拦截 + JSON.parse 分派；非 JSON 放行原生（D11，ADR-0006）
6. 边界条件：handoff/new 标记重置 → 自然注入；compact 经 `session.compacting` context 钩子拼接保留（widget 绿）；plan mode 放弃特判（扩展 API 无法检测）；子代理天然隔离（模块实例独立）（D10）
7. 工具 schema 无法消息注入（tools 参数外不可调）——工具能力通过 bash JSON 序列化调用 + 插件分派提供（D11）
8. 检测开关（`/dspro-boost` 打开，默认关）= opt-in（ADR-0002）；后台工作（str_replace_editor 注册、头部标记、分派准备）始终进行（D6）
