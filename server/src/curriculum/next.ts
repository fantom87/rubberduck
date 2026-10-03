import type { NextStep, Progress } from "@teacher/shared";
import type { Curriculum } from "./loader.js";

/**
 * Every lesson and project stage in a track, in the order the learner meets
 * them on the Track page: each unit's lessons, then that unit's projects'
 * stages. Keys the curriculum doesn't know (a manifest naming a lesson whose
 * folder is missing) are left out.
 */
export function trackSequence(cur: Curriculum, trackId: string): string[] {
  const track = cur.tracks.find((t) => t.id === trackId);
  if (!track) return [];
  const out: string[] = [];
  for (const unit of track.units) {
    for (const id of unit.lessons) {
      const key = `${trackId}/${unit.id}/${id}`;
      if (cur.lessons.has(key)) out.push(key);
    }
    for (const projectId of unit.projects) {
      const project = cur.projects.get(`${trackId}/${unit.id}/${projectId}`);
      for (const stageId of project?.stages ?? []) {
        const key = `${trackId}/${unit.id}/${projectId}/${stageId}`;
        if (cur.lessons.has(key)) out.push(key);
      }
    }
  }
  return out;
}

/**
 * The single thing the Home page offers to open, so coming back never starts
 * with a decision.
 *
 *   resume  the lesson last opened or worked in, if it isn't finished
 *   next    the first unfinished lesson after the one last touched, in its track
 *   start   nothing touched yet: the first unfinished lesson in the first track
 *
 * "Last touched" is progress.lastActive. Files written before it existed fall
 * back to the newest completion, which is a fair guess at where someone was.
 * Returns null only when every lesson is done.
 */
export function computeNextStep(cur: Curriculum, progress: Progress): Omit<NextStep, "hasDraft"> | null {
  const done = (key: string) => Boolean(progress.lessons[key]?.completedAt);

  let lastKey = progress.lastActive?.key;
  if (!lastKey || !cur.lessons.has(lastKey)) {
    lastKey = Object.entries(progress.lessons)
      .filter(([key, lp]) => lp.completedAt && cur.lessons.has(key))
      .sort(([, a], [, b]) => a.completedAt!.localeCompare(b.completedAt!))
      .at(-1)?.[0];
  }

  const firstUnfinishedAnywhere = (): string | undefined => {
    for (const track of cur.tracks) {
      const found = trackSequence(cur, track.id).find((k) => !done(k));
      if (found) return found;
    }
    return undefined;
  };

  let kind: NextStep["kind"];
  let target: string | undefined;
  if (lastKey && !done(lastKey)) {
    kind = "resume";
    target = lastKey;
  } else if (lastKey) {
    kind = "next";
    const seq = trackSequence(cur, cur.lessons.get(lastKey)!.trackId);
    const at = seq.indexOf(lastKey);
    // Forward from where they were, then any gap they skipped earlier in the
    // same track, then anywhere at all.
    target = seq.slice(at + 1).find((k) => !done(k)) ?? seq.find((k) => !done(k)) ?? firstUnfinishedAnywhere();
  } else {
    kind = "start";
    target = firstUnfinishedAnywhere();
  }
  if (!target) return null;

  const lesson = cur.lessons.get(target)!;
  const track = cur.tracks.find((t) => t.id === lesson.trackId);
  const last = lastKey ? cur.lessons.get(lastKey) : undefined;
  return {
    kind,
    key: target,
    title: lesson.title,
    trackId: lesson.trackId,
    trackTitle: track?.title ?? lesson.trackId,
    estMinutes: lesson.estMinutes,
    ...(lesson.stage ? { projectTitle: lesson.stage.projectTitle } : {}),
    last: last && lastKey ? { key: lastKey, title: last.title, completed: done(lastKey) } : null,
  };
}
