import { describe, expect, it } from "vitest";
import type { Lesson, PracticeSummary } from "@teacher/shared";
import { buildOpener } from "./opener";
import { practiceLine, practiceToast, weekPart } from "./practice";

function lesson(starter: string, extra: Partial<Lesson> = {}): Lesson {
  return {
    id: "l",
    title: "Variables",
    language: "python",
    runner: "browser",
    estMinutes: 12,
    files: [{ path: "main.py", starter: "starter/main.py" }],
    goal: "Make two variables and print them.",
    checks: [],
    trackId: "python",
    unitId: "u",
    body: "",
    starterFiles: { "main.py": starter },
    testFiles: {},
    entry: "main.py",
    ...extra,
  } as Lesson;
}

describe("buildOpener", () => {
  const numbered = "# 1. Make a variable called answer holding 6 * 7.\n\n# 2. Print it.\n";

  it("stays quiet below the two highest assistance levels", () => {
    for (const level of [1, 2, 3] as const) expect(buildOpener(lesson(numbered), level)).toBeNull();
  });

  it("at level 5 quotes step 1 and the line it's on", () => {
    const text = buildOpener(lesson(numbered), 5)!;
    expect(text).toContain("Make two variables and print them.");
    expect(text).toContain("line 1 of `main.py`");
    expect(text).toContain("Make a variable called answer holding 6 * 7.");
    expect(text).toContain("**Run**");
  });

  it("finds step 1 in any comment style, not just the first line", () => {
    const html = lesson("<!doctype html>\n<!-- 1. Add a heading -->\n<body></body>", {
      language: "html-css",
      entry: "index.html",
      starterFiles: { "index.html": "<!doctype html>\n<!-- 1. Add a heading -->\n<body></body>" },
    });
    expect(buildOpener(html, 5)).toContain("line 2 of `index.html`");
    expect(buildOpener(html, 5)).toContain("> Add a heading");
    const sql = lesson("", { language: "sql", entry: "query.sql", starterFiles: { "query.sql": "-- 1) Select every title\n" } });
    expect(buildOpener(sql, 4)).toContain("Select every title");
  });

  it("without a numbered step it points at the comments instead of inventing one", () => {
    const text = buildOpener(lesson("# Write your code below\n"), 5)!;
    expect(text).toContain("comments at the top of `main.py`");
    expect(text).not.toContain("Step 1 is");
  });

  it("level 4 is shorter and doesn't say hi", () => {
    const text = buildOpener(lesson(numbered), 4)!;
    expect(text.startsWith("Goal:")).toBe(true);
    expect(text).not.toContain("Hi!");
  });

  it("in a project stage it says the earlier code is still there", () => {
    const stage = lesson(numbered, {
      stage: { projectKey: "p", projectTitle: "Snake", stageIndex: 1, stageCount: 3 },
    });
    expect(buildOpener(stage, 5)).toContain("Stage 2 of 3");
    expect(buildOpener(stage, 5)).not.toContain("  ");
  });
});

describe("scoreboard wording", () => {
  const summary = (over: Partial<PracticeSummary>): PracticeSummary => ({
    weeklyGoal: 3,
    daysThisWeek: 0,
    goalMetThisWeek: false,
    weekStreak: 0,
    bestWeekStreak: 0,
    totalDays: 0,
    lastPracticeDate: null,
    daysSinceLast: null,
    ...over,
  });

  // The whole point: after a gap, nothing on screen is a zero.
  const noZero = (s: string) => expect(s).not.toMatch(/(^|\D)0(\D|$)/);

  it("a first-timer sees how a day counts, not a score", () => {
    const line = practiceLine(summary({}));
    noZero(line);
    expect(line).toContain("10 minutes");
  });

  it("coming back after weeks away shows the goal ahead and the total so far", () => {
    const line = practiceLine(summary({ totalDays: 2, daysSinceLast: 52 }));
    noZero(line);
    expect(line).toBe("This week's goal: 3 days · 2 days practiced in all");
  });

  it("a live streak leads, in weeks", () => {
    const line = practiceLine(summary({ weekStreak: 2, daysThisWeek: 1, totalDays: 9 }));
    expect(line).toBe("🔥 2 weeks in a row · 1 of 3 days this week · 9 days practiced in all");
  });

  it("says when the weekly goal is met", () => {
    expect(weekPart(summary({ daysThisWeek: 3, goalMetThisWeek: true }))).toBe("Weekly goal met: 3 of 3 days");
  });

  it("toasts a new practice day, and the goal being met, and nothing otherwise", () => {
    const before = summary({ totalDays: 2, daysThisWeek: 1 });
    expect(practiceToast(before, summary({ totalDays: 3, daysThisWeek: 2 }))).toBe(
      "That counts as a practice day: 2 of 3 this week.",
    );
    expect(practiceToast(before, summary({ totalDays: 3, daysThisWeek: 3, goalMetThisWeek: true, weekStreak: 1 }))).toBe(
      "Weekly goal met: 3 days this week 🔥",
    );
    expect(practiceToast(before, before)).toBeNull();
  });
});
