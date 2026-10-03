import type { AssistanceLevel, Lesson } from "@teacher/shared";

// The tutor's first line, written from the lesson itself, so the tutor speaks
// first at the two highest assistance levels. It costs no Claude usage, works
// offline, and is instant. Everything it quotes is already on screen: the goal,
// and the starter code's "1." comment when there is one (about 4 lessons in 10).

const STEP_ONE = /^\s*(?:#|\/\/|--|<!--)\s*(?:step\s*)?1[.):]\s*(.+?)\s*(?:-->)?\s*$/i;

function firstStep(source: string): { line: number; text: string } | null {
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(STEP_ONE);
    if (m) return { line: i + 1, text: m[1] };
  }
  return null;
}

export function buildOpener(lesson: Lesson, level: AssistanceLevel): string | null {
  if (level < 4) return null; // lower levels mean "let me get on with it"
  const entry = lesson.entry ?? lesson.files[0]?.path ?? "";
  const step = firstStep(lesson.starterFiles[entry] ?? "");
  const where = lesson.stage
    ? `Stage ${lesson.stage.stageIndex + 1} of ${lesson.stage.stageCount}, and your code from earlier stages is all still here.`
    : "";

  if (level === 5) {
    const start = step
      ? `Step 1 is the comment on line ${step.line} of \`${entry}\`:\n\n> ${step.text}\n\nDo just that bit, press **Run**, and tell me what you see.`
      : `Start with the comments at the top of \`${entry}\`, try the first line, and press **Run**. Mistakes are free here. Tell me what you see.`;
    return [`Hi! ${where} Here's what we're doing: ${lesson.goal}`.replace("  ", " "), "We'll go one small step at a time.", start].join("\n\n");
  }

  const start = step
    ? `First step, line ${step.line} of \`${entry}\`: ${step.text}`
    : `Read the comments in \`${entry}\` and try the first line.`;
  return [`${where} Goal: ${lesson.goal}`.trim(), `${start} Run early; I'll explain whatever comes back.`].join("\n\n");
}
