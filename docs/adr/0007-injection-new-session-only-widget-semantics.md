# 上下文注入仅会话头部 + 内容随标准流程流转 + widget 消费真实状态

**注入判定 = 会话头部**（历史中尚无 user 消息），不依赖插件自造开关。注入内容 = omp 系统约定全文（event.systemPrompt）+ omp 全套工具介绍与 schema（getAllTools 运行时状态）+ 一句告知（bash 以 JSON 序列化形式调用这些工具）。注入为 custom 消息（customType `dspro-boost-inject`，display: false），实证转换 role="developer" 进入 LLM 请求并持久入历史。

**会话头部标记（hasUserMessage）由真实事件维护**：
- `session_start`（新扩展实例）/ `session_switch`(handoff|new)（消息清空，agent.reset 实证）→ 置「无 user 消息」（回到头部）
- 首个真实请求（before_agent_start）→ 置「有」（本轮 user 消息进入历史）
- `session_switch`(fork)（消息保留，源码实证）→ 保持
- `session_compact`（同会话）→ 保持

handoff/new 因此**天然被覆盖**：消息清空 → 回到头部 → 下一个匹配请求注入——无需专门钩子。

**compact 内容流转**：经 `session.compacting` 事件的 `context` 字段（官方钩子，「Additional context lines to include in summary」）把注入内容拼进压缩摘要 → 内容随标准压缩流程保留，无需重新注入。

**widget 消费真实状态，非状态机自造**：颜色由「注入内容是否真实存在于当前上下文」计算——
- 注入完成 → 绿
- 会话头部未注入（开启后未发消息/中途开启但已过头部/compact 拼接失败）→ 红
- compact 拼接成功（内容经摘要保留）→ 绿
- 显示/隐藏 = 极简环境激活（检测开关开 + pro+High 匹配）；配置不匹配 → 消失

**理由**：
- 注入内容只在会话头部有价值；会话进行中注入造成重复/错位
- handoff/compact 是 omp 标准流程，注入内容随其流转（拼接/头部判定），插件不维护可能失真的自造状态
- widget 与事实脱钩即为假象——只消费真实事件推导的状态

**权衡/后果**：
- 注入消息含全套工具 schema，token 成本随历史每轮携带（L3 验证锚定纯净度）
- compact 拼接依赖 `session.compacting` 的 context 钩子行为（摘要附加行）——若实现确认 context 直接进摘要则内容原文保留；若经 LLM 处理则内容变形（widget 相应如实反映）

**Status**: accepted
