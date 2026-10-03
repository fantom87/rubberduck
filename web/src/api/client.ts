import type { CheckResult, CheckSpec, Lesson, NextStep, ProgressWithPractice, Settings, Tier, Language, RunnerKind, JournalEntry } from "@teacher/shared";

export interface LessonRow {
  id: string;
  key: string;
  title: string;
  estMinutes: number;
  runner: RunnerKind;
  completedAt: string | null;
}

export interface ProjectRow {
  id: string;
  key: string;
  title: string;
  summary: string;
  estMinutes: number;
  runner: RunnerKind;
  stagesTotal: number;
  stagesDone: number;
  completedAt: string | null;
  /** the stage to open: first unfinished, or the last one when it's all done */
  resumeKey: string | null;
}

export interface UnitView {
  id: string;
  title: string;
  tier: Tier;
  summary: string;
  lessons: LessonRow[];
  projects: ProjectRow[];
  planned?: boolean;
  plannedLessons?: string[];
  topics?: string[];
}

/** The stage roster a project's rail renders, sent with any stage lesson. */
export interface ProjectContext {
  key: string;
  title: string;
  entry: string | null;
  stages: { id: string; key: string; title: string; completedAt: string | null }[];
}

export interface TrackView {
  id: string;
  title: string;
  language: Language;
  philosophy: string;
  units: UnitView[];
}

export interface CurriculumResponse {
  tracks: TrackView[];
  errors: { file: string; message: string }[];
}

export interface Health {
  ok: boolean;
  version: string;
  runtimes: {
    python: string | null;
    node: string | null;
    dotnet: string | null;
    go: string | null;
    rust: string | null;
    powershell: string | null;
    bash: string | null;
    sql: string;
  };
  /** Coarse view kept for compatibility: "failed" means the tutor is off,
   *  without saying which of the two reasons applies. */
  sdkAuth: "unknown" | "checking" | "ok" | "failed";
  sdkAuthDetail?: string;
  /** Why the tutor is off, when it is: no Claude Code at all, or one that
   *  isn't signed in. Absent from servers older than this field. */
  tutor?: {
    state: TutorState;
    detail?: string;
    /** the Claude Code the server resolved, or null when it found none */
    executable?: string | null;
  };
}

export type TutorState = "unknown" | "checking" | "ok" | "not-installed" | "not-logged-in";

/** The tutor pane renders optimistically until health answers, so this is
 *  deliberately three-valued: undefined = don't know yet. */
export function tutorAvailability(health: Health | null | undefined): {
  available: boolean | undefined;
  state: TutorState;
} {
  if (!health) return { available: undefined, state: "unknown" };
  const state: TutorState = health.tutor?.state ?? (health.sdkAuth === "failed" ? "not-logged-in" : health.sdkAuth);
  if (state === "ok") return { available: true, state };
  if (state === "not-installed" || state === "not-logged-in") return { available: false, state };
  return { available: undefined, state };
}

