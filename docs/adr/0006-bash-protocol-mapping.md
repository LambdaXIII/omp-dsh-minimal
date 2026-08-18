# bash 协议映射：内部 URL 在工具调用拦截点内部分派

极简环境只有 `bash` + `str_replace_editor` 两个工具。模型在 bash 里表达对 omp 内部 URL（`skill://` `xd://` `local://` 等）的请求时，插件在**工具调用拦截点**（`tool_call` 事件，对任何工具调用开放）处理协议串。

**机制**：
- `tool_call` 拦截所有工具调用（用户方案：任何工具被调用时处理）；bash 分支检测 command 协议串（`detectProtocol`，core seam）
- **bash 原生展开协议放行**：omp bash 在 execute 前调用 `expandSkillUrls` + `expandInternalUrls`，把 `skill://` `agent://` `artifact://` `memory://` `rule://` `local://` 展开为 shell-escaped 绝对路径——读写都原生工作（源码 + 冒烟实证），插件不干预
- **`xd://` 内部分派**：URL 自带工具名（如 `xd://read`）→ `getAllTools()`（官方 API）查工具描述 → `input` 替换为 `echo '<description>'` 返回（bash 执行 echo，模型看到文本）
- 其余不展开协议（`mcp://` `issue://` `pr://` `vault://` `omp://` `history://`）无官方读取 API → 放行原生 bash（fail-open，bash 报错模型自适应）
- 无协议串 → 放行原生 bash

**为什么是这种形态**（候选排除，均源码/冒烟实证）：
- **工具 schema 注入 + JSON 分派（原 ADR-0006）被废弃**：ablation 实证注入工具文本破坏「We need」锚定效果（模型对工具提及文本级敏感），且模型会条件反射直接调用不可调用的工具
- **同名注册委托工具 + `ctx.invokeTool` 委托被否决（API 实证）**：`tool_call` 事件的会话 ctx **没有 `invokeTool`**（日志实证 `invokeTool=undefined`——它只在 `registerTool` 的 execute 参数提供）；且 `invokeTool` same-tool only（只能委托同名内置），无法从 bash 委托到 read/glob。委托通道不存在
- **插件自建协议解析被否决**：不自己实现 URL→内容解析器；`xd://` 用官方 `getAllTools()` 读取，其余 fail-open
- **注册自定义 bash 工具（内部分派）被否决**：会替换原生 bash 语义（参数、approval、并发、内部 URL 展开全要重实现），且 same-tool only 仍阻断跨名委托

**权衡/后果**：
- 协议识别是文本启发（协议串前缀）——协议串是强特征，误判风险低；无匹配放行原生保证 fail-open
- `xd://` 是唯一在拦截点可用官方 API 解析的协议（工具文档对极简环境 2 工具价值有限，属可接受降级）；bash 原生展开覆盖了实际高频场景（技能、本地文件）
- 拦截点对任何工具调用开放（不只 bash）——未来若有其他工具的协议场景可在同一位置处理
- str_replace_editor 为 schema 内原生工具（独立于 bash 映射），dsh 语义真实现

**Status**: accepted（取代原 0006 工具能力 JSON 分派设计；委托通道版本经 API 实证否决后修正为内部分派）
