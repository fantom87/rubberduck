import type { CheckResult, CheckSpec, DomAssertion, RunResult, TestEvent } from "./types.js";

// Runner-agnostic goal checking. Both the browser (instant feedback) and the
// server (canonical verdict) feed RunResults through these functions, so the
// pass/fail logic exists exactly once.
//
// - stdout / tests checks are evaluated here from a RunResult.
// - dom checks need a live DOM; the runner evaluates assertions (browser
//   bridge or server jsdom) into DomAssertionOutcome[] and passes them in.
// - ai-judge checks are server-only (the tutor grades them) and are skipped
//   here with passed=false, message explaining they need the server.

export interface DomAssertionOutcome {
  assertion: DomAssertion;
  passed: boolean;
  detail?: string;
}

export function describeAssertion(a: DomAssertion): string {
  if ("exists" in a) return `${a.selector} exists`;
  if ("textContains" in a) return `${a.selector} contains "${a.textContains}"`;
  if ("count" in a) return `exactly ${a.count} × ${a.selector}`;
  if ("attr" in a) return `${a.selector}[${a.attr}] = "${a.equals}"`;
  return `${a.selector} has ${a.cssRule.property}: ${a.cssRule.equals}`;
}

function normalizeNewlines(s: string): string {
  // Also strip ANSI escape sequences defensively — colored output should
  // never fail an otherwise-correct answer. The escape byte is required so
  // legitimate text like "[10m" is never rewritten.
  // eslint-disable-next-line no-control-regex
  return s.replace(/\r\n/g, "\n").replace(/\x1b\[[0-9;]*m/g, "");
}

export function evaluateStdoutCheck(
  spec: Extract<CheckSpec, { type: "stdout" }>,
  run: RunResult,
): CheckResult {
  const actual = normalizeNewlines(run.stdout);
  const expected = normalizeNewlines(spec.value);
  if (run.timedOut) {
    return { checkId: spec.id, passed: false, message: "The program never finished (timed out)." };
  }
  if (!run.ok) {
    return { checkId: spec.id, passed: false, message: "The program crashed before it could produce the expected output." };
  }
  let passed: boolean;
  switch (spec.match) {
    case "exact":
      passed = actual === expected;
      break;
    case "contains":
      passed = actual.includes(expected);
      break;
    case "regex":
      passed = new RegExp(expected).test(actual);
      break;
  }
  return {
    checkId: spec.id,
    passed,
    message: passed ? "Output looks right." : "The output doesn't match what's expected yet.",
    expected: spec.match === "exact" ? expected : undefined,
    actual: passed ? undefined : actual.slice(0, 500),
  };
}

export function evaluateTestsCheck(
  spec: Extract<CheckSpec, { type: "tests" }>,
  run: RunResult,
): CheckResult {
  if (run.timedOut) {
    return { checkId: spec.id, passed: false, message: "Tests never finished (timed out)." };
  }
  const events = run.events ?? [];
  if (events.length === 0) {
    return {
      checkId: spec.id,
      passed: false,
      message: run.ok ? "No test results were produced." : "The code crashed before the tests could run.",
      actual: run.stderr.slice(0, 500) || undefined,
    };
  }
  const failed = events.filter((e) => !e.passed);
  if (failed.length === 0 && !run.ok) {
    // Every reported test passed, but the program still died (e.g. an async
    // callback threw after the tests ran). A crash is never a green check.
    return {
      checkId: spec.id,
      passed: false,
      message: `All ${events.length} test(s) passed, but the program crashed afterwards.`,
      actual: run.stderr.slice(0, 500) || undefined,
    };
  }
  return {
    checkId: spec.id,
    passed: failed.length === 0,
    message:
      failed.length === 0
        ? `All ${events.length} test(s) passed.`
        : `${failed.length}/${events.length} test(s) failed: ${failed.map((f) => f.name + (f.message ? ` (${f.message})` : "")).join("; ")}`,
  };
}

export function evaluateDomCheck(
  spec: Extract<CheckSpec, { type: "dom" }>,
  outcomes: DomAssertionOutcome[],
): CheckResult {
  const failed = outcomes.filter((o) => !o.passed);
  return {
    checkId: spec.id,
    passed: failed.length === 0 && outcomes.length === spec.assertions.length,
    message:
      failed.length === 0
        ? "The page structure looks right."
        : `Not there yet: ${failed.map((f) => f.detail ?? describeAssertion(f.assertion)).join("; ")}`,
  };
}

/**
 * The one completion gate, shared by POST /api/check and the tutor's
 * mark_complete guard: every deterministic check must pass and every ai-judge
 * check that returned a verdict must pass. An `unreachable` ai-judge result
 * (SDK offline / auth broken / unparseable) never blocks completion.
 */
export function completionVerdict(checks: CheckResult[]): { complete: boolean; blockedBy: string[] } {
  const blockedBy = checks.filter((c) => !c.passed && !c.unreachable).map((c) => c.checkId);
  return { complete: blockedBy.length === 0, blockedBy };
}

// ---------- Stylesheet inlining (shared by preview iframe + server dom-check) ----------

/**
 * Inline linked local stylesheets into an HTML string — neither the preview
 * iframe (srcdoc) nor the server's jsdom pass can fetch lesson files. Handles
 * href="styles.css", './styles.css', single quotes, and unquoted hrefs, and
 * uses a replacer function so "$&" in stylesheet text is never treated as a
 * replacement pattern.
 */
export function inlineStylesheets(html: string, files: Record<string, string>): string {
  for (const [name, contents] of Object.entries(files)) {
    if (!name.endsWith(".css")) continue;
    const file = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const linkRe = new RegExp(
      `<link\\b[^>]*\\bhref\\s*=\\s*(?:["']\\s*(?:\\./)?${file}\\s*["']|(?:\\./)?${file}(?=[\\s/>]))[^>]*>`,
      "i",
    );
    if (linkRe.test(html)) {
      // A literal "</style" in the CSS would end the injected block early and
      // spill the rest as page text; "\/" is a valid CSS escape for "/".
      const safe = contents.replace(/<\/style/gi, "<\\/style");
      html = html.replace(linkRe, () => `<style>${safe}</style>`);
    }
  }
  return html;
}

// ---------- Test harnesses (assembled around user code by the runners) ----------
//
// Hardened against learner code: the helpers live on collision-proof
// __check_* names, console.log/print are captured before user code runs, and
// every event line carries a per-run nonce so user code can't forge or spoof
// "__TEST__" results — extractTestEvents only accepts lines with the nonce.

/** JS harness prelude. The `__NONCE__` token is replaced per run by the builders. */
export const JS_TEST_HARNESS = `
const __check_prefix = "__TEST____NONCE____";
const __check_log = console.log.bind(console);
const __check_assert = (ok, msg) => { if (!ok) throw new Error(msg); };
// Structural equality. JSON.stringify comparison made {a, b} unequal to {b, a}
// and collapsed NaN, undefined and Map/Set — correct learner code was going red.
const __check_eq = (a, b) => {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => __check_eq(v, b[i]));
  if (a instanceof Map && b instanceof Map) return __check_eq([...a].sort(), [...b].sort());
  if (a instanceof Set && b instanceof Set) return __check_eq([...a].sort(), [...b].sort());
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && __check_eq(a[k], b[k]));
};
const __check_expect = (actual) => ({
  toBe(expected) { __check_assert(Object.is(actual, expected), "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual)); },
  toEqual(expected) { __check_assert(__check_eq(actual, expected), "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual)); },
  toContain(item) { __check_assert(actual.includes(item), JSON.stringify(actual) + " does not contain " + JSON.stringify(item)); },
  toBeTruthy() { __check_assert(!!actual, JSON.stringify(actual) + " is not truthy"); },
});
const __check_test = (name, fn) => {
  try { fn(); __check_log(__check_prefix + JSON.stringify({ name, passed: true })); }
  catch (e) { __check_log(__check_prefix + JSON.stringify({ name, passed: false, message: e instanceof Error ? e.message : String(e) })); }
};
`;

/** Python harness, appended AFTER user code (`test = __check_test` overrides
 *  any learner-defined `test`). The `__NONCE__` token is replaced per run. */
export const PY_TEST_HARNESS = `
import json as __check_json
from builtins import print as __check_print

__check_prefix = "__TEST____NONCE____"

def __check_test(name, fn):
    try:
        fn()
        __check_print(__check_prefix + __check_json.dumps({"name": name, "passed": True}))
    except AssertionError as e:
        __check_print(__check_prefix + __check_json.dumps({"name": name, "passed": False, "message": str(e) or "assertion failed"}))
    except Exception as e:
        __check_print(__check_prefix + __check_json.dumps({"name": name, "passed": False, "message": type(e).__name__ + ": " + str(e)}))

test = __check_test
`;

/**
 * JS combined test program: harness consts, then the learner's code, then the
 * test file inside a block that binds `test`/`expect` to the harness — so a
 * learner's own top-level `test`/`expect` (function, let, or const) is
 * shadowed instead of hijacking the harness or throwing a redeclare error.
 * The nonce should be simple hex ([a-z0-9]).
 */
export function buildJsTestProgram(userCode: string, testSource: string, nonce: string): string {
  return `${JS_TEST_HARNESS.replaceAll("__NONCE__", nonce)}\n${userCode}\n;{\nconst test = __check_test;\nconst expect = __check_expect;\n${testSource}\n}\n`;
}

/** Python combined test program: learner code, then the harness, then the test file. */
export function buildPyTestProgram(userCode: string, testSource: string, nonce: string): string {
  return `${userCode}\n${PY_TEST_HARNESS.replaceAll("__NONCE__", nonce)}\n${testSource}\n`;
}

/**
 * Parse harness event lines out of stdout; returns [cleanStdout, events].
 * Only lines carrying this run's nonce become events — anything the learner
 * prints (including forged "__TEST__" lines) stays ordinary output. With no
 * nonce (a plain run without a harness), nothing is extracted.
 */
export function extractTestEvents(stdout: string, nonce: string | undefined): [string, TestEvent[]] {
  const prefix = nonce ? `__TEST__${nonce}__` : null;
  const events: TestEvent[] = [];
  const clean: string[] = [];
  for (const line of stdout.split("\n")) {
    if (prefix && line.startsWith(prefix)) {
      try {
        events.push(JSON.parse(line.slice(prefix.length)) as TestEvent);
        continue;
      } catch {
        // fall through: treat as normal output
      }
    }
    clean.push(line);
  }
  return [clean.join("\n"), events];
}
