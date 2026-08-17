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
 * Design: docs/design/anchor-plugin.md · ADRs: docs/adr/0001-0004
 * Testing: docs/design/testing.md
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Container, Text } from "@oh-my-pi/pi-tui";

const DEBUG = process.env.PI_ANCHOR_DEBUG === "1";

/** Minimal tool set exposed during the bootstrap (anchored) phase. */
const ANCHOR_TOOLS = ["bash", "edit"];

/** dsh minimal persona, verbatim from DeepSeek Harness. */
const MINIMAL_PERSONA = "You are a helpful software engineer assistant.";

/** Matches DeepSeek V4 Pro model ids (activation condition). */
const PRO_MODEL_PATTERN = /deepseek[^/]*[\/:]?(?:deepseek-)?v4-?pro(?:[:/]|$)/i;

type WidgetState = "off" | "active" | "inactive";

export default function dsproBoost(pi: ExtensionAPI): void {
  // Logging: key events always land in the omp file log (~/.omp/logs/omp.*.log)
  // via pi.logger (console output would corrupt the TUI). Detail lines only
  // when PI_ANCHOR_DEBUG=1.
  const log = (message: string): void => {
    pi.logger.info(`[dspro-boost] ${message}`);
  };
  const debug = (message: string): void => {
    if (DEBUG) pi.logger.debug(`[dspro-boost] ${message}`);
  };

  // User switch: whether anchoring is allowed at all. Default off.
  let enabled = false;
  // Phase state: false = bootstrap (anchored, not yet promoted); true = full.
  let promoted = false;
  // Snapshot of the full tool set taken before anchoring, restored on promote.
  let fullTools: string[] | undefined;
  // Last widget state (active = switch on AND config matches pro+High).
  let widgetState: WidgetState = "off";

  /** Whether the current model + thinking level match the pro+High condition. */
  const isActive = (ctx: ExtensionContext): boolean => {
    if (!enabled) return false;
    const model = ctx.models.current();
    const modelId = model?.id ?? model?.name ?? "";
    const isPro = PRO_MODEL_PATTERN.test(modelId);
    const isHigh = pi.getThinkingLevel() === ThinkingLevel.High;
    const active = isPro && isHigh;
    debug(`isActive: enabled=${enabled} model="${modelId}" pro=${isPro} high=${isHigh} -> ${active}`);
    return active;
  };

  /** Renders the persistent status widget above the editor (or removes it). */
  const renderFor = (ctx: ExtensionContext): void => {
    if (!enabled) {
      ctx.ui.setWidget("dspro-boost", undefined);
      return;
    }
    const color = widgetState === "active" ? "success" : "error";
    const label = widgetState === "active" ? "boost: active" : "boost: inactive";
    ctx.ui.setWidget(
      "dspro-boost",
      (_tui, theme) => {
        const container = new Container();
        container.addChild(new Text(theme.fg(color, label), 1, 0));
        return container;
      },
      { placement: "aboveEditor" },
    );
  };

  pi.registerCommand("dspro-boost", {
    description:
      "Two-phase tool anchoring for DeepSeek V4-Pro CoT overfitting. Usage: /dspro-boost on|off|status",
    handler: async (args, ctx) => {
      const cmd = (args.trim().split(/\s+/)[0] ?? "").toLowerCase();
      if (cmd === "on") {
        enabled = true;
        promoted = false;
        fullTools = undefined;
        // Convenience only: set model/thinking to V4-Pro/High. Does NOT change
        // the activation logic (still requires actual pro+High each turn).
        let resolved;
        for (const spec of ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro:high"]) {
          resolved = ctx.models.resolve(spec);
          if (resolved) break;
        }
        if (resolved) {
          await pi.setModel(resolved);
        } else {
          debug("on: could not resolve a V4-Pro model; leaving model as-is");
        }
        pi.setThinkingLevel(ThinkingLevel.High);
        log("switch on");
        ctx.ui.notify("dspro-boost: on (model/thinking set to V4-Pro/High)", "info");
        renderFor(ctx);
      } else if (cmd === "off") {
        enabled = false;
        promoted = false;
        log("switch off");
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
