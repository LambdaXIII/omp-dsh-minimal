/**
 * omp-dsh-minimal — pure logic (no omp dependency).
 *
 * This is the single unit-test seam for the plugin. All behavior that can be
 * decided without ExtensionAPI lives here; src/index.ts only wires these
 * functions/classes to omp events and commands.
 *
 * Final design (2026-08-18, omp-dsh-minimal):
 * - Explicit minimal switch (`/dsh-minimal`); no model/thinking monitoring.
 * - The model stays in the minimal environment (bash + str_replace_editor) for
 *   the whole period; no promote. Zero tool text anywhere in injected content
 *   (ablation-proven: tool-text mentions break the We-need anchor).
 * - Session-head injection = convention file text (AGENTS.md), NOT
 *   event.systemPrompt (which renders tool names/descriptions/policy).
 * - bash protocol mapping: commands referencing omp internal URLs (skill://
 *   xd:// local:// …) are delegated to native omp tools via a same-name
 *   re-registered tool + ctx.invokeTool; everything else passes through.
 *
 * See: docs/design/dsh-minimal.md (D1-D9) · docs/adr/0002-0007
 */

/** dsh minimal persona, verbatim from DeepSeek Harness. */
export const MINIMAL_PERSONA = "You are a helpful software engineer assistant.";

/** Minimal tool set exposed during the minimal period (D1). */
export const ANCHOR_TOOLS: readonly string[] = ["bash", "str_replace_editor"];

/**
 * Minimal switch mode (ADR-0008): the three-state switch `off | normal | pure`.
 * A single well-defined value — never stacked. `on`/`normal`/bare command all
 * target `normal`; `pure` targets `pure`.
 */
export type MinimalMode = "off" | "normal" | "pure";

/**
 * Parsed `/dsh-minimal` command (ADR-0008, contract fixed by spec discussion —
 * implementers must not change it):
 * - bare command / on / normal → { action: "enter", mode: "normal" }
 * - pure → { action: "enter", mode: "pure" }
 * - off → { action: "exit" }
 * - status → { action: "status" }
 * - first arg anything else → { action: "unknown", argument: <that word> }
 */
export type Command =
  | { action: "enter"; mode: "normal" | "pure" }
  | { action: "exit" }
  | { action: "status" }
  | { action: "unknown"; argument: string };

/**
 * Parse `/dsh-minimal` command arguments into a {@link Command} (ADR-0008).
 * Only the first whitespace-separated word is considered; the rest are
 * ignored. Matching is case-insensitive; the `unknown` argument preserves the
 * original (un-lowercased) first word.
 */
export function parseCommand(args: string): Command {
  const first = args.trim().split(/\s+/)[0] ?? "";
  switch (first.toLowerCase()) {
    case "":
      return { action: "enter", mode: "normal" };
    case "on":
    case "normal":
      return { action: "enter", mode: "normal" };
    case "pure":
      return { action: "enter", mode: "pure" };
    case "off":
      return { action: "exit" };
    case "status":
      return { action: "status" };
    default:
      return { action: "unknown", argument: first };
  }
}

/**
 * Whether conventions should be injected for the given mode (ADR-0008).
 * Only normal mode injects; pure never injects (its whole point) and off is
 * not an active mode.
 */
export function shouldInjectConventions(mode: MinimalMode): boolean {
  return mode === "normal";
}

/** `N| line` numbering used by read/str_replace_editor view (aligned to the read tool's style). */
export function formatNumberedContent(content: string): string {
  return content
    .split("\n")
    .map((line, i) => `${i + 1}| ${line}`)
    .join("\n");
}

/**
 * Tracks whether the current session is still at its head (no user message in
 * history yet) — the only condition under which context injection happens
 * (D6/ADR-0007). The flag is maintained from real omp events, never invented:
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

/**
 * One-shot exit-notice state machine (D8/ADR-0007). After `/dsh-minimal off`
 * the plugin injects a single custom message on the next real request telling
 * the model the minimal period is over; this tracker guarantees the notice is
 * delivered exactly once per off cycle.
 */
export class ExitNoticeTracker {
  #armed = false;
  #delivered = false;

  /** Whether the exit notice still needs to be injected. */
  shouldDeliver(): boolean {
    return this.#armed && !this.#delivered;
  }

  /** Arm the notice (called after a confirmed `/dsh-minimal off`). */
  arm(): void {
    this.#armed = true;
    this.#delivered = false;
  }

  /** Mark the notice as delivered (called after injection). */
  consume(): void {
    this.#delivered = true;
  }

  /** Cancel a pending notice (e.g. minimal mode re-enabled before delivery). */
  disarm(): void {
    this.#armed = false;
  }
}

/** omp internal URL protocols the bash protocol mapping understands. */
const PROTOCOLS = [
  "skill",
  "xd",
  "local",
  "artifact",
  "history",
  "rule",
  "memory",
  "mcp",
  "issue",
  "pr",
  "vault",
  "omp",
] as const;

/**
 * Protocols omp's bash tool expands natively before execution
 * (expandSkillUrls + expandInternalUrls in tools/bash.ts): skill:// agent://
 * artifact:// memory:// rule:// local:// become shell-escaped absolute paths,
 * so reads AND writes to them work in plain bash with no delegation. Commands
 * carrying these protocols are therefore left untouched (fail-open).
 */
export const BASH_EXPANDED_PROTOCOLS: Record<string, true> = {
  skill: true,
  agent: true,
  artifact: true,
  memory: true,
  rule: true,
  local: true,
};

/**
 * Detect an omp internal URL protocol in a bash command string (ADR-0006).
 * Returns the protocol name (e.g. "skill", "xd", "local") or undefined when
 * the command carries none. Only word-boundary protocol forms count, so
 * ordinary text like "https://…" cannot match.
 */
export function detectProtocol(command: string): string | undefined {
  for (const proto of PROTOCOLS) {
    const re = new RegExp(`(?:^|[^A-Za-z])${proto}://`);
    if (re.test(command)) return proto;
  }
  return undefined;
}

/**
 * Extract the full internal-URL token (scheme + address) from the command —
 * the resource the interception point resolves. The URL is the token
 * containing `<protocol>://`, delimited by whitespace or shell metacharacters.
 */
export function extractUrl(command: string, protocol: string): string | undefined {
  const re = new RegExp(`(?:^|[^A-Za-z])(${protocol}://[^\\s'"\\;|&<>(){}]+)(?:$|[\\s'"\\;|&<>(){}])`);
  const match = command.match(re);
  return match?.[1];
}
