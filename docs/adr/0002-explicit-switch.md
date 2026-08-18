# Explicit opt-in（检测开关，默认关）

锚定切换极简环境会让 systemPrompt/tools 变化、破坏 KV 前缀缓存（真实每会话成本）。因此要求显式 opt-in：`/dspro-boost`（裸命令）打开**检测开关**（默认关）并便利设置模型/thinking 为 V4-Pro/High。检测开关打开后，插件才在每次真实请求检测 pro+High 条件；匹配则进入极简环境，不匹配则透明。开关关闭（默认）时插件完全透明——**不敲命令，用 pro+High 也不锚定**。无 off 命令（配置变化自然停止）。

**Status**: accepted
