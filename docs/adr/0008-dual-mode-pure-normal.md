# 双模式开关（pure / normal）

极简开关从单值升级为三态 `off | normal | pure`，命令集对应扩展。**normal**（`/dsh-minimal` 裸命令 / `on` / `normal` 三者等价）维持既有语义：会话头部注入约定文件，零工具文本。**pure**（`/dsh-minimal pure`）与 dsh minimal 完全一致——极简环境（纯净 persona + `bash` + `str_replace_editor`）**不注入任何约定**，供仅需简单问答、省去注入 token/延迟开销的场景。

**两模式唯一差异 = 约定注入**：normal 在会话头部注入约定文件原文（ADR-0007 机制不变）；pure 永不注入。便利设模型（V4-Pro/High）、退出流程、协议映射（ADR-0006）、退出告知（ADR-0007）两模式一致。pure 开关独立——只影响未来动作，历史已注入内容不撤销。

**状态机**：`minimalEnabled`(bool) 升级为三态 `off | normal | pure`；`on`/`normal`/裸命令 → `normal`，`pure` → `pure`，`off` → 退出（确认框 → 恢复工具 → KV 警告 → 退出告知）。

**widget 反映模式差异**：off 无；normal 绿 = `…: Context Injected`（已注入）/ 红 = `…: Active`（未注入）；pure 恒蓝 = `…: Pure`（无注入概念，显式声明）。

**`status` 保留**，展示 `off` | `pure` | `normal (injected)` | `normal (not injected)`，completion 增补 `pure`/`normal`。

**理由**：pure 满足「仅简单问答、无需约定上下文」的轻量场景——注入约定全文有 token 成本且单轮稍慢（ADR-0007 权衡），对不需要约定的问答是纯开销；normal 保留约定可用性。二者不互斥，用户按需显式选择。`on` 作为 `normal` 的显式别名补齐 `on`/`off` 对称（用户提出：on/off 需同时提供，否则使用麻烦）。

**Status**: accepted（ADR-0002 极简开关的扩展，0002 保留为历史并交叉引用）
