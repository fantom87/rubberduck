import { api } from "./api/client";

// Active-time tracking for the lesson that's open. A tick every minute
// reports the time since the last tick while the window is visible, and
// closing the lesson reports the partial minute at the end.
//
// Without that last partial report, a "just 10 minutes" session that stops at
// 10:00 has only logged nine whole minutes, and the day it was meant to earn
// doesn't count.

const TICK_MS = 60_000;

let key: string | null = null;
let lastBeat = 0;
let timer: number | undefined;

function report(seconds: number): Promise<void> {
  if (!key || seconds < 1) return Promise.resolve();
  return api.reportActivity(Math.min(3600, Math.round(seconds)), key).catch(() => {});
}

export function beginLessonActivity(lessonKey: string): void {
  void endLessonActivity();
  key = lessonKey;
  lastBeat = Date.now();
  timer = window.setInterval(() => {
    const now = Date.now();
    // Time behind a hidden or minimised window isn't practice.
    if (document.visibilityState === "visible") void report((now - lastBeat) / 1000);
    lastBeat = now;
  }, TICK_MS);
}

/** Stops the ticks and reports the partial minute. Safe to call twice. */
export function endLessonActivity(): Promise<void> {
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
  const flushed = document.visibilityState === "visible" ? report((Date.now() - lastBeat) / 1000) : Promise.resolve();
  key = null;
  return flushed;
}
