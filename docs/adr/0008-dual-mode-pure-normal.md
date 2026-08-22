# 双模式开关（pure / normal）

极简开关从单值升级为三态 `off | normal | pure`，命令集对应扩展。**normal**（`/dsh-minimal on` / `normal`）会话头部披露环境信息 + 约定（见 ADR-0009），零工具文本。**pure**（`/dsh-minimal pure`）极简环境（纯净 persona + `bash` + `str_replace_editor`）**仅注入 AGENTS 约定，不披露环境/纪律层**，供仅需简单问答、省去环境披露 token 开销的场景。两模式披露内容见 ADR-0009。**`/dsh-minimal` 裸命令 = status**（查看状态，不自动开启）——开启必须显式 `on`/`normal`/`pure`。

**两模式差异 = 是否披露环境/纪律层**：normal 披露 [Internal URLs + xd 板块 + APPEND_SYSTEM] + AGENTS；pure 仅 AGENTS（约定两模式都注入，机制见 ADR-0007，内容见 ADR-0009）。便利设模型（V4-Pro/High）、退出流程、协议映射（ADR-0006）、退出告知（ADR-0007）两模式一致。pure 开关独立——只影响未来动作，历史已注入内容不撤销。

**状态机**：`minimalEnabled`(bool) 升级为三态 `off | normal | pure`；`on`/`normal` → `normal`，`pure` → `pure`，裸命令/`status` → status（查看，不改变模式），`off` → 退出（确认框 → 恢复工具 → KV 警告 → 退出告知）。

**widget 反映模式与注入态**：off 无；绿 = normal 已注入；蓝 = pure 已注入；红 = 任一模式开启但未注入（未命中会话头部）。

**`status` 保留**，展示 `off` | `normal (injected)` | `normal (not injected)` | `pure (injected)` | `pure (not injected)`，并披露插件版本、实际 omp 版本（`pi.VERSION`）、期望 omp 版本（≥18）——单行纯展示，无行为区分。completion 增补 `pure`/`normal`。

**理由**：pure 满足「仅简单问答」的轻量场景——不披露环境/纪律层（Internal URLs / xd 板块 / APPEND_SYSTEM）省 token，但 AGENTS 约定仍注入（约定可用性，与 normal 共享）；normal 额外披露环境信息以对齐 omp 环境一致性（ADR-0009）。二者不互斥，用户按需显式选择。`on` 作为 `normal` 的显式别名（对称于 `off`）；**裸命令改为 status**——查看状态不自动开启，避免误触开启，开启需显式选择模式。

**Status**: accepted（ADR-0002 极简开关的扩展，0002 保留为历史并交叉引用）
