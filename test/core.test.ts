import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MINIMAL_PERSONA, parseToolCall, dispatchTool, SessionHeadTracker, isProAndHigh } from "../src/core";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "dspro-boost-"));
  await writeFile(join(dir, "a.txt"), "line one\nline two\n");
  await writeFile(join(dir, "b.txt"), "target here\nother\n");
  await mkdir(join(dir, "sub"));
  await writeFile(join(dir, "sub", "c.txt"), "nested target\n");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("MINIMAL_PERSONA", () => {
  test("is the dsh minimal persona verbatim", () => {
    expect(MINIMAL_PERSONA).toBe("You are a helpful software engineer assistant.");
  });
});

describe("parseToolCall", () => {
  test("recognizes a valid JSON-serialized tool call", () => {
    const command = JSON.stringify({ name: "read", arguments: { path: "src/foo.ts" } });
    expect(parseToolCall(command)).toEqual({ kind: "tool", name: "read", args: { path: "src/foo.ts" } });
  });

  test("treats a plain shell command as shell", () => {
    expect(parseToolCall("ls -la")).toEqual({ kind: "shell" });
  });

  test("treats non-JSON as shell", () => {
    expect(parseToolCall("cat src/foo.ts")).toEqual({ kind: "shell" });
  });

  test("treats malformed JSON as shell", () => {
    expect(parseToolCall('{"name": "read"')).toEqual({ kind: "shell" });
  });

  test("treats JSON without arguments as shell", () => {
    expect(parseToolCall('{"name": "read"}')).toEqual({ kind: "shell" });
  });

  test("treats JSON with non-string name as shell", () => {
    expect(parseToolCall('{"name": 42, "arguments": {}}')).toEqual({ kind: "shell" });
  });

  test("treats JSON with non-object arguments as shell", () => {
    expect(parseToolCall('{"name": "read", "arguments": "x"}')).toEqual({ kind: "shell" });
  });

  test("treats JSON array as shell", () => {
    expect(parseToolCall('[{"name": "read"}]')).toEqual({ kind: "shell" });
  });

  test("treats empty string as shell", () => {
    expect(parseToolCall("")).toEqual({ kind: "shell" });
  });
});

describe("dispatchTool", () => {
  test("read returns file content with line numbers", async () => {
    const r = await dispatchTool("read", { path: join(dir, "a.txt") });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("1| line one");
    expect(r.content).toContain("2| line two");
  });

  test("read errors on missing file", async () => {
    const r = await dispatchTool("read", { path: join(dir, "nope.txt") });
    expect(r.ok).toBe(false);
  });

  test("write creates/overwrites a file", async () => {
    const target = join(dir, "written.txt");
    const r = await dispatchTool("write", { path: target, content: "hello\nworld\n" });
    expect(r.ok).toBe(true);
    expect(await readFile(target, "utf8")).toBe("hello\nworld\n");
  });

  test("edit replaces a unique old_string exactly", async () => {
    const target = join(dir, "a.txt");
    const r = await dispatchTool("edit", { path: target, old_string: "line one", new_string: "line ONE" });
    expect(r.ok).toBe(true);
    expect(await readFile(target, "utf8")).toBe("line ONE\nline two\n");
  });

  test("edit errors when old_string is absent", async () => {
    const r = await dispatchTool("edit", { path: join(dir, "a.txt"), old_string: "absent", new_string: "x" });
    expect(r.ok).toBe(false);
  });

  test("edit errors when old_string is not unique", async () => {
    await writeFile(join(dir, "dup.txt"), "same\nsame\n");
    const r = await dispatchTool("edit", { path: join(dir, "dup.txt"), old_string: "same", new_string: "x" });
    expect(r.ok).toBe(false);
  });

  test("glob lists matching files", async () => {
    const r = await dispatchTool("glob", { pattern: join(dir, "*.txt") });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("a.txt");
    expect(r.content).toContain("b.txt");
  });

  test("grep finds matching lines recursively", async () => {
    const r = await dispatchTool("grep", { pattern: "target", path: dir });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("b.txt");
    expect(r.content).toContain("nested target");
  });

  test("interactive tools return unavailable", async () => {
    const r = await dispatchTool("ask", { question: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not available in the minimal environment");
  });

  test("unknown tool name returns unavailable", async () => {
    const r = await dispatchTool("no-such-tool", {});
    expect(r.ok).toBe(false);
  });
});

describe("SessionHeadTracker", () => {
  test("starts at session head", () => {
    const t = new SessionHeadTracker();
    expect(t.atHead).toBe(true);
  });

  test("session_start resets to head", () => {
    const t = new SessionHeadTracker();
    t.onRequestStart();
    t.onSessionStart();
    expect(t.atHead).toBe(true);
  });

  test("a real request leaves the head", () => {
    const t = new SessionHeadTracker();
    t.onRequestStart();
    expect(t.atHead).toBe(false);
  });

  test("handoff switch resets to head", () => {
    const t = new SessionHeadTracker();
    t.onRequestStart();
    t.onSessionSwitch("handoff");
    expect(t.atHead).toBe(true);
  });

  test("new session switch resets to head", () => {
    const t = new SessionHeadTracker();
    t.onRequestStart();
    t.onSessionSwitch("new");
    expect(t.atHead).toBe(true);
  });

  test("fork switch keeps the head state", () => {
    const t = new SessionHeadTracker();
    t.onRequestStart();
    t.onSessionSwitch("fork");
    expect(t.atHead).toBe(false);
  });

  test("resume switch keeps the head state", () => {
    const t = new SessionHeadTracker();
    t.onRequestStart();
    t.onSessionSwitch("resume");
    expect(t.atHead).toBe(false);
  });

  // Compact keeps the head state implicitly: only session_start and
  // handoff/new switches reset it (no method exists for compact events).
});

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
