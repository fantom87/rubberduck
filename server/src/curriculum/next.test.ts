import { describe, expect, it } from "vitest";
import type { Lesson, Progress, Project, Track } from "@teacher/shared";
import type { Curriculum } from "./loader.js";
import { computeNextStep, trackSequence } from "./next.js";

// Two tracks. Python's unit 2 holds two lessons and then a two-stage project;
// SQL has one unit. Only the fields the sequencing reads are filled in.
function fixture(): Curriculum {
  const lessons = new Map<string, Lesson>();
  const add = (key: string, stage?: Lesson["stage"]) => {
    const [trackId, unitId, id] = key.split("/");
    lessons.set(key, { id, title: `T:${key}`, trackId, unitId, estMinutes: 12, stage } as unknown as Lesson);
  };
  for (const k of ["python/u1/a", "python/u1/b", "python/u2/c", "python/u2/d", "sql/s1/x", "sql/s1/y"]) add(k);
  const stage = (i: number) => ({ projectKey: "python/u2/game", projectTitle: "Build a Game", stageIndex: i, stageCount: 2 });
  add("python/u2/game/one", stage(0));
  add("python/u2/game/two", stage(1));
  const unit = (id: string, lessonIds: string[], projects: string[] = []) => ({
    id,
    title: id,
    tier: "foundations" as const,
    summary: "",
    lessons: lessonIds,
    projects,
  });
  const tracks: Track[] = [
    { id: "python", title: "Python", language: "python", philosophy: "", units: [unit("u1", ["a", "b"]), unit("u2", ["c", "d"], ["game"])] },
    { id: "sql", title: "SQL", language: "sql", philosophy: "", units: [unit("s1", ["x", "y"])] },
  ];
  const projects = new Map<string, Project>([
    ["python/u2/game", { stages: ["one", "two"] } as unknown as Project],
  ]);
  return { tracks, lessons, projects, solutions: new Map(), errors: [], manifestFiles: [] };
}

function progress(done: string[], lastActive?: string, completedAt?: Record<string, string>): Progress {
  const lessons: Progress["lessons"] = {};
  done.forEach((k, i) => {
    lessons[k] = { attempts: 1, timeSpentMin: 1, completedAt: completedAt?.[k] ?? `2026-08-0${i + 1}T12:00:00Z` };
  });
  return {
    lessons,
    practiceDays: [],
    today: { date: "", minutes: 0 },
    totals: { runs: 0, checksPassed: 0, checksFailed: 0 },
    ...(lastActive ? { lastActive: { key: lastActive, at: "2026-08-10T12:00:00Z" } } : {}),
  };
}

describe("trackSequence", () => {
  it("is each unit's lessons, then that unit's project stages, in Track-page order", () => {
    expect(trackSequence(fixture(), "python")).toEqual([
      "python/u1/a",
      "python/u1/b",
      "python/u2/c",
      "python/u2/d",
      "python/u2/game/one",
      "python/u2/game/two",
    ]);
  });
});

describe("computeNextStep", () => {
  it("starts at the very first lesson when nothing has been touched", () => {
    const s = computeNextStep(fixture(), progress([]));
    expect(s).toMatchObject({ kind: "start", key: "python/u1/a", trackTitle: "Python", last: null });
  });

  it("resumes the lesson last opened if it isn't finished", () => {
    const s = computeNextStep(fixture(), progress(["python/u1/a"], "python/u2/c"));
    expect(s).toMatchObject({ kind: "resume", key: "python/u2/c", last: { key: "python/u2/c", completed: false } });
  });

  it("goes to the next unfinished lesson after the one just finished, skipping ones already done", () => {
    const s = computeNextStep(fixture(), progress(["python/u1/a", "python/u1/b", "python/u2/c"], "python/u1/a"));
    expect(s).toMatchObject({ kind: "next", key: "python/u2/d", last: { key: "python/u1/a", completed: true } });
  });

  it("falls back to the newest completion when lastActive is missing, as in a version-1 file", () => {
    const done = ["python/u1/a", "sql/s1/x"];
    const s = computeNextStep(
      fixture(),
      progress(done, undefined, { "python/u1/a": "2026-08-09T14:53:00Z", "sql/s1/x": "2026-08-09T15:10:00Z" }),
    );
    expect(s).toMatchObject({ kind: "next", key: "sql/s1/y", trackId: "sql", last: { key: "sql/s1/x" } });
  });

  it("ignores a lastActive key the curriculum no longer has", () => {
    const s = computeNextStep(fixture(), progress(["python/u1/a"], "python/gone/lesson"));
    expect(s).toMatchObject({ kind: "next", key: "python/u1/b" });
  });

  it("walks into a unit's project after its lessons, and labels the stage", () => {
    const s = computeNextStep(fixture(), progress(["python/u2/d"], "python/u2/d"));
    expect(s).toMatchObject({ kind: "next", key: "python/u2/game/one", projectTitle: "Build a Game" });
  });

  it("goes back for a skipped lesson once the end of the track is done", () => {
    const s = computeNextStep(fixture(), progress(["python/u2/game/two"], "python/u2/game/two"));
    expect(s).toMatchObject({ kind: "next", key: "python/u1/a" });
  });

  it("moves to the next track when one is finished", () => {
    const all = trackSequence(fixture(), "python");
    const s = computeNextStep(fixture(), progress(all, all.at(-1)));
    expect(s).toMatchObject({ kind: "next", key: "sql/s1/x", trackTitle: "SQL" });
  });

  it("returns null only when every lesson is done", () => {
    const cur = fixture();
    expect(computeNextStep(cur, progress([...cur.lessons.keys()], "sql/s1/y"))).toBeNull();
  });
});
