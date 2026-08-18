# 无 promote 极简锚定（取代 ADR-0001/0004）

锚定采用**无 promote** 设计：模型从第一轮到任务结束**全程只面对 `bash` + `str_replace_editor` 两个工具**，工具集不切换。删除两阶段锚定（anchor-then-promote，ADR-0001）与一次性 promote（ADR-0004）机制。

**背景**：早期设计沿用社区两阶段模式——极简 bootstrap → 首次工具调用后 promote 回完整工具集。实测与讨论发现：**bash 是万能通道**，极简环境里模型用 bash 原生命令（cat/ls/sed/curl）即可完成读写、编辑、列目录、网络请求，不需要恢复完整工具集。dsh minimal 实证：模型在只有 bash + str_replace_editor 的环境里能完整干活并产出干净的 `We need` 式推理。

**理由**：
- bash 原生命令 + 命令分派覆盖全部工具能力，promote 无必要
- 删除 promote 消灭 KV 前缀缓存破坏（每次工具切换 = 一次缓存失效）
- 连带消灭全部 promote 相关边界问题（compact/handoff/plan/子代理与 promote 的交互）
- CoT 锚定全程保持：工具集从第一轮到结束不变，推理轨迹全程锚定在极简环境

**权衡/后果**：
- 模型永远没有 omp 内置工具（read/write/edit 等）——能力通过 bash 命令表达（见 ADR-0006）
- 配置变化（用户切走 pro+high）时停止锚定（不再覆盖 persona），但工具从未切换（始终 2 工具），无「卡极简」问题

**Status**: accepted（取代 ADR-0001、ADR-0004）
