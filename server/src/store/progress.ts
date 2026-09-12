import path from "node:path";
import type { Progress } from "@teacher/shared";
import { readJson, withFileLock, writeJsonInLock } from "./jsonStore.js";

// A day keeps the streak alive if the learner completes a lesson OR racks up
// at least this many minutes of active lesson time (fed by the activity
// heartbeat from the Lesson view).
const STREAK_ACTIVITY_MINUTES = 15;

function emptyProgress(): Progress {
  // Fresh object every call — read-modify-write mutates the value readJson
  // returns, and a shared constant would leak state between calls.
  return {
    lessons: {},
    streak: { current: 0, best: 0, lastActiveDate: "" },
    totals: { runs: 0, checksPassed: 0, checksFailed: 0 },
    version: 1,
  };
}

function progressFile(dataDir: string): string {
  return path.join(dataDir, "progress.json");
}

function localDateString(d = new Date()): string {
  // Local calendar date, not UTC — streaks follow the user's clock.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function yesterdayString(): string {
  // Calendar arithmetic, not "now minus 24h" — DST days aren't 24 hours long.
  const now = new Date();
  return localDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
}

function touchStreak(p: Progress): void {
  const today = localDateString();
  if (p.streak.lastActiveDate === today) return;
  p.streak.current = p.streak.lastActiveDate === yesterdayString() ? p.streak.current + 1 : 1;
  p.streak.best = Math.max(p.streak.best, p.streak.current);
  p.streak.lastActiveDate = today;
}

async function readProgress(dataDir: string): Promise<Progress> {
  const p = await readJson(progressFile(dataDir), emptyProgress());
  // Minimal shape repair — a hand-edited file must never 500 the routes.
  p.lessons ??= {};
  p.streak ??= { current: 0, best: 0, lastActiveDate: "" };
  p.totals ??= { runs: 0, checksPassed: 0, checksFailed: 0 };
  // A lapsed streak is over now, not at the next completion: if the last
  // active day is neither today nor yesterday, the current run is 0.
  if (p.streak.lastActiveDate !== localDateString() && p.streak.lastActiveDate !== yesterdayString()) {
    p.streak.current = 0;
  }
  return p;
}

/** Read-modify-write under the per-file lock so concurrent requests
 *  (runs, checks, tutor tools, activity pings) can't lose updates. */
async function mutateProgress(dataDir: string, mutate: (p: Progress) => void): Promise<Progress> {
  const file = progressFile(dataDir);
  return withFileLock(file, async () => {
    const p = await readProgress(dataDir);
    mutate(p);
    p.version = 1;
    await writeJsonInLock(file, p);
    return p;
  });
}

export async function getProgress(dataDir: string): Promise<Progress> {
  return readProgress(dataDir);
}

export async function recordAttempt(dataDir: string, lessonKey: string): Promise<Progress> {
  return mutateProgress(dataDir, (p) => {
    const lp = (p.lessons[lessonKey] ??= { attempts: 0, timeSpentMin: 0 });
    lp.attempts += 1;
    p.totals.runs += 1;
  });
}

/**
 * Marks a lesson (or project stage) done. `first` is decided inside the file
 * lock: reading it beforehand let two overlapping completions both see "not
 * yet done" and both write a journal entry.
 */
export async function completeLesson(
  dataDir: string,
  lessonKey: string,
): Promise<{ progress: Progress; first: boolean }> {
  let first = false;
  const progress = await mutateProgress(dataDir, (p) => {
    const lp = (p.lessons[lessonKey] ??= { attempts: 0, timeSpentMin: 0 });
    if (!lp.completedAt) {
      lp.completedAt = new Date().toISOString();
      first = true;
    }
    touchStreak(p);
  });
  return { progress, first };
}

export async function recordChecks(dataDir: string, passed: number, failed: number): Promise<void> {
  await mutateProgress(dataDir, (p) => {
    p.totals.checksPassed += passed;
    p.totals.checksFailed += failed;
  });
}

/** Activity heartbeat: accumulate active time into today's tally (and the
 *  lesson's timeSpentMin), and keep the streak alive once today crosses the
 *  ≥15-minute activity threshold — completing a lesson isn't the only way. */
export async function recordActivity(dataDir: string, seconds: number, lessonKey?: string): Promise<Progress> {
  return mutateProgress(dataDir, (p) => {
    const today = localDateString();
    if (p.streak.todayDate !== today) {
      p.streak.todayDate = today;
      p.streak.todayMinutes = 0;
    }
    const minutes = seconds / 60;
    p.streak.todayMinutes = (p.streak.todayMinutes ?? 0) + minutes;
    if (lessonKey) {
      const lp = (p.lessons[lessonKey] ??= { attempts: 0, timeSpentMin: 0 });
      lp.timeSpentMin += minutes;
    }
    if (p.streak.todayMinutes >= STREAK_ACTIVITY_MINUTES) touchStreak(p);
  });
}
