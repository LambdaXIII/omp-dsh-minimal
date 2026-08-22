# 会话头部全量注入 + 退出告知（内容随标准流程流转）

**注入判定 = 会话头部**（历史中尚无 user 消息），不依赖插件自造开关。注入内容**按模式分层**（normal = 头部说明 + `# Internal URLs` + xd 板块 + `<repo-rules>`[AGENTS] + APPEND_SYSTEM；pure = `<repo-rules>`[AGENTS]）——板块清单与顺序见 ADR-0009。**零工具文本**（ablation 实证：工具文本提及破坏极简锚定）：注入的 omp 板块仅取 `getSystemPrompt()` 中**无工具文本的段**（`# Internal URLs`、`<repo-rules>`），排除 `# Tool Inventory`、`# xd:// Tool Devices`（schema 格式）、`§ Tool Policy` 等含工具名/描述/schema 的段；xd 协议板块与头部说明为插件自产，仅含协议名无工具文本。注入为 custom 消息（customType `dsh-minimal-inject`，display: false），实证转换 role="developer" 进入 LLM 请求并持久入历史。中途开启（会话已有 user 消息）不注入（widget 红如实反映）。

**会话头部标记（hasUserMessage）由真实事件维护**：
- `session_start` / `session_switch`(handoff|new)（消息清空，agent.reset 实证）→ 置「无 user 消息」（回到头部）
- 首个真实请求（before_agent_start）→ 置「有」（本轮 user 消息进入历史）
- `session_switch`(fork)（消息保留）→ 保持
- `session_compact`（同会话）→ 保持

handoff/new 因此天然被覆盖（消息清空 → 回到头部 → 下一个匹配请求注入）。

**compact 内容流转**：经 `session.compacting` 事件的 `context` 字段（官方钩子）把注入内容拼进压缩摘要 → 内容随标准流程保留，无需重新注入。

**退出告知**（`/dsh-minimal off` 后）：
- 已注入内容作为历史**不额外处理**（不删除）；真实注入环境回归 omp 标准（下一轮起 systemPrompt/tools 恢复）
- off 后**下一个真实请求**（`before_agent_start`）注入一条一次性 custom 消息（customType `dsh-minimal-exit-notice`，与 omp 其他信息做法一致）：告知 LLM 极简模式已退出、环境已恢复完整、忽略历史中极简注入的内容——避免模型把历史 developer 消息仍当指令。一次性：注入后不再重复（同会话后续轮次不注入）
- 用户侧：off 时 `ctx.ui.confirm` 确认对话框 + `ctx.ui.notify` 退出警告（含 KV 缓存代价提示）

**widget 消费真实状态**：颜色由「注入内容是否真实存在于当前上下文」计算——注入完成 → 绿（normal）/ 蓝（pure）；头部未注入 → 红；compact 拼接成功 → 绿（normal）/ 蓝（pure）。显示/隐藏 = 极简开关状态（开启显示、off 消失）。三色语义见 ADR-0008，文案为完整描述句。

**理由**：
- 注入 = 约定可用性（模型知道 AGENTS.md 约定）+ 环境可用性（normal 额外告知 omp 协议/设备能力，见 ADR-0009）；零工具文本 = 锚定纯净（ablation 实证）
- 退出告知 = 防止历史极简注入内容在完整环境下被误读为当前指令
- 内容随标准流程流转（头部判定/compact 拼接），插件不维护可能失真的自造状态

**权衡/后果**：
- 注入系统约定全文有 token 成本且单轮稍慢（ablation 1 实测 We need 保持但模型会检查协议）——可接受（约定可用性优先）
- normal 披露多板块（Internal URLs / xd / APPEND_SYSTEM）进一步增加 token；协议名提及档未实证（冒烟测试项，若破坏则回退为纯约定披露，见 ADR-0009）
- 退出告知是一条额外注入消息（环境已恢复完整，不受锚定约束）

**Status**: accepted（取代原 0007 注入语义）
