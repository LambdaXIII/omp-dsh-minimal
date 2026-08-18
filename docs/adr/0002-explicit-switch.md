# Explicit switch（极简开关，手动开/off）

插件是 dsh minimal 模式的 omp 实现（`omp-dsh-minimal`）：手动开启进入极简环境（纯净 persona + `bash` + `str_replace_editor`），手动 `off` 退出。**不监测模型/thinking 配置**——开启后任何模型都工作于极简环境（ADR-0003 已取代）。

- `/dsh-minimal`（裸命令）= 开启 + 便利设模型/thinking 为 V4-Pro/High（纯便利，不改环境语义）
- `/dsh-minimal off` = 退出：确认对话框 → 恢复完整工具 + persona 回归 omp 标准（下一轮起）→ 警告用户（含 KV 缓存代价提示）→ 下一轮注入退出告知（告知 LLM 极简已退出、忽略历史极简注入）
- 显式 opt-in 的代价：进入/退出极简会改变 systemPrompt/tools、破坏 KV 前缀缓存（真实每会话成本）——警告中向用户呈现

**Status**: accepted
