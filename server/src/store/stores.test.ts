import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readJson, withFileLock, writeJson } from "./jsonStore.js";
import { completeLesson, getProgress, recordActivity, recordAttempt } from "./progress.js";
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
    expect(p.version).toBe(1);
  });

  it("reports a lapsed streak as 0 at read time (best kept)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 10, 12, 0, 0));
    await completeLesson(dataDir, "a/b/c");
    vi.setSystemTime(new Date(2026, 0, 11, 12, 0, 0));
    expect((await getProgress(dataDir)).streak.current).toBe(1); // yesterday still counts
    vi.setSystemTime(new Date(2026, 0, 20, 12, 0, 0));
    const lapsed = await getProgress(dataDir);
    expect(lapsed.streak.current).toBe(0);
    expect(lapsed.streak.best).toBe(1);
  });

  it("reports the first completion once, from inside the lock", async () => {
    // Two overlapping completions used to both read "not yet done" before
    // either wrote — and both journaled. Now exactly one sees first: true.
    const results = await Promise.all([completeLesson(dataDir, "a/b/c"), completeLesson(dataDir, "a/b/c")]);
    expect(results.filter((r) => r.first).length).toBe(1);
    expect((await completeLesson(dataDir, "a/b/c")).first).toBe(false);
  });

  it("increments the streak across consecutive days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 1, 20, 0, 0));
    await completeLesson(dataDir, "a/b/c");
    vi.setSystemTime(new Date(2026, 2, 2, 8, 0, 0));
    await completeLesson(dataDir, "a/b/d");
    expect((await getProgress(dataDir)).streak.current).toBe(2);
  });

  it("credits the streak after 15 minutes of activity, without a completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 10, 0, 0));
    for (let i = 0; i < 14; i++) await recordActivity(dataDir, 60, "a/b/c");
    expect((await getProgress(dataDir)).streak.current).toBe(0);
    const p = await recordActivity(dataDir, 60, "a/b/c");
    expect(p.streak.current).toBe(1);
    expect(p.streak.lastActiveDate).toBe("2026-06-01");
    expect(p.lessons["a/b/c"].timeSpentMin).toBe(15);
  });

  it("resets the daily activity tally when the date changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 23, 50, 0));
    await recordActivity(dataDir, 600);
    vi.setSystemTime(new Date(2026, 5, 2, 0, 10, 0));
    const p = await recordActivity(dataDir, 60);
    expect(p.streak.todayDate).toBe("2026-06-02");
    expect(p.streak.todayMinutes).toBe(1);
  });

  it("repairs a hand-edited progress.json instead of throwing", async () => {
    await fs.writeFile(path.join(dataDir, "progress.json"), "{}", "utf8");
    const p = await getProgress(dataDir);
    expect(p.lessons).toEqual({});
    expect(p.totals.runs).toBe(0);
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
