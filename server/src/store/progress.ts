import path from "node:path";
import type { Progress } from "@teacher/shared";
import { readJson, withFileLock, writeJsonInLock } from "./jsonStore.js";
import { PRACTICE_MINUTES, isDateString, localDateString, markPracticeDay } from "./practice.js";

function emptyProgress(): Progress {
  // Fresh object every call — read-modify-write mutates the value readJson
  // returns, and a shared constant would leak state between calls.
  return {
    lessons: {},
    practiceDays: [],
    today: { date: "", minutes: 0 },
    totals: { runs: 0, checksPassed: 0, checksFailed: 0 },
    version: 2,
  };
}

function progressFile(dataDir: string): string {
  return path.join(dataDir, "progress.json");
}

/** Playground and placement keys ride the same routes but aren't lessons;
 *  "pick up where you left off" must never point at them. */
function isLessonKey(key: string): boolean {
  return !/^(playground|placement)[/-]/.test(key);
}

function touchLastActive(p: Progress, key: string): void {
  if (isLessonKey(key)) p.lastActive = { key, at: new Date().toISOString() };
}

/**
 * Version 1 kept a daily streak: current/best, the last day that counted, and
 * today's minute tally. Version 2 keeps the list of practice days instead. The
 * old file only remembers the LAST counted day, so the migration rebuilds the
 * list from every completion date plus that one. Days that counted through
 * minutes alone, before the last one, are gone — the old format never stored
 * them.
 */
function migrate(raw: Record<string, unknown>, p: Progress): void {
  const old = (raw.streak ?? {}) as { lastActiveDate?: unknown; todayDate?: unknown; todayMinutes?: unknown };
  if (!Array.isArray(p.practiceDays)) {
    const days: string[] = [];
    for (const lp of Object.values(p.lessons)) {
      if (lp?.completedAt) markPracticeDay(days, localDateString(new Date(lp.completedAt)));
    }
    if (isDateString(old.lastActiveDate)) markPracticeDay(days, old.lastActiveDate);
    p.practiceDays = days;
  }
  p.practiceDays = [...new Set(p.practiceDays.filter(isDateString))].sort();
  if (!p.today || !isDateString(p.today.date) || typeof p.today.minutes !== "number") {
    p.today = isDateString(old.todayDate)
      ? { date: old.todayDate, minutes: typeof old.todayMinutes === "number" ? old.todayMinutes : 0 }
      : { date: "", minutes: 0 };
  }
  delete (p as unknown as Record<string, unknown>).streak;
}

async function readProgress(dataDir: string): Promise<Progress> {
  const raw = await readJson<Record<string, unknown>>(progressFile(dataDir), emptyProgress() as unknown as Record<string, unknown>);
  const p = raw as unknown as Progress;
  // Minimal shape repair — a hand-edited file must never 500 the routes.
  p.lessons ??= {};
  p.totals ??= { runs: 0, checksPassed: 0, checksFailed: 0 };
  migrate(raw, p);
  return p;
}

/** Read-modify-write under the per-file lock so concurrent requests
 *  (runs, checks, tutor tools, activity pings) can't lose updates. */
async function mutateProgress(dataDir: string, mutate: (p: Progress) => void): Promise<Progress> {
  const file = progressFile(dataDir);
  return withFileLock(file, async () => {
    const p = await readProgress(dataDir);
    mutate(p);
    p.version = 2;
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
    touchLastActive(p, lessonKey);
  });
}

/** Opening a lesson is enough to make it the one "pick up where you left off"
 *  returns to — nothing has to be run or typed first. */
export async function recordVisit(dataDir: string, lessonKey: string): Promise<Progress> {
  return mutateProgress(dataDir, (p) => touchLastActive(p, lessonKey));
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
    markPracticeDay(p.practiceDays, localDateString());
    touchLastActive(p, lessonKey);
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
 *  lesson's timeSpentMin), and count the day once the tally reaches
 *  PRACTICE_MINUTES — completing a lesson isn't the only way a day counts. */
export async function recordActivity(dataDir: string, seconds: number, lessonKey?: string): Promise<Progress> {
  return mutateProgress(dataDir, (p) => {
    const today = localDateString();
    if (p.today.date !== today) p.today = { date: today, minutes: 0 };
    const minutes = seconds / 60;
    p.today.minutes += minutes;
    if (lessonKey) {
      const lp = (p.lessons[lessonKey] ??= { attempts: 0, timeSpentMin: 0 });
      lp.timeSpentMin += minutes;
      touchLastActive(p, lessonKey);
    }
    // A hair under the threshold still counts: heartbeats are whole minutes
    // measured by a browser timer, and 9.99 minutes is ten.
    if (p.today.minutes >= PRACTICE_MINUTES - 0.05) markPracticeDay(p.practiceDays, today);
  });
}
