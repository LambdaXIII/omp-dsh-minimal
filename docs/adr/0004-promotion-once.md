# Promotion is one-time, reset on config break

Promotion (bootstrap→full) happens **once per active config**, not every turn — re-anchoring every turn would repeatedly invalidate the KV cache. A break in the activation condition (switch off, model changed, thinking changed) resets promotion, so the next matching turn re-anchors fresh. This bounds the cache cost to single, one-way switches while preserving clean-environment planning for each new pro+High segment of a session.

**Status**: accepted
