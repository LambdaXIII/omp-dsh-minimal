# Changelog

本文件按**对外行为**记录变更（参照 journal `07-工具脚本设计与集成` 的 CHANGELOG 分类纪律）：修复错误行为记 Fixed、新增功能记 Added、对外行为变化记 Changed；行为不变的重构不记录。

## [Unreleased]

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
