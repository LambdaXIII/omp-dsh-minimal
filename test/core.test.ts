import { describe, expect, test } from "bun:test";
import {
  MINIMAL_PERSONA,
  SessionHeadTracker,
  ExitNoticeTracker,
  detectProtocol,
  extractUrl,
  BASH_EXPANDED_PROTOCOLS,
  formatNumberedContent,
} from "../src/core";

describe("MINIMAL_PERSONA", () => {
  test("is the dsh minimal persona verbatim", () => {
    expect(MINIMAL_PERSONA).toBe("You are a helpful software engineer assistant.");
  });
});

describe("formatNumberedContent", () => {
  test("numbers each line with N| prefix", () => {
    expect(formatNumberedContent("line one\nline two")).toBe("1| line one\n2| line two");
  });
});

describe("SessionHeadTracker", () => {
  test("starts at head", () => {
    expect(new SessionHeadTracker().atHead).toBe(true);
  });

  test("a real request leaves the head", () => {
    const t = new SessionHeadTracker();
    t.onRequestStart();
    expect(t.atHead).toBe(false);
  });

  test("session_start resets to head", () => {
    const t = new SessionHeadTracker();
    t.onRequestStart();
    t.onSessionStart();
    expect(t.atHead).toBe(true);
  });

  test("session_switch handoff resets to head", () => {
    const t = new SessionHeadTracker();
    t.onRequestStart();
    t.onSessionSwitch("handoff");
    expect(t.atHead).toBe(true);
  });

  test("session_switch new resets to head", () => {
    const t = new SessionHeadTracker();
    t.onRequestStart();
    t.onSessionSwitch("new");
    expect(t.atHead).toBe(true);
  });

  test("session_switch fork keeps the state", () => {
    const t = new SessionHeadTracker();
    t.onRequestStart();
    t.onSessionSwitch("fork");
    expect(t.atHead).toBe(false);
  });

  test("session_switch resume keeps the state", () => {
    const t = new SessionHeadTracker();
    t.onRequestStart();
    t.onSessionSwitch("resume");
    expect(t.atHead).toBe(false);
  });
});

describe("ExitNoticeTracker", () => {
  test("starts unarmed", () => {
    const t = new ExitNoticeTracker();
    expect(t.shouldDeliver()).toBe(false);
  });

  test("arm marks the exit notice as pending", () => {
    const t = new ExitNoticeTracker();
    t.arm();
    expect(t.shouldDeliver()).toBe(true);
  });

  test("consume delivers once and stops", () => {
    const t = new ExitNoticeTracker();
    t.arm();
    expect(t.shouldDeliver()).toBe(true);
    t.consume();
    expect(t.shouldDeliver()).toBe(false);
    t.consume();
    expect(t.shouldDeliver()).toBe(false);
  });

  test("re-arm after consume allows another notice", () => {
    const t = new ExitNoticeTracker();
    t.arm();
    t.consume();
    t.arm();
    expect(t.shouldDeliver()).toBe(true);
  });

  test("disarm cancels a pending notice", () => {
    const t = new ExitNoticeTracker();
    t.arm();
    t.disarm();
    expect(t.shouldDeliver()).toBe(false);
  });
});

describe("detectProtocol", () => {
  test.each([
    ["cat skill://foo", "skill"],
    ["ls xd://read", "xd"],
    ["echo hi > local://x.md", "local"],
    ["cat artifact://abc", "artifact"],
    ["cat history://abc", "history"],
    ["cat rule://name", "rule"],
    ["cat memory://abc", "memory"],
    ["cat mcp://uri", "mcp"],
    ["cat issue://123", "issue"],
    ["cat pr://456", "pr"],
    ["cat vault://v/p", "vault"],
    ["cat omp://docs", "omp"],
  ])("detects %s -> %s", (command, expected) => {
    expect(detectProtocol(command)).toBe(expected);
  });

  test("returns undefined for plain shell commands", () => {
    expect(detectProtocol("ls -la")).toBeUndefined();
    expect(detectProtocol("cat /tmp/foo.txt")).toBeUndefined();
    expect(detectProtocol("echo no protocol here")).toBeUndefined();
    expect(detectProtocol("")).toBeUndefined();
  });

  test("detects protocol mid-pipeline", () => {
    expect(detectProtocol("cd /tmp && cat skill://x")).toBe("skill");
    expect(detectProtocol("cat local://a.md | head")).toBe("local");
  });
});

describe("extractUrl", () => {
  test("covers every protocol bash expands natively", () => {
    expect(BASH_EXPANDED_PROTOCOLS).toEqual({
      skill: true,
      agent: true,
      artifact: true,
      memory: true,
      rule: true,
      local: true,
    });
  });
});

describe("extractUrl", () => {
  test("extracts the full protocol URL token", () => {
    expect(extractUrl("cat xd://read", "xd")).toBe("xd://read");
    expect(extractUrl("ls xd://read | head", "xd")).toBe("xd://read");
    expect(extractUrl("cat issue://123", "issue")).toBe("issue://123");
  });

  test("stops at quotes and metacharacters", () => {
    expect(extractUrl("cat 'xd://read'", "xd")).toBe("xd://read");
    expect(extractUrl("cat xd://read; echo done", "xd")).toBe("xd://read");
  });

  test("returns undefined when the protocol is absent", () => {
    expect(extractUrl("cat /tmp/foo.txt", "xd")).toBeUndefined();
  });
});


