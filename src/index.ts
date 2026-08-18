/**
 * dspro-boost — omp extension implementing one-shot two-phase tool anchoring.
 *
 * This file is the WIRING layer only: it connects the pure logic in ./core
 * (the unit-test seam) to omp events and commands. All behavior decisions
 * (activation, cycle, promote) live in ./core.
 *
 * One-shot model: a bare `/dspro-boost` starts one anchoring cycle — minimal
 * persona + minimal tools (bash, edit) for the thinking phase, then promote to
 * the full tool set on the FIRST TOOL CALL and auto-reset. Cancellation
 * (config no longer pro+High, detected at the next real request) restores the
 * full tool set. Explicit opt-in because the phase switch breaks KV caching.
 *
 * Design: docs/design/anchor-plugin.md · ADRs: docs/adr/0001-0004
 * Testing: docs/design/testing.md
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Container, Text } from "@oh-my-pi/pi-tui";
import {
  ANCHOR_TOOLS,
  MINIMAL_PERSONA,
  AnchorCycle,
  isProAndHigh,
  shouldAnchor,
} from "./core";

const DEBUG = process.env.PI_ANCHOR_DEBUG === "1";

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

  // Snapshot of the full tool set taken at anchor time, restored on promote or
  // cancellation so tools never stay stuck minimal.
  let fullTools: string[] | undefined;
  // Last widget state.
  let widgetState: WidgetState = "off";
  // One-shot anchoring cycle (ADR-0004, D6/D7/D8).
  const cycle = new AnchorCycle();

  /** Whether the activation condition (ADR-0003) currently holds. */
  const isActive = (ctx: ExtensionContext): boolean => {
    const model = ctx.models.current();
    const modelId = model?.id ?? model?.name;
    const level = pi.getThinkingLevel();
    const active = isProAndHigh(modelId, level);
    debug(`isActive: model="${modelId}" thinking=${level} -> ${active}`);
    return active;
  };

  /** Restore the full tool set (promote or cancellation) and clear the snapshot. */
  const restoreTools = async (reason: string): Promise<void> => {
    if (fullTools) {
      log(`restoring ${fullTools.length} tools (${reason})`);
      await pi.setActiveTools(fullTools);
      fullTools = undefined;
    }
  };

  /** Renders the persistent status widget above the editor (or removes it). */
  const renderFor = (ctx: ExtensionContext): void => {
    if (widgetState === "off") {
      ctx.ui.setWidget("dspro-boost", undefined);
      return;
    }
    const color = widgetState === "active" ? "success" : "error";
    const label = widgetState === "active" ? "boost: anchoring" : "boost: config mismatch";
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

  /** Set the widget state and repaint. Groups the repeated state+render pairs. */
  const setWidget = (state: WidgetState, ctx: ExtensionContext): void => {
    widgetState = state;
    renderFor(ctx);
  };

  pi.registerCommand("dspro-boost", {
    description:
      "One-shot two-phase tool anchoring for DeepSeek V4-Pro CoT overfitting. Usage: /dspro-boost | /dspro-boost status",
    handler: async (args, ctx) => {
      const cmd = (args.trim().split(/\s+/)[0] ?? "").toLowerCase();
      if (cmd === "status") {
        ctx.ui.notify(`dspro-boost: ${cycle.isAnchoring ? "anchoring" : "inactive"}`, "info");
        return;
      }
      // Bare command: start one anchoring cycle + convenience set model/thinking
      // to V4-Pro/High (pure convenience; activation still checks actual config).
      cycle.start();
      let resolved;
      for (const spec of ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro:high"]) {
        resolved = ctx.models.resolve(spec);
        if (resolved) break;
      }
      if (resolved) {
        await pi.setModel(resolved);
      } else {
        debug("start: could not resolve a V4-Pro model; leaving model as-is");
      }
      pi.setThinkingLevel(ThinkingLevel.High);
      setWidget(isActive(ctx) ? "active" : "inactive", ctx);
      log("cycle start");
      ctx.ui.notify("dspro-boost: anchoring (model/thinking set to V4-Pro/High)", "info");
    },
  });

  // Per-turn decision point. Anchoring + active → anchor (minimal tools + pure
  // persona). Anchoring + config no longer pro+High → cancel + restore tools.
  // Not anchoring → pass through untouched.
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!cycle.isAnchoring) return;
    const active = isActive(ctx);
    if (!active) {
      // Config break during the cycle (before promote): cancel + restore tools.
      cycle.reset();
      await restoreTools("cancel (config no longer pro+High)");
      setWidget("off", ctx);
      log("cycle cancelled: config no longer pro+High");
      return;
    }
    if (shouldAnchor(cycle.isAnchoring, active)) {
      // Bootstrap: snapshot full tools, cut to minimal, override persona.
      if (!fullTools) fullTools = pi.getActiveTools();
      log(`anchoring: ${fullTools.length} tools -> [${ANCHOR_TOOLS.join(",")}]`);
      await pi.setActiveTools([...ANCHOR_TOOLS]);
      setWidget("active", ctx);
      return { systemPrompt: [MINIMAL_PERSONA] };
    }
  });

  // First tool call → promote + auto-reset (ADR-0004). Plain-text replies never
  // promote; this handler is only wired to tool_call.
  pi.on("tool_call", async (event, ctx) => {
    if (!cycle.isAnchoring) return;
    if (cycle.promoteOnce()) {
      await restoreTools(`promote (tool_call:${event.toolName})`);
      setWidget("off", ctx);
      log(`promoted (tool_call:${event.toolName}) — cycle reset`);
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    // One-shot cycle is not persisted — a restarted/resumed session starts idle.
    cycle.reset();
    fullTools = undefined;
    log("session_start: inactive (one-shot, not persisted)");
    setWidget("off", ctx);
  });
}
