/**
 * dspro-boost — pure logic (no omp dependency).
 *
 * This is the single unit-test seam for the plugin. All behavior that can be
 * decided without ExtensionAPI lives here; src/index.ts only wires these
 * functions/classes to omp events and commands.
 *
 * See: docs/design/anchor-plugin.md · docs/adr/0001-0004
 */

/** Minimal tool set exposed during the bootstrap (anchored) phase. */
export const ANCHOR_TOOLS: readonly string[] = ["bash", "edit"];

/** dsh minimal persona, verbatim from DeepSeek Harness. */
export const MINIMAL_PERSONA = "You are a helpful software engineer assistant.";

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

/**
 * One-time promotion state machine (ADR-0004). Bootstrap → full happens once
 * per active config; a config break calls {@link reset} so the next matching
 * turn re-anchors fresh. Pure state, no omp dependency.
 */
export class AnchorMachine {
  private _promoted = false;

  /** Whether the machine has been promoted (full phase). */
  get isPromoted(): boolean {
    return this._promoted;
  }

  /**
   * Promote once. Returns true only on the first successful promotion; later
   * calls are no-ops returning false (promotion is one-time per config).
   */
  promoteOnce(): boolean {
    if (this._promoted) return false;
    this._promoted = true;
    return true;
  }

  /** Reset to un-promoted when the activation condition breaks (ADR-0004). */
  reset(): void {
    this._promoted = false;
  }
}

/**
 * Whether the current turn should anchor (bootstrap) — the conjunction of the
 * switch (ADR-0002), the activation condition (ADR-0003), and not-yet-promoted
 * (ADR-0004). `active` is the caller's `isProAndHigh(modelId, thinkingLevel)`.
 */
export function shouldAnchor(
  enabled: boolean,
  active: boolean,
  isPromoted: boolean,
): boolean {
  return enabled && active && !isPromoted;
}
