/**
 * omp-dsh-minimal — omp extension implementing the dsh minimal mode:
 * a clean persona + only bash + str_replace_editor, no promote.
 *
 * This file is the WIRING layer only: it connects the pure logic in ./core
 * (the unit-test seam) to omp events and commands.
 *
 * Design (2026-08-18, omp-dsh-minimal):
 * - `/dsh-minimal` enables an explicit minimal switch (any model; no config
 *   monitoring) and conveniently sets model/thinking to V4-Pro/High.
 * - The model stays in the minimal environment for the whole period: persona
 *   `You are a helpful software engineer assistant.` + 2 tools. No promote.
 * - Session-head injection = convention file text (AGENTS.md), zero tool text
 *   (ablation-proven: tool-text mentions break the We-need anchor).
 * - tool_call is intercepted on ANY tool call; the bash branch handles omp
 *   internal URLs in the interception point: bash-expanded protocols
 *   (skill:// local:// artifact:// …) pass through (bash expands them
 *   natively), xd:// resolves via getAllTools() with the command replaced by
 *   an echo of the tool description, everything else fails open.
 * - `/dsh-minimal off`: confirm dialog → restore full tool snapshot → warning
 *   (KV-cache cost) → one-shot exit notice to the model on the next request.
 *
 * Design: docs/design/dsh-minimal.md · ADRs: docs/adr/0002-0007
 * Testing: docs/design/testing.md
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Type } from "@oh-my-pi/omptype/typebox";
import { Container, Text } from "@oh-my-pi/pi-tui";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  ANCHOR_TOOLS,
  BASH_EXPANDED_PROTOCOLS,
  MINIMAL_PERSONA,
  SessionHeadTracker,
  ExitNoticeTracker,
  detectProtocol,
  extractUrl,
  formatNumberedContent,
} from "./core";

const DEBUG = process.env.PI_ANCHOR_DEBUG === "1";

/** str_replace_editor description, verbatim from @deepseek-ai/dsh-tool-str-replace-editor. */
const STR_REPLACE_EDITOR_DESCRIPTION = `Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\``;

/** Model specs tried by the convenience set-model step, in order. */
const PRO_MODEL_SPECS = ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro:high"];

const CUSTOM_TYPE_INJECT = "dsh-minimal-inject";
const CUSTOM_TYPE_EXIT_NOTICE = "dsh-minimal-exit-notice";

/** Convention files injected at the session head (D6/ADR-0007). */
const CONVENTION_FILES = ["AGENTS.md"];

const WIDGET_GREEN = "DeepSeek Harness Minimal Mode: Context Injected";
const WIDGET_RED = "DeepSeek Harness Minimal Mode: Active";

const EXIT_NOTICE_TEXT =
  "The minimal mode (/dsh-minimal) has been turned off and the full tool environment is restored. Ignore any earlier messages about minimal mode and follow the current system prompt.";

type WidgetState = "off" | "red" | "green";

