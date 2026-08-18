# omp-dsh-minimal

DeepSeek Harness **minimal mode** for omp: a clean persona plus only `bash` and `str_replace_editor` — mitigates DeepSeek V4-Pro CoT overfitting.

## Why

DeepSeek V4-Pro's CoT overfits to its training distribution: once it enters a `Let me`-style reasoning chain, inference quality collapses. dsh minimal (DeepSeek Harness's minimal preset) demonstrates that a minimal environment produces clean `We need`-style reasoning (official benchmark 99/96 vs 91/92 full). omp has no such mode; this extension adds it.

**Key constraint (ablation-tested, 2026-08-18)**: mentioning tool text — tool names, descriptions, or schemas in messages, even when not callable — breaks `We need` and triggers the model to call non-callable tools. The minimal environment must stay **zero tool text**. This extension therefore injects no tool schema and no tool mentions.

## Install

There is no config-identifier auto-install (writing a name in a config file and having it fetched) — installs happen through `omp plugin` (identifier-based CLI) or by placing the extension module where discovery finds it. Extensions are TS/JS modules exporting a default factory (`export default function (pi: ExtensionAPI) {}`). Prerequisites: `omp` and `bun`; runtime dependencies are transitively covered via `@oh-my-pi/pi-coding-agent` (a single `bun install` fetches everything).

```bash
git clone https://github.com/LambdaXIII/omp-dsh-minimal ~/omp-dsh-minimal
cd ~/omp-dsh-minimal && bun install
```

**Option A: `omp plugin` (recommended)**

omp ships a plugin distribution system (`omp plugin install/uninstall/list/upgrade/marketplace`) — installs by identifier into `~/.omp/plugins/`; the extension entry is auto-discovered via `getAllPluginExtensionPaths`, no configuration needed:

```bash
omp plugin install github:LambdaXIII/omp-dsh-minimal
# pin a commit: omp plugin install "github:LambdaXIII/omp-dsh-minimal#<commit>"
```

Supported identifier forms: npm package names (`@oh-my-pi/exa`), `name@marketplace`, `github:user/repo`, `https://github.com/user/repo#v1.0`, local paths (linked). `omp plugin marketplace add <source>` registers a custom marketplace. This repository is a plugin-package (`package.json` declares `"omp": { "extensions": [...] }`; runtime deps live in `dependencies` so npm/bun installs work).

> Note: `github:user/repo` without a commit relies on bun's branch-resolution cache and can occasionally resolve an outdated commit — pin with `#<commit>` or run `omp plugin upgrade` if so.

**Option B: config.yml path**

```yaml
# ~/.omp/agent/config.yml (or <project>/.omp/config.yml)
extensions:
  - ~/omp-dsh-minimal
```

**Reference**:
- Disable individually: `disabledExtensions: [extension-module:<name>]` (name from path: `foo.ts` → `foo`, `foo/index.ts` → `foo`)
- Load order: auto-discovery → hook factories → plugin package entries → explicitly configured paths; deduplicated by absolute path, first wins
- Extensions are the unified system (events + tools + commands + renderers); hooks are the legacy event API, custom-tools are tool-only modules — build plugins on the extension system
- Extensions are not sandboxed and share the process; during factory load you may only register, runtime behavior goes in events/commands/tools

## Quick Start

| Command | Behavior |
|---|---|
| `/dsh-minimal` | Enable minimal mode (convenience: sets V4-Pro/High; any model becomes minimal once enabled) |
| `/dsh-minimal off` | Exit (confirm dialog → restore full tools → KV-cache-cost warning) |
| `/dsh-minimal status` | Show current state |

Typing `/dsh-minimal ` (trailing space) triggers argument completion (`off` / `status` with descriptions).

**Effect**: after enabling, the first request of a new session auto-injects the convention files (`AGENTS.md` text, zero tool text); the model keeps only `bash` + `str_replace_editor`; thinking opens with `We need` and stays decisive across turns. Verified on real DeepSeek V4 Pro: `We need` reproduced, high reasoning quality; the cost is slower turns (convention-text injection).

**Widget**: status bar above the editor — green = `DeepSeek Harness Minimal Mode: Context Injected`, red = `DeepSeek Harness Minimal Mode: Active` (not injected, e.g. enabled mid-session); gone when off. The switch is not persisted (defaults to off per session).

## Mechanism

- **Minimal environment**: every turn injects the clean persona (`You are a helpful software engineer assistant.`) + only 2 tools; no promote, no model monitoring
- **Session-head injection**: first request (no user message in history) injects convention-file text; compaction keeps it via the official hook; handoff/new clears messages and re-injects naturally; **enabling mid-session never injects** (widget stays red)
- **Protocol handling** (at the tool-call interception point): `skill://` `agent://` `artifact://` `memory://` `rule://` `local://` are expanded natively by omp bash (read and write both work); `xd://<tool>` resolves the tool description via `getAllTools()` and returns it; the rest (`mcp://` `issue://` `pr://` `vault://` `omp://` `history://`) fail open to native bash
- **Exit**: after a confirmed off, the full tool snapshot is restored and persona override stops; the next request injects a one-shot exit notice (ignore historical minimal-mode injections)

## Docs

- [Design](docs/design/dsh-minimal.md) (D1-D9, authoritative) · [Testing](docs/design/testing.md) (L1-L3)
- Decision records: `docs/adr/0002` (explicit switch) / `0003` (no activation condition) / `0005` (no promote) / `0006` (protocol handling) / `0007` (injection & exit notice)
- Domain glossary: [CONTEXT.md](CONTEXT.md)
- Spec & user stories: `.scratch/dsh-minimal/spec.md` (local tracker, not published)
- 中文版: [README.zh-CN.md](README.zh-CN.md)

## License

[MIT](LICENSE)

- Slower turns: convention-text injection + minimal environment (per-turn token cost, KV-cache switching)
- Multi-turn hesitation: inherent cost of a zero-context environment (ablation shows injection cannot fix it)
- `mcp://` and similar protocols unavailable in minimal mode (no official read API; fail open to bash errors)
