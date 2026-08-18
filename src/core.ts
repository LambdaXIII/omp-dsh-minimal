/**
 * dspro-boost — pure logic (no omp dependency).
 *
 * This is the single unit-test seam for the plugin. All behavior that can be
 * decided without ExtensionAPI lives here; src/index.ts only wires these
 * functions/classes to omp events and commands.
 *
 * One-shot anchoring model (D6/D7/D8): a `/dspro-boost` command starts one
 * anchoring cycle; promotion happens only on the first tool call and the cycle
 * auto-resets. Cancellation restores the full tool set.
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
 * One-shot anchoring cycle (ADR-0004, D6/D7/D8). A command starts the cycle
 * (anchoring); promotion happens once, triggered only by the first tool call,
 * and the cycle auto-resets. Pure state, no omp dependency.
 */
export class AnchorCycle {
  private _anchoring = false;

  /** Whether the cycle is currently anchoring (started, not promoted, not reset). */
  get isAnchoring(): boolean {
    return this._anchoring;
  }

  /** Start a one-shot anchoring cycle (bare `/dspro-boost`). */
  start(): void {
    this._anchoring = true;
  }

  /**
   * Promote once, only while anchoring. On success the cycle auto-resets and
   * returns true (caller must restore the full tool set); otherwise false
   * (not anchoring, or already promoted/reset). Plain-text replies never call
   * this — the wiring layer only calls it from the first tool call.
   */
  promoteOnce(): boolean {
    if (!this._anchoring) return false;
    this._anchoring = false;
    return true;
  }

  /** Cancel the anchoring cycle (config no longer pro+High) → back to idle. */
  reset(): void {
    this._anchoring = false;
  }
}

/**
 * Whether the current turn should anchor (bootstrap): the cycle is anchoring
 * (started, not yet promoted) AND the activation condition holds. `active` is
 * the caller's `isProAndHigh(modelId, thinkingLevel)`.
 */
export function shouldAnchor(isAnchoring: boolean, active: boolean): boolean {
  return isAnchoring && active;
}
