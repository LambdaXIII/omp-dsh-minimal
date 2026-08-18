import * as fs from "node:fs/promises";
import { join } from "node:path";

/**
 * dspro-boost — pure logic (no omp dependency).
 *
 * This is the single unit-test seam for the plugin. All behavior that can be
 * decided without ExtensionAPI lives here; src/index.ts only wires these
 * functions/classes to omp events and commands.
 *
 * Final design (2026-08-18, grill-converged):
 * - No promote: the model stays in the minimal environment (bash +
 *   str_replace_editor) for the whole anchoring period.
 * - Tool capability flows through bash's `command: string` as JSON-serialized
 *   tool calls ({"name": ..., "arguments": ...}); the plugin parses and
 *   dispatches.
 * - Context injection happens only at the session head (no user message yet),
 *   tracked by an event-maintained flag.
 *
 * See: docs/design/anchor-plugin.md (D1-D11) · docs/adr/0002-0007
 */

/** dsh minimal persona, verbatim from DeepSeek Harness. */
export const MINIMAL_PERSONA = "You are a helpful software engineer assistant.";

/** Minimal tool set exposed during anchoring (D1). */
export const ANCHOR_TOOLS: readonly string[] = ["bash", "str_replace_editor"];

/** Matches DeepSeek V4 Pro model ids (activation condition, ADR-0003). */
const PRO_MODEL_PATTERN = /deepseek[^/]*[\/:]?(?:deepseek-)?v4-?pro(?:[:/]|$)/i;

/** The thinking level value that activates anchoring (ADR-0003). */
const HIGH_THINKING = "high";

/**
 * Whether the activation condition (ADR-0003) holds: current model is DeepSeek
 * V4 Pro AND thinking level is High. Pure predicate; callers feed it the actual
 * model id and thinking level.
 */
export function isProAndHigh(
  modelId: string | undefined,
  thinkingLevel: string | undefined,
): boolean {
  if (!modelId || !thinkingLevel) return false;
  return PRO_MODEL_PATTERN.test(modelId) && thinkingLevel.toLowerCase() === HIGH_THINKING;
}

/** A recognized JSON-serialized tool call inside a bash command string. */
export interface ParsedToolCall {
  kind: "tool";
  name: string;
  args: Record<string, unknown>;
}

/** Anything that is not a JSON-serialized tool call (plain shell command). */
export interface ShellCommand {
  kind: "shell";
}

export type ParseResult = ParsedToolCall | ShellCommand;

/**
 * Decide whether a bash `command` string is a JSON-serialized tool call or a
 * plain shell command (D11/ADR-0006). JSON-serialized tool calls have the shape
 * {"name": string, "arguments": object}; everything else is shell.
 */
export function parseToolCall(command: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(command);
  } catch {
    return { kind: "shell" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "shell" };
  }
  const { name, arguments: args } = parsed as Record<string, unknown>;
  if (typeof name !== "string" || typeof args !== "object" || args === null || Array.isArray(args)) {
    return { kind: "shell" };
  }
  return { kind: "tool", name, args: args as Record<string, unknown> };
}

/** Result of dispatching a JSON-serialized tool call (D11). */
export interface DispatchResult {
  ok: boolean;
  /** Human/model-facing text when the dispatch succeeded. */
  content?: string;
  /** Error/unavailable message when it failed. */
  error?: string;
}

const UNAVAILABLE_SUFFIX =
  " is not available in the minimal environment. Express the intent with bash commands (e.g. cat/sed/find) or a JSON-serialized call to another tool.";

function asString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

/** `N| line` numbering used by read/str_replace_editor view (aligned to the read tool's style). */
export function formatNumberedContent(content: string): string {
  return content
    .split("\n")
    .map((line, i) => `${i + 1}| ${line}`)
    .join("\n");
}

/** Reads a file with `N| line` numbering (aligned to the read tool's style). */
async function dispatchRead(args: Record<string, unknown>): Promise<DispatchResult> {
  const path = asString(args, "path");
  if (!path) return { ok: false, error: "read requires a string `path` argument" };
  const content = await fs.readFile(path, "utf8");
  return { ok: true, content: formatNumberedContent(content) };
}

