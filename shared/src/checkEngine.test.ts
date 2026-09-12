import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  buildJsTestProgram,
  buildPyTestProgram,
  completionVerdict,
  evaluateStdoutCheck,
  evaluateTestsCheck,
  extractTestEvents,
  inlineStylesheets,
} from "./checkEngine.js";
import type { CheckResult, RunResult } from "./types.js";

function run(overrides: Partial<RunResult>): RunResult {
  return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, ...overrides };
}

describe("evaluateStdoutCheck", () => {
  const spec = { id: "c", type: "stdout", entry: "main.py", match: "exact", value: "hi\n" } as const;

  it("passes on exact match", () => {
    expect(evaluateStdoutCheck(spec, run({ stdout: "hi\n" })).passed).toBe(true);
  });

  it("normalizes CRLF from Windows runtimes", () => {
    expect(evaluateStdoutCheck(spec, run({ stdout: "hi\r\n" })).passed).toBe(true);
  });

  it("fails on wrong output and reports actual", () => {
    const r = evaluateStdoutCheck(spec, run({ stdout: "bye\n" }));
    expect(r.passed).toBe(false);
    expect(r.actual).toBe("bye\n");
  });

  it("fails on crash", () => {
    expect(evaluateStdoutCheck(spec, run({ ok: false, exitCode: 1 })).passed).toBe(false);
  });

  it("fails on timeout", () => {
    expect(evaluateStdoutCheck(spec, run({ ok: false, timedOut: true })).passed).toBe(false);
  });

  it("supports contains and regex", () => {
    const contains = { ...spec, match: "contains", value: "world" } as const;
    expect(evaluateStdoutCheck(contains, run({ stdout: "hello world!\n" })).passed).toBe(true);
    const regex = { ...spec, match: "regex", value: "^\\d{4}$" } as const;
    expect(evaluateStdoutCheck(regex, run({ stdout: "2026" })).passed).toBe(true);
    expect(evaluateStdoutCheck(regex, run({ stdout: "20x6" })).passed).toBe(false);
  });

  it("strips real ANSI color sequences from output", () => {
    expect(evaluateStdoutCheck(spec, run({ stdout: "\x1b[32mhi\x1b[0m\n" })).passed).toBe(true);
  });

  it("leaves bracket-digit text like '[10m' alone (escape byte required)", () => {
    const rope = { ...spec, value: "The rope is [10m long\n" } as const;
    expect(evaluateStdoutCheck(rope, run({ stdout: "The rope is [10m long\n" })).passed).toBe(true);
    // Without the ESC byte, "[32m" is ordinary output — it must NOT be stripped.
    expect(evaluateStdoutCheck(spec, run({ stdout: "[32mhi[0m\n" })).passed).toBe(false);
  });
});

describe("evaluateTestsCheck", () => {
  const spec = { id: "t", type: "tests", entry: "main.py", testFile: "tests/t.py" } as const;

  it("passes when all events pass", () => {
    const r = evaluateTestsCheck(spec, run({ events: [{ name: "a", passed: true }] }));
    expect(r.passed).toBe(true);
  });

  it("fails with named failures", () => {
    const r = evaluateTestsCheck(
      spec,
      run({ events: [{ name: "a", passed: true }, { name: "b", passed: false, message: "boom" }] }),
    );
    expect(r.passed).toBe(false);
    expect(r.message).toContain("b (boom)");
  });

  it("fails when no events were produced (crash before tests)", () => {
    expect(evaluateTestsCheck(spec, run({ ok: false, stderr: "SyntaxError" })).passed).toBe(false);
  });

  it("fails when the program crashed even though every test passed", () => {
    const r = evaluateTestsCheck(spec, run({ ok: false, exitCode: 1, events: [{ name: "a", passed: true }] }));
    expect(r.passed).toBe(false);
    expect(r.message).toContain("crashed");
  });
});

describe("completionVerdict", () => {
  const passed = (id: string): CheckResult => ({ checkId: id, passed: true, message: "ok" });
  const failed = (id: string): CheckResult => ({ checkId: id, passed: false, message: "no" });

  it("completes when every check passes", () => {
    expect(completionVerdict([passed("a"), passed("b")])).toEqual({ complete: true, blockedBy: [] });
  });

  it("a failed deterministic check blocks", () => {
    expect(completionVerdict([passed("a"), failed("b")])).toEqual({ complete: false, blockedBy: ["b"] });
  });

  it("an ai-judge that FAILED (returned a verdict) blocks", () => {
    const judged: CheckResult = { checkId: "ai", passed: false, message: "Not quite there yet." };
    expect(completionVerdict([passed("a"), judged]).complete).toBe(false);
  });

  it("an UNREACHABLE ai-judge never blocks", () => {
    const offline: CheckResult = {
      checkId: "ai",
      passed: false,
      unreachable: true,
      message: "Couldn't reach the tutor to grade this — it won't block you.",
    };
    expect(completionVerdict([passed("a"), offline])).toEqual({ complete: true, blockedBy: [] });
  });

  it("unreachable judge plus a failing deterministic check still blocks on the latter", () => {
    const offline: CheckResult = { checkId: "ai", passed: false, unreachable: true, message: "offline" };
    expect(completionVerdict([failed("b"), offline])).toEqual({ complete: false, blockedBy: ["b"] });
  });
});

