import {
  MINIMAL_PERSONA,
  SessionHeadTracker,
  ExitNoticeTracker,
  detectProtocol,
  extractUrl,
  BASH_EXPANDED_PROTOCOLS,
  formatNumberedContent,
  parseCommand,
  shouldInjectConventions,
  REQUIRED_OMP_VERSION,
  describeState,
  formatStatus,
  buildDisclosure,
  buildXdProtocolBlock,
  HEADING_NOTICE,
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

});

describe("parseCommand", () => {
  test.each([
    ["", { action: "status" }],
    ["   ", { action: "status" }],
    ["on", { action: "enter", mode: "normal" }],
    ["normal", { action: "enter", mode: "normal" }],
    ["pure", { action: "enter", mode: "pure" }],
    ["off", { action: "exit" }],
    ["status", { action: "status" }],
  ])("parses %j -> %j", (args, expected) => {
    expect(parseCommand(args as string)).toEqual(expected);
  });

  test("matches case-insensitively", () => {
    expect(parseCommand("ON")).toEqual({ action: "enter", mode: "normal" });
    expect(parseCommand("Pure")).toEqual({ action: "enter", mode: "pure" });
    expect(parseCommand("OFF")).toEqual({ action: "exit" });
  });

  test("uses only the first word, ignoring extra args", () => {
    expect(parseCommand("on extra words")).toEqual({ action: "enter", mode: "normal" });
    expect(parseCommand("normal --foo")).toEqual({ action: "enter", mode: "normal" });
    expect(parseCommand("pure whatever")).toEqual({ action: "enter", mode: "pure" });
    expect(parseCommand("off please")).toEqual({ action: "exit" });
  });

});

describe("shouldInjectConventions", () => {
  test("normal and pure inject, off does not", () => {
    expect(shouldInjectConventions("normal")).toBe(true);
    expect(shouldInjectConventions("pure")).toBe(true);
    expect(shouldInjectConventions("off")).toBe(false);
  });
});

describe("REQUIRED_OMP_VERSION", () => {
  test("requires omp 18 or newer", () => {
    expect(REQUIRED_OMP_VERSION).toBe(18);
  });
});

describe("describeState", () => {
  test.each([
    ["off", true, "off"],
    ["off", false, "off"],
    ["normal", true, "normal (injected)"],
    ["normal", false, "normal (not injected)"],
    ["pure", true, "pure (injected)"],
    ["pure", false, "pure (not injected)"],
  ])("mode=%s injected=%s -> %s", (mode, injected, expected) => {
    expect(describeState(mode as "off" | "normal" | "pure", injected as boolean)).toBe(expected);
  });
});

describe("formatStatus", () => {
  test("renders plugin, host and required versions plus state on one line", () => {
    expect(
      formatStatus("normal (injected)", { pluginVersion: "0.3.0", hostOmpVersion: "18.0.0" }),
    ).toBe("dsh-minimal 0.3.0: omp 18.0.0 (req ≥18) · normal (injected)");
  });

  test("renders pure not-injected state with versions", () => {
    expect(formatStatus("pure (not injected)", { pluginVersion: "0.3.0", hostOmpVersion: "18.1.0" })).toBe(
      "dsh-minimal 0.3.0: omp 18.1.0 (req ≥18) · pure (not injected)",
    );
  });
});

describe("HEADING_NOTICE", () => {
  test("is English and opens with the omp-context marker", () => {
    expect(HEADING_NOTICE.startsWith("<omp-context>")).toBe(true);
    expect(HEADING_NOTICE.length).toBeLessThan(300);
  });
});

describe("buildXdProtocolBlock", () => {
  test("renders the framework text plus one line per device", () => {
    const block = buildXdProtocolBlock([
      { name: "read", summary: "Read files" },
      { name: "bash", summary: "Run shell commands" },
    ]);
    expect(block.split("\n")[0]).toBe("# xd:// Tool Access");
    expect(block).toContain("xd://<tool>");
    expect(block).toContain("- read: Read files");
    expect(block).toContain("- bash: Run shell commands");
  });

  test("renders the framework even with no devices", () => {
    const block = buildXdProtocolBlock([]);
    expect(block).toContain("# xd:// Tool Access");
    expect(block).not.toContain("- ");
  });
});

describe("buildDisclosure", () => {
  const parts = {
    internalUrls: "# Internal URLs\nMost FS/bash tools auto-resolve these to FS paths.",
    xdBlock: "# xd:// Tool Access\nOmp tools are reachable from bash.",
    repoRules: "<repo-rules>\nMUST follow these context files for all tasks:\n<file path=\"AGENTS.md\">\ncontent\n</file>\n</repo-rules>",
    appendSystem: "Append system discipline text.",
  };

  test("normal assembles header + all blocks in omp render order", () => {
    const disclosure = buildDisclosure("normal", parts);
    expect(disclosure).toBe(
      [
        HEADING_NOTICE,
        parts.internalUrls,
        parts.xdBlock,
        parts.repoRules,
        parts.appendSystem,
      ].join("\n\n"),
    );
  });

  test("pure discloses only the AGENTS repo-rules block", () => {
    expect(buildDisclosure("pure", parts)).toBe(parts.repoRules);
  });

  test("off discloses nothing", () => {
    expect(buildDisclosure("off", parts)).toBeUndefined();
  });

  test("pure without repo-rules discloses nothing", () => {
    expect(buildDisclosure("pure", {})).toBeUndefined();
  });

  test("normal skips missing optional blocks but keeps the header", () => {
    const disclosure = buildDisclosure("normal", { repoRules: parts.repoRules });
    expect(disclosure).toBe([HEADING_NOTICE, parts.repoRules].join("\n\n"));
  });

  test("trims each block and joins with blank lines", () => {
    const disclosure = buildDisclosure("normal", {
      internalUrls: `  ${parts.internalUrls}\n  `,
      repoRules: `\n${parts.repoRules}\n\n`,
    });
    expect(disclosure).toBe([HEADING_NOTICE, parts.internalUrls, parts.repoRules].join("\n\n"));
  });
});


