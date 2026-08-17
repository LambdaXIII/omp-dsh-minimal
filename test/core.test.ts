import { describe, expect, test } from "bun:test";
import { AnchorMachine, isProAndHigh, shouldAnchor } from "../src/core";

describe("isProAndHigh", () => {
  test("true for DeepSeek V4 Pro with High thinking", () => {
    expect(isProAndHigh("deepseek/deepseek-v4-pro", "high")).toBe(true);
  });

  test("true for V4Pro variant with High thinking", () => {
    expect(isProAndHigh("deepseek/deepseek-v4-pro:high", "high")).toBe(true);
  });

  test("false for non-pro model (flash) with High thinking", () => {
    expect(isProAndHigh("deepseek/deepseek-v4-flash", "high")).toBe(false);
  });

  test("false for V4 Pro with non-High thinking", () => {
    expect(isProAndHigh("deepseek/deepseek-v4-pro", "medium")).toBe(false);
  });

  test("false when model id is undefined", () => {
    expect(isProAndHigh(undefined, "high")).toBe(false);
  });

  test("false when thinking level is undefined", () => {
    expect(isProAndHigh("deepseek/deepseek-v4-pro", undefined)).toBe(false);
  });
});

describe("AnchorMachine", () => {
  test("starts un-promoted", () => {
    expect(new AnchorMachine().isPromoted).toBe(false);
  });

  test("promoteOnce returns true first time and flips state", () => {
    const m = new AnchorMachine();
    expect(m.promoteOnce()).toBe(true);
    expect(m.isPromoted).toBe(true);
  });

  test("promoteOnce is idempotent (one-time promotion)", () => {
    const m = new AnchorMachine();
    expect(m.promoteOnce()).toBe(true);
    expect(m.promoteOnce()).toBe(false);
    expect(m.isPromoted).toBe(true);
  });

  test("reset returns to un-promoted", () => {
    const m = new AnchorMachine();
    m.promoteOnce();
    m.reset();
    expect(m.isPromoted).toBe(false);
  });
});

describe("shouldAnchor", () => {
  test("anchors when enabled, condition active, un-promoted", () => {
    expect(shouldAnchor(true, true, false)).toBe(true);
  });

  test("does not anchor when switch disabled", () => {
    expect(shouldAnchor(false, true, false)).toBe(false);
  });

  test("does not anchor when condition inactive", () => {
    expect(shouldAnchor(true, false, false)).toBe(false);
  });

  test("does not re-anchor when already promoted", () => {
    expect(shouldAnchor(true, true, true)).toBe(false);
  });
});


