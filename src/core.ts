/**
 * omp-dsh-minimal — pure logic (no omp dependency).
 *
 * This is the single unit-test seam for the plugin. All behavior that can be
 * decided without ExtensionAPI lives here; src/index.ts only wires these
 * functions/classes to omp events and commands.
 *
 * - Session-head injection = disclosure (ADR-0009): normal = header + Internal
 *   URLs + xd protocol block + AGENTS + APPEND_SYSTEM; pure = AGENTS only.
 * - bash protocol mapping: commands referencing omp internal URLs (skill://
 *   xd:// local:// …) are delegated to native omp tools via a same-name
 *   re-registered tool + ctx.invokeTool; everything else passes through.
 *
 * See: docs/design/dsh-minimal.md (D1-D9) · docs/adr/0002-0009
 */

/** dsh minimal persona, verbatim from DeepSeek Harness. */
export const MINIMAL_PERSONA = "You are a helpful software engineer assistant.";

/** Minimal tool set exposed during the minimal period (D1). */
export const ANCHOR_TOOLS: readonly string[] = ["bash", "str_replace_editor"];

/**
 * Minimal switch mode (ADR-0008): the three-state switch `off | normal | pure`.
 * A single well-defined value — never stacked. `on`/`normal` target `normal`;
 * `pure` targets `pure`; the bare command shows status (spec: disclosure-and-status).
 */
export type MinimalMode = "off" | "normal" | "pure";

/**
 * Parsed `/dsh-minimal` command (ADR-0008, contract fixed by spec discussion —
 * implementers must not change it):
 * - bare command → { action: "status" }
 * - on / normal → { action: "enter", mode: "normal" }
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
      return { action: "status" };
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
 * Whether conventions should be injected for the given mode (ADR-0008/0009).
 * Both active modes inject AGENTS conventions (pure skips only the
 * environment/discipline layer); off is not an active mode.
 */
export function shouldInjectConventions(mode: MinimalMode): boolean {
  return mode !== "off";
}

/**
 * Required omp host version (spec: disclosure-and-status). Aligns with the
 * package.json dependency range `^18.0.0`; display-only, nothing is enforced.
 */
export const REQUIRED_OMP_VERSION = 18;

/** Mode + injection state as shown by status and the widget (ADR-0008). */
export type StatusState =
  | "off"
  | "normal (injected)"
  | "normal (not injected)"
  | "pure (injected)"
  | "pure (not injected)";

/** Versions reported by status: the plugin's own and the host omp release. */
export interface StatusVersions {
  pluginVersion: string;
  hostOmpVersion: string;
}

/** Status state string for a mode + injection truth (ADR-0008/0009). */
export function describeState(mode: MinimalMode, injected: boolean): StatusState {
  if (mode === "off") return "off";
  const tag = mode === "pure" ? "pure" : "normal";
  return `${tag} (${injected ? "injected" : "not injected"})`;
}

/**
 * Single-line status report: plugin version, actual/required omp versions, and
 * the mode + injection state (spec: disclosure-and-status). Pure display.
 */
export function formatStatus(state: StatusState, versions: StatusVersions): string {
  return `dsh-minimal ${versions.pluginVersion}: omp ${versions.hostOmpVersion} (req ≥${REQUIRED_OMP_VERSION}) · ${state}`;
}

/**
 * English header opening the normal-mode disclosure (ADR-0009). One or two
 * guiding sentences, no per-block explanation (avoids the model re-checking
 * each protocol). No tool names/descriptions/schemas (pollution boundary).
 */
export const HEADING_NOTICE =
  "<omp-context> You are running inside the omp harness. The sections below describe the environment, the access paths available through bash, and the conventions in effect. Read them once and follow them.";

/** One `xd://` device listed in the xd protocol block (ADR-0009). */
export interface XdEntry {
  name: string;
  /** One-line capability summary; never full tool descriptions/schemas. */
  summary: string;
}

const XD_BLOCK_TITLE = "# xd:// Tool Access";
const XD_BLOCK_INTRO =
  "Omp tools are reachable from bash by writing `xd://<tool>` (e.g. `xd://read`) — the harness answers with the tool's docs. Devices available:";

/**
 * Self-authored xd protocol block (ADR-0009): framework text + one
 * `name: summary` line per device. Replaces the omp-native `# xd:// Tool
 * Devices` section, whose schema format is excluded by the pollution boundary.
 */
export function buildXdProtocolBlock(entries: readonly XdEntry[]): string {
  const lines = [XD_BLOCK_TITLE, XD_BLOCK_INTRO];
  for (const entry of entries) {
    lines.push(`- ${entry.name}: ${entry.summary}`);
  }
  return lines.join("\n");
}

/**
 * Disclosure content blocks (ADR-0009). Each part is a pre-rendered section;
 * wiring supplies them from omp's own rendering/file sources, so the plugin
 * only self-authors the header and the xd block framework.
 */
export interface DisclosureParts {
  /** `# Internal URLs` section (reused omp rendering; protocol directory). */
  internalUrls?: string;
  /** Self-authored xd protocol block; present when xdev devices are active. */
  xdBlock?: string;
  /** `<repo-rules>`[AGENTS] section (reused omp rendering). */
  repoRules?: string;
  /** APPEND_SYSTEM text (reused omp rendering). */
  appendSystem?: string;
}

/**
 * Assemble the disclosure (supplemental developer message) for a mode
 * (ADR-0009): normal = header + Internal URLs + xd block + repo-rules +
 * APPEND_SYSTEM (omp render order, header first); pure = repo-rules only.
 * Missing optional parts are skipped; returns undefined when the mode
 * discloses nothing (off, or pure without AGENTS). Each block is trimmed.
 */
export function buildDisclosure(mode: MinimalMode, parts: DisclosureParts): string | undefined {
  if (mode === "off") return undefined;
  const trimmed = (value: string | undefined): string | undefined =>
    value && value.trim() ? value.trim() : undefined;
  if (mode === "pure") return trimmed(parts.repoRules);
  const blocks: string[] = [HEADING_NOTICE];
  for (const part of [parts.internalUrls, parts.xdBlock, parts.repoRules, parts.appendSystem]) {
    const block = trimmed(part);
    if (block) blocks.push(block);
  }
  return blocks.join("\n\n");
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
