import type { PracticeSummary } from "@teacher/shared";

// Every word the app says about the scoreboard, in one place. The rule they
// all follow: never lead with a zero. An empty week is described as a goal
// ahead, a lapsed streak is simply not mentioned, and the total only ever
// goes up. Past the goal, the count stands alone: "4 of 3" reads like a typo.

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function weekPart(p: PracticeSummary): string {
  if (p.goalMetThisWeek) return `Weekly goal met: ${plural(p.daysThisWeek, "day")} this week`;
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
    return next.goalMetThisWeek
      ? `Another practice day: ${next.daysThisWeek} this week.`
      : `That counts as a practice day: ${next.daysThisWeek} of ${next.weeklyGoal} this week.`;
  }
  return null;
}

export interface StatCard {
  value: string;
  label: string;
}

/**
 * The practice cards on Stats. Cards that would show a zero aren't shown:
 * an empty week shows its goal as the figure, and with no streak running the
 * best one stands in, as a thing achieved.
 */
export function practiceCards(p: PracticeSummary): StatCard[] {
  const cards: StatCard[] = [];
  if (p.totalDays > 0) cards.push({ value: String(p.totalDays), label: `day${p.totalDays === 1 ? "" : "s"} practiced, all time` });
  if (p.weekStreak > 0) {
    const best = p.bestWeekStreak > p.weekStreak ? ` (best: ${p.bestWeekStreak})` : "";
    cards.push({ value: `🔥 ${p.weekStreak}`, label: `week${p.weekStreak === 1 ? "" : "s"} in a row with your goal met${best}` });
  } else if (p.bestWeekStreak > 0) {
    cards.push({ value: String(p.bestWeekStreak), label: `your best run of weeks with the goal met` });
  }
  if (p.goalMetThisWeek) cards.push({ value: `✓ ${p.daysThisWeek}`, label: "days this week, goal met" });
  else if (p.daysThisWeek === 0) cards.push({ value: String(p.weeklyGoal), label: "day goal this week" });
  else cards.push({ value: `${p.daysThisWeek}/${p.weeklyGoal}`, label: "days this week" });
  return cards;
}
