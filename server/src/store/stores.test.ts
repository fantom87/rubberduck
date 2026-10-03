import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readJson, withFileLock, writeJson } from "./jsonStore.js";
import {
  completeLesson,
  getProgress,
  recordActivity,
  recordAttempt,
  recordGoalChange,
  recordSessionComplete,
  recordVisit,
} from "./progress.js";
import { getSnapshot, listSnapshots, markSnapshotPassed, takeSnapshot } from "./snapshots.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pt-store-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

describe("jsonStore", () => {
  it("returns the fallback and sets the file aside when JSON is corrupt", async () => {
    const file = path.join(dataDir, "broken.json");
    await fs.writeFile(file, "{ not json", "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await readJson(file, { ok: true })).toEqual({ ok: true });
    warn.mockRestore();
    const siblings = await fs.readdir(dataDir);
    expect(siblings.some((f) => f.startsWith("broken.json.corrupt-"))).toBe(true);
    expect(siblings.includes("broken.json")).toBe(false);
  });

  it("serializes work per file through withFileLock", async () => {
    const file = path.join(dataDir, "locked.json");
    const order: number[] = [];
    await Promise.all([
      withFileLock(file, async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(1);
      }),
      withFileLock(file, async () => {
        order.push(2);
      }),
    ]);
    expect(order).toEqual([1, 2]);
  });

  it("keeps the lock chain alive after a failure", async () => {
    const file = path.join(dataDir, "locked.json");
    await expect(withFileLock(file, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(withFileLock(file, async () => "next")).resolves.toBe("next");
  });

  it("survives concurrent writes to the same file", async () => {
    const file = path.join(dataDir, "hot.json");
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeJson(file, { i })));
    const parsed = await readJson<{ i: number } | null>(file, null);
    expect(parsed).not.toBeNull();
  });
});

