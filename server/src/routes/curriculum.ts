import fs from "node:fs/promises";
import { Router } from "express";
import type { NextStep } from "@teacher/shared";
import { getCurriculum, reloadCurriculum } from "../curriculum/loader.js";
import { computeNextStep } from "../curriculum/next.js";
import { getProgress } from "../store/progress.js";
import { draftFile } from "./drafts.js";

export function curriculumRoutes(contentDir: string, dataDir: string): Router {
  const r = Router();

  // Tracks + units + per-lesson completion, shaped for Home/Track views.
  r.get("/api/curriculum", async (_req, res) => {
    const cur = await getCurriculum(contentDir);
    const progress = await getProgress(dataDir);
    const tracks = cur.tracks.map((t) => ({
      ...t,
      units: t.units.map((u) => ({
        ...u,
        lessons: u.lessons.map((lessonId) => {
          const key = `${t.id}/${u.id}/${lessonId}`;
          const lesson = cur.lessons.get(key);
          return {
            id: lessonId,
            key,
            title: lesson?.title ?? lessonId,
            estMinutes: lesson?.estMinutes ?? 10,
            runner: lesson?.runner ?? "browser",
            completedAt: progress.lessons[key]?.completedAt ?? null,
          };
        }),
        // A project is one row in the same list, carrying its stage tally.
        // `resumeKey` is the stage to open: the first unfinished one, or the
        // last if the whole thing is done — so the row is always clickable.
        projects: u.projects.map((projectId) => {
          const key = `${t.id}/${u.id}/${projectId}`;
          const project = cur.projects.get(key);
          const stageKeys = (project?.stages ?? []).map((sid) => `${key}/${sid}`);
          const done = stageKeys.filter((sk) => progress.lessons[sk]?.completedAt);
          const firstUnfinished = stageKeys.find((sk) => !progress.lessons[sk]?.completedAt);
          return {
            id: projectId,
            key,
            title: project?.title ?? projectId,
            summary: project?.summary ?? "",
            estMinutes: project?.estMinutes ?? 45,
            runner: project?.runner ?? "browser",
            stagesTotal: stageKeys.length,
            stagesDone: done.length,
            completedAt: stageKeys.length > 0 && done.length === stageKeys.length ? done.at(-1)! : null,
            resumeKey: firstUnfinished ?? stageKeys.at(-1) ?? null,
          };
        }),
      })),
    }));
    res.json({ tracks, errors: cur.errors });
  });

  // The one thing to open next — the Home page's big button. Server-side, so
  // it survives a cleared browser profile (the old Continue button lived in
  // localStorage and vanished whenever the app's origin changed).
  r.get("/api/next", async (_req, res) => {
    const cur = await getCurriculum(contentDir);
    const progress = await getProgress(dataDir);
    const step = computeNextStep(cur, progress);
    if (!step) {
      res.json(null);
      return;
    }
    const lesson = cur.lessons.get(step.key)!;
    const draftId = lesson.stage?.projectKey ?? step.key;
    const hasDraft = await fs.access(draftFile(dataDir, draftId)).then(
      () => true,
      () => false,
    );
    const payload: NextStep = { ...step, hasDraft };
    res.json(payload);
  });

  // Full lesson content (frontmatter + body + starter files). No solutions, ever.
  r.get("/api/curriculum/lesson", async (req, res) => {
    const key = String(req.query.id ?? "");
    const cur = await getCurriculum(contentDir);
    const lesson = cur.lessons.get(key);
    if (!lesson) {
      res.status(404).json({ error: `no lesson "${key}"` });
      return;
    }

    // A project stage's neighbours are its sibling stages, never the unit's
    // lessons — and the rail needs the whole roster with its completion state.
    if (lesson.stage) {
      const project = cur.projects.get(lesson.stage.projectKey);
      const progress = await getProgress(dataDir);
      const stageKeys = (project?.stages ?? []).map((sid) => `${lesson.stage!.projectKey}/${sid}`);
      const index = lesson.stage.stageIndex;
      res.json({
        ...lesson,
        nextLessonKey: index + 1 < stageKeys.length ? stageKeys[index + 1] : null,
        project: {
          key: lesson.stage.projectKey,
          title: lesson.stage.projectTitle,
          entry: project?.entry ?? null,
          stages: (project?.stageList ?? []).map((s, i) => ({
            id: s.id,
            key: stageKeys[i],
            title: s.title,
            completedAt: progress.lessons[stageKeys[i]]?.completedAt ?? null,
          })),
        },
      });
      return;
    }

    // The lesson that follows: next in this unit, else the first lesson of
    // the next unit that has authored lessons. Null at the end of content.
    let nextLessonKey: string | null = null;
    const track = cur.tracks.find((t) => t.id === lesson.trackId);
    const unitIndex = track?.units.findIndex((u) => u.id === lesson.unitId) ?? -1;
    if (track && unitIndex >= 0) {
      const unit = track.units[unitIndex];
      const lessonIndex = unit.lessons.indexOf(lesson.id);
      if (lessonIndex >= 0 && lessonIndex + 1 < unit.lessons.length) {
        nextLessonKey = `${track.id}/${unit.id}/${unit.lessons[lessonIndex + 1]}`;
      } else {
        const nextUnit = track.units.slice(unitIndex + 1).find((u) => u.lessons.length > 0);
        if (nextUnit) nextLessonKey = `${track.id}/${nextUnit.id}/${nextUnit.lessons[0]}`;
      }
    }

    res.json({ ...lesson, nextLessonKey });
  });

  /**
   * The escape hatch: the workspace as it should look at the END of a stage.
   *
   * For a learner who has painted themselves into a corner, this is the only
   * way out that doesn't mean abandoning the project — every later stage
   * builds on this one. It is deliberately a separate, explicit endpoint
   * rather than anything the tutor can reach: the model never sees or pastes
   * these files, it's a decision the learner makes with a confirm dialog.
   *
   * Stages only. A lesson's solution stays unreachable, as it always has been.
   */
  r.get("/api/curriculum/stage-solution", async (req, res) => {
    const key = String(req.query.id ?? "");
    const cur = await getCurriculum(contentDir);
    const stage = cur.lessons.get(key);
    if (!stage?.stage) {
      res.status(404).json({ error: `no project stage "${key}"` });
      return;
    }
    const delta = cur.solutions.get(key) ?? {};
    res.json({ files: { ...stage.starterFiles, ...delta } });
  });

  r.post("/api/curriculum/validate", async (_req, res) => {
    const cur = await reloadCurriculum(contentDir);
    res.json({ ok: cur.errors.length === 0, errors: cur.errors });
  });

  return r;
}
