# Changelog

## [0.3.0] — 2026-08-22

### Changed

- 对齐 omp 18：运行时依赖（`@oh-my-pi/omptype` / `pi-agent-core` / `pi-tui`）升至 `^18.0.0`，开发依赖 `pi-coding-agent` 升至 `18.0.0`（omp 18 将扩展的 `@oh-my-pi/pi-*` import 重写为内置模块，锁 17 仅影响编译类型；升 18 消除声明与运行时的错位）
- 移除 `session_switch` 的 `handoff` 分支：omp 18 起 handoff 不再作为 session 切换触发（改为经 compaction 提交到当前会话，注入文本由 `session.compacting` 重挂），仅 `new` 重置会话头部

## [0.2.0] — 2026-08-19

## [0.2.0] — 2026-08-19

### Added

- 三态极简开关（ADR-0008）：`/dsh-minimal`/`on`/`normal` → normal（会话头部注入约定），`/dsh-minimal pure` → pure（不注入约定，唯一差异），`off`/`status` 语义保留；参数补全增补 `on`/`normal`/`pure`
- pure 模式：与 normal 唯一差异 = 不注入约定；退出流程、便利设 V4-Pro/High、协议映射、退出告知两模式一致
- widget 蓝色态：pure 恒 `DeepSeek Harness Minimal Mode: Pure`；normal 保持绿（注入）/红（未注入）
- `status` 展示 `off` | `pure` | `normal (injected)` | `normal (not injected)`

## [0.1.0] — 2026-08-19

初始发布。dspro-boost 定位废弃（工具文本注入经 ablation 实证破坏锚定），本版本为 omp 上的 dsh minimal 模式实现。

### Added

- 显式极简开关：`/dsh-minimal`（开启 + 便利设 V4-Pro/High）、`/dsh-minimal off`（确认对话框 → 恢复完整工具 → KV 代价警告 → 一次性退出告知）、`/dsh-minimal status`；参数补全（off/status）
- 极简环境：纯净 persona（`You are a helpful software engineer assistant.`）+ 仅 `bash` + `str_replace_editor` 两工具，无 promote、无模型监测（任何模型开启即极简）
- 会话头部注入：首轮注入约定文件原文（AGENTS.md，零工具文本）；compact 保留；handoff/new 自然重注入；中途开启不注入
- 协议处理：`skill://` 等 bash 原生展开协议放行；`xd://<tool>` 经 `getAllTools()` 解析返回；其余 fail-open
- 完整描述句 widget（`DeepSeek Harness Minimal Mode: Context Injected` / `Active`）
- str_replace_editor 与 dsh 官方语义对齐（四子命令 view/create/str_replace/insert）

### Changed

- 项目更名 dspro-boost → omp-dsh-minimal；废除 pro+High 激活条件与 promote 机制
- 工具能力通道：JSON 分派（原设计）→ 工具调用拦截点内部分派（API 实证 tool_call 事件无 invokeTool，委托通道不存在）
- 注入内容：systemPrompt 原文 → 约定文件（源码实证 systemPrompt 渲染工具名/描述/策略，违背零工具文本约束）
