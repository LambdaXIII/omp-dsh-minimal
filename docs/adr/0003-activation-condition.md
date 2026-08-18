# No activation condition（开启即极简，取代 pro+High 监测）

早期设计（dspro-boost）限定 DeepSeek V4 Pro + thinking High 才激活锚定（原 ADR-0003）。**omp-dsh-minimal 废除该条件**：插件是 dsh minimal 模式的通用实现，极简环境的价值不限于特定模型配置——开启即极简，任何模型/thinking 都工作于同一环境。

**理由**：
- 定位从「V4-Pro 过拟合 booster」转为「dsh minimal 模式的 omp 实现」——环境是通用能力，不绑定模型
- 便利命令 `/dsh-minimal` 仍顺手切 V4-Pro/High（V4-Pro 是主要使用场景），但这是便利不是条件——用户之后切换模型，环境不变
- 简化状态：无「条件匹配/不匹配」判定，无配置变化自动停止逻辑（退出由 `/dsh-minimal off` 显式控制，ADR-0002）

**Status**: accepted（取代原 0003 激活条件设计）