describe("extractTestEvents (nonce-protected)", () => {
  it("separates events carrying the run nonce from normal output", () => {
    const [clean, events] = extractTestEvents('hello\n__TEST__abc123__{"name":"a","passed":true}\nworld', "abc123");
    expect(clean).toBe("hello\nworld");
    expect(events).toEqual([{ name: "a", passed: true }]);
  });

  it("rejects forged lines without the nonce (they stay ordinary output)", () => {
    const forged = '__TEST__{"name":"forged","passed":true}';
    const [clean, events] = extractTestEvents(forged, "abc123");
    expect(clean).toBe(forged);
    expect(events).toEqual([]);
  });

  it("rejects lines carrying a wrong nonce", () => {
    const [clean, events] = extractTestEvents('__TEST__deadbeef__{"name":"x","passed":true}', "abc123");
    expect(clean).toContain("deadbeef");
    expect(events).toEqual([]);
  });

  it("keeps malformed marker lines as output", () => {
    const [clean, events] = extractTestEvents("__TEST__abc123__not-json", "abc123");
    expect(clean).toBe("__TEST__abc123__not-json");
    expect(events).toEqual([]);
  });

  it("extracts nothing when no nonce is provided (plain runs have no harness)", () => {
    const [clean, events] = extractTestEvents('__TEST__{"name":"a","passed":true}', undefined);
    expect(clean).toBe('__TEST__{"name":"a","passed":true}');
    expect(events).toEqual([]);
  });
});

describe("test program builders", () => {
  it("JS: binds test/expect AFTER user code, inside a block, with the nonce baked in", () => {
    const prog = buildJsTestProgram("function test(a, b) { return a * b; }", 'test("t", () => {});', "cafe01");
    expect(prog).toContain('__TEST__cafe01__');
    expect(prog).not.toContain("__NONCE__");
    const userIdx = prog.indexOf("function test(a, b)");
    const bindIdx = prog.indexOf("const test = __check_test;");
    const testIdx = prog.indexOf('test("t"');
    expect(userIdx).toBeGreaterThan(-1);
    expect(bindIdx).toBeGreaterThan(userIdx);
    expect(testIdx).toBeGreaterThan(bindIdx);
  });

  it("Python: appends the harness after user code so `test = __check_test` wins", () => {
    const prog = buildPyTestProgram("def test():\n    pass", 'test("t", lambda: None)', "cafe01");
    expect(prog).toContain('__TEST__cafe01__');
    expect(prog).not.toContain("__NONCE__");
    expect(prog.indexOf("test = __check_test")).toBeGreaterThan(prog.indexOf("def test():"));
  });
});

describe("inlineStylesheets", () => {
  const css = "h1 { color: darkblue; }";

  it.each([
    'href="styles.css"',
    'href="./styles.css"',
    "href='styles.css'",
    "href=styles.css",
    'href = "styles.css"',
  ])("inlines <link %s>", (attr) => {
    const html = `<head><link rel="stylesheet" ${attr}></head><h1>Hi</h1>`;
    const out = inlineStylesheets(html, { "styles.css": css });
    expect(out).toContain(`<style>${css}</style>`);
    expect(out).not.toContain("<link");
  });

  it("escapes regex metacharacters in the whole filename", () => {
    const html = '<link href="a.b.css">';
    expect(inlineStylesheets(html, { "a.b.css": css })).toContain("<style>");
    expect(inlineStylesheets('<link href="aXbXcss">', { "a.b.css": css })).not.toContain("<style>");
  });

  it("never treats $& in stylesheet text as a replacement pattern", () => {
    const tricky = "h1::before { content: '$&'; }";
    const out = inlineStylesheets('<link href="styles.css">', { "styles.css": tricky });
    expect(out).toContain(tricky);
  });
});

describe("JS test harness toEqual", () => {
  // Run the combined program the way the runners would, with console.log
  // captured, then read the harness events back out of it.
  function runHarness(userCode: string, testSource: string) {
    const nonce = "abc123";
    const lines: string[] = [];
    const program = buildJsTestProgram(userCode, testSource, nonce);
    runInNewContext(program, { console: { log: (s: unknown) => lines.push(String(s)) } });
    return extractTestEvents(lines.join("\n"), nonce)[1];
  }

  it("is structural, so key order doesn't matter", () => {
    const events = runHarness(
      `function settings() { return { volume: 3, theme: "dark" }; }`,
      `test("shape", () => expect(settings()).toEqual({ theme: "dark", volume: 3 }));`,
    );
    expect(events).toEqual([{ name: "shape", passed: true }]);
  });

  it("still fails on a real difference", () => {
    const events = runHarness(
      `function settings() { return { volume: 4, theme: "dark" }; }`,
      `test("shape", () => expect(settings()).toEqual({ theme: "dark", volume: 3 }));`,
    );
    expect(events[0].passed).toBe(false);
    expect(events[0].message).toContain("expected");
  });

  it("compares nested arrays and NaN sensibly", () => {
    const events = runHarness(
      `const grid = [[1, NaN], [2, { a: [3] }]];`,
      `test("nested", () => expect(grid).toEqual([[1, NaN], [2, { a: [3] }]]));
       test("length", () => expect([1, 2]).toEqual([1, 2, 3]));`,
    );
    expect(events.map((e) => e.passed)).toEqual([true, false]);
  });
});