describe("progress store", () => {
  it("doesn't lose concurrent attempt increments", async () => {
    await Promise.all(Array.from({ length: 10 }, () => recordAttempt(dataDir, "a/b/c")));
    const p = await getProgress(dataDir);
    expect(p.lessons["a/b/c"].attempts).toBe(10);
    expect(p.totals.runs).toBe(10);
    expect(p.version).toBe(2);
  });

  it("reports the first completion once, from inside the lock", async () => {
    // Two overlapping completions used to both read "not yet done" before
    // either wrote — and both journaled. Now exactly one sees first: true.
    const results = await Promise.all([completeLesson(dataDir, "a/b/c"), completeLesson(dataDir, "a/b/c")]);
    expect(results.filter((r) => r.first).length).toBe(1);
    expect((await completeLesson(dataDir, "a/b/c")).first).toBe(false);
  });

  it("counts a practice day on completion, and a gap never takes it back", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 10, 12, 0, 0));
    await completeLesson(dataDir, "a/b/c");
    vi.setSystemTime(new Date(2026, 2, 20, 12, 0, 0)); // ten weeks later
    expect((await getProgress(dataDir)).practiceDays).toEqual(["2026-01-10"]);
  });

  it("counts a day after 10 minutes of activity, without a completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 10, 0, 0));
    for (let i = 0; i < 9; i++) await recordActivity(dataDir, 60, "a/b/c");
    expect((await getProgress(dataDir)).practiceDays).toEqual([]);
    const p = await recordActivity(dataDir, 60, "a/b/c");
    expect(p.practiceDays).toEqual(["2026-06-01"]);
    expect(p.lessons["a/b/c"].timeSpentMin).toBe(10);
  });

  it("counts a partial last tick, so a session that ends mid-minute still counts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 10, 0, 0));
    for (let i = 0; i < 9; i++) await recordActivity(dataDir, 60, "a/b/c");
    const p = await recordActivity(dataDir, 58, "a/b/c"); // flushed as the lesson closed
    expect(p.practiceDays).toEqual(["2026-06-01"]);
  });

  it("resets today's tally when the date changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 23, 50, 0));
    await recordActivity(dataDir, 300);
    vi.setSystemTime(new Date(2026, 5, 2, 0, 10, 0));
    const p = await recordActivity(dataDir, 60);
    expect(p.today).toEqual({ date: "2026-06-02", minutes: 1 });
  });

  it("remembers the lesson last opened or worked in, and never a playground", async () => {
    await recordVisit(dataDir, "python/u/one");
    expect((await getProgress(dataDir)).lastActive?.key).toBe("python/u/one");
    await recordAttempt(dataDir, "python/u/two");
    expect((await getProgress(dataDir)).lastActive?.key).toBe("python/u/two");
    await recordAttempt(dataDir, "playground/python");
    expect((await getProgress(dataDir)).lastActive?.key).toBe("python/u/two");
  });

  it("a peek at another lesson doesn't bury the one in progress", async () => {
    await recordAttempt(dataDir, "python/u/working"); // real work
    await recordVisit(dataDir, "python/u/peeked");
    await recordActivity(dataDir, 3, "python/u/peeked"); // the few seconds before leaving
    expect((await getProgress(dataDir)).lastActive?.key).toBe("python/u/working");
    // A full minute in the other lesson is work, and moves it.
    await recordActivity(dataDir, 60, "python/u/peeked");
    expect((await getProgress(dataDir)).lastActive?.key).toBe("python/u/peeked");
  });

  it("looking back at a finished lesson doesn't move where you left off", async () => {
    await completeLesson(dataDir, "python/u/done");
    await recordAttempt(dataDir, "python/u/next");
    await recordVisit(dataDir, "python/u/done");
    await recordAttempt(dataDir, "python/u/done"); // re-running it is reviewing
    expect((await getProgress(dataDir)).lastActive?.key).toBe("python/u/next");
  });

  it("a visit does move it when nothing else is in progress", async () => {
    await recordVisit(dataDir, "python/u/a");
    await recordVisit(dataDir, "python/u/b"); // a has no work yet
    expect((await getProgress(dataDir)).lastActive?.key).toBe("python/u/b");
  });

  it("a finished 10-minute session counts the day on its own", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 3, 9, 0, 0));
    const p = await recordSessionComplete(dataDir);
    expect(p.practiceDays).toEqual(["2026-06-03"]);
  });

  it("records goal changes by the Monday they take effect, the old goal first", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 1, 12, 0, 0)); // Thursday Oct 1
    await recordGoalChange(dataDir, 3, 4);
    let p = await recordGoalChange(dataDir, 4, 5); // same week: replaces
    expect(p.goalHistory).toEqual([
      { from: "0000-00-00", goal: 3 },
      { from: "2026-09-28", goal: 5 },
    ]);
    vi.setSystemTime(new Date(2026, 9, 6, 12, 0, 0)); // next week
    p = await recordGoalChange(dataDir, 5, 2);
    expect(p.goalHistory?.map((h) => h.from)).toEqual(["0000-00-00", "2026-09-28", "2026-10-05"]);
  });

  it("migrates a version-1 file: completions and the last counted day become practice days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 3, 12, 0, 0));
    const v1 = {
      lessons: {
        "python/u/a": { attempts: 1, timeSpentMin: 0, completedAt: new Date(2026, 7, 9, 14, 53).toISOString() },
        "sql/u/b": { attempts: 1, timeSpentMin: 0, completedAt: new Date(2026, 7, 9, 15, 10).toISOString() },
      },
      streak: { current: 1, best: 1, lastActiveDate: "2026-08-12", todayDate: "2026-08-12", todayMinutes: 16 },
      totals: { runs: 2, checksPassed: 5, checksFailed: 3 },
      version: 1,
    };
    await fs.writeFile(path.join(dataDir, "progress.json"), JSON.stringify(v1), "utf8");
    const p = await getProgress(dataDir);
    expect(p.practiceDays).toEqual(["2026-08-09", "2026-08-12"]);
    expect(p.today).toEqual({ date: "2026-08-12", minutes: 16 });
    expect((p as unknown as Record<string, unknown>).streak).toBeUndefined();
    expect(p.totals.runs).toBe(2);
    // The next write persists the migrated shape as version 2.
    const after = await recordAttempt(dataDir, "python/u/a");
    expect(after.version).toBe(2);
    expect(after.practiceDays).toEqual(["2026-08-09", "2026-08-12"]);
  });

  it("repairs a hand-edited progress.json instead of throwing", async () => {
    await fs.writeFile(
      path.join(dataDir, "progress.json"),
      JSON.stringify({ practiceDays: ["2026-01-01", "nonsense", 42, "2026-01-01"] }),
      "utf8",
    );
    const p = await getProgress(dataDir);
    expect(p.lessons).toEqual({});
    expect(p.totals.runs).toBe(0);
    expect(p.practiceDays).toEqual(["2026-01-01"]);
    expect(p.today).toEqual({ date: "", minutes: 0 });
  });
});

describe("snapshot store", () => {
  const KEY = "playground/python"; // pseudo-key: valid without a curriculum load

  it("rejects path-escaping lesson keys with a 400-status error", async () => {
    for (const bad of ["..\\..\\evil", "../../evil", "a:b", "a\\b", ""]) {
      await expect(listSnapshots(dataDir, bad)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("rejects snapshots for unknown lessons", async () => {
    await expect(takeSnapshot(dataDir, "garbage/nope/nothing", "run", {})).rejects.toMatchObject({ status: 400 });
  });

  it("returns null (not []) for a snapshot in a lesson with no snapshot dir", async () => {
    expect(await getSnapshot(dataDir, KEY, "deadbeef")).toBeNull();
  });

  it("keeps the newest passing snapshot out of ring eviction", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 1, 9, 0, 0));
    const first = await takeSnapshot(dataDir, KEY, "check", { "main.py": "print('pass')" });
    await markSnapshotPassed(dataDir, KEY, first.id);
    for (let i = 0; i < 15; i++) {
      vi.advanceTimersByTime(60_000);
      await takeSnapshot(dataDir, KEY, "run", { "main.py": `print(${i})` });
    }
    const metas = await listSnapshots(dataDir, KEY);
    expect(metas.length).toBe(11); // KEEP + the pinned passing one
    const pinned = metas.find((m) => m.id === first.id);
    expect(pinned?.passed).toBe(true);
  });
});
