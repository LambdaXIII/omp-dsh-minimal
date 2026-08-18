# omp-dsh-minimal — dsh minimal 模式的 omp 实现

> 状态：**决策已定（2026-08-18）**。依据 = ①dsh minimal 实证（纯净 persona + 2 工具 → We need 干净推理）+ ②omp 源码实证 + ③**ablation 实测**（工具文本提及破坏锚定、系统约定注入拖慢单轮、零注入多轮犹豫——详见 journal 研究条目）。

## 文档导航

**设计文档（行为全貌）**：本文档——极简环境机制、技术事实、设计决策、约束、验证计划。

**架构决策（ADR，`docs/adr/`）**：
- [ADR-0001](docs/adr/0001-two-phase-anchoring.md) — 两阶段锚定 ※**已由 ADR-0005 取代**
- [ADR-0002](docs/adr/0002-explicit-switch.md) — 极简开关（手动开/off，显式 opt-in）
- [ADR-0003](docs/adr/0003-activation-condition.md) — 无激活条件（开启即极简，取代 pro+High 监测）
- [ADR-0004](docs/adr/0004-promotion-once.md) — 一次性 promote ※**已由 ADR-0005 取代**
- [ADR-0005](docs/adr/0005-no-promote-minimal-anchoring.md) — 无 promote 极简锚定
- [ADR-0006](docs/adr/0006-bash-protocol-mapping.md) — bash 协议映射（skill:// xd:// local:// 委托 omp 工具）
- [ADR-0007](docs/adr/0007-injection-and-exit-notice.md) — 会话头部全量注入 + 退出告知

## 1. 背景与定位

DeepSeek V4-Pro 的 CoT 对训练分布过拟合（`Let me` 式低质思维链）。dsh minimal（DeepSeek Harness 极简 preset）实证：纯净 persona（`You are a helpful software engineer assistant.`）+ 仅 `bash` + `str_replace_editor` 两工具 → 模型产出干净的 `We need` 式推理（官方基准 99/96 vs 全量 91/92）。

**本插件 = dsh minimal 模式的 omp 实现**（原名 dspro-boost，定位从「V4-Pro 过拟合 booster」转为「极简环境的通用移植」）。**ablation 关键实证**（journal: deepseek-anchor-text-sensitivity）：
- 工具文本提及（消息里出现工具名/描述/schema，即使不可调用）**破坏 We need** 并诱发直接调用——锚定敏感是文本级
- 系统约定全文注入：We need 保持，单轮稍慢（模型 thinking 检查协议）
- 零注入：We need 保持 + 单轮最快，但多轮持续犹豫

定稿取舍：**全量系统约定注入（约定可用性）+ 零工具文本（锚定纯净）**；多轮犹豫记录为已知限制。

## 2. 核心机制

```
/dsh-minimal（裸命令，开启极简开关）
   → 便利设模型/thinking = V4-Pro/High（纯便利，不绑定）
   → 极简环境：setActiveTools(['bash','str_replace_editor']) + persona 覆盖纯净
   → 会话头部（历史无 user 消息）→ 全量注入约定文件（AGENTS.md 原文，零工具文本）
   → 模型用 bash 原生命令（cat/ls/sed）干活；内部 URL（skill:// xd:// local:// 等）
     在工具调用拦截点内部分派（ADR-0006）
   → 开启期间任何模型都极简（无监测，ADR-0003）
   → /dsh-minimal off → 确认对话框 → 恢复完整工具 + persona 回归
      → 警告用户（含 KV 缓存代价）+ 下一轮注入退出告知（ADR-0007）
```

## 3. 设计决策

### D1. 工具集 → `bash` + `str_replace_editor`（2 schema 不变，全程）

命名对齐 dsh minimal。persona 全文 = `You are a helpful software engineer assistant.`（逐字节复刻 dsh minimal）。str_replace_editor = **dsh 官方语义真实现**（`@deepseek-ai/dsh-tool-str-replace-editor` 逐字节对齐）：description 原文 + 四子命令 `view`（cat -n 显示/目录列 2 层非隐藏）/`create`（新建不覆盖）/`str_replace`（唯一精确替换）/`insert`（行后插入），参数 `command`/`path`/`file_text`/`insert_line`/`new_str`/`old_str`/`view_range`。注册 `defaultInactive`（完整环境不可见）。

### D2. 无 promote（ADR-0005）

模型全程 2 工具，无切换。能力 = bash 原生命令 + 协议映射。

### D3. 无激活条件（ADR-0003）

开启即极简，任何模型/thinking。便利命令仍切 V4-Pro/High（主要使用场景）。

### D4. 极简开关（ADR-0002）

`/dsh-minimal`（开启 + 便利切配置）、`/dsh-minimal off`（退出 + 确认对话框）、`/dsh-minimal status`（查看）。**不监测配置**——退出只能显式 off。KV 缓存代价在 off 警告与开启信息中呈现。**不持久化开关**——session 重启默认关闭，用户重新 `/dsh-minimal`。

### D5. persona 作用域 → 极简期间全程

