# 无 promote 极简锚定（取代 ADR-0001/0004）

插件（`omp-dsh-minimal`）实现 dsh minimal 模式的极简环境：模型从第一轮到任务结束**全程只面对 `bash` + `str_replace_editor` 两个工具**，工具集不切换。删除两阶段锚定（anchor-then-promote，ADR-0001）与一次性 promote（ADR-0004）。

**背景**：早期设计沿用社区两阶段模式——极简 bootstrap → 首次工具调用后 promote 回完整工具集。实测与讨论确认：**bash 是万能通道**，极简环境里模型用 bash 原生命令（cat/ls/sed）即可完成读写、编辑、列目录，不需要恢复完整工具集。dsh minimal 实证：模型在只有 bash + str_replace_editor 的环境里能完整干活并产出干净的 `We need` 式推理。

**理由**：
- bash 原生命令 + 协议映射（ADR-0006）覆盖全部能力，promote 无必要
- 删除 promote 消灭 KV 前缀缓存反复破坏（切换 = 缓存失效）
- CoT 锚定全程保持：工具集从第一轮到结束不变，推理轨迹全程锚定在极简环境
- ablation 实证：任何工具文本提及（消息级）都破坏锚定——极简必须彻底（零工具文本注入）

**权衡/后果**：
- 模型永远没有 omp 内置工具（read/write/edit 等）——能力通过 bash 原生命令表达；内部 URL 协议经 bash 协议映射委托（ADR-0006）
- 退出由 `/dsh-minimal off` 显式控制（ADR-0002），配置变化不自动停止

**Status**: accepted（取代 ADR-0001、ADR-0004）
