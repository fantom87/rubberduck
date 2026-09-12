import crypto from "node:crypto";
import type { CheckResult, CheckSpec, Lesson, RunResult } from "@teacher/shared";
import {
  buildJsTestProgram,
  buildPyTestProgram,
  evaluateDomCheck,
  evaluateStdoutCheck,
  evaluateTestsCheck,
} from "@teacher/shared";
import { runLocal } from "../runner/localRunner.js";
import { evaluateDomAssertions } from "../runner/domCheck.js";

// Canonical check pass. The browser gives instant preview feedback with the
// same shared engine; this server-side pass is the one that counts.
// Completion is decided by completionVerdict (shared/src/checkEngine.ts).

export type JudgeFn = (lesson: Lesson, rubric: string, files: Record<string, string>, run: RunResult | null) => Promise<CheckResult>;

// M3 replaces this with the real tutor-powered judge.
let judge: JudgeFn = async (_lesson, _rubric, _files, _run) => ({
  checkId: "",
  passed: false,
  unreachable: true,
  message: "AI-graded checks arrive with the tutor (milestone M3).",
});

export function setJudge(fn: JudgeFn): void {
  judge = fn;
}

export interface CheckPassResult {
  run: RunResult | null;
  checks: CheckResult[];
}

export function testProgram(
  lesson: Lesson,
  files: Record<string, string>,
  spec: Extract<CheckSpec, { type: "tests" }>,
  testSource: string,
): { files: Record<string, string>; entry: string; nonce: string } {
  const userCode = files[spec.entry] ?? "";
  const nonce = crypto.randomBytes(8).toString("hex");
  if (lesson.language === "python") {
    return { files: { ...files, "__tests__.py": buildPyTestProgram(userCode, testSource, nonce) }, entry: "__tests__.py", nonce };
  }
  // javascript
  return { files: { ...files, "__tests__.js": buildJsTestProgram(userCode, testSource, nonce) }, entry: "__tests__.js", nonce };
}

export async function runCheckPass(
  dataDir: string,
  lesson: Lesson,
  files: Record<string, string>,
  testSources: Record<string, string>, // testFile path -> contents (loaded from lesson dir)
): Promise<CheckPassResult> {
  const checks: CheckResult[] = [];
  const lessonKey = `${lesson.trackId}/${lesson.unitId}/${lesson.id}`;
  let baseRun: RunResult | null = null;

  // Identical programs run once: a lesson with several stdout checks on the
  // same (entry, stdin) — and the ai-judge's base run — reuse one RunResult
  // instead of re-spawning per check (each C# spawn costs a compile).
  const runCache = new Map<string, RunResult>();
  const cachedRun = async (entry: string, stdin: string | undefined): Promise<RunResult> => {
    const cacheKey = JSON.stringify([entry, stdin ?? null]);
    let run = runCache.get(cacheKey);
    if (!run) {
      run = await runLocal(dataDir, {
        language: lesson.language,
        entry,
        files,
        stdin,
        timeoutMs: lesson.timeoutMs,
        lessonKey,
      });
      runCache.set(cacheKey, run);
    }
    return run;
  };

  for (const spec of lesson.checks) {
    switch (spec.type) {
      case "stdout": {
        const run = await cachedRun(spec.entry, spec.stdin);
        baseRun ??= run;
        checks.push(evaluateStdoutCheck(spec, run));
        break;
      }
      case "tests": {
        const source = testSources[spec.testFile];
        if (source === undefined) {
          checks.push({ checkId: spec.id, passed: false, message: `test file ${spec.testFile} missing` });
          break;
        }
        const prog = testProgram(lesson, files, spec, source);
        const run = await runLocal(dataDir, {
          language: lesson.language,
          entry: prog.entry,
          files: prog.files,
          timeoutMs: lesson.timeoutMs,
          lessonKey,
          nonce: prog.nonce,
        });
        baseRun ??= run; // tests-only lessons: the judge still deserves a run to look at
        checks.push(evaluateTestsCheck(spec, run));
        break;
      }
      case "dom": {
        const { outcomes, domSnapshot } = await evaluateDomAssertions(files, spec.assertions);
        baseRun ??= {
          ok: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          durationMs: 0,
          timedOut: false,
          domSnapshot,
        };
        checks.push(evaluateDomCheck(spec, outcomes));
        break;
      }
      case "ai-judge": {
        const result = await judge(lesson, spec.rubric, files, baseRun);
        checks.push({ ...result, checkId: spec.id });
        break;
      }
    }
  }

  return { run: baseRun, checks };
}
