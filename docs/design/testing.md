# 测试计划 — omp-dsh-minimal 插件验证

> 目的：极简环境插件的验证方法，让任何人（包括未来的会话）能按本文档复现测试。用户亲自执行 L3；L1/L2 由 agent 完成。

## 1. 局部引入 omp 的方式（不污染全局配置）

插件**不安装**到用户级 `~/.omp/agent/extensions/`。局部引入方式：

```bash
cd <项目目录>/omp-dsh-minimal
omp --extension ./src/index.ts
```

- `--extension`（`-e`）加载指定入口，不写任何配置、不污染全局
- 相对路径按当前 cwd 解析；`.ts` 直接支持（Bun 加载）

## 2. 插件内置 log 机制

插件**不打控制台**（会破坏 TUI），全部走 `pi.logger` → omp 文件日志：

- **位置**：`~/.omp/logs/omp.<日期>.<pid>.log`
- **查看**：`tail -f ~/.omp/logs/omp.$(date +%F).*.log | grep dsh-minimal`

| 级别 | 内容 | 何时写 |
|---|---|---|
| `info`（常开） | 关键事件：`switch on`、`minimal tools active`、`injected: systemPrompt`、`switch off (confirmed)`、`exit notice injected`、`protocol dispatch: <verb> <protocol>` | 总是写入 |
| `debug`（开关） | 细节：模型/thinking 便利设置、注入摘要、协议检测命中/放行 | 仅 `PI_ANCHOR_DEBUG=1` |

## 3. 观察指标清单

| # | 指标 | 从哪看 | 期望 |
|---|---|---|---|
| 1 | 插件加载成功 | 日志 | 无 load error |
| 2 | 开关状态 | `/dsh-minimal status` 或 widget | 与操作一致 |
| 3 | 极简工具目录 | 日志 `minimal tools active` / 请求观察 | 实际只有 `bash` + `str_replace_editor` |
| 4 | persona | 请求观察 | 纯净 persona `You are a helpful…` |
| 5 | 注入 | 日志 `injected` / 请求观察 | 会话头部一轮：约定文件原文（AGENTS.md），**无工具提及** |
| 6 | 协议映射 | 日志 `protocol dispatch` | `cat local://` 等被委托原生工具；无协议命令放行 |
| 7 | 退出 | 日志 `switch off` | 确认对话框、工具恢复、下一轮退出告知 |
| 8 | 推理风格 | 对话输出 | 极简期 `We need` 式干净推理（L3） |
| 9 | widget | TUI | 完整描述句文案，绿/红反映注入状态 |

## 4. L1 · 单元测试（agent 完成，必做）

- **范围**：纯逻辑（`src/core.ts` seam）——命令解析 `parseCommand`（裸命令→normal、`on`/`normal`→normal、`pure`→pure、`off`→exit、`status`→status、未知词→unknown、多余参数仅取首词）、注入判定 `shouldInjectConventions`（normal→true，pure/off→false）、会话头部状态机（session_start/switch(handoff|new) 重置、请求消费、fork/compact 保持）、`detectProtocol`（各协议串识别、无协议、畸形输入）、`mapVerbToTool`（动词×协议矩阵、无映射放行）、退出状态机（off→确认→恢复→告知标记）
- **方法**：bun test（`bun test`）
- **验证点**：每种判定分支、矩阵组合、状态转换的确定性输出

## 5. L2 · 冒烟测试（agent 完成，必做）

真实 omp 会话（无需真实模型）：

1. `omp --extension ./src/index.ts` 启动，无加载错误
2. `/dsh-minimal status` → 默认关闭
3. `/dsh-minimal` → 极简环境 + widget 出现（红=未注入）；`/dsh-minimal on`、`/dsh-minimal normal` 行为一致；`/dsh-minimal pure` → 蓝 widget、不注入
4. 发消息 → 注入完成（widget 绿）、工具卸载、模型回复
5. 构造 bash 协议调用（`cat local://x`）→ 委托原生工具 → 结果返回
6. `/dsh-minimal off` → 确认对话框、工具恢复、widget 消失、下一轮退出告知（从 normal 或 pure 均一致）
7. 会话无异常

## 6. L3 · 效果验证（用户执行，必做一次）

真实 DeepSeek 会话，**开插件 vs 关插件**跑同一任务，回答「效果更好吗」。

**对照步骤**：
1. **关插件**：正常 `omp` 启动，跑中等复杂度任务，记录：耗时、thinking 开头（`We need` / `Let me`）
2. **开插件**：`omp --extension ./src/index.ts`，`/dsh-minimal`，跑同一任务，记录：耗时、thinking 开头、注入内容、协议使用
3. 对比：

| 指标 | 关 | 开 | 差异 |
|---|---|---|---|
| thinking 开头（We need / Let me） | | | |
| 极简期实际工具数 | — | | |
| 注入体积（系统约定） | — | | |
| 任务耗时 | | | |
| 结果质量（主观 1-5） | | | |

**通过标准（建议）**：开插件时 thinking 开头为 `We need` 式干净推理、任务质量不降、耗时增加可接受（KV 一次性代价 + 注入体积）。

**记录**：结果写回本文件（追加「L3 实测记录」节）或 `.scratch/`。

## 7. 测试顺序

L1 → L2 → L3。L1/L2 通过前不花真实模型钱。
