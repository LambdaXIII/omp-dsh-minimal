# One-time promotion (first tool call) + auto-reset + cancellation

Promotion (bootstrap→full) happens **once per cycle**, triggered **only by the first tool call** — plain-text replies do not promote. A real-session test showed the initial "first reply or tool call" trigger was too narrow: anchoring only covered the first turn, so the main task ran in the full environment. Restricting promotion to the first tool call keeps the whole thinking/planning phase in the minimal environment.

After promotion the plugin **auto-resets** — there is no persistent switch, and later turns pass through untouched. If the model config stops being pro+High **before** promotion (detected at the next real request), the cycle is **cancelled** and the full tool set restored, so tools never stay stuck minimal.

**Status**: superseded by [ADR-0005](0005-no-promote-minimal-anchoring.md) — 已由「无 promote 极简锚定」取代
