import type { PracticeSummary } from "@teacher/shared";

// Every word the app says about the scoreboard, in one place. The rule they
// all follow: never lead with a zero. An empty week is described as a goal
// ahead, and a lapsed streak is simply not mentioned. The total only ever
// goes up.

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function weekPart(p: PracticeSummary): string {
  if (p.goalMetThisWeek) return `Weekly goal met: ${p.daysThisWeek} of ${p.weeklyGoal} days`;
  if (p.daysThisWeek === 0) return `This week's goal: ${plural(p.weeklyGoal, "day")}`;
  return `${p.daysThisWeek} of ${p.weeklyGoal} days this week`;
}

/** The one-line scoreboard under Home's big button. */
export function practiceLine(p: PracticeSummary): string {
  if (p.totalDays === 0) return "A day counts when you finish a lesson or spend 10 minutes on one.";
  const parts: string[] = [];
  if (p.weekStreak > 0) parts.push(`🔥 ${plural(p.weekStreak, "week")} in a row`);
  parts.push(weekPart(p));
  parts.push(`${plural(p.totalDays, "day")} practiced in all`);
  return parts.join(" · ");
}

/** What changed since the last look, worth a toast. Null when nothing did. */
export function practiceToast(prev: PracticeSummary, next: PracticeSummary): string | null {
  if (next.goalMetThisWeek && !prev.goalMetThisWeek) {
    return next.weekStreak > 1
      ? `Weekly goal met. That's ${next.weekStreak} weeks in a row 🔥`
      : `Weekly goal met: ${next.daysThisWeek} days this week 🔥`;
  }
  if (next.totalDays > prev.totalDays) {
    return `That counts as a practice day: ${next.daysThisWeek} of ${next.weeklyGoal} this week.`;
  }
  return null;
}
