import path from "node:path";
import fs from "node:fs/promises";
import { Router } from "express";
import { DEFAULT_SETTINGS, settingsSchema, type Progress, type ProgressWithPractice } from "@teacher/shared";
import { isKnownLessonKey } from "../curriculum/loader.js";
import { readJson } from "../store/jsonStore.js";
import { localDateString, summarizePractice } from "../store/practice.js";
import { getProgress, recordActivity, recordVisit } from "../store/progress.js";
import { resetAllTutorState } from "../tutor/service.js";

/** The weekly goal lives in settings; a missing or hand-mangled value is the default. */
async function weeklyGoal(dataDir: string): Promise<number> {
  const raw = await readJson<Record<string, unknown>>(path.join(dataDir, "settings.json"), {});
  const parsed = settingsSchema.shape.weeklyGoal.safeParse(raw?.weeklyGoal);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS.weeklyGoal;
}

async function withPractice(dataDir: string, p: Progress): Promise<ProgressWithPractice> {
  return { ...p, practice: summarizePractice(p.practiceDays, await weeklyGoal(dataDir), localDateString()) };
}

export function progressRoutes(dataDir: string): Router {
  const r = Router();

  // Wipes learning state; keeps settings + profile. The x-confirm header is
  // the server-side twin of the Settings UI's confirm dialog — no accidental
  // (or cross-site) wipes.
  r.post("/api/progress/reset", async (req, res) => {
    if (req.get("x-confirm") !== "reset") {
      res.status(400).json({ error: 'progress reset requires the "x-confirm: reset" header' });
      return;
    }
    // Close live tutor sessions and delete their SDK transcripts first — a
    // wipe shouldn't leave conversation history behind outside data/.
    await resetAllTutorState(dataDir).catch(() => {});
    const failed: string[] = [];
    for (const target of ["progress.json", "journal.json", "drafts", "snapshots", "sessions"]) {
      try {
        // maxRetries: Windows file locks (editors, antivirus) reject the
        // first rm; force only covers nonexistence.
        await fs.rm(path.join(dataDir, target), { recursive: true, force: true, maxRetries: 3 });
      } catch (err) {
        failed.push(`${target} (${(err as NodeJS.ErrnoException).code ?? String(err)})`);
      }
    }
    if (failed.length > 0) {
      res.status(500).json({ error: `couldn't delete: ${failed.join(", ")} — close anything using the data folder and retry` });
      return;
    }
    res.status(204).end();
  });

  r.get("/api/progress", async (_req, res) => {
    res.json(await withPractice(dataDir, await getProgress(dataDir)));
  });

  // Activity heartbeat from the Lesson view (60 s ticks while visible, plus a
  // partial tick when the lesson closes): feeds per-lesson time-spent and the
  // minutes rule for a practice day. Completion stays /api/check's job —
  // there is no manual-complete endpoint.
  r.post("/api/progress/activity", async (req, res) => {
    const seconds = Number(req.body?.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) {
      res.status(400).json({ error: "seconds must be between 1 and 3600" });
      return;
    }
    const lessonKey =
      typeof req.body?.lessonKey === "string" && req.body.lessonKey ? (req.body.lessonKey as string) : undefined;
    res.json(await withPractice(dataDir, await recordActivity(dataDir, seconds, lessonKey)));
  });

  // Opening a lesson makes it the one "pick up where you left off" returns to.
  // Only real lesson and stage keys — this comes in off the wire.
  r.post("/api/progress/visit", async (req, res) => {
    const lessonKey = typeof req.body?.lessonKey === "string" ? (req.body.lessonKey as string) : "";
    if (!(await isKnownLessonKey(lessonKey))) {
      res.status(400).json({ error: "lessonKey must name a lesson" });
      return;
    }
    await recordVisit(dataDir, lessonKey);
    res.status(204).end();
  });

  return r;
}
