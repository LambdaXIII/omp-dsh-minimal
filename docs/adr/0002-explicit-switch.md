# Explicit on/off switch (default off)

The bootstrap→full phase switch invalidates the KV prefix cache (the system prompt changes), a real per-session cost. We therefore expose an explicit `/dspro-boost on|off|status` switch defaulting to **off**, rather than silently enabling anchoring. The user must opt in knowingly; the switch is the gate, the activation condition (ADR-0003) is the trigger. Enabling never happens without the user asking for it.

**Status**: accepted