/** A non-2xx API response, carrying the server's `error` text and the status
 *  code (so callers can special-case e.g. 409 runtime-missing notices). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// App.tsx listens for these to show/clear the "can't reach the local server"
// banner. Fired on network-level failures (server down), not on HTTP errors.
export const API_OFFLINE_EVENT = "pt:api-offline";
export const API_ONLINE_EVENT = "pt:api-online";

async function request(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (err instanceof TypeError) window.dispatchEvent(new Event(API_OFFLINE_EVENT));
    throw err;
  }
  window.dispatchEvent(new Event(API_ONLINE_EVENT));
  if (!res.ok) {
    // Prefer the server's own message — it composes friendly, actionable
    // text (e.g. the winget command when a runtime is missing).
    let message = `${method} ${url} → ${res.status}`;
    try {
      const data = (await res.json()) as { error?: unknown };
      if (typeof data?.error === "string" && data.error) message = data.error;
    } catch {
      // non-JSON body — keep the generic message
    }
    throw new ApiError(message, res.status);
  }
  return res;
}

async function get<T>(url: string): Promise<T> {
  const res = await request("GET", url);
  return res.json() as Promise<T>;
}

function send(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<Response> {
  return request(method, url, body, headers);
}

export interface SnapshotMeta {
  id: string;
  lessonId: string;
  takenAt: string;
  trigger: "run" | "check";
  passed?: boolean;
}

export interface CheckResponse {
  run: import("@teacher/shared").RunResult | null;
  checks: import("@teacher/shared").CheckResult[];
  completed: boolean;
}

export interface DocsPage {
  slug: string;
  title: string;
  keywords: string[];
}

export interface DocsSection {
  section: string;
  pages: DocsPage[];
}

export type CustomLessonDifficulty = "beginner" | "intermediate" | "advanced";

export interface CustomLessonPreview {
  id: string;
  title: string;
  estMinutes: number;
  language: Language;
  runner: RunnerKind;
  goal: string;
  docs: string[];
  checks: CheckSpec[];
  hints: string[];
  body: string;
  files: string[];
}

export interface CustomLessonStatus {
  state: "generating" | "ready" | "failed";
  lesson?: CustomLessonPreview;
  checks?: CheckResult[];
  warnings?: string[];
  error?: string;
}

export const api = {
  curriculum: () => get<CurriculumResponse>("/api/curriculum"),
  lesson: (key: string) =>
    get<Lesson & { project?: ProjectContext }>(`/api/curriculum/lesson?id=${encodeURIComponent(key)}`),
  /** The canonical end-of-stage workspace — the learner's way out of a corner. */
  stageSolution: (key: string) =>
    get<{ files: Record<string, string> }>(`/api/curriculum/stage-solution?id=${encodeURIComponent(key)}`),
  progress: () => get<ProgressWithPractice>("/api/progress"),
  /** The one thing to open next, for the Home page's big button. Null when everything is done. */
  next: () => get<NextStep | null>("/api/next"),
  reportActivity: (seconds: number, lessonKey?: string) =>
    send("POST", "/api/progress/activity", { seconds, lessonKey }).then(() => undefined),
  /** Opening a lesson makes it the one "pick up where you left off" returns to. */
  visit: (lessonKey: string) => send("POST", "/api/progress/visit", { lessonKey }).then(() => undefined),
  resetProgress: () => send("POST", "/api/progress/reset", undefined, { "x-confirm": "reset" }).then(() => undefined),
  settings: () => get<Settings>("/api/settings"),
  saveSettings: (s: Settings) => send("PUT", "/api/settings", s).then(() => undefined),
  health: () => get<Health>("/api/health"),
  profile: () => get<{ profile: string }>("/api/profile"),
  saveProfile: (profile: string) => send("PUT", "/api/profile", { profile }).then(() => undefined),
  journal: () => get<JournalEntry[]>("/api/journal"),
  docsIndex: () => get<DocsSection[]>("/api/docs"),
  docsPage: (section: string, slug: string) =>
    get<{ markdown?: string }>(`/api/docs/page?section=${encodeURIComponent(section)}&slug=${encodeURIComponent(slug)}`),
  draft: (id: string) =>
    get<{ files: Record<string, string> | null }>(`/api/drafts?id=${encodeURIComponent(id)}`),
  saveDraft: (id: string, files: Record<string, string>) =>
    send("PUT", `/api/drafts?id=${encodeURIComponent(id)}`, { files }).then(() => undefined),
  run: async (lessonId: string, files: Record<string, string>) => {
    const res = await send("POST", "/api/run", { lessonId, files });
    return res.json() as Promise<import("@teacher/shared").RunResult>;
  },
  check: async (lessonId: string, files: Record<string, string>) => {
    const res = await send("POST", "/api/check", { lessonId, files });
    return res.json() as Promise<CheckResponse>;
  },
  createCustomLesson: async (trackId: string, prompt: string, difficulty: CustomLessonDifficulty) => {
    const res = await send("POST", "/api/custom-lesson", { trackId, prompt, difficulty });
    return res.json() as Promise<{ jobId: string }>;
  },
  customLessonStatus: (jobId: string) =>
    get<CustomLessonStatus>(`/api/custom-lesson/${encodeURIComponent(jobId)}`),
  acceptCustomLesson: async (jobId: string) => {
    const res = await send("POST", `/api/custom-lesson/${encodeURIComponent(jobId)}/accept`);
    return res.json() as Promise<{ key: string }>;
  },
  discardCustomLesson: (jobId: string) =>
    send("POST", `/api/custom-lesson/${encodeURIComponent(jobId)}/discard`).then(() => undefined),
  snapshots: (id: string) => get<SnapshotMeta[]>(`/api/snapshots?id=${encodeURIComponent(id)}`),
  snapshot: (id: string, snap: string) =>
    get<{ files: Record<string, string> }>(
      `/api/snapshots/one?id=${encodeURIComponent(id)}&snap=${encodeURIComponent(snap)}`,
    ),
};
