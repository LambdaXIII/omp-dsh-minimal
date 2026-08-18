# dspro-boost（DeepSeek V4-Pro 极简锚定插件）

omp 扩展插件，缓解 DeepSeek V4 Pro 高思考强度下的 CoT 过拟合：锚定模型于极简环境（纯净 persona + 两个工具），工具能力经 bash JSON 序列化调用提供。

## Language

**锚定（anchoring）**：
让模型在极简工具环境（纯净 persona + `bash` + `str_replace_editor`）中推理的机制，工具列表全程不变、无 promote。
_Avoid_: 两阶段、promote、bootstrap

**检测开关（detection switch）**：
`/dspro-boost` 打开的 opt-in 开关（默认关），控制插件是否检测 pro+High 条件；关闭时插件完全透明（后台准备仍进行）。
_Avoid_: 锚定开关、on/off 命令

**激活条件（activation condition）**：
检测开关开且当前模型为 DeepSeek V4 Pro、thinking 为 High——极简环境进入的唯一判据。
_Avoid_: 开启状态、锚定中

**极简环境（minimal environment）**：
锚定激活时模型的运行环境：纯净 persona 系统提示 + 仅 `bash`、`str_replace_editor` 两个工具。
_Avoid_: 极简工具集、bootstrap 阶段

**会话头部（session head）**：
历史中尚无 user 消息的会话起始状态；注入上下文仅在此状态发生。
_Avoid_: 新会话、第一轮、pendingNewSession

**注入（injection）**：
会话头部把上下文（系统约定全文 + 全套工具 schema + JSON 调用告知）作为 custom 消息写入历史，模型后续轮次自动携带。
_Avoid_: 上下文披露、预置、prologue

**JSON 序列化调用（JSON-serialized tool call）**：
模型在 bash 的 `command` 字符串内以 `{"name":..., "arguments":...}` 表达的 omp 工具调用，插件解析后分派。
_Avoid_: 假命令、命令翻译、首词解析、嵌套 schema

**命令分派（dispatch）**：
`tool_call` 拦截 bash 调用后，JSON 解析成功则按工具名分派（fs 自实现或不可用提示），否则放行原生执行。
_Avoid_: 翻译表、命令拦截、bash 假命令层

**widget**：
编辑器上方状态条；显示/隐藏 = 极简激活，红/绿 = 注入内容是否真实存在于上下文。
_Avoid_: 指示灯、状态机驱动、生命周期条

**哑工具（dumb tool）**：
（已废弃）早期设计 str_replace_editor 只返回引导提示的实现方式，现改为 dsh 语义真实现。
_Avoid_: 使用此术语描述当前实现
