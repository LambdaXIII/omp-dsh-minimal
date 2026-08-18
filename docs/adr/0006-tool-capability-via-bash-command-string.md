# 工具能力通过 bash JSON 序列化调用提供（schema 符合 dsh）

锚定期模型只有 `bash` + `str_replace_editor` 两个工具。全部其他工具能力（读/写/编辑/搜索/列目录等）通过 **bash 的 `command: string` 参数 + JSON 序列化工具调用**提供：

- **bash schema 保持 dsh 形态**：`command` 是字符串（`{"command": "..."}`），不注册自定义 bash、不改参数结构、零完整环境污染
- **调用形态**：模型在 command 字符串里写 **JSON 序列化的工具调用**（`{"name": "read", "arguments": {"path": "..."}}`）——LLM 对 schema 与工具调用格式是本能，无需教语法
- **分派**：`tool_call` 拦截 bash 调用 → `JSON.parse` 成功且含 `name`/`arguments` → 按 name 分派（可翻译的工具插件自实现 fs，不可翻译的返回不可用提示）；非 JSON → 放行原生 bash
- **告知来源 = omp 运行时状态**：注入消息里列 omp 全套工具介绍 + 各工具 schema 原文（`getAllTools()` 实时获取）——omp 有哪些工具就告知哪些，零硬编码、零特例

**为什么是这种形态**（候选方案排除过程，均源码实证）：
- **schema 消息注入不可行**：模型只能调用请求「工具清单」（tools 参数）中声明的工具；消息里的 schema 文字模型能读，但无法对未声明的工具发起调用
- **嵌套 schema（bash 参数含结构化字段）被否决**：需要注册自定义 bash 工具覆盖内置（registry 无条件覆盖 + 无注销 API → 完整环境 bash schema 永久被改）；且 `invokeTool` same-tool only 无法转调其他内置工具；bash 形态偏离 dsh 的纯 `command: string`
- **字符串文本语法（`read foo.txt` 首词解析）被否决**：bash 内置 `read` 命令字面冲突、write 多行无法表达、文本解析有固有歧义
- **JSON 序列化是唯一同时满足**：schema 符合 dsh（command 是字符串）+ 结构化可靠解析（JSON 语法硬边界）+ 零环境污染（不注册自定义 bash）+ 模型调用自然（LLM 原生工具调用格式的文本形态）

**权衡/后果**：
- 注入内容含全套工具 schema，体积较大（token 成本，注入一次但入历史每轮携带）——L3 验证对锚定纯净度的影响
- 分派 fail-closed：`JSON.parse` 或 handler 抛错不阻断 bash 工具执行（回退放行）
- **plan mode 特判放弃**：扩展 API 无 plan mode 状态入口（无 API、无事件；plan 上下文是 custom 消息不在 systemPrompt），无法检测。触发面窄（须在 plan mode 下主动开启锚定），设计文档说明即可
- str_replace_editor 为 schema 内原生工具（独立于 bash 分派），按 dsh 语义真实现（view/create/str_replace/insert 四子命令）

**Status**: accepted
