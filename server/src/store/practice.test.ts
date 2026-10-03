import { describe, expect, it } from "vitest";
import { addDays, daysBetween, summarizePractice, weekStart } from "./practice.js";

describe("calendar arithmetic", () => {
  it("weeks start on Monday", () => {
    expect(weekStart("2026-10-03")).toBe("2026-09-28"); // a Saturday
    expect(weekStart("2026-09-28")).toBe("2026-09-28"); // the Monday itself
    expect(weekStart("2026-10-04")).toBe("2026-09-28"); // Sunday closes the week
  });

  it("steps over DST changes by calendar day, not by 24 hours", () => {
    // US DST ends 2026-11-01, the EU's on 2026-10-25. Either way a day is a day.
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(addDays("2026-10-25", -1)).toBe("2026-10-24");
    expect(daysBetween("2026-10-24", "2026-11-03")).toBe(10);
    expect(weekStart("2026-11-01")).toBe("2026-10-26");
  });
});

describe("summarizePractice", () => {
  const goal = 3;
  // Weeks of 2026: Sep 14, Sep 21, Sep 28. Today is Saturday Oct 3.
  const today = "2026-10-03";

  it("an empty history is zeros and nulls, which the UI turns into words, not a score", () => {
    expect(summarizePractice([], goal, today)).toEqual({
      weeklyGoal: 3,
      daysThisWeek: 0,
      goalMetThisWeek: false,
      weekStreak: 0,
      bestWeekStreak: 0,
      totalDays: 0,
      lastPracticeDate: null,
      daysSinceLast: null,
    });
  });

  it("the week in progress never breaks the streak", () => {
    const days = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-21", "2026-09-22", "2026-09-23"];
    const s = summarizePractice(days, goal, today);
    expect(s.daysThisWeek).toBe(0);
    expect(s.weekStreak).toBe(2); // the last two weeks, still alive
    expect(s.goalMetThisWeek).toBe(false);
  });

  it("meeting this week's goal extends the streak at once", () => {
    const days = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-28", "2026-09-30", "2026-10-02"];
    const s = summarizePractice(days, goal, today);
    expect(s.daysThisWeek).toBe(3);
    expect(s.goalMetThisWeek).toBe(true);
    expect(s.weekStreak).toBe(2);
  });

  it("missing a whole week ends the streak, while best and total remember", () => {
    const days = ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-29"];
    const s = summarizePractice(days, goal, today);
    expect(s.weekStreak).toBe(0); // the Sep 21 week had nothing
    expect(s.bestWeekStreak).toBe(2);
    expect(s.totalDays).toBe(7);
    expect(s.daysThisWeek).toBe(1);
    expect(s.lastPracticeDate).toBe("2026-09-29");
    expect(s.daysSinceLast).toBe(4);
  });

  it("a week short of the goal doesn't extend the streak", () => {
    const s = summarizePractice(["2026-09-21", "2026-09-22"], goal, today);
    expect(s.weekStreak).toBe(0);
    expect(s.totalDays).toBe(2);
  });

  it("a goal of one makes any practised week count", () => {
    const s = summarizePractice(["2026-09-15", "2026-09-22", "2026-10-01"], 1, today);
    expect(s.weekStreak).toBe(3);
  });

  it("ignores junk, duplicates and future dates", () => {
    const s = summarizePractice(["2026-10-01", "not-a-date", "2026-12-25", "2026-10-01"], goal, today);
    expect(s.totalDays).toBe(1);
    expect(s.lastPracticeDate).toBe("2026-10-01");
  });

  it("raising the goal keeps the weeks already earned under the old one", () => {
    const days = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-21", "2026-09-22", "2026-09-23"];
    const history = [
      { from: "0000-00-00", goal: 3 },
      { from: "2026-09-28", goal: 4 }, // raised this week
    ];
    const s = summarizePractice(days, 4, today, history);
    expect(s.weekStreak).toBe(2);
    expect(s.bestWeekStreak).toBe(2);
    expect(s.weeklyGoal).toBe(4);
    // Without the history, the same change would wipe both.
    expect(summarizePractice(days, 4, today).weekStreak).toBe(0);
  });

  it("lowering the goal doesn't turn old weeks into streak weeks after the fact", () => {
    const days = ["2026-09-15", "2026-09-22"];
    const history = [
      { from: "0000-00-00", goal: 3 },
      { from: "2026-09-28", goal: 1 },
    ];
    expect(summarizePractice(days, 1, today, history).weekStreak).toBe(0);
  });

  it("this week is always held to today's goal", () => {
    const history = [
      { from: "0000-00-00", goal: 3 },
      { from: "2026-09-28", goal: 1 },
    ];
    const s = summarizePractice(["2026-09-29"], 1, today, history);
    expect(s.goalMetThisWeek).toBe(true);
    expect(s.weekStreak).toBe(1);
  });

  it("Bradley's real history: two days in August, seven weeks ago", () => {
    const s = summarizePractice(["2026-08-09", "2026-08-12"], goal, today);
    expect(s).toMatchObject({ daysThisWeek: 0, weekStreak: 0, totalDays: 2, daysSinceLast: 52 });
  });
});
