import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CheckResult, Lesson, RunResult, Settings } from "@teacher/shared";
import { JUDGE_SYSTEM, judgePrompt } from "./prompts.js";
import { tutorOfflineReason } from "./service.js";
import { claudeExecutableOption } from "./claudeBinary.js";

// One-shot ai-judge query: no tools, single turn, strict JSON verdict.
// An unreachable judge (SDK down, auth broken, unparseable twice) reports
// `unreachable` — such a check never blocks completion; a real verdict does.

export function sdkEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "ANTHROPIC_API_KEY") env[k] = v; // never bill a stray API key
  }
  return env;
}

// The reference solution is always included in judge grading when one exists.
// Registered by tutorRoutes (which owns the curriculum handle); callers may
// also pass a solution explicitly to skip the lookup.
type SolutionProvider = (lessonKey: string) => Promise<Record<string, string> | null>;
let solutionProvider: SolutionProvider | null = null;

export function setSolutionProvider(fn: SolutionProvider): void {
  solutionProvider = fn;
}

async function loadSolution(lesson: Lesson): Promise<Record<string, string> | null> {
  if (!solutionProvider) return null;
  const key = `${lesson.trackId}/${lesson.unitId}/${lesson.id}`;
  return solutionProvider(key).catch(() => null);
}

export type OneShotResult = { ok: true; text: string } | { ok: false; reason: string };

// Also used by tutor/author.ts (custom lesson generation) — same no-tools,
// single-turn, subscription-auth query shape.
// A wedged Claude subprocess would otherwise pin the caller open for good —
// for the ai-judge that is the Check button never settling. Generous, because
// a real grading turn on a slow machine can take a while.
const ONE_SHOT_TIMEOUT_MS = 90_000;

export async function oneShot(prompt: string, systemPrompt: string, model: string): Promise<OneShotResult> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), ONE_SHOT_TIMEOUT_MS);
  timer.unref();
  try {
    for await (const message of query({
      prompt,
      options: {
        abortController,
        // The learner's own Claude Code, when they have one — we ship none.
        ...(await claudeExecutableOption()),
        model,
        systemPrompt,
        maxTurns: 1,
        allowedTools: [],
        disallowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "TodoWrite", "NotebookEdit"],
        env: sdkEnv(),
      },
    })) {
      if (message.type === "result") {
        return message.subtype === "success" ? { ok: true, text: message.result } : { ok: false, reason: message.subtype };
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      console.error(`[judge] query timed out after ${ONE_SHOT_TIMEOUT_MS / 1000}s`);
      return { ok: false, reason: "timeout" };
    }
    console.error("[judge] query failed:", err);
    return { ok: false, reason: String(err) };
  } finally {
    clearTimeout(timer);
  }
  return { ok: false, reason: "no result message" };
}

function parseVerdict(text: string): { passed: boolean; message: string } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const v = JSON.parse(match[0]) as { passed?: unknown; message?: unknown };
    if (typeof v.passed === "boolean") {
      return { passed: v.passed, message: typeof v.message === "string" ? v.message : "" };
    }
  } catch {
    // fall through
  }
  return null;
}

const UNREACHABLE_MESSAGE = "Couldn't reach the tutor to grade this — it won't block you.";

function unreachableResult(extra?: string): CheckResult {
  return {
    checkId: "",
    passed: false,
    unreachable: true,
    message: extra ? `${UNREACHABLE_MESSAGE} ${extra}` : UNREACHABLE_MESSAGE,
  };
}

export async function judgeCheck(
  getModel: () => Promise<Settings["tutorModel"]>,
  lesson: Lesson,
  rubric: string,
  files: Record<string, string>,
  run: RunResult | null,
  solution?: Record<string, string> | null,
): Promise<CheckResult> {
  // Known-unavailable tutor: don't burn two doomed attempts, and say what's
  // wrong — "not installed" and "not signed in" have different fixes.
  const offline = tutorOfflineReason();
  if (offline) return unreachableResult(`(${offline})`);

  const model = await getModel();
  const sol = solution !== undefined ? solution : await loadSolution(lesson);
  const prompt = judgePrompt(lesson, rubric, files, run, sol);

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await oneShot(prompt, JUDGE_SYSTEM, model);
    if (result.ok) {
      const verdict = parseVerdict(result.text);
      if (verdict) {
        return { checkId: "", passed: verdict.passed, message: verdict.message || (verdict.passed ? "Approved." : "Not quite there yet.") };
      }
    } else if (/usage|limit|credit/i.test(result.reason)) {
      // Out of subscription budget — retrying can't help until the window resets.
      return unreachableResult("(Claude usage limit reached — grading resumes when it resets.)");
    }
  }
  return unreachableResult();
}
