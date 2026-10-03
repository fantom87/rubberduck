import type { PracticeSummary } from "@teacher/shared";

// Calendar arithmetic for the practice scoreboard. Everything is a local
// calendar date string ("YYYY-MM-DD") and every step is a calendar step, never
// "now minus 24 hours": DST days aren't 24 hours long, and the scoreboard
// follows the learner's own clock.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A day counts if a lesson was completed, or this many active minutes. Ten,
 *  so a "just 10 minutes" session counts on its own. */
export const PRACTICE_MINUTES = 10;

export function localDateString(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function isDateString(s: unknown): s is string {
  return typeof s === "string" && DATE_RE.test(s);
}

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = parts(date);
  return localDateString(new Date(y, m - 1, d + n));
}

/** Whole calendar days from a to b (b later → positive). UTC so DST can't skew it. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = parts(a);
  const [by, bm, bd] = parts(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** The Monday that starts the week containing `date`. */
export function weekStart(date: string): string {
  const [y, m, d] = parts(date);
  const dow = new Date(y, m - 1, d).getDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

/** Add a day to the sorted, unique list. Returns true if it was new. */
export function markPracticeDay(days: string[], date: string): boolean {
  if (days.includes(date)) return false;
  days.push(date);
  days.sort();
  return true;
}

export interface GoalChange {
  from: string;
  goal: number;
}

/** Before the first recorded change, the goal was whatever it was then. */
export const GOAL_EPOCH = "0000-00-00";

export function summarizePractice(
  days: string[],
  weeklyGoal: number,
  today: string,
  history: GoalChange[] = [],
): PracticeSummary {
  const perWeek = new Map<string, number>();
  for (const day of new Set(days)) {
    if (!isDateString(day) || day > today) continue; // a hand edit or a clock change
    const w = weekStart(day);
    perWeek.set(w, (perWeek.get(w) ?? 0) + 1);
  }
  const thisWeek = weekStart(today);
  // Each past week is held to the goal in force that week. Without this,
  // raising the goal from 3 to 4 would retroactively fail every 3-day week
  // and wipe a streak already earned. The current week always uses today's
  // goal, which is the one on screen.
  const ordered = [...history].filter((h) => h.goal >= 1).sort((a, b) => a.from.localeCompare(b.from));
  const goalFor = (w: string): number => {
    if (w >= thisWeek || ordered.length === 0) return weeklyGoal;
    let goal = ordered[0].goal;
    for (const h of ordered) if (h.from <= w) goal = h.goal;
    return goal;
  };
  const met = (w: string) => (perWeek.get(w) ?? 0) >= goalFor(w);

  const daysThisWeek = perWeek.get(thisWeek) ?? 0;
  const goalMetThisWeek = daysThisWeek >= weeklyGoal;

  // The week in progress only ever adds to the streak. Until it's met, the
  // streak is whatever ran up to the end of last week.
  let weekStreak = 0;
  for (let w = goalMetThisWeek ? thisWeek : addDays(thisWeek, -7); met(w); w = addDays(w, -7)) weekStreak++;

  const valid = [...new Set(days)].filter((d) => isDateString(d) && d <= today).sort();
  let bestWeekStreak = 0;
  if (valid.length > 0) {
    let run = 0;
    for (let w = weekStart(valid[0]); w <= thisWeek; w = addDays(w, 7)) {
      run = met(w) ? run + 1 : 0;
      bestWeekStreak = Math.max(bestWeekStreak, run);
    }
  }

  const lastPracticeDate = valid.at(-1) ?? null;
  return {
    weeklyGoal,
    daysThisWeek,
    goalMetThisWeek,
    weekStreak,
    bestWeekStreak: Math.max(bestWeekStreak, weekStreak),
    totalDays: valid.length,
    lastPracticeDate,
    daysSinceLast: lastPracticeDate ? daysBetween(lastPracticeDate, today) : null,
  };
}