/** Writes a file; `content` may contain newlines. */
async function dispatchWrite(args: Record<string, unknown>): Promise<DispatchResult> {
  const path = asString(args, "path");
  const content = asString(args, "content");
  if (!path || content === undefined) {
    return { ok: false, error: "write requires string `path` and `content` arguments" };
  }
  await fs.writeFile(path, content, "utf8");
  return { ok: true, content: `File written: ${path}` };
}

/** Replaces a unique exact `old_string` with `new_string` in `path`. */
async function dispatchEdit(args: Record<string, unknown>): Promise<DispatchResult> {
  const path = asString(args, "path");
  const oldString = asString(args, "old_string");
  const newString = asString(args, "new_string");
  if (!path || oldString === undefined || newString === undefined) {
    return { ok: false, error: "edit requires string `path`, `old_string` and `new_string` arguments" };
  }
  const content = await fs.readFile(path, "utf8");
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) return { ok: false, error: `old_string not found in ${path}` };
  if (occurrences > 1) {
    return { ok: false, error: `old_string is not unique in ${path} (${occurrences} occurrences)` };
  }
  await fs.writeFile(path, content.replace(oldString, newString), "utf8");
  return { ok: true, content: `Edited ${path}` };
}

/** Lists paths matching a glob pattern (via fs.glob, Node 22+/Bun). */
async function dispatchGlob(args: Record<string, unknown>): Promise<DispatchResult> {
  const pattern = asString(args, "pattern");
  if (!pattern) return { ok: false, error: "glob requires a string `pattern` argument" };
  const matches: string[] = [];
  for await (const entry of fs.glob(pattern)) {
    matches.push(String(entry));
  }
  matches.sort();
  return { ok: true, content: matches.join("\n") };
}

/** Searches files under `path` for lines matching `pattern` (regex). */
async function dispatchGrep(args: Record<string, unknown>): Promise<DispatchResult> {
  const pattern = asString(args, "pattern");
  const path = asString(args, "path");
  if (!pattern || !path) return { ok: false, error: "grep requires string `pattern` and `path` arguments" };
  const re = new RegExp(pattern);
  const hits: string[] = [];
  for await (const entry of fs.glob(join(path, "**", "*"))) {
    const p = String(entry);
    let stat;
    try {
      stat = await fs.stat(p);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    let content: string;
    try {
      content = await fs.readFile(p, "utf8");
    } catch {
      continue; // binary/unreadable
    }
    for (const [i, line] of content.split("\n").entries()) {
      if (re.test(line)) hits.push(`${p}:${i + 1}: ${line}`);
    }
  }
  return { ok: true, content: hits.join("\n") };
}

/**
 * Dispatches a JSON-serialized tool call (D11/ADR-0006): file-operation tools
 * are implemented here (fs); everything else is reported unavailable. Returns a
 * text result the model sees. Never throws — callers must fail closed.
 */
export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  try {
    switch (name) {
      case "read":
        return await dispatchRead(args);
      case "write":
        return await dispatchWrite(args);
      case "edit":
        return await dispatchEdit(args);
      case "glob":
        return await dispatchGlob(args);
      case "grep":
        return await dispatchGrep(args);
      default:
        return { ok: false, error: `Tool ${name}${UNAVAILABLE_SUFFIX}` };
    }
  } catch (error) {
    return { ok: false, error: `${name}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Tracks whether the current session is still at its head (no user message in
 * history yet) — the only condition under which context injection happens
 * (D9/ADR-0007). The flag is maintained from real omp events, never invented:
 * - session_start / session_switch(handoff|new) clear messages → back to head
 * - any real request (before_agent_start) adds a user message → leaves head
 * - fork / resume / compact keep the current state
 */
export class SessionHeadTracker {
  #atHead = true;

  /** True when the session is at its head and injection is allowed. */
  get atHead(): boolean {
    return this.#atHead;
  }

  /** session_start: a fresh extension instance starts a fresh session. */
  onSessionStart(): void {
    this.#atHead = true;
  }

  /** session_switch: handoff/new clear all messages; fork/resume keep them. */
  onSessionSwitch(reason: string): void {
    if (reason === "handoff" || reason === "new") {
      this.#atHead = true;
    }
  }

  /** A real request has been submitted; its user message enters history. */
  onRequestStart(): void {
    this.#atHead = false;
  }
}
