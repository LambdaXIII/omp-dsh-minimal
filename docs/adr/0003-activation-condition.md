# Activation limited to DeepSeek V4 Pro + thinking High

Anchoring only activates when the current model is **DeepSeek V4 Pro** and the thinking level is **High** — the configuration where CoT overfitting is worst. Other models or configs pass through untouched. `/dspro-boost on` conveniently sets the model/thinking to V4-Pro/High, but this is convenience only: activation still requires the actual pro+High condition each turn, and if the user later changes the model or thinking, anchoring simply deactivates (the widget shows red). This keeps the two control layers separate — the switch is the user's willingness, the condition is the automatic trigger.

**Status**: accepted
