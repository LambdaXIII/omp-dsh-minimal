### Verification

**禁止自动启动真实 omp 会话做验证**（`omp -p`、交互会话、`hub start` 等都会触发真实模型调用，产生费用）。改动的验证只用：

- 单元测试：`bun test`（`test/core.test.ts` 覆盖纯逻辑）
- 静态检查：`bunx tsc --noEmit`

任何需要启动 omp 会话的运行时验证，必须先征得用户明确同意（注明会消耗模型 token）。
