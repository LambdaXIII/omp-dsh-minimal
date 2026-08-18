# Two-phase tool anchoring (anchor-then-promote)

DeepSeek V4-Pro 0813's post-training RL overfits to agentic benchmarks, degrading CoT reasoning when the model anchors on a large tool set (`Let me`-style low-quality thinking). We adopt the community-validated two-phase pattern: bootstrap with a minimal persona + minimal tools (bash, edit) so the model completes initial planning in a clean environment, then promote to the full tool set on first tool call or first assistant output. This trades a one-time KV prefix-cache invalidation at promotion for higher reasoning quality on every task — the same tradeoff dsh minimal and pi-deepseek-anchor make.

**Status**: superseded by [ADR-0005](0005-no-promote-minimal-anchoring.md) — 已由「无 promote 极简锚定」取代
