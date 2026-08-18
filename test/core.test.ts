import { describe, expect, test } from "bun:test";
import { AnchorCycle, isProAndHigh, shouldAnchor } from "../src/core";

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

describe("AnchorCycle", () => {
  test("starts idle (not anchoring)", () => {
    expect(new AnchorCycle().isAnchoring).toBe(false);
  });

  test("start begins anchoring", () => {
    const c = new AnchorCycle();
    c.start();
    expect(c.isAnchoring).toBe(true);
  });

  test("promoteOnce returns true while anchoring and auto-resets", () => {
    const c = new AnchorCycle();
    c.start();
    expect(c.promoteOnce()).toBe(true);
    expect(c.isAnchoring).toBe(false);
  });

  test("promoteOnce returns false when not anchoring (idle)", () => {
    const c = new AnchorCycle();
    expect(c.promoteOnce()).toBe(false);
  });

  test("promoteOnce is one-time (second call false after reset)", () => {
    const c = new AnchorCycle();
    c.start();
    c.promoteOnce();
    expect(c.promoteOnce()).toBe(false);
  });

  test("reset returns to idle", () => {
    const c = new AnchorCycle();
    c.start();
    c.reset();
    expect(c.isAnchoring).toBe(false);
  });
});

describe("shouldAnchor", () => {
  test("anchors when anchoring and condition active", () => {
    expect(shouldAnchor(true, true)).toBe(true);
  });

  test("does not anchor when not anchoring", () => {
    expect(shouldAnchor(false, true)).toBe(false);
  });

  test("does not anchor when condition inactive", () => {
    expect(shouldAnchor(true, false)).toBe(false);
  });
});
