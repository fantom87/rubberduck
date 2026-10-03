import type { AssistanceLevel, Lesson } from "@teacher/shared";

// The tutor's first line, written from the lesson itself, so the tutor speaks
// first at the two highest assistance levels. It costs no Claude usage, works
// offline, and is instant. Everything it quotes is already on screen: the goal,
// and the starter code's "1." comment when there is one (about 4 lessons in 10).

const COMMENT = /^\s*(#|\/\/|--)\s?(.*)$/;
const NUMBERED = /^\s*(?:#|\/\/|--|<!--)\s*(?:step\s*)?\d+[.):]/i;
const STEP_ONE = /^\s*(?:#|\/\/|--|<!--)\s*(?:step\s*)?1[.):]\s*(.+?)\s*(?:-->)?\s*$/i;

/**
 * Step 1 in full. A third of these comments run onto the next lines ("Write a
 * while loop. Each trip:" then a list), and quoting only the first line
 * leaves the learner holding half an instruction. Continuation lines are the
 * comments that follow, up to the next numbered step, a blank comment, or code.
 */
export function firstStep(source: string): { line: number; text: string } | null {
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(STEP_ONE);
    if (!m) continue;
    const text = [m[1]];
    for (let j = i + 1; j < lines.length; j++) {
      if (NUMBERED.test(lines[j])) break;
      const c = lines[j].match(COMMENT);
      if (!c || !c[2].trim()) break;
      text.push(c[2].trimEnd());
    }
    return { line: i + 1, text: text.join("\n") };
  }
  return null;
}

/**
 * Markdown-escape prose, leaving `code spans` alone. Goals mention things like
 * List<Shape> and __init__, which markdown would otherwise read as an HTML tag
 * (stripped) and as bold.
 */
export function escapeMarkdown(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/([\\*_<>[\]])/g, "\\$1")))
    .join("");
}

/** Quoted verbatim in a fence: nothing inside a code block is markdown. */
function fenced(text: string): string {
  return "```text\n" + text.replace(/```/g, "'''") + "\n```";
}

export function buildOpener(lesson: Lesson, level: AssistanceLevel): string | null {
  if (level < 4) return null; // lower levels mean "let me get on with it"
  const entry = lesson.entry ?? lesson.files[0]?.path ?? "";
  const step = firstStep(lesson.starterFiles[entry] ?? "");
  const goal = escapeMarkdown(lesson.goal);
  const where = lesson.stage
    ? `Stage ${lesson.stage.stageIndex + 1} of ${lesson.stage.stageCount}, and your code from earlier stages is all still here. `
    : "";

  if (level === 5) {
    const start = step
      ? `Step 1 is the comment on line ${step.line} of \`${entry}\`:\n\n${fenced(step.text)}\n\nDo just that bit, press **Run**, and tell me what you see.`
      : `Start with the comments at the top of \`${entry}\`, try the first line, and press **Run**. Mistakes are free here. Tell me what you see.`;
    return [`Hi! ${where}Here's what we're doing: ${goal}`, "We'll go one small step at a time.", start].join("\n\n");
  }

  const start = step
    ? `First step, line ${step.line} of \`${entry}\`:\n\n${fenced(step.text)}`
    : `Read the comments in \`${entry}\` and try the first line.`;
  return [`${where}Goal: ${goal}`, start, "Run early; I'll explain whatever comes back."].join("\n\n");
}
