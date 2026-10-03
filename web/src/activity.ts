import type { PracticeSummary } from "@teacher/shared";
import { api } from "./api/client";

// Active-time tracking for the lesson that's open. A tick every minute
// reports the time since the last tick, and closing the lesson (or the
// window) reports the partial minute at the end, so a "just 10 minutes"
// session that stops at 10:00 has all ten minutes on record.
//
// Two things don't count. A gap longer than a tick is never credited past one
// tick: timers stop while a laptop sleeps, and the first tick after waking
// would otherwise report the whole nap. And time with no key, click or scroll
// for IDLE_MS isn't practice either: a lesson left on screen while the
// learner is away shouldn't earn the day.

/** Fired with the fresh PracticeSummary after each report, so the app can
 *  say "that counts as a practice day" when minutes earn it. */
export const PRACTICE_EVENT = "rubberduck:practice";

const TICK_MS = 60_000;
const MAX_REPORT_SECONDS = 60;
const IDLE_MS = 5 * 60_000;

let key: string | null = null;
let lastBeat = 0;
let lastInput = Date.now();
let timer: number | undefined;

function noteInput() {
  lastInput = Date.now();
}
for (const type of ["keydown", "pointerdown", "wheel"] as const) {
  window.addEventListener(type, noteInput, { capture: true, passive: true });
}

/** Here, and looking: the window is visible and someone has touched it lately. */
function present(now: number): boolean {
  return document.visibilityState === "visible" && now - lastInput < IDLE_MS;
}

function report(seconds: number, keepalive = false): Promise<void> {
  if (!key || seconds < 1) return Promise.resolve();
  return api
    .reportActivity(Math.min(MAX_REPORT_SECONDS, Math.round(seconds)), key, keepalive)
    .then((practice: PracticeSummary | null) => {
      if (practice) window.dispatchEvent(new CustomEvent(PRACTICE_EVENT, { detail: practice }));
    })
    .catch(() => {});
}

/** Report the time since the last beat, if it was spent here, and restart the clock. */
function beat(keepalive = false): Promise<void> {
  const now = Date.now();
  const flushed = present(now) ? report((now - lastBeat) / 1000, keepalive) : Promise.resolve();
  lastBeat = now;
  return flushed;
}

// The window closing mid-lesson: keepalive lets the request outlive the page.
window.addEventListener("pagehide", () => {
  if (key) void beat(true);
});

export function beginLessonActivity(lessonKey: string): void {
  void endLessonActivity();
  key = lessonKey;
  lastBeat = Date.now();
  lastInput = Date.now(); // opening a lesson is input
  timer = window.setInterval(() => void beat(), TICK_MS);
}

/** Stops the ticks and reports the partial minute. Safe to call twice. */
export function endLessonActivity(): Promise<void> {
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
  const flushed = key ? beat() : Promise.resolve();
  key = null;
  return flushed;
}