开启期间每轮 `before_agent_start` 返回纯净 persona 覆盖；off 后不再返回（omp 恢复标准 base）。

### D6. 会话头部注入（ADR-0007）

- 注入 = **约定文件原文**（`<cwd>/AGENTS.md` + `~/.omp/agent/AGENTS.md` 拼接）——**非 `event.systemPrompt` 原文**（源码实证：base systemPrompt 渲染工具名/描述/策略——`# Tool Inventory`、`# xd:// Tool Devices`、`§ Tool Policy`——含大量工具文本，违背零工具文本约束）。约定文件是约定主源（完整环境的 systemPrompt 从它们构建），天然无 omp 工具渲染
- custom 消息（customType `dsh-minimal-inject`，display: false）→ developer role 入历史
- 判定 = 会话头部标记（hasUserMessage）：`session_start`/`session_switch`(handoff|new) 重置、首请求消费、fork/compact 保持
- **中途开启**（会话已有 user 消息）→ 不注入（widget 红如实反映）
- compact：`session.compacting` context 钩子拼接注入文本 → 保留
- handoff/new：消息清空 → 头部重置 → 自然重注入

### D7. bash 协议映射（ADR-0006）

`tool_call` 拦截**任何工具调用**（用户方案：工具被调用时处理）；bash 分支检测 command 协议串（core seam `detectProtocol`），在拦截点内部分派（**无 invokeTool 委托**——API 实证 tool_call 事件 ctx 无 invokeTool，见 §4）：
- **bash 原生展开协议放行**：`skill://` `agent://` `artifact://` `memory://` `rule://` `local://` 由 omp bash 原生展开为绝对路径（读写都工作）——插件不干预
- **`xd://` 内部分派**：URL 自带工具名 → `getAllTools()`（官方 API）查工具描述 → `input` 替换 `echo '<description>'` 返回
- **其余不展开协议**（`mcp://` `issue://` `pr://` `vault://` `omp://` `history://`）无官方读取 API → 放行原生 bash（fail-open）
- 无协议串 → 放行原生

### D8. 退出（ADR-0002/0007）

`/dsh-minimal off` → `ctx.ui.confirm` 确认对话框 → 恢复完整工具快照（开启时保存） + persona 停止覆盖 → `ctx.ui.notify` 警告用户（含 KV 代价）→ 下一轮 `before_agent_start` 注入退出告知（custom 消息 `dsh-minimal-exit-notice`，一次性：极简已退出、环境已恢复、忽略历史极简注入——与 omp 其他信息做法一致）→ widget 消失。已注入内容作为历史不额外处理。

### D9. widget

完整描述句文案（非缩写）：绿 = `DeepSeek Harness Minimal Mode: Context Injected`；红 = `DeepSeek Harness Minimal Mode: Active`（未注入）。显示 = 开关开启；off 消失。红/绿消费真实注入状态。

## 4. 技术事实（omp 源码实证）

- `before_agent_start` 返回 `{ systemPrompt: string[] }`（per-turn 覆盖）+ `message`（custom 消息注入）
- **base systemPrompt 含工具渲染**（源码实证）：`# Tool Inventory`（工具名列表）、`# xd:// Tool Devices`（工具文档）、`§ Tool Policy`（每工具策略行）——注入必须换源为约定文件（D6）
- custom 消息 → `convertMessageToLlm` 转 role="developer" 进请求 + 入历史
- `setActiveTools` 必须 `await`；turn 内下一 model call 生效
- `agent.reset()`（newSession/handoff）清空消息；fork 保留；runner 复用无新 session_start
- `session.compacting` 返回 `{ context }` 附加进摘要
- `ctx.ui.confirm`/`notify` 可用（确认对话框/警告）
- `tool_call` 事件 ctx **无 `invokeTool`**（冒烟实证 `invokeTool=undefined`）——它只在 `registerTool` 的 execute 参数提供；且 same-tool only（只能委托同名内置，无法从 bash 委托 read/glob）→ 委托通道不存在，协议分派在拦截点内做
- omp bash execute 前原生展开内部 URL（`expandSkillUrls` + `expandInternalUrls`：skill/agent/artifact/memory/rule/local → 绝对路径，冒烟实证 local:// 读写）
- 扩展每次加载 = 新模块实例（子代理天然隔离）

## 5. 约束与风险

- 注入含系统约定全文（token 成本 + 单轮稍慢）——已知权衡（ADR-0007）
- 多轮持续犹豫（零上下文代价）——已知限制，不可注入解决（ablation 实证）
- 协议识别文本启发——协议串强特征，误判低；fail-open 放行
- 背景回调用 `ctx.setTimeout`/`setInterval`；多扩展链式 persona 覆盖需协调

## 6. 验证计划

见 **[docs/design/testing.md](docs/design/testing.md)**：
- L1 单元：会话头部状态机、协议映射（动词 × 协议矩阵）、退出状态机
- L2 冒烟：命令（开/off/status/确认对话框）、注入、协议委托、widget 文案
- L3 效果（用户）：真实会话 We need 复现 + 协议可用性 + 退出行为
