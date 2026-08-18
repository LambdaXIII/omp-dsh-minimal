/**
 * dspro-boost — omp extension implementing minimal-environment anchoring
 * (no promote) for DeepSeek V4-Pro.
 *
 * This file is the WIRING layer only: it connects the pure logic in ./core
 * (the unit-test seam) to omp events and commands. All behavior decisions
 * (activation, head tracking, dispatch) live in ./core.
 *
 * Final design (2026-08-18):
 * - `/dspro-boost` opens the detection switch (opt-in) and conveniently sets
 *   model/thinking to V4-Pro/High. Anchoring = switch on ∧ pro+High, checked at
 *   every real request; config change stops it naturally.
 * - In the minimal environment the model has only bash + str_replace_editor.
 *   Other tool capabilities flow through bash's `command: string` as
 *   JSON-serialized tool calls; the plugin parses and dispatches them.
 * - Context injection happens only at the session head (no user message yet):
 *   system prompt + full tool catalog (live getAllTools) + a one-line note that
 *   tools can be called as JSON inside bash. Handoff/new clear messages → head
 *   resets → re-injection is natural. Compact re-attaches the injection text
 *   via the session.compacting context hook.
 *
 * Design: docs/design/anchor-plugin.md · ADRs: docs/adr/0002-0007
 * Testing: docs/design/testing.md
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Type } from "@oh-my-pi/omptype/typebox";
import { Container, Text } from "@oh-my-pi/pi-tui";
import * as fsPromises from "node:fs/promises";
import {
  ANCHOR_TOOLS,
  MINIMAL_PERSONA,
  SessionHeadTracker,
  dispatchTool,
  formatNumberedContent,
  isProAndHigh,
  parseToolCall,
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

type WidgetState = "off" | "red" | "green";

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

  // Detection switch (opt-in, ADR-0002): `/dspro-boost` turns it on. While off
  // the plugin is fully transparent; background work still runs.
  let detectionEnabled = false;
  // Snapshot of the full tool set taken when entering the minimal environment,
  // restored when the config no longer matches (D8).
  let fullTools: string[] | undefined;
  // Whether the minimal environment is currently active.
  let enteredMinimal = false;
  // Widget presentation state.
  let widgetState: WidgetState = "off";
  // Whether the injection text is currently present in the session context.
  let injectionOk = false;
  // The last injected text, re-attached to compaction summaries (D10/ADR-0007).
  let injectionText = "";
  // Session-head tracker (D9/ADR-0007).
  const head = new SessionHeadTracker();

  /** Whether the activation condition (ADR-0003) currently holds. */
  const isActive = (ctx: ExtensionContext): boolean => {
    const model = ctx.models.current();
    const modelId = model?.id ?? model?.name;
    const level = pi.getThinkingLevel();
    const active = isProAndHigh(modelId, level);
    debug(`isActive: model="${modelId}" thinking=${level} -> ${active}`);
    return active;
  };

  /** Renders the persistent status widget above the editor (or removes it). */
  const renderFor = (ctx: ExtensionContext): void => {
    if (widgetState === "off") {
      ctx.ui.setWidget("dspro-boost", undefined);
      return;
    }
    const color = widgetState === "green" ? "success" : "error";
    const label =
      widgetState === "green" ? "boost: injected" : "boost: minimal env (not injected)";
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

  /** Set the widget state and repaint. */
  const setWidget = (state: WidgetState, ctx: ExtensionContext): void => {
    widgetState = state;
    renderFor(ctx);
  };

  /** Single-quote a string for safe interpolation into a shell command. */
  const shellQuote = (text: string): string => "'" + text.replace(/'/g, "'\\''") + "'";

  /** Builds the session-head injection message (D9/ADR-0007). */
  const buildInjection = (systemPrompt: string[]): { customType: string; content: string; display: boolean; attribution: "agent" } => {
    const tools = pi.getAllTools();
    const toolBlock = tools
      .map(t => `### ${t.name}\n${t.description}\n\nSchema: ${JSON.stringify(t.parameters)}`)
      .join("\n\n");
    const content = [
      "以下为系统约定与本环境可用工具的说明。请遵循系统约定。",
      "在 bash 工具的 command 参数中，可直接以 JSON 序列化形式调用下列工具，例如：",
      '{"name":"read","arguments":{"path":"src/a.ts"}}',
      "非 JSON 内容按普通 shell 命令执行。",
      "",
      "== 系统约定 ==",
      systemPrompt.join("\n"),
      "",
      "== 可用工具（omp 运行时状态）==",
      toolBlock,
    ].join("\n");
    return {
      customType: "dspro-boost-inject",
      content,
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
  // Command: /dspro-boost [status]
  // =========================================================================
  pi.registerCommand("dspro-boost", {
    description:
      "Minimal-environment anchoring for DeepSeek V4-Pro CoT overfitting. Usage: /dspro-boost | /dspro-boost status",
    handler: async (args, ctx) => {
      const cmd = (args.trim().split(/\s+/)[0] ?? "").toLowerCase();
      if (cmd === "status") {
        const state = !detectionEnabled
          ? "detection off"
          : enteredMinimal
            ? `minimal env active (${injectionOk ? "injected" : "not injected"})`
            : "detection on, config not pro+High";
        ctx.ui.notify(`dspro-boost: ${state}`, "info");
        return;
      }
      // Bare command: open the detection switch + convenience set model/thinking
      // to V4-Pro/High (pure convenience; activation still checks actual config).
      detectionEnabled = true;
      let resolved;
      for (const spec of PRO_MODEL_SPECS) {
        resolved = ctx.models.resolve(spec);
        if (resolved) break;
      }
      if (resolved) {
        await pi.setModel(resolved);
      } else {
        debug("start: could not resolve a V4-Pro model; leaving model as-is");
      }
      pi.setThinkingLevel(ThinkingLevel.High);
      setWidget(isActive(ctx) ? (injectionOk ? "green" : "red") : "off", ctx);
      log("detection switch on");
      ctx.ui.notify("dspro-boost: detection on (model/thinking set to V4-Pro/High)", "info");
    },
  });

  // =========================================================================
  // Session lifecycle events → head tracker + widget truth (D9/D10/ADR-0007)
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
    // the standard compact flow (D10/ADR-0007). Context lines are appended to
    // the summary; the widget stays green only when the text is present.
    return injectionOk ? { context: [injectionText] } : undefined;
  });

  // =========================================================================
  // Per-turn decision point: activate minimal env / inject at head / stop
  // =========================================================================
  pi.on("before_agent_start", async (event, ctx) => {
    if (!detectionEnabled) return;
    const active = isActive(ctx);
    if (!active) {
      if (enteredMinimal) {
        if (fullTools) {
          await pi.setActiveTools(fullTools);
          fullTools = undefined;
        }
        enteredMinimal = false;
        setWidget("off", ctx);
        log("config break: restored full tools");
      }
      return;
    }
    // Active: ensure the minimal environment (one-time tool switch).
    if (!enteredMinimal) {
      fullTools = pi.getActiveTools();
      await pi.setActiveTools([...ANCHOR_TOOLS]);
      enteredMinimal = true;
      log("anchoring: minimal tools active (bash, str_replace_editor)");
    }
    // Injection only at the session head (no user message yet).
    const wasAtHead = head.atHead;
    head.onRequestStart();
    if (wasAtHead) {
      const message = buildInjection(event.systemPrompt);
      injectionText = message.content;
      injectionOk = true;
      setWidget("green", ctx);
      log(`injected: systemPrompt + ${pi.getAllTools().length} tool schemas`);
      return { systemPrompt: [MINIMAL_PERSONA], message };
    }
    if (!injectionOk) setWidget("red", ctx);
    return { systemPrompt: [MINIMAL_PERSONA] };
  });

  // =========================================================================
  // tool_call: JSON-serialized tool calls inside bash (D11/ADR-0006)
  // =========================================================================
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: unknown } | undefined)?.command;
    if (typeof command !== "string") return;
    const parsed = parseToolCall(command);
    if (parsed.kind === "shell") return; // plain shell command → native bash
    const result = await dispatchTool(parsed.name, parsed.args);
    const text = result.ok ? (result.content ?? "") : (result.error ?? "tool failed");
    log(`dispatch: ${parsed.name} -> ${result.ok ? "ok" : "error"}`);
    // The bash tool cannot return arbitrary text from an interceptor; the
    // dispatched result is echoed back through a rewritten command so the model
    // sees it as ordinary tool output.
    return { input: { command: `echo ${shellQuote(text)}` } };
  });
}
