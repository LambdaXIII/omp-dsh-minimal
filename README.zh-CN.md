# omp-dsh-minimal

DeepSeek Harness **minimal 模式**的 omp 实现：纯净 persona + 仅 `bash` + `str_replace_editor` 两个工具，缓解 DeepSeek V4-Pro 的 CoT 过拟合。

## 为什么

DeepSeek V4-Pro 的 CoT 对训练分布过拟合：进入 `Let me` 式思维链后推理质量崩。dsh minimal（DeepSeek Harness 极简 preset）实证：极简环境产出干净的 `We need` 式推理（第三方评测：xiaobright 自建 Project2 V4.1b 套件上，DeepSeek-V4-Pro 正式版在 DSH minimal 下两跑 99/96、DSH standard 91、DSH PTC 92——小样本观测，非 DeepSeek 官方 benchmark，未被独立复现。[成绩榜](https://github.com/xiaobright/modeltest/blob/main/evaluator/reports/v4.1b_scoreboard.md) / [对照分析](https://github.com/xiaobright/modeltest/blob/main/docs/v4.1/DEEPSEEK_V4_PRO_HARNESS_ANALYSIS_20260814.md)）。omp 无此模式，本插件补上。

**关键约束（ablation 实测，2026-08-18）**：工具文本提及（消息里出现工具名/描述/schema，即使不可调用）破坏 `We need` 并诱发模型直接调用不可调用工具——极简环境必须**零工具文本**。因此本插件不注入工具 schema、不注入工具提及。

## 安装

没有「配置里写个标识就自动安装」的机制——安装通过 `omp plugin`（标识 CLI）或把扩展模块放到发现位置完成。扩展是 TS/JS 模块，导出默认工厂（`export default function (pi: ExtensionAPI) {}`）。前提：已安装 `omp` 与 `bun`；运行时依赖经 `@oh-my-pi/pi-coding-agent` 传递覆盖（一次 `bun install` 装全）。

```bash
git clone https://github.com/LambdaXIII/omp-dsh-minimal ~/omp-dsh-minimal
cd ~/omp-dsh-minimal && bun install
```

**方式一：`omp plugin` 自动安装（推荐）**

omp 有插件分发体系（`omp plugin install/uninstall/list/upgrade/marketplace`）——按标识安装到 `~/.omp/plugins/`，扩展入口经 `getAllPluginExtensionPaths` 自动发现，**无需配置**：

```bash
omp plugin install github:LambdaXIII/omp-dsh-minimal
# 固定版本：omp plugin install "github:LambdaXIII/omp-dsh-minimal#<commit>"
```

支持标识形态：npm 包名（`@oh-my-pi/exa`）、`name@marketplace`、`github:user/repo`、`https://github.com/user/repo#v1.0`、本地路径（link）。`omp plugin marketplace add <source>` 添加自定义市场。本仓库即插件包形态（`package.json` 声明 `"omp": { "extensions": [...] }`，运行时依赖在 `dependencies` 供 npm/bun 安装）。

> 提示：`github:user/repo`（无 commit）依赖 bun 的分支解析缓存，个别情况会拉到旧 commit——遇此用 `#<commit>` 固定或 `omp plugin upgrade`。

**方式二：config.yml 配置路径**

```yaml
# ~/.omp/agent/config.yml（或 <项目>/.omp/config.yml）
extensions:
  - ~/omp-dsh-minimal
```

**参考**：
- 禁用单个：`disabledExtensions: [extension-module:<名字>]`（名字取自路径：`foo.ts` → `foo`，`foo/index.ts` → `foo`）
- 加载顺序：自动发现 → hook 工厂 → 插件包入口 → 显式配置路径；按绝对路径去重，先到先得
- 扩展是统一体系（事件 + 工具 + 命令 + 渲染器）；hook 是遗留事件 API，custom-tools 是纯工具模块——插件用扩展体系
- 扩展不沙箱、与进程同运行；工厂加载期只能注册，运行时行为放事件/命令/工具里

## 快速开始

| 命令 | 行为 |
|---|---|
| `/dsh-minimal` | 查看状态（裸命令 = status，**不开启**） |
| `/dsh-minimal on` / `normal` | 开启极简（normal：完整披露——头部说明 + Internal URLs + xd 协议板块 + AGENTS + APPEND_SYSTEM；便利设 V4-Pro/High；开启后任何模型都极简） |
| `/dsh-minimal pure` | 开启极简（pure：仅 AGENTS，无环境/纪律层） |
| `/dsh-minimal off` | 退出（确认对话框 → 恢复完整工具 → 警告含 KV 缓存代价） |
| `/dsh-minimal status` | 查看状态 + 版本：`off` \| `normal (injected)` \| `normal (not injected)` \| `pure (injected)` \| `pure (not injected)`，外加插件 / 实际 omp / 期望 omp（≥18）版本 |

输入 `/dsh-minimal `（带空格）触发参数补全（`on` / `normal` / `pure` / `off` / `status` + 说明）。

**效果**：开启后新会话首轮按模式注入披露——normal 注入完整披露（头部 + `# Internal URLs` + xd 协议板块 + AGENTS + APPEND_SYSTEM，全部复用 omp 自身渲染，零工具文本）；pure 仅注入 AGENTS（无环境/纪律层）。模型全程只有 `bash` + `str_replace_editor`（例外见下「inspect_image」小节），thinking 开头呈 `We need` 式，多轮不纠结。已实测（真实 DeepSeek V4 Pro）：We need 复现、思考质量高；代价是速度较慢（披露注入）。

**widget**：编辑器上方状态条——绿 = `DeepSeek Harness Minimal Mode: Context Injected`（normal 已注入）、蓝 = `DeepSeek Harness Minimal Mode: Pure`（pure 已注入）、红 = `DeepSeek Harness Minimal Mode: Active`（任一模开启但未注入，如中途开启）；off 消失。开关不持久化（session 重启默认关）。

## 使用要点：`inspect_image` 留在极简工具集

omp 会对「无原生图像输入的模型」强制激活 `inspect_image`：默认 `inspect_image.mode: auto` 恰在 `model.input` 不含 `"image"` 时暴露它，且 omp 的 `reconcileInspectImageTool` 在每次模型/设置变化时重加回它，**无视 `setActiveTools`**。DeepSeek V4 模型无图像输入，因此极简模式下**实际工具集是 `bash`、`str_replace_editor` 和 `inspect_image`**——并非本 README 声明的那两个。插件无法移除它（扩展 API 无法设置 `inspect_image.mode`）。想移除需全局设置：

```yaml
# ~/.omp/agent/config.yml
inspect_image:
  mode: off
```

披露契约（normal / pure 各自注入什么）见 `docs/adr/0009-mode-disclosure-contract.md`。

## 机制

- **极简环境**：开启期间每轮注入纯净 persona（`You are a helpful software engineer assistant.`）+ `bash` + `str_replace_editor`（+ 模型无图像能力时 omp 强制的 `inspect_image`，见上）；无 promote、无模型监测
- **会话头部披露**：首轮（历史无用户消息）按模式注入披露——normal = 头部 + Internal URLs + xd 协议板块 + AGENTS + APPEND_SYSTEM，pure = 仅 AGENTS；全部复用 omp 渲染（`getSystemPrompt()`），嵌套项目得到完整 AGENTS walk-up；compact 经官方钩子保留；handoff/new 消息清空后自然重注入；**中途开启不注入**（widget 红如实反映）
- **协议处理**（工具调用拦截点）：`skill://` `agent://` `artifact://` `memory://` `rule://` `local://` 由 omp bash 原生展开（读写都工作）；`xd://<tool>` 经 `getAllTools()` 解析工具描述返回；其余（`mcp://` `issue://` `pr://` `vault://` `omp://` `history://`）fail-open 放行原生
- **退出**：off 确认后恢复完整工具快照 + persona 停止覆盖；下一轮向模型注入一次性退出告知（忽略历史极简注入）

## 文档

- [设计](docs/design/dsh-minimal.md)（D1-D9，权威规格）· [测试方法](docs/design/testing.md)（L1-L3）
- 决策记录：`docs/adr/0002`（极简开关）/`0003`（无激活条件）/`0005`（无 promote）/`0006`（协议处理）/`0007`（注入与退出告知）/`0008`（双模式 pure/normal）/`0009`（披露内容契约）
- 领域术语：[CONTEXT.md](CONTEXT.md)
- 规格与用户故事：`.scratch/disclosure-and-status/spec.md`（本地 tracker，不发布）
- English: [README.md](README.md)

## 许可证

[MIT](LICENSE)

## 已知限制

- 速度较慢：注入披露全文 + 极简环境（单轮 token 成本、KV 缓存切换代价）
- 多轮持续犹豫：零上下文环境的模型固有代价（ablation 实证非注入可解）
- `mcp://` 等协议在极简环境不可用（无官方读取 API，fail-open 由 bash 报错）
- 极简工具集实为 `bash` + `str_replace_editor` + `inspect_image`（deepseek 无图像时 omp 强制，见「使用要点」小节；`inspect_image.mode: off` 可移除）
