# 双模式披露内容契约（normal / pure 各披露哪些板块）

极简开关下，模型看到的**补充层**（developer 消息）内容按模式分层。基础层 systemPrompt 两模式一致（纯净 dsh persona + `bash` + `str_replace_editor`，与 dsh minimal 逐字节一致），**不披露 omp 任何系统板块**。本 ADR 定义补充层各模式披露的板块清单（含插件新增板块）与污染边界。

**披露结构**：
- **基础层**（systemPrompt，normal 与 pure 相同）：纯净 persona，零 omp 板块
- **补充层**（developer 消息，会话头部注入）：按模式披露下表板块

**对比表**（按 omp 原始渲染顺序，含新增板块）：

| omp 原始板块 | normal | pure |
|---|---|---|
| `# Internal URLs`（协议目录） | ✅ | ✗ |
| `# xd:// Tool Devices`（omp 原生，schema 格式） | ✗ 替代为自产 xd 板块 | ✗ |
| `<repo-rules>`[AGENTS] | ✅ | ✅ |
| `{{appendPrompt}}`[APPEND_SYSTEM] | ✅ | ✗ |
| **新增：头部说明**（英文 `<omp-context>`） | ✅ | ✗ |
| **新增：xd 协议板块**（自产框架 + `xdevEntries` 清单） | ✅ | ✗ |

**顺序**：按 omp 原始渲染顺序排列（Internal URLs → xd 板块 → repo-rules → APPEND_SYSTEM），头部说明在最前。pure 仅 `<repo-rules>`[AGENTS]（自带 "MUST follow these context files for all tasks:" 引入，天然通顺，不加头部）。

**各板块来源**：
- `# Internal URLs`：复用 omp 渲染段（`getSystemPrompt()` 截取），零自产
- xd 协议板块：插件自产框架文字（英文，一句总引导 + "可用 bash 访问 `xd://<tool>` 查询工具说明"）+ 复用 omp `xdevEntries()`（工具名 + 一句话 summary）；**xdev 激活时生效**
- `<repo-rules>`[AGENTS]：复用 omp 渲染段（项目级反向 walk 全部 + 用户级），零自产
- `{{appendPrompt}}`[APPEND_SYSTEM]：复用文件原文，零自产
- 头部说明：插件自产，英文，一两句总引导，不做逐块解释（避免诱导模型反复核对协议）

**污染边界**（ablation 实证裁定）：
- **排除**：任何工具名 / description / schema（含 omp `xdevDocs` 整段）——ablation 完整版实证破坏 We need
- **未实证**：协议名提及（`xd://` `skill://` 等，无工具描述）——实现后冒烟测试项
- **无污染**：约定 / 行为纪律文本（AGENTS、APPEND_SYSTEM）——ablation 1 实证保持

**理由**：
- 基础层保持 dsh 纯净 = We need 锚定（ablation 实证）
- normal 额外披露环境信息 = 与 omp 环境最大一致性，告知 LLM 可用 bash 访问 omp 协议/设备能力（插件 tool_call 拦截 + bash 原生展开已实现，但需告知）
- pure 保留 AGENTS = 约定可用性（与 normal 唯一差异 = 环境/纪律层）
- 复用 omp 现成渲染/文件（Internal URLs / repo-rules / APPEND_SYSTEM / xdevEntries）= 零自产为主，仅 xd 框架与头部说明自产（描述插件特有能力，omp 无对应说明）

**权衡/后果**：
- normal 披露多板块有 token 成本且单轮稍慢（ablation 1：约定全文注入 We need 保持但模型检查协议）——可接受（环境可用性优先）
- 协议名提及档未实证——冒烟测试验证，若破坏则回退为纯约定披露
- pure 不再是最省 token 形态（含 AGENTS）——语义变更，见 ADR-0008

**Status**: accepted
