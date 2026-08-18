# Explicit opt-in (one-shot, default inactive)

The bootstrap→full phase switch invalidates the KV prefix cache (the system prompt changes), a real per-session cost. We therefore require an explicit opt-in: `/dspro-boost` (bare command) starts a **one-shot** anchoring cycle that auto-completes on promotion. Nothing anchors without the user asking for it. Because the cycle is one-shot, there is no persistent on/off switch — promotion resets automatically, so the plugin never lingers in an "on but inactive" state.

**Status**: accepted