/** Shell-single-quote a string for embedding in a replaced bash command. */
const shellQuote = (text: string): string => "'" + text.replace(/'/g, "'\\''") + "'";

export default function dshMinimal(pi: ExtensionAPI): void {
  // Logging: key events always land in the omp file log (~/.omp/logs/omp.*.log)
  // via pi.logger (console output would corrupt the TUI). Detail lines only
  // when PI_ANCHOR_DEBUG=1.
  const log = (message: string): void => {
    pi.logger.info(`[dsh-minimal] ${message}`);
  };
  const debug = (message: string): void => {
    if (DEBUG) pi.logger.debug(`[dsh-minimal] ${message}`);
  };

  // Minimal switch (opt-in, ADR-0002): `/dsh-minimal` turns it on. While off
  // the plugin is fully transparent (except a one-shot exit notice).
  let minimalEnabled = false;
  // Snapshot of the full tool set taken when entering minimal mode, restored
  // on `/dsh-minimal off` (D8).
  let fullTools: string[] | undefined;
  // Whether the minimal environment is currently active.
  let enteredMinimal = false;
  // Widget presentation state.
  let widgetState: WidgetState = "off";
  // Whether the injection text is currently present in the session context.
  let injectionOk = false;
  // The last injected text, re-attached to compaction summaries (D6/ADR-0007).
  let injectionText = "";
  // Session-head tracker (D6/ADR-0007).
  const head = new SessionHeadTracker();
  // One-shot exit notice state (D8/ADR-0007).
  const exitNotice = new ExitNoticeTracker();

  /** Renders the persistent status widget above the editor (or removes it). */
  const renderFor = (ctx: ExtensionContext): void => {
    if (widgetState === "off") {
      ctx.ui.setWidget("dsh-minimal", undefined);
      return;
    }
    const color = widgetState === "green" ? "success" : "error";
    const label = widgetState === "green" ? WIDGET_GREEN : WIDGET_RED;
    ctx.ui.setWidget(
      "dsh-minimal",
      (_tui, theme) => {
        const container = new Container();
        container.addChild(new Text(theme.fg(color, label), 1, 0));
        return container;
      },
      { placement: "aboveEditor" },
    );
  };

  /** Set the widget state and repaint. */
  const setWidget = (state: WidgetState, ctx: ExtensionContext): void => {
    widgetState = state;
    renderFor(ctx);
  };

  /**
   * Builds the session-head injection message (D6/ADR-0007): convention file
   * text (cwd/AGENTS.md + ~/.omp/agent/AGENTS.md), NOT event.systemPrompt
   * (which renders tool names/descriptions/policy). Zero tool text. Returns
   * undefined when no convention file is readable — no injection then.
   */
  const buildInjection = async (ctx: ExtensionContext): Promise<{ customType: string; content: string; display: boolean; attribution: "agent" } | undefined> => {
    const files: string[] = [];
    for (const name of CONVENTION_FILES) {
      files.push(join(ctx.cwd, name));
    }
    files.push(join(homedir(), ".omp", "agent", "AGENTS.md"));
    const parts: string[] = [];
    for (const file of files) {
      try {
        const content = await fsPromises.readFile(file, "utf8");
        if (content.trim()) parts.push(content.trim());
      } catch {
        // missing/unreadable convention file: skip, fail-open
      }
    }
    if (parts.length === 0) return undefined;
    return {
      customType: CUSTOM_TYPE_INJECT,
      content: parts.join("\n\n"),
      display: false,
      attribution: "agent",
    };
  };

  // =========================================================================
  // str_replace_editor — dsh-aligned four-command editor (D1)
  // =========================================================================
  pi.registerTool({
    name: "str_replace_editor",
    label: "String Replacement Editor",
    description: STR_REPLACE_EDITOR_DESCRIPTION,
    parameters: Type.Object({
      command: Type.Union([
        Type.Literal("view"),
        Type.Literal("create"),
        Type.Literal("str_replace"),
        Type.Literal("insert"),
      ]),
      path: Type.String(),
      file_text: Type.Optional(Type.String()),
      insert_line: Type.Optional(Type.Number()),
      new_str: Type.Optional(Type.String()),
      old_str: Type.Optional(Type.String()),
      view_range: Type.Optional(Type.Array(Type.Number())),
    }),
    defaultInactive: true,
    approval: "write",
    async execute(_toolCallId, params) {
      const { command, path } = params;
      try {
        switch (command) {
          case "view": {
            const stat = await fsPromises.stat(path);
            if (stat.isDirectory()) {
              // dsh semantics: non-hidden files and directories up to 2 levels deep.
              const lines: string[] = [];
              const walk = async (dir: string, depth: number): Promise<void> => {
                if (depth > 2) return;
                const entries = await fsPromises.readdir(dir, { withFileTypes: true });
                for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
                  if (e.name.startsWith(".")) continue;
                  const prefix = "  ".repeat(depth);
                  if (e.isDirectory()) {
                    lines.push(`${prefix}${e.name}/`);
                    if (depth < 2) await walk(`${dir}/${e.name}`, depth + 1);
                  } else {
                    lines.push(`${prefix}${e.name}`);
                  }
                }
              };
              await walk(path, 0);
              return { content: [{ type: "text", text: lines.join("\n") }] };
            }
            const content = await fsPromises.readFile(path, "utf8");
            const lines = formatNumberedContent(content).split("\n");
            const [from, to] = (params.view_range ?? []).slice(0, 2);
            const selected =
              typeof from === "number"
                ? lines.slice(from - 1, typeof to === "number" && to !== -1 ? to : undefined)
                : lines;
            return { content: [{ type: "text", text: selected.join("\n") }] };
          }
          case "create": {
            if (params.file_text === undefined) {
              return { content: [{ type: "text", text: "Parameter `file_text` is required for command: create" }], isError: true };
            }
            const existing = await fsPromises.stat(path).catch(() => undefined);
            if (existing) {
              return { content: [{ type: "text", text: `File already exists at: ${path}. Cannot overwrite files using command \`create\`.` }], isError: true };
            }
            await fsPromises.writeFile(path, params.file_text, "utf8");
            return { content: [{ type: "text", text: `New file created successfully at: ${path}` }] };
          }
          case "str_replace": {
            if (params.old_str === undefined) {
              return { content: [{ type: "text", text: "Parameter `old_str` is required for command: str_replace" }], isError: true };
            }
            const content = await fsPromises.readFile(path, "utf8");
            const occurrences = content.split(params.old_str).length - 1;
            if (occurrences === 0) {
              return { content: [{ type: "text", text: `old_str not found in ${path}` }], isError: true };
            }
            if (occurrences > 1) {
              return { content: [{ type: "text", text: `old_str is not unique in ${path} (${occurrences} occurrences). Include more context.` }], isError: true };
            }
            await fsPromises.writeFile(path, content.replace(params.old_str, params.new_str ?? ""), "utf8");
            return { content: [{ type: "text", text: `The file ${path} has been edited.` }] };
          }
          case "insert": {
            if (params.insert_line === undefined || params.new_str === undefined) {
              return { content: [{ type: "text", text: "Parameters `insert_line` and `new_str` are required for command: insert" }], isError: true };
            }
            const content = await fsPromises.readFile(path, "utf8");
            const lines = content.split("\n");
            if (!Number.isInteger(params.insert_line) || params.insert_line < 0 || params.insert_line > lines.length) {
              return { content: [{ type: "text", text: `Invalid \`insert_line\` parameter: ${params.insert_line}. It should be within the range of lines of the file: [0, ${lines.length}]` }], isError: true };
            }
            const next = [...lines.slice(0, params.insert_line), params.new_str, ...lines.slice(params.insert_line)];
            await fsPromises.writeFile(path, next.join("\n"), "utf8");
            return { content: [{ type: "text", text: `The file ${path} has been edited.` }] };
          }
          default:
            return { content: [{ type: "text", text: `Unknown command: ${String(command)}` }], isError: true };
        }
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  });

  // =========================================================================
  // Command: /dsh-minimal [off|status]
  // =========================================================================
  pi.registerCommand("dsh-minimal", {
    description:
      "DeepSeek Harness minimal mode for omp: clean persona + bash + str_replace_editor. Usage: /dsh-minimal | /dsh-minimal off | /dsh-minimal status",
    handler: async (args, ctx) => {
      const cmd = (args.trim().split(/\s+/)[0] ?? "").toLowerCase();
      if (cmd === "off") {
        if (!minimalEnabled) {
          ctx.ui.notify("dsh-minimal: not enabled", "info");
          return;
        }
        const ok = await ctx.ui.confirm(
          "Exit DeepSeek Harness minimal mode?",
          "Restores the full tool environment and persona. Note: switching tool sets may invalidate the provider KV cache (costs re-warming).",
        );
        if (!ok) {
          log("off: cancelled by user");
          return;
        }
        if (fullTools) {
          await pi.setActiveTools(fullTools);
          fullTools = undefined;
        }
        enteredMinimal = false;
        minimalEnabled = false;
        setWidget("off", ctx);
        exitNotice.arm();
        ctx.ui.notify("dsh-minimal: off — full tools restored (KV cache may need re-warming)", "warning");
        log("off: full tools restored, exit notice armed");
        return;
      }
      if (cmd === "status") {
        const state = !minimalEnabled
          ? "off"
          : enteredMinimal
            ? injectionOk
              ? "on (injected)"
              : "on (not injected)"
            : "on";
        ctx.ui.notify(`dsh-minimal: ${state}`, "info");
        return;
      }
      if (minimalEnabled) {
        ctx.ui.notify("dsh-minimal: already on", "info");
        return;
      }
      // Bare command: enable the minimal switch + convenience set model/thinking
      // to V4-Pro/High (pure convenience; the switch works for any model).
      // Cancel a pending exit notice: re-enabling before delivery must not
      // tell the model the opposite of the real state on the next turn.
      exitNotice.disarm();
      minimalEnabled = true;
      let resolved;
      for (const spec of PRO_MODEL_SPECS) {
        resolved = ctx.models.resolve(spec);
        if (resolved) break;
      }
      if (resolved) {
        await pi.setModel(resolved);
      } else {
        debug("on: could not resolve a V4-Pro model; leaving model as-is");
      }
      pi.setThinkingLevel(ThinkingLevel.High);
      setWidget("red", ctx);
      log("on: minimal switch enabled");
      ctx.ui.notify(
        "dsh-minimal: on — minimal environment applies from the next message (KV cache may need re-warming)",
        "info",
      );
    },
  });

  // =========================================================================
  // Session lifecycle events → head tracker + widget truth (D6/ADR-0007)
  // =========================================================================
  pi.on("session_start", (_event, ctx) => {
    head.onSessionStart();
    injectionOk = false;
    debug("session_start: head reset");
    if (enteredMinimal) setWidget("red", ctx);
  });

  pi.on("session_switch", (event, ctx) => {
    head.onSessionSwitch(event.reason);
    if (event.reason === "handoff" || event.reason === "new") {
      injectionOk = false;
      debug(`session_switch(${event.reason}): head reset`);
      if (enteredMinimal) setWidget("red", ctx);
    }
  });

  pi.on("session.compacting", (_event) => {
    // Re-attach the injection text to the compaction summary so it survives
    // the standard compact flow (D6/ADR-0007). Context lines are appended to
    // the summary; the widget stays green only when the text is present.
    return injectionOk ? { context: [injectionText] } : undefined;
  });

  // =========================================================================
  // Per-turn decision point: minimal env / head injection / exit notice
  // =========================================================================
  pi.on("before_agent_start", async (_event, ctx) => {
    // Every real request adds a user message to history — consume the head
    // tracker BEFORE any switch/notice branch so a mid-session enable never
    // injects at a non-head position (ADR-0007: mid-session enable = no
    // injection, widget stays red).
    const wasAtHead = head.atHead;
    head.onRequestStart();
    // Exit notice takes priority and is independent of the switch: it fires
    // once on the first request after a confirmed /dsh-minimal off.
    if (exitNotice.shouldDeliver()) {
      exitNotice.consume();
      log("exit notice: delivered");
      return {
        message: {
          customType: CUSTOM_TYPE_EXIT_NOTICE,
          content: EXIT_NOTICE_TEXT,
          display: false,
          attribution: "agent",
        },
      };
    }
    if (!minimalEnabled) return;
    // Enter the minimal environment (one-time tool switch).
    if (!enteredMinimal) {
      fullTools = pi.getActiveTools();
      await pi.setActiveTools([...ANCHOR_TOOLS]);
      enteredMinimal = true;
      log("minimal: active (bash, str_replace_editor)");
    }
    if (wasAtHead) {
      const injection = await buildInjection(ctx);
      if (injection) {
        injectionText = injection.content;
        injectionOk = true;
        setWidget("green", ctx);
        log("injected: convention files");
        return { systemPrompt: [MINIMAL_PERSONA], message: injection };
      }
      debug("inject: no convention file readable; skipping");
    }
    if (!injectionOk) setWidget("red", ctx);
    return { systemPrompt: [MINIMAL_PERSONA] };
  });

  // =========================================================================
  // tool_call: intercepted on ANY tool call (user's design); the bash branch
  // handles omp internal URLs (ADR-0006).
  //
  // Dispatch happens IN the interception point — no invokeTool delegation
  // (tool_call ctx has no invokeTool; same-tool-only forbids cross-name):
  // - bash-expanded protocols (skill/agent/artifact/memory/rule/local) are
  //   left alone — omp's bash expands them natively (verified in smoke).
  // - xd:// reads resolve through the official getAllTools() API and the
  //   command is replaced with an echo of the tool description.
  // - anything else falls through to native bash (fail-open).
  // =========================================================================
  pi.on("tool_call", async (event) => {
    debug(`tool_call: ${event.toolName} minimal=${enteredMinimal}`);
    if (!enteredMinimal) return;
    if (event.toolName !== "bash") return;
    // ToolCallEvent is not a clean discriminated union (CustomToolCallEvent has
    // a wide toolName), so the narrowing above does not type `input`; guard.
    if (!("command" in event.input) || typeof event.input.command !== "string") return;
    const command = event.input.command;
    const protocol = detectProtocol(command);
    if (!protocol || BASH_EXPANDED_PROTOCOLS[protocol]) return;
    const url = extractUrl(command, protocol);
    if (!url) return;
    if (protocol === "xd") {
      const toolName = url.slice("xd://".length);
      const info = pi.getAllTools().find((t) => t.name === toolName);
      const text = info
        ? `xd://${toolName} — ${info.description}`
        : `xd://${toolName}: unknown tool`;
      log(`protocol: xd://${toolName} (${info ? "resolved" : "unknown"})`);
      return { input: { ...event.input, command: `echo ${shellQuote(text)}` } };
    }
    // Unresolvable protocol: fall through to native bash (it will report its
    // own error and the model adapts).
    debug(`protocol: ${protocol} not resolvable; fail-open`);
  });
}
