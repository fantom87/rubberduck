// The contract everything hangs off. Server, web, and content all import from here.

export type Tier = "foundations" | "core" | "intermediate" | "advanced" | "refresher" | "custom";
export type Language =
  | "python"
  | "javascript"
  | "html-css"
  | "csharp"
  | "sql"
  | "powershell"
  | "bash"
  | "go"
  | "rust";
export type RunnerKind = "browser" | "local";
export type AssistanceLevel = 1 | 2 | 3 | 4 | 5;

export const ASSISTANCE_NAMES: Record<AssistanceLevel, string> = {
  1: "Silent Examiner",
  2: "Coach",
  3: "Guide",
  4: "Instructor",
  5: "Hand-holder",
};

// ---------- Running code ----------

export interface TestEvent {
  name: string;
  passed: boolean;
  message?: string;
}

export interface RunResult {
  ok: boolean; // ran to completion (not the same as "correct")
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  domSnapshot?: string; // serialized HTML after render (html-css lessons)
  events?: TestEvent[]; // structured results from the injected test harness
}

// ---------- Goal checks ----------

export type DomAssertion =
  | { selector: string; exists: true }
  | { selector: string; textContains: string }
  | { selector: string; count: number }
  | { selector: string; attr: string; equals: string }
  | { selector: string; cssRule: { property: string; equals: string } };

export type CheckSpec =
  | {
      id: string;
      type: "stdout";
      entry: string;
      match: "exact" | "contains" | "regex";
      value: string;
      stdin?: string;
    }
  | { id: string; type: "tests"; entry: string; testFile: string }
  | { id: string; type: "dom"; assertions: DomAssertion[] }
  | { id: string; type: "ai-judge"; rubric: string };

export interface CheckResult {
  checkId: string;
  passed: boolean;
  message: string;
  expected?: string;
  actual?: string;
  /** true when an ai-judge check could not be graded (offline/auth) — such a
   *  check never blocks completion; a real failed verdict does. */
  unreachable?: boolean;
}

// ---------- Curriculum ----------

export interface LessonFile {
  path: string;
  starter: string; // path within the lesson dir
}

export interface LessonMeta {
  id: string;
  title: string;
  language: Language;
  runner: RunnerKind;
  estMinutes: number;
  files: LessonFile[];
  goal: string;
  docs?: string[]; // doc slugs, e.g. "python/loops"
  checks: CheckSpec[];
  hints?: string[];
  timeoutMs?: number; // local-runner override
}

export interface Lesson extends LessonMeta {
  trackId: string;
  unitId: string;
  body: string; // markdown below the frontmatter
  starterFiles: Record<string, string>; // path -> contents (sent to frontend)
  testFiles: Record<string, string>; // testFile path -> contents (used by both runners)
  /** key of the lesson that follows this one (API-populated; null at the end of authored content) */
  nextLessonKey?: string | null;
  /** present only when this Lesson is a projected stage of a tutorial project */
  stage?: StageRef;
  /** the file the runners execute; for a stage it comes from the project, never from files[0] */
  entry?: string;
}

/**
 * What makes a projected stage different from an ordinary lesson.
 *
 * A project's stages are loaded as Lessons — same shape, same map, same
 * runners, same checks — because everything downstream of the loader already
 * takes a Lesson by value. Only the identity differs: completion is keyed per
 * stage, but the workspace the learner is editing belongs to the whole
 * project, so drafts are keyed by `projectKey`. That split is what carries
 * their own code from one stage to the next.
 */
export interface StageRef {
  /** "trackId/unitId/projectId" — the draft key for the shared workspace */
  projectKey: string;
  projectTitle: string;
  stageIndex: number; // 0-based
  stageCount: number;
}

export interface ProjectStage {
  id: string;
  title: string;
  goal: string;
  docs?: string[];
  checks: CheckSpec[];
  hints?: string[];
  estMinutes: number;
  timeoutMs?: number;
}

export interface ProjectMeta {
  id: string;
  title: string;
  language: Language;
  runner: RunnerKind;
  /** the file the runners execute — projects don't get to guess from files[0] */
  entry: string;
  summary: string;
  /** folder holding the starting files, relative to the project dir */
  workspace: string;
  stages: string[]; // stage ids, in order
  estMinutes: number;
}

export interface Project extends ProjectMeta {
  trackId: string;
  unitId: string;
  body: string; // the brief
  workspaceFiles: Record<string, string>;
  stageList: ProjectStage[]; // resolved, in order
}

export interface Unit {
  id: string;
  title: string;
  tier: Tier;
  summary: string;
  lessons: string[]; // lesson ids, in order
  /** tutorial project ids, in order — a unit may hold both, or only one kind */
  projects: string[];
  planned?: boolean; // true = syllabus entry whose lessons aren't authored yet
  plannedLessons?: string[]; // ids of lessons designed but not yet authored
  topics?: string[]; // for planned units: what its lessons will cover
}

export interface Track {
  id: string;
  title: string;
  language: Language;
  philosophy: string;
  units: Unit[];
}

// ---------- Progress / settings / journal ----------

export interface LessonProgress {
  completedAt?: string;
  attempts: number;
  timeSpentMin: number;
}

export interface Progress {
  lessons: Record<string, LessonProgress>;
  streak: {
    current: number;
    best: number;
    lastActiveDate: string;
    /** rolling activity tally for the ≥15-minute streak rule */
    todayDate?: string;
    todayMinutes?: number;
  };
  totals: { runs: number; checksPassed: number; checksFailed: number };
  /** persisted-data schema version for future migrations */
  version?: number;
}

export interface Settings {
  theme: "dark" | "light";
  assistanceDefault: AssistanceLevel;
  tutorModel: "claude-sonnet-5" | "claude-opus-4-8" | "claude-fable-5";
  editor: { fontSize: number; autocomplete: boolean };
  layout?: { paneSizes: number[] };
  onboarded: boolean;
  /** Absolute path to the learner's own Claude Code, for installs the
   *  automatic lookup can't find. Empty/absent means "go and find it". */
  claudePath?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  assistanceDefault: 3,
  tutorModel: "claude-fable-5",
  editor: { fontSize: 14, autocomplete: true },
  onboarded: false,
};

export interface JournalEntry {
  lessonId: string;
  trackId: string;
  completedAt: string;
  summary: string; // 2 lines, tutor-written
}

export interface Snapshot {
  id: string;
  lessonId: string;
  takenAt: string;
  trigger: "run" | "check";
  /** set when this snapshot's code passed every check (restore point) */
  passed?: boolean;
  files: Record<string, string>;
}
