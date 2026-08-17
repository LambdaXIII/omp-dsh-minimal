/**
 * dspro-boost — omp extension implementing two-phase tool anchoring.
 *
 * This file is the WIRING layer only: it connects the pure logic in ./core
 * (the unit-test seam) to omp events and commands. All behavior decisions
 * (activation, phase, promote) live in ./core.
 *
 * Mitigates DeepSeek V4-Pro CoT overfitting: bootstrap in a minimal persona +
 * minimal tools (bash, edit), then promote to the full tool set on first tool
 * call or first assistant output. Explicit switch (`/dspro-boost on|off|status`,
 * default off) because the phase switch breaks KV prefix caching.
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
  AnchorMachine,
  isProAndHigh,
  shouldAnchor,
} from "./core";

const DEBUG = process.env.PI_ANCHOR_DEBUG === "1";

type WidgetState = "off" | "active" | "inactive";

/** appendEntry customType for persisting the switch state (spec boundary ①). */
const SWITCH_ENTRY_TYPE = "dspro-boost.switch";

/** Persisted switch payload. */
interface SwitchEntryData {
  enabled: boolean;
}

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

  // User switch (ADR-0002). Default off.
  let enabled = false;
  // Snapshot of the full tool set taken before anchoring, restored on promote.
  let fullTools: string[] | undefined;
  // Last widget state.
  let widgetState: WidgetState = "off";
  // True while the current turn is actively anchored (bootstrap). Gates promote
  // so an un-anchored turn (condition mismatch) never promotes (spec: transparent).
  let anchoredThisTurn = false;
  // Phase state machine (ADR-0004).
  const machine = new AnchorMachine();

  /** Whether the activation condition (ADR-0003) currently holds. */
  const isActive = (ctx: ExtensionContext): boolean => {
    if (!enabled) return false;
    const model = ctx.models.current();
    const modelId = model?.id ?? model?.name;
    const level = pi.getThinkingLevel();
    const active = isProAndHigh(modelId, level);
    debug(`isActive: enabled=${enabled} model="${modelId}" thinking=${level} -> ${active}`);
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

  /** Set the widget state and repaint. Groups the repeated state+render pairs. */
  const setWidget = (state: WidgetState, ctx: ExtensionContext): void => {
    widgetState = state;
    renderFor(ctx);
  };

  pi.registerCommand("dspro-boost", {
    description:
      "Two-phase tool anchoring for DeepSeek V4-Pro CoT overfitting. Usage: /dspro-boost on|off|status",
    handler: async (args, ctx) => {
      const cmd = (args.trim().split(/\s+/)[0] ?? "").toLowerCase();
      if (cmd === "on") {
        enabled = true;
        machine.reset();
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
        setWidget(isActive(ctx) ? "active" : "inactive", ctx);
        pi.appendEntry(SWITCH_ENTRY_TYPE, { enabled });
        log("switch on");
        ctx.ui.notify("dspro-boost: on (model/thinking set to V4-Pro/High)", "info");
      } else if (cmd === "off") {
        enabled = false;
        machine.reset();
        setWidget("off", ctx);
        pi.appendEntry(SWITCH_ENTRY_TYPE, { enabled });
        log("switch off");
        ctx.ui.notify("dspro-boost: off", "info");
      } else {
        ctx.ui.notify(
          `dspro-boost: ${enabled ? "on" : "off"} · phase=${machine.isPromoted ? "full" : "bootstrap"}`,
          "info",
        );
      }
    },
  });

  // Per-turn decision point (ADR-0003/0004). Active config + not yet promoted →
  // anchor. Promoted → pass through (omp restores the full base prompt + tools).
  // Config break (switch off, model changed, or thinking left High) → reset
  // promotion; the next matching turn re-anchors fresh (ADR-0004).
  //
  // Multi-extension chaining (spec boundary): omp chains before_agent_start
  // systemPrompt overrides. During bootstrap we deliberately override with the
  // pure minimal persona, temporarily replacing other extensions' prompt blocks
  // — anchoring requires a clean environment. After promote we return no
  // override, so other extensions' blocks are restored with the full base.
  pi.on("before_agent_start", async (_event, ctx) => {
    const active = isActive(ctx);
    if (!active) {
      anchoredThisTurn = false;
      if (machine.isPromoted || fullTools !== undefined) {
        machine.reset();
        fullTools = undefined;
        log("config break: promotion reset");
      }
      setWidget("inactive", ctx);
      return;
    }
    if (shouldAnchor(enabled, active, machine.isPromoted)) {
      // Bootstrap: snapshot full tools, cut to minimal, override persona.
      anchoredThisTurn = true;
      if (!fullTools) fullTools = pi.getActiveTools();
      log(`anchoring: ${fullTools.length} tools -> [${ANCHOR_TOOLS.join(",")}]`);
      await pi.setActiveTools([...ANCHOR_TOOLS]);
      setWidget("active", ctx);
      return { systemPrompt: [MINIMAL_PERSONA] };
    }
    // Already promoted: pass through (omp restores the full base prompt + tools).
    anchoredThisTurn = false;
    setWidget("active", ctx);
  });

  // Promote signals: first tool call or first assistant output (ADR-0004).
  // Only promotes when the current turn actually anchored — a turn that passed
  // through (condition mismatch) must never promote or flip the widget.
  const promote = async (source: string, ctx: ExtensionContext): Promise<void> => {
    if (!enabled || !anchoredThisTurn) return;
    if (!machine.promoteOnce()) return; // one-time per config
    if (fullTools) {
      log(`promoting (${source}): restoring ${fullTools.length} tools`);
      await pi.setActiveTools(fullTools);
    }
    setWidget("active", ctx);
  };

  pi.on("tool_call", async (event, ctx) => {
    await promote(`tool_call:${event.toolName}`, ctx);
  });

  pi.on("message_end", async (_event, ctx) => {
    await promote("message_end", ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    // Restore the switch state persisted by the on/off commands (appendEntry),
    // so a restarted/resumed session keeps the user's last choice.
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === SWITCH_ENTRY_TYPE) {
        enabled = (entry.data as SwitchEntryData | undefined)?.enabled ?? false;
      }
    }
    machine.reset();
    fullTools = undefined;
    widgetState = enabled ? "inactive" : "off";
    log(`session_start: restored enabled=${enabled}`);
    renderFor(ctx);
  });
}
