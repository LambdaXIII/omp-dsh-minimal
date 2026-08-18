# omp-dsh-minimal（dsh minimal 模式的 omp 实现）

omp 扩展插件，把 DeepSeek Harness 的 minimal preset 移植到 omp：极简环境（纯净 persona + 两个工具）触发干净的 We need 式推理，缓解 DeepSeek V4-Pro 的 CoT 过拟合。

## Language

**极简环境（minimal environment）**：
开启插件后模型的运行环境：纯净 persona（`You are a helpful software engineer assistant.`）+ 仅 `bash`、`str_replace_editor` 两个工具，全程不变。
_Avoid_: 锚定、bootstrap、两阶段

**极简开关（minimal switch）**：
`/dsh-minimal`（裸命令/`on`/`normal` → normal）、`/dsh-minimal pure`（→ pure）、`/dsh-minimal off`（退出）的三态显式开关 `off | normal | pure`。开启即极简，**任何模型都工作于同一环境**（不监测模型/thinking 配置）。
_Avoid_: 检测开关、激活条件、opt-in 监测

**常规模式（normal mode）**：
极简开关的默认开启态（`/dsh-minimal`、`on`、`normal` 三者等价）。会话头部注入约定文件（全量注入），维持既有极简语义。
_Avoid_: 裸命令、仅开启

**纯模式（pure mode）**：
`/dsh-minimal pure` 进入——极简环境**不注入任何约定**，与 dsh minimal 完全一致，供仅需简单问答、省去注入 token/延迟的场景。与 normal 唯一差异 = 不注入；已注入内容不撤销，纯开关只影响未来动作。
_Avoid_: 零注入模式、静默模式

**会话头部（session head）**：
历史中尚无 user 消息的会话起始状态；全量系统约定注入仅在此状态发生。
_Avoid_: 新会话、第一轮、pendingNewSession

**全量注入（full injection）**：
会话头部把约定文件原文（`<cwd>/AGENTS.md` + `~/.omp/agent/AGENTS.md`）作为 custom 消息写入历史——**零工具文本**（工具提及破坏 We need，ablation 实证；`event.systemPrompt` 原文含工具渲染故不用）。
_Avoid_: 工具 schema 注入、systemPrompt 原文注入、渐进注入

**协议映射（protocol mapping）**：
bash 拦截识别 omp 内部 URL（`skill://` `xd://` `local://` 等）→ 动词映射 omp 工具（同名注册 + invokeTool 委托原生）→ 结果 echo 返回。非协议命令放行原生 bash。
_Avoid_: 工具分派、JSON 序列化调用、命令翻译、首词解析

**退出告知（exit notice）**：
`/dsh-minimal off` 后下一轮注入的 custom 消息——告知 LLM 极简已退出、环境已恢复、忽略历史极简注入。
_Avoid_: 注入清理、历史删除

**widget**：
编辑器上方状态条；显示/隐藏 = 极简开关；绿 = `DeepSeek Harness Minimal Mode: Context Injected`、红 = `DeepSeek Harness Minimal Mode: Active`（normal 未注入）、蓝 = `DeepSeek Harness Minimal Mode: Pure`（pure 恒蓝）。
_Avoid_: 指示灯、缩写标签、状态机驱动

**KV 缓存代价（KV cache cost）**：
进入/退出极简改变 systemPrompt/tools 导致的前缀缓存失效成本——在开启信息与 off 警告中向用户呈现。
_Avoid_: 缓存破坏、promote 代价

**委托工具（delegation tools）**：
插件同名注册（`defaultInactive`）供 `ctx.invokeTool` 委托的 omp 工具（read/glob/write 等）——仅作协议映射的执行通道，模型永远看不到。
_Avoid_: 扩展工具、自定义工具、嵌套 schema

**哑工具（dumb tool）**：
（已废弃）早期设计 str_replace_editor 只返回引导提示的实现方式，现为 dsh 语义完整实现。
_Avoid_: 使用此术语描述当前实现
