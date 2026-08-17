# 测试计划 — dspro-boost 插件验证

> 目的：锚定插件的验证方法，让任何人（包括未来的会话）能按本文档复现测试。用户亲自执行 L3；L1/L2 由 agent 完成。

## 1. 局部引入 omp 的方式（不污染全局配置）

插件**不安装**到用户级 `~/.omp/agent/extensions/`。局部引入方式：

**推荐 · 显式路径加载**（每次启动时传入，只影响本次会话）：

```bash
cd <项目目录>/omp-deepseekpro-booster
omp --extension ./src/index.ts
```

- `--extension`（`-e`）加载指定入口，不写任何配置、不污染全局
- 相对路径按当前 cwd 解析；`.ts` 直接支持（Bun 加载）
- 项目仓库目录可用 `.scratch/` 之外的任何位置；插件目录与 omp 会话目录无需相同

**备选 · 项目级配置**（持久，但只在该项目目录启动时生效）：

```yaml
# <cwd>/.omp/config.yml
extensions:
  - <项目目录>/src/index.ts
```

**排除项**：不放进 `~/.omp/agent/extensions/`（污染用户级）；不用 `omp plugin link` 安装（除非要发布）。

## 2. 插件内置 log 机制

插件**不打控制台**（会破坏 TUI），全部走 `pi.logger` → omp 文件日志：

- **位置**：`~/.omp/logs/omp.<日期>.<pid>.log`
- **查看**：`tail -f ~/.omp/logs/omp.$(date +%F).*.log | grep dspro-boost`

**两级输出**：

| 级别 | 内容 | 何时写 |
|---|---|---|
| `info`（常开） | 关键事件：`switch on/off`、`anchoring: N tools -> [bash,edit]`、`promoting (tool_call:bash): restoring N tools`、`config break: promotion reset`、`session_start` | 总是写入日志 |
| `debug`（开关） | 细节：`isActive: enabled=… model="…" pro=… high=… -> …`、model resolve 失败 | 仅 `PI_ANCHOR_DEBUG=1` 时写入 |

```bash
# 开 debug 细节
PI_ANCHOR_DEBUG=1 omp --extension ./src/index.ts
```

## 3. 观察指标清单（启动后看什么）

| # | 指标 | 从哪看 | 期望（插件正常时） |
|---|---|---|---|
| 1 | 插件加载成功 | 日志（扩展加载） | 无 load error |
| 2 | 开关状态 | `/dspro-boost status` 或 widget | on/off 与操作一致 |
| 3 | 激活条件 | 日志 `isActive`（debug）或 widget | 条件符合时 active（绿） |
| 4 | 锚定期 systemPrompt | 日志 `anchoring` 附近 / 请求观察 | 纯净 persona `You are a helpful…` |
| 5 | 锚定期工具目录 | 日志 `anchoring: N tools -> [bash,edit]` | 实际只有 `bash` + `edit` |
| 6 | promote 触发 | 日志 `promoting (…)` | 首个 tool_call 或 message_end 触发一次 |
| 7 | promote 后工具恢复 | 日志 `restoring N tools` | 完整工具集恢复 |
| 8 | 推理风格 | 对话输出 | 锚定期 `We need` 式干净推理（非 `Let me`） |
| 9 | 耗时 | 任务完成时间 | 与关闭时对比，记录 KV 缓存代价 |

## 4. L1 · 单元测试（agent 完成，必做）

- **范围**：纯逻辑——激活条件判定（模型 id 匹配 pro、thinking==High）、阶段转换（bootstrap→promoted→config-break 重置）、promote 一次性
- **方法**：bun test（`bun test`）
- **前提工作**：当前逻辑闭包在扩展工厂内，需抽取为可测纯函数（如 `isProAndHigh(modelId, thinkingLevel)`、阶段状态机 reducer），工厂只做接线
- **验证点**：每种判定分支、阶段转换的确定性输出

## 5. L2 · 冒烟测试（agent 完成，必做）

在真实 omp 会话（无需真实模型）验证插件能跑：

1. `omp --extension ./src/index.ts` 启动，确认无加载错误（日志）
2. `/dspro-boost status` → 反馈 `off`（默认）
3. `/dspro-boost on` → notify 反馈 + widget 出现（boost: inactive 红色，因模型非 pro）
4. `/dspro-boost off` → widget 消失
5. 会话内无异常（无 uncaught exception、session 不崩）

## 6. L3 · 效果验证（用户执行，必做一次）

真实 DeepSeek 会话，**开插件 vs 关插件**跑同一任务，回答「效果更好吗」。

**准备**：
- 真实 API key + DeepSeek V4 Pro 可用；thinking 设为 High
- 记录会话起始时间

**对照步骤**：
1. **关插件**：正常 `omp` 启动（不带 --extension），跑一个中等复杂度任务（如「修这个 bug」），记录：任务耗时、观察首条 thinking 开头是 `Let me` 还是 `We need`
2. **开插件**：`omp --extension ./src/index.ts`，`/dspro-boost on`（自动设 pro+high），跑**同一任务**，记录：任务耗时、thinking 开头、日志中锚定/promote 事件
3. 对比两张表：

| 指标 | 关 | 开 | 差异 |
|---|---|---|---|
| thinking 开头（Let me / We need） | | | |
| 锚定期实际工具数 | — | | |
| promote 触发时机 | — | | |
| 任务耗时 | | | |
| 结果质量（主观 1-5） | | | |

**通过标准（建议）**：开插件时 thinking 开头变为 `We need` 式干净推理、任务质量不降、耗时增加可接受（KV 缓存一次性代价）。

**记录**：结果写回本文件（追加「L3 实测记录」节），或记入 `.scratch/`。

## 7. 测试顺序与依赖

1. 先 L1（逻辑正确）→ 2. L2（能跑起来）→ 3. L3（效果）。L1/L2 通过前不花真实模型钱。
