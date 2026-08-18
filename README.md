# omp-dsh-minimal

DeepSeek Harness **minimal 模式**的 omp 实现：纯净 persona + 仅 `bash` + `str_replace_editor` 两个工具，缓解 DeepSeek V4-Pro 的 CoT 过拟合。

## 为什么

DeepSeek V4-Pro 的 CoT 对训练分布过拟合：进入 `Let me` 式思维链后推理质量崩。dsh minimal（DeepSeek Harness 极简 preset）实证：极简环境产出干净的 `We need` 式推理（官方基准 99/96 vs 全量 91/92）。omp 无此模式，本插件补上。

**关键约束（ablation 实测，2026-08-18）**：工具文本提及（消息里出现工具名/描述/schema，即使不可调用）破坏 `We need` 并诱发模型直接调用不可调用工具——极简环境必须**零工具文本**。因此本插件不注入工具 schema、不注入工具提及。

## 快速开始

```bash
omp --extension ./src/index.ts
```

| 命令 | 行为 |
|---|---|
| `/dsh-minimal` | 开启极简开关（便利设 V4-Pro/High；开启后任何模型都极简） |
| `/dsh-minimal off` | 退出（确认对话框 → 恢复完整工具 → 警告含 KV 缓存代价） |
| `/dsh-minimal status` | 查看当前状态 |

输入 `/dsh-minimal `（带空格）触发参数补全（`off` / `status` + 说明）。

**效果**：开启后新会话首轮自动注入约定文件（`AGENTS.md` 原文，零工具文本）；模型全程只有 `bash` + `str_replace_editor`，thinking 开头呈 `We need` 式，多轮不纠结。已实测（真实 DeepSeek V4 Pro）：We need 复现、思考质量高；代价是速度较慢（约定全文注入）。

**widget**：编辑器上方状态条——绿 = `DeepSeek Harness Minimal Mode: Context Injected`，红 = `DeepSeek Harness Minimal Mode: Active`（未注入，如中途开启）；off 消失。开关不持久化（session 重启默认关）。

## 机制

- **极简环境**：开启期间每轮注入纯净 persona（`You are a helpful software engineer assistant.`）+ 仅 2 工具，无 promote、无模型监测
- **会话头部注入**：首轮（历史无用户消息）注入约定文件原文；compact 经官方钩子保留；handoff/new 消息清空后自然重注入；**中途开启不注入**（widget 红如实反映）
- **协议处理**（工具调用拦截点）：`skill://` `agent://` `artifact://` `memory://` `rule://` `local://` 由 omp bash 原生展开（读写都工作）；`xd://<tool>` 经 `getAllTools()` 解析工具描述返回；其余（`mcp://` `issue://` `pr://` `vault://` `omp://` `history://`）fail-open 放行原生
- **退出**：off 确认后恢复完整工具快照 + persona 停止覆盖；下一轮向模型注入一次性退出告知（忽略历史极简注入）

## 文档

- [设计](docs/design/dsh-minimal.md)（D1-D9，权威规格）· [测试方法](docs/design/testing.md)（L1-L3）
- 决策记录：`docs/adr/0002`（极简开关）/`0003`（无激活条件）/`0005`（无 promote）/`0006`（协议处理）/`0007`（注入与退出告知）
- 领域术语：[CONTEXT.md](CONTEXT.md)
- 规格与用户故事：`.scratch/dsh-minimal/spec.md`

## 已知限制

- 速度较慢：注入约定全文 + 极简环境（单轮 token 成本、KV 缓存切换代价）
- 多轮持续犹豫：零上下文环境的模型固有代价（ablation 实证非注入可解）
- `mcp://` 等协议在极简环境不可用（无官方读取 API，fail-open 由 bash 报错）
