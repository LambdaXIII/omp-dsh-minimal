/**
 * dspro-boost — omp extension implementing two-phase tool anchoring.
 *
 * Mitigates DeepSeek V4-Pro CoT overfitting: in the bootstrap phase the model
 * sees only a minimal persona + a minimal tool set (bash, edit), completes its
 * initial planning in a clean environment, then promotes to the full tool set
 * on first tool call or first assistant output. The switch is explicit
 * (`/dspro-boost on|off|status`, default off) because the phase switch breaks
 * KV prefix caching; `on` also conveniently sets model/thinking to V4-Pro/High.
 *
 * Design: docs/design/anchor-plugin.md
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const DEBUG = process.env.PI_ANCHOR_DEBUG === "1";

function log(message: string): void {
  if (DEBUG) console.error(`[dspro-boost] ${message}`);
}

/** Minimal tool set exposed during the bootstrap (anchored) phase. */
const ANCHOR_TOOLS = ["bash", "edit"];

/** dsh minimal persona, verbatim from DeepSeek Harness. */
const MINIMAL_PERSONA = "You are a helpful software engineer assistant.";

export default function dsproBoost(pi: ExtensionAPI): void {
  // User switch: whether anchoring is allowed at all. Default off.
  let enabled = false;
  // Phase state: false = bootstrap (anchored, not yet promoted); true = full.
  // Once true it stays true for the session's active model configuration.
  let promoted = false;
  // The model/thinking config under which promotion happened (for reset logic).
  let promotedConfig: string | undefined;

  const currentConfigKey = (_ctx: unknown): string | undefined => {
    // TODO: build a stable key from current model id + thinking level.
    return undefined;
  };

  const renderWidget = (): void => {
    // TODO: component-factory widget (theme.fg green/red).
    // Skeleton: no-op until the theme/widget API is confirmed.
  };

  pi.registerCommand("dspro-boost", {
    description: "Two-phase tool anchoring for DeepSeek V4-Pro CoT overfitting. Usage: /dspro-boost on|off|status",
    handler: async (args, ctx) => {
      const cmd = (args.trim().split(/\s+/)[0] ?? "").toLowerCase();
      if (cmd === "on") {
        enabled = true;
        promoted = false;
        promotedConfig = undefined;
        // Convenience only: set model/thinking to V4-Pro/High. Does NOT change
        // the activation logic (still requires actual pro+high each turn).
        // TODO: resolve the V4-Pro model via ctx.models.resolve and call
        //       pi.setModel(model); pi.setThinkingLevel("high").
        ctx.ui.notify("dspro-boost: on", "info");
        log("switch on");
      } else if (cmd === "off") {
        enabled = false;
        // TODO: tear down widget; stop intercepting.
        ctx.ui.notify("dspro-boost: off", "info");
        log("switch off");
      } else {
        // status
        ctx.ui.notify(
          `dspro-boost: ${enabled ? "on" : "off"} · phase=${promoted ? "full" : "bootstrap"}`,
          "info",
        );
      }
      renderWidget();
    },
  });

  // Per-turn decision point: if enabled and the model config matches pro+High,
  // anchor (bootstrap) unless already promoted; otherwise pass through.
  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled) return;
    const key = currentConfigKey(ctx);
    if (!key) return; // config not matching (or undetermined) → pass through
    if (promoted && promotedConfig === key) return; // already full for this config

    // TODO: if !promoted → return { systemPrompt: [MINIMAL_PERSONA] } and
    //       await pi.setActiveTools(ANCHOR_TOOLS). On first promote signal,
    //       restore full tools (await pi.setActiveTools(fullNames)) and stop
    //       returning the override so omp restores the full base prompt.
    log(`before_agent_start: config=${key} promoted=${promoted}`);
    void event;
  });

  // Promote signals: first tool call or first assistant output.
  pi.on("tool_call", async (event, _ctx) => {
    if (!enabled || promoted) return;
    // TODO: promote once — restore full tools, set promoted=true.
    log(`tool_call promote signal: ${event.toolName}`);
  });

  pi.on("message_end", async (_event, _ctx) => {
    if (!enabled || promoted) return;
    // TODO: promote once on first assistant output.
    log("message_end promote signal");
  });

  pi.on("session_start", async (_event, _ctx) => {
    // TODO: restore switch state from persisted entry (appendEntry) and
    //       render the widget.
    log(`session_start: anchor=[${ANCHOR_TOOLS.join(",")}] persona="${MINIMAL_PERSONA}"`);
    renderWidget();
  });
}
