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
 * Activation: enabled (switch) AND current model is DeepSeek V4 Pro AND
 * thinking level is High. A break in any condition resets promotion.
 *
 * Design: docs/design/anchor-plugin.md
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";

const DEBUG = process.env.PI_ANCHOR_DEBUG === "1";

/** Minimal tool set exposed during the bootstrap (anchored) phase. */
const ANCHOR_TOOLS = ["bash", "edit"];

/** dsh minimal persona, verbatim from DeepSeek Harness. */
const MINIMAL_PERSONA = "You are a helpful software engineer assistant.";

/** Matches DeepSeek V4 Pro model ids (activation condition). */
const PRO_MODEL_PATTERN = /deepseek[^/]*[\/:]?(?:deepseek-)?v4-?pro(?:[:/]|$)/i;

function log(message: string): void {
  if (DEBUG) console.error(`[dspro-boost] ${message}`);
}

type WidgetState = "off" | "active" | "inactive";

export default function dsproBoost(pi: ExtensionAPI): void {
  // User switch: whether anchoring is allowed at all. Default off.
  let enabled = false;
  // Phase state: false = bootstrap (anchored, not yet promoted); true = full.
  let promoted = false;
  // Snapshot of the full tool set taken before anchoring, restored on promote.
  let fullTools: string[] | undefined;
  // Last widget state (active = switch on AND config matches pro+High).
  let widgetState: WidgetState = "off";

  /** Whether the current model + thinking level match the pro+High condition. */
  const isActive = (ctx: { models?: unknown }): boolean => {
    if (!enabled) return false;
    const model = (ctx.models as { current?: () => { id?: string; name?: string } | undefined } | undefined)
      ?.current?.();
    const modelId = model?.id ?? model?.name ?? "";
    const isPro = PRO_MODEL_PATTERN.test(modelId);
    const isHigh = pi.getThinkingLevel() === ThinkingLevel.High;
    const active = isPro && isHigh;
    log(`isActive: enabled=${enabled} model="${modelId}" pro=${isPro} high=${isHigh} -> ${active}`);
    return active;
  };

  const renderFor = (ctx: { ui: { setWidget: unknown } }): void => {
    if (!enabled) {
      (ctx.ui as { setWidget(key: string, content: unknown): void }).setWidget("dspro-boost", undefined);
      return;
    }
    const color = widgetState === "active" ? "green" : "red";
    const label = widgetState === "active" ? "boost: active" : "boost: inactive";
    (ctx.ui as { setWidget(key: string, content: unknown, opts?: unknown): void }).setWidget(
      "dspro-boost",
      (_tui: unknown, theme: { fg: (color: string, text: string) => unknown }) => {
        // Plain-text widget until the theme component API is confirmed.
        return theme.fg(color, label);
      },
      { placement: "aboveEditor" },
    );
  };

  pi.registerCommand("dspro-boost", {
    description: "Two-phase tool anchoring for DeepSeek V4-Pro CoT overfitting. Usage: /dspro-boost on|off|status",
    handler: async (args, ctx) => {
      const cmd = (args.trim().split(/\s+/)[0] ?? "").toLowerCase();
      if (cmd === "on") {
        enabled = true;
        promoted = false;
        fullTools = undefined;
        // Convenience only: set model/thinking to V4-Pro/High. Does NOT change
        // the activation logic (still requires actual pro+High each turn).
        const models = ctx.models as { resolve?: (spec: string) => unknown };
        let resolved: unknown;
        for (const spec of ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro:high"]) {
          resolved = models.resolve?.(spec);
          if (resolved) break;
        }
        if (resolved) {
          await (pi.setModel as (m: unknown) => Promise<boolean>)(resolved);
        } else {
          log("on: could not resolve a V4-Pro model; leaving model as-is");
        }
        pi.setThinkingLevel(ThinkingLevel.High);
        ctx.ui.notify("dspro-boost: on (model/thinking set to V4-Pro/High)", "info");
        renderFor(ctx);
      } else if (cmd === "off") {
        enabled = false;
        promoted = false;
        ctx.ui.notify("dspro-boost: off", "info");
        renderFor(ctx);
      } else {
        ctx.ui.notify(
          `dspro-boost: ${enabled ? "on" : "off"} · phase=${promoted ? "full" : "bootstrap"}`,
          "info",
        );
      }
    },
  });

  // Per-turn decision point. Active config + not yet promoted → anchor.
  // Promoted → pass through (omp restores the full base prompt + tools).
  // Config break → reset promotion.
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!isActive(ctx)) {
      if (promoted) {
        promoted = false;
        log("config break: promotion reset");
      }
      renderFor(ctx);
      return;
    }
    if (promoted) {
      renderFor(ctx);
      return;
    }
    // Bootstrap: snapshot full tools, cut to minimal, override persona.
    if (!fullTools) fullTools = pi.getActiveTools();
    log(`anchoring: ${fullTools.length} tools -> [${ANCHOR_TOOLS.join(",")}]`);
    await pi.setActiveTools(ANCHOR_TOOLS);
    renderFor(ctx);
    return { systemPrompt: [MINIMAL_PERSONA] };
  });

  // Promote signals: first tool call or first assistant output.
  const promote = async (source: string): Promise<void> => {
    if (!enabled || promoted) return;
    promoted = true;
    if (fullTools) {
      log(`promoting (${source}): restoring ${fullTools.length} tools`);
      await pi.setActiveTools(fullTools);
    }
    widgetState = "active";
  };

  pi.on("tool_call", async (event, ctx) => {
    await promote(`tool_call:${event.toolName}`);
    renderFor(ctx);
  });

  pi.on("message_end", async (_event, ctx) => {
    await promote("message_end");
    renderFor(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    // TODO: restore switch state from persisted entry (appendEntry).
    log(`session_start: enabled=${enabled} promoted=${promoted}`);
    renderFor(ctx);
  });
}
