import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import type { Snapshot } from "@teacher/shared";
import { completionVerdict } from "@teacher/shared";
import { getCurriculum } from "../curriculum/loader.js";
import { runLocal, sweepStaleWorkspaces } from "../runner/localRunner.js";
import { evaluateDomAssertions } from "../runner/domCheck.js";
import { runCheckPass } from "../checks/run.js";
import { recordAttempt, recordChecks } from "../store/progress.js";
import { recordCompletion } from "../store/completion.js";
import { readJson, withFileLock, writeJsonInLock } from "../store/jsonStore.js";
import { updateChecks } from "../tutor/service.js";
import { takeSnapshot, listSnapshots, getSnapshot } from "../store/snapshots.js";
import { detectRuntimes, type RuntimeStatus } from "../preflight.js";
import { missingRuntimeHint } from "../runtimeHints.js";
import { parseFiles } from "./files.js";

/** "That runtime isn't installed" with an install command for THIS OS, or
 *  null when the language can run here. */
function missingRuntimeError(language: string, runtimes: RuntimeStatus): string | null {
  return missingRuntimeHint(language, runtimes);
}

/** Flip `passed: true` on the snapshot just taken for a passing check — it
 *  becomes a restore point ("✓ passing") in the history menu. */
async function markCheckSnapshotPassed(dataDir: string, lessonKey: string): Promise<void> {
  const dir = path.join(dataDir, "snapshots", lessonKey.replaceAll("/", "__"));
  let entries: string[];
  try {
    entries = (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return;
  }
  const latest = entries.at(-1);
  if (!latest) return;
  const file = path.join(dir, latest);
  await withFileLock(file, async () => {
    const snap = await readJson<Snapshot | null>(file, null);
    if (snap && snap.trigger === "check") await writeJsonInLock(file, { ...snap, passed: true });
  });
}

export function runRoutes(contentDir: string, dataDir: string): Router {
  const r = Router();

  // Failed cleanups (Defender locks, killed children) leave orphaned run
  // workspaces behind; clear the stale ones at server start.
  void sweepStaleWorkspaces(dataDir);

  // Local-runner execution of the user's editor files (no goal checking).
  // Accepts real lesson keys and playground pseudo-lessons.
  r.post("/api/run", async (req, res) => {
    const { lessonId } = req.body ?? {};
    const files = parseFiles(req.body?.files);
    const { resolveLesson } = await import("./tutor.js");
    const lesson = (await resolveLesson(contentDir, String(lessonId)))?.lesson;
    if (!lesson || !files) {
      res.status(400).json({ error: "lessonId and files (path -> string) required" });
      return;
    }
    const runtimes = await detectRuntimes();
    const missing = missingRuntimeError(lesson.language, runtimes);
    if (missing) {
      res.json({ ok: false, exitCode: null, stdout: "", stderr: missing, durationMs: 0, timedOut: false });
      return;
    }
    await recordAttempt(dataDir, String(lessonId));
    await takeSnapshot(dataDir, String(lessonId), "run", files);

    if (lesson.language === "html-css") {
      // "Running" HTML = parse + snapshot; the browser shows the live preview.
      const allAssertions = lesson.checks.flatMap((c) => (c.type === "dom" ? c.assertions : []));
      const { domSnapshot } = evaluateDomAssertions(files, allAssertions);
      res.json({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0, timedOut: false, domSnapshot });
      return;
    }

    const result = await runLocal(dataDir, {
      language: lesson.language,
      entry: lesson.entry ?? lesson.files[0].path,
      files,
      timeoutMs: lesson.timeoutMs,
      lessonKey: String(lessonId),
    });
    res.json(result);
  });

  // Canonical goal check: runs, evaluates every check, and completes the
  // lesson per completionVerdict — every check must pass, except an ai-judge
  // that was unreachable (offline/auth down), which never blocks completion.
  r.post("/api/check", async (req, res) => {
    const { lessonId } = req.body ?? {};
    const files = parseFiles(req.body?.files);
    const cur = await getCurriculum(contentDir);
    const lesson = cur.lessons.get(String(lessonId));
    if (!lesson || !files) {
      res.status(400).json({ error: "lessonId and files (path -> string) required" });
      return;
    }
    const runtimes = await detectRuntimes();
    const missing = lesson.language !== "html-css" ? missingRuntimeError(lesson.language, runtimes) : null;
    if (missing) {
      res.status(409).json({ error: missing });
      return;
    }
    await takeSnapshot(dataDir, String(lessonId), "check", files);

    const pass = await runCheckPass(dataDir, lesson, files, lesson.testFiles);
    updateChecks(String(lessonId), pass.checks); // keep the tutor's <context> goal-state line fresh
    await recordChecks(dataDir, pass.checks.filter((c) => c.passed).length, pass.checks.filter((c) => !c.passed).length);

    let completed = false;
    if (completionVerdict(pass.checks).complete) {
      await recordCompletion(dataDir, String(lessonId), lesson);
      await markCheckSnapshotPassed(dataDir, String(lessonId));
      completed = true;
    }
    res.json({ run: pass.run, checks: pass.checks, completed });
  });

  r.get("/api/snapshots", async (req, res) => {
    res.json(await listSnapshots(dataDir, String(req.query.id ?? "")));
  });

  // Browser-runner lessons execute client-side; they report snapshots here.
  r.post("/api/snapshots", async (req, res) => {
    const { lessonId, trigger } = req.body ?? {};
    const files = parseFiles(req.body?.files);
    if (!lessonId || !files) {
      res.status(400).json({ error: "lessonId and files (path -> string) required" });
      return;
    }
    await recordAttempt(dataDir, String(lessonId));
    await takeSnapshot(dataDir, String(lessonId), trigger === "check" ? "check" : "run", files);
    res.status(204).end();
  });

  r.get("/api/snapshots/one", async (req, res) => {
    const snap = await getSnapshot(dataDir, String(req.query.id ?? ""), String(req.query.snap ?? ""));
    if (!snap) {
      res.status(404).json({ error: "snapshot not found" });
      return;
    }
    res.json(snap);
  });

  return r;
}
