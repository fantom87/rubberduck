import type { Lesson } from "@teacher/shared";
import { completeLesson } from "./progress.js";
import { appendJournal } from "./profile.js";

/**
 * The one place a lesson (or a project stage) is recorded as done.
 *
 * Both the Check button and the tutor's mark_complete land here, because
 * learners at low assistance levels finish work without the tutor ever being
 * asked — and because the two paths had already drifted: /api/check guarded
 * the journal write with a first-completion check and mark_complete didn't, so
 * re-completing a lesson through the tutor duplicated the entry.
 *
 * Projects journal ONCE, when the last stage passes. Eight stages producing
 * eight timeline entries would drown the journal in bookkeeping, and "I built
 * Snake" is the thing worth remembering, not "I completed stage 4 of 8".
 */
export async function recordCompletion(
  dataDir: string,
  key: string,
  lesson: Lesson,
  summary?: string,
): Promise<void> {
  const { first } = await completeLesson(dataDir, key);
  if (!first) return;

  if (lesson.stage) {
    const isFinalStage = lesson.stage.stageIndex === lesson.stage.stageCount - 1;
    if (!isFinalStage) return;
    await appendJournal(dataDir, {
      lessonId: lesson.stage.projectKey,
      trackId: lesson.trackId,
      completedAt: new Date().toISOString(),
      summary: summary ?? `Built "${lesson.stage.projectTitle}" — all ${lesson.stage.stageCount} stages.`,
    });
    return;
  }

  await appendJournal(dataDir, {
    lessonId: key,
    trackId: lesson.trackId,
    completedAt: new Date().toISOString(),
    summary: summary ?? `Completed "${lesson.title}" — ${lesson.goal}`,
  });
}
