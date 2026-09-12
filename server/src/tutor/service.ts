import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import type { Response } from "express";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AssistanceLevel, CheckResult, Lesson, RunResult, Settings } from "@teacher/shared";
import { DEFAULT_SETTINGS, completionVerdict } from "@teacher/shared";
import { buildPlacementPrompt, buildPlaygroundPrompt, buildSystemPrompt, wrapTurn } from "./prompts.js";
import { sdkEnv } from "./judge.js";
import { claudeExecutableOption, locateClaude } from "./claudeBinary.js";
import { runLocal } from "../runner/localRunner.js";
import { evaluateDomAssertions } from "../runner/domCheck.js";
import { runCheckPass } from "../checks/run.js";
import { getProgress, recordChecks } from "../store/progress.js";
import { appendProfileNote, getProfile } from "../store/profile.js";
import { recordCompletion } from "../store/completion.js";
import { readJson, writeJson } from "../store/jsonStore.js";
import { detectRuntimes } from "../preflight.js";
import { missingRuntimeHint } from "../runtimeHints.js";

// ---------- SSE hub ----------

export type SseEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-use"; name: string; detail?: string }
  | { type: "check-results"; checks: unknown[]; completed: boolean }
  | { type: "hint"; index: number }
  | { type: "doc"; slug: string }
  | { type: "complete" }
  | { type: "turn-end" }
  | { type: "recommendation"; unitId: string; assistanceLevel: number; reasoning: string }
  | { type: "error"; message: string };

const BUFFER_SIZE = 300;

// Monotonic across ALL keys and resets — ids are never reused until server
// restart, so clients can safely dedupe replayed events by id.
let nextEventId = 1;

interface BufferedSseEvent {
  id: number;
  event: SseEvent;
}

class SseHub {
  private clients = new Map<string, Set<Response>>();
  private buffers = new Map<string, BufferedSseEvent[]>();

  /** Replays the buffered transcript (events newer than afterId, or all of it),
   *  then subscribes. Reconnects and remounts recover everything they missed. */
  subscribe(key: string, res: Response, afterId?: number): () => void {
    for (const item of this.buffers.get(key) ?? []) {
      if (afterId !== undefined && item.id <= afterId) continue;
      res.write(`id: ${item.id}\ndata: ${JSON.stringify(item.event)}\n\n`);
    }
    if (!this.clients.has(key)) this.clients.set(key, new Set());
    this.clients.get(key)!.add(res);
    return () => this.clients.get(key)?.delete(res);
  }

  send(key: string, event: SseEvent): void {
    const id = nextEventId++;
    let buffer = this.buffers.get(key);
    if (!buffer) {
      buffer = [];
      this.buffers.set(key, buffer);
    }
    buffer.push({ id, event });
    if (buffer.length > BUFFER_SIZE) buffer.splice(0, buffer.length - BUFFER_SIZE);
    for (const res of this.clients.get(key) ?? []) {
      res.write(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  }

  clearBuffer(key: string): void {
    this.buffers.delete(key);
  }

  heartbeat(): void {
    for (const set of this.clients.values()) {
      for (const res of set) res.write(": ping\n\n");
    }
  }
}

export const hub = new SseHub();
setInterval(() => hub.heartbeat(), 15_000).unref();

// ---------- session plumbing ----------

interface QueuedTurn {
  wrapped: string;
}

class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((v: T) => void)[] = [];
  private closed = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    // Wake pending waiters with no more input — generator ends.
    for (const w of this.waiters.splice(0)) w(undefined as T);
  }

  /** Removes and returns items not yet consumed (for handing to a successor queue). */
  takePending(): T[] {
    return this.items.splice(0);
  }

  async next(): Promise<T | undefined> {
    if (this.items.length > 0) return this.items.shift();
    if (this.closed) return undefined;
    return new Promise<T>((resolve) => this.waiters.push(resolve));
  }
}

export type SessionMode = "lesson" | "playground" | "placement";

export interface PlacementInfo {
  trackTitle: string;
  units: { id: string; title: string; tier: string; summary: string }[];
}

interface TutorSession {
  key: string;
  lesson: Lesson;
  mode: SessionMode;
  placementInfo?: PlacementInfo;
  level: AssistanceLevel;
  levelChanged: boolean;
  latestFiles: Record<string, string>;
  lastRun: RunResult | null;
  lastChecks: CheckResult[] | null;
  queue: AsyncQueue<QueuedTurn>;
  done: Promise<void>;
  idleTimer?: NodeJS.Timeout;
  sdkQuery?: ReturnType<typeof query>;
  /** placement only: learner turns since recommend_start fired (undefined until it fires) */
  postRecommendTurns?: number;
}

export interface TutorDeps {
  dataDir: string;
  contentDir: string;
  getSolution: (key: string) => Promise<Record<string, string> | null>;
  getDocSlugs: () => Promise<string[]>;
  getSettings: () => Promise<Settings>;
}

const sessions = new Map<string, TutorSession>();

const IDLE_MS = 20 * 60_000; // close idle sessions; resume makes revival transparent
const PLACEMENT_IDLE_MS = 10 * 60_000;
const POST_RECOMMEND_TURNS = 2; // placement ends shortly after the recommendation

function sessionFile(dataDir: string, key: string): string {
  return path.join(dataDir, "sessions", `${key.replaceAll("/", "__")}.json`);
}

export function getSessionLevel(key: string): AssistanceLevel | null {
  return sessions.get(key)?.level ?? null;
}

function closeSession(session: TutorSession): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = undefined;
  session.queue.close();
}

function armIdleTimer(session: TutorSession): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  const ms = session.mode === "placement" ? PLACEMENT_IDLE_MS : IDLE_MS;
  session.idleTimer = setTimeout(() => {
    closeSession(session);
    if (sessions.get(session.key) === session) sessions.delete(session.key);
  }, ms);
  session.idleTimer.unref?.();
}

function crossesSolutionThreshold(a: AssistanceLevel, b: AssistanceLevel): boolean {
  // The reference solution enters the system prompt at level >= 3.
  return (a >= 3) !== (b >= 3);
}

/** Close the current query and start a fresh one on the same key: rebuilt
 *  system prompt, resumed SDK session. Pending turns carry over. */
function restartSession(deps: TutorDeps, old: TutorSession): TutorSession {
  const pending = old.queue.takePending();
  closeSession(old);
  if (sessions.get(old.key) === old) sessions.delete(old.key);
  const fresh: TutorSession = {
    key: old.key,
    lesson: old.lesson,
    mode: old.mode,
    placementInfo: old.placementInfo,
    level: old.level,
    levelChanged: old.levelChanged,
    latestFiles: old.latestFiles,
    lastRun: old.lastRun,
    lastChecks: old.lastChecks,
    postRecommendTurns: old.postRecommendTurns,
    queue: new AsyncQueue<QueuedTurn>(),
    done: Promise.resolve(),
  };
  sessions.set(fresh.key, fresh);
  fresh.done = startSession(deps, fresh);
  for (const turn of pending) fresh.queue.push(turn);
  armIdleTimer(fresh);
  return fresh;
}

export async function setLevel(deps: TutorDeps, key: string, level: AssistanceLevel): Promise<void> {
  const s = sessions.get(key);
  if (!s || s.level === level) return;
  const crossed = s.mode === "lesson" && crossesSolutionThreshold(s.level, level);
  s.level = level;
  s.levelChanged = true;
  // Crossing 2↔3 changes what the frozen system prompt may contain (the
  // reference solution), so the query must be rebuilt, not just notified.
  if (crossed) restartSession(deps, s);
}

export async function resetSession(deps: TutorDeps, key: string): Promise<void> {
  const s = sessions.get(key);
  if (s) {
    closeSession(s);
    sessions.delete(key);
  }
  hub.clearBuffer(key);
  const file = sessionFile(deps.dataDir, key);
  const stored = await readJson<{ sessionId?: string | null }>(file, {});
  if (stored.sessionId) await deleteSdkTranscript(stored.sessionId);
  await writeJson(file, { sessionId: null });
}

/** The Agent SDK persists conversation transcripts under the user's Claude home
 *  dir (keyed by process cwd), outside data/. A reset shouldn't leave the
 *  learner's conversation history behind. Best effort — the layout is the SDK's. */
async function deleteSdkTranscript(sessionId: string): Promise<void> {
  if (!/^[a-z0-9-]+$/i.test(sessionId)) return;
  const projectDir = process.cwd().replace(/[^a-zA-Z0-9]/g, "-");
  const file = path.join(os.homedir(), ".claude", "projects", projectDir, `${sessionId}.jsonl`);
  await fs.unlink(file).catch(() => {});
}

/** Interrupt the in-flight turn of a session, if the SDK supports it. */
export async function interruptSession(key: string): Promise<void> {
  const q = sessions.get(key)?.sdkQuery as { interrupt?: () => Promise<void> } | undefined;
  if (q && typeof q.interrupt === "function") {
    await q.interrupt().catch((err) => console.warn(`[tutor] interrupt ${key} failed:`, err));
  }
}

/** Latest server-side check results for a key (e.g. from /api/check) — feeds
 *  the per-turn checks: line so the tutor knows the goal state without a tool call. */
export function updateChecks(key: string, checks: CheckResult[]): void {
  const s = sessions.get(key);
  if (s) s.lastChecks = checks;
}

/** Full tutor-state reset for "Reset all progress": close every live session
 *  and best-effort delete every stored SDK transcript, so nothing conversational
 *  survives a wipe. The caller removes data/sessions itself afterwards. */
export async function resetAllTutorState(dataDir: string): Promise<void> {
  for (const [key, s] of [...sessions]) {
    closeSession(s);
    sessions.delete(key);
    hub.clearBuffer(key);
  }
  const dir = path.join(dataDir, "sessions");
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const stored = await readJson<{ sessionId?: string | null }>(path.join(dir, name), {});
    if (stored.sessionId) await deleteSdkTranscript(stored.sessionId);
  }
}

// ---------- per-session tools ----------

// Same guidance /api/run and /api/check give — the tutor must never surface a
// raw "spawn dotnet ENOENT" as if it were the learner's bug.
async function missingRuntimeMessage(language: string): Promise<string | null> {
  // javascript is deliberately absent: this server IS Node, so it's present.
  if (!["python", "csharp", "go", "rust", "bash", "powershell"].includes(language)) return null;
  return missingRuntimeHint(language, await detectRuntimes());
}

function buildTools(deps: TutorDeps, session: TutorSession) {
  const { dataDir } = deps;
  const lesson = session.lesson;
  const key = session.key;

  const runCode = tool(
    "run_code",
    "Run the learner's current editor code and return the result. Pass files to run a modified variant instead of the learner's exact buffer.",
    { files: z.record(z.string(), z.string()).optional() },
    async (args) => {
      hub.send(key, { type: "tool-use", name: "run_code" });
      const files = args.files ?? session.latestFiles;
      let result: RunResult;
      if (lesson.language === "html-css") {
        const assertions = lesson.checks.flatMap((c) => (c.type === "dom" ? c.assertions : []));
        const { domSnapshot } = await evaluateDomAssertions(files, assertions);
        result = { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0, timedOut: false, domSnapshot };
      } else {
        const missing = await missingRuntimeMessage(lesson.language);
        if (missing) {
          return { content: [{ type: "text" as const, text: missing }], isError: true };
        }
        result = await runLocal(dataDir, {
          language: lesson.language,
          entry: lesson.entry ?? lesson.files[0].path,
          files,
          timeoutMs: lesson.timeoutMs,
        });
      }
      session.lastRun = result;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              stdout: result.stdout.slice(0, 2000),
              stderr: result.stderr.slice(0, 2000),
              domSnapshot: result.domSnapshot?.slice(0, 3000),
            }),
          },
        ],
      };
    },
  );

  const checkGoal = tool(
    "check_goal",
    "Run every goal check for this lesson against the learner's current code.",
    {},
    async () => {
      hub.send(key, { type: "tool-use", name: "check_goal" });
      const missing = await missingRuntimeMessage(lesson.language);
      if (missing) {
        return { content: [{ type: "text" as const, text: missing }], isError: true };
      }
      const pass = await runCheckPass(dataDir, lesson, session.latestFiles, lesson.testFiles);
      session.lastChecks = pass.checks;
      await recordChecks(dataDir, pass.checks.filter((c) => c.passed).length, pass.checks.filter((c) => !c.passed).length);
      const verdict = completionVerdict(pass.checks);
      const progress = await getProgress(dataDir);
      const alreadyCompleted = Boolean(progress.lessons[key]?.completedAt);
      hub.send(key, { type: "check-results", checks: pass.checks, completed: alreadyCompleted });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              complete: verdict.complete,
              blockedBy: verdict.blockedBy,
              checks: pass.checks.map((c) => ({ id: c.checkId, passed: c.passed, unreachable: c.unreachable, message: c.message })),
              ...(verdict.complete && !alreadyCompleted
                ? { next: "Every required check passes — call mark_complete NOW with a journalSummary." }
                : {}),
            }),
          },
        ],
      };
    },
  );

  const markComplete = tool(
    "mark_complete",
    "Mark the lesson complete. Refused unless every goal check passes right now. Include a 2-line journal summary of what the learner learned.",
    { journalSummary: z.string().min(10).max(400) },
    async (args) => {
      hub.send(key, { type: "tool-use", name: "mark_complete" });
      const missing = await missingRuntimeMessage(lesson.language);
      if (missing) {
        return { content: [{ type: "text" as const, text: missing }], isError: true };
      }
      // Guard: the server re-runs checks itself; the model can't be sweet-talked.
      const pass = await runCheckPass(dataDir, lesson, session.latestFiles, lesson.testFiles);
      session.lastChecks = pass.checks;
      await recordChecks(dataDir, pass.checks.filter((c) => c.passed).length, pass.checks.filter((c) => !c.passed).length);
      const verdict = completionVerdict(pass.checks);
      if (!verdict.complete) {
        return {
          content: [{ type: "text" as const, text: `REFUSED: these checks are not passing: ${verdict.blockedBy.join(", ")}. Help the learner fix them first.` }],
          isError: true,
        };
      }
      await recordCompletion(dataDir, key, lesson, args.journalSummary);
      hub.send(key, { type: "check-results", checks: pass.checks, completed: true });
      hub.send(key, { type: "complete" });
      return { content: [{ type: "text" as const, text: "Lesson marked complete. Congratulate the learner briefly." }] };
    },
  );

  const showHint = tool(
    "show_hint",
    "Reveal one of the lesson's baked hints in the lesson pane (0-based index).",
    { index: z.number().int().min(0) },
    async (args) => {
      const max = (lesson.hints?.length ?? 0) - 1;
      if (args.index > max) {
        return { content: [{ type: "text" as const, text: `No hint at index ${args.index}; the last is ${max}.` }], isError: true };
      }
      hub.send(key, { type: "hint", index: args.index });
      return { content: [{ type: "text" as const, text: `Hint ${args.index} is now visible in the lesson pane.` }] };
    },
  );

  const showDoc = tool(
    "show_doc",
    "Open a documentation page in the app's docs drawer.",
    { slug: z.string() },
    async (args) => {
      hub.send(key, { type: "doc", slug: args.slug });
      return { content: [{ type: "text" as const, text: `Doc "${args.slug}" is now open for the learner.` }] };
    },
  );

  const updateProfile = tool(
    "update_profile",
    "Record a durable observation about the learner (recurring mistake, preference, mastered concept). Optionally replace ONE outdated note by passing a distinctive substring of it (at least 10 characters; only the first matching line is removed).",
    { note: z.string().min(5).max(200), replaces: z.string().min(10).optional() },
    async (args) => {
      await appendProfileNote(dataDir, args.note, args.replaces);
      return { content: [{ type: "text" as const, text: "Noted." }] };
    },
  );

  const recommendStart = tool(
    "recommend_start",
    "Deliver the placement recommendation: which unit the learner should start at and their initial assistance level.",
    {
      unitId: z.string(),
      assistanceLevel: z.number().int().min(1).max(5),
      reasoning: z.string().max(300),
    },
    async (args) => {
      hub.send(key, { type: "recommendation", unitId: args.unitId, assistanceLevel: args.assistanceLevel, reasoning: args.reasoning });
      // The interview winds down: a couple more learner turns, then the queue closes.
      session.postRecommendTurns ??= 0;
      return { content: [{ type: "text" as const, text: "Recommendation delivered — now tell the learner in one or two warm sentences." }] };
    },
  );

  const toolsByMode = {
    lesson: [runCode, checkGoal, markComplete, showHint, showDoc, updateProfile],
    playground: [runCode, showDoc, updateProfile],
    placement: [recommendStart, updateProfile],
  }[session.mode];

  return createSdkMcpServer({
    name: "tutor",
    version: "1.0.0",
    tools: toolsByMode,
  });
}

const TOOL_NAMES = [
  "mcp__tutor__run_code",
  "mcp__tutor__check_goal",
  "mcp__tutor__mark_complete",
  "mcp__tutor__show_hint",
  "mcp__tutor__show_doc",
  "mcp__tutor__update_profile",
  "mcp__tutor__recommend_start",
];

// ---------- the session loop ----------

function friendlyTutorError(detail: string): string | null {
  const d = detail.toLowerCase();
  if (d.includes("usage") || d.includes("limit") || d.includes("credit")) {
    return "Claude usage limit reached — tutoring pauses until it resets. Deterministic checks still work.";
  }
  if (d.includes("max_turns")) {
    return "The tutor hit its turn limit for this stretch — just send another message to pick up where you left off.";
  }
  return null;
}

async function startSession(deps: TutorDeps, session: TutorSession): Promise<void> {
  const { dataDir } = deps;
  const key = session.key;
  const settings = await deps.getSettings().catch(() => DEFAULT_SETTINGS);
  const solution = await deps.getSolution(key);
  const profile = await getProfile(dataDir);
  const docSlugs = await deps.getDocSlugs();
  // Playground and placement conversations are ephemeral by design: never
  // persisted, never resumed — every visit starts fresh.
  const persistent = session.mode === "lesson";
  const stored = persistent ? await readJson<{ sessionId?: string | null }>(sessionFile(dataDir, key), {}) : {};

  const systemPrompt =
    session.mode === "playground"
      ? buildPlaygroundPrompt({ language: session.lesson.language, profile, docSlugs, level: session.level })
      : session.mode === "placement"
        ? buildPlacementPrompt({
            trackTitle: session.placementInfo?.trackTitle ?? session.lesson.trackId,
            units: session.placementInfo?.units ?? [],
            profile,
          })
        : buildSystemPrompt({
            lesson: session.lesson,
            solution,
            level: session.level,
            profile,
            docSlugs,
          });

  async function* turns() {
    while (true) {
      const item = await session.queue.next();
      if (!item) return;
      yield {
        type: "user" as const,
        message: { role: "user" as const, content: item.wrapped },
        parent_tool_use_id: null,
        session_id: "",
      };
    }
  }

  try {
    const q = query({
      prompt: turns(),
      options: {
        // The learner's own Claude Code, when they have one — we ship none.
        ...(await claudeExecutableOption()),
        model: settings.tutorModel,
        systemPrompt,
        mcpServers: { tutor: buildTools(deps, session) },
        allowedTools: TOOL_NAMES,
        disallowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "TodoWrite", "NotebookEdit"],
        includePartialMessages: true,
        resume: stored.sessionId ?? undefined,
        env: sdkEnv(),
        maxTurns: 500,
      },
    });
    session.sdkQuery = q;

    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") {
        if (persistent) {
          await writeJson(sessionFile(dataDir, key), { sessionId: message.session_id, updatedAt: new Date().toISOString() });
        }
      } else if (message.type === "stream_event") {
        const event = message.event as { type: string; delta?: { type: string; text?: string }; content_block?: { type: string; name?: string } };
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          hub.send(key, { type: "text-delta", text: event.delta.text });
        }
      } else if (message.type === "result") {
        hub.send(key, { type: "turn-end" });
        if (message.subtype !== "success") {
          hub.send(key, { type: "error", message: friendlyTutorError(message.subtype) ?? `Tutor error: ${message.subtype}` });
        }
      }
    }
  } catch (err) {
    console.error(`[tutor] session ${key} failed:`, err);
    hub.send(key, { type: "error", message: friendlyTutorError(String(err)) ?? String(err) });
  } finally {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    // A successor session may already own this key (reset, restart) — never delete it.
    if (sessions.get(key) === session) sessions.delete(key);
  }
}

export async function sendMessage(
  deps: TutorDeps,
  lesson: Lesson,
  opts: {
    text: string;
    files: Record<string, string>;
    lastRun?: RunResult | null;
    lastChecks?: CheckResult[] | null;
    level: AssistanceLevel;
    mode?: SessionMode;
    placementInfo?: PlacementInfo;
  },
): Promise<void> {
  const key = `${lesson.trackId}/${lesson.unitId}/${lesson.id}`;
  let session = sessions.get(key);
  if (!session) {
    const mode = opts.mode ?? "lesson";
    if (mode === "lesson") {
      // Concurrency cap: one live lesson conversation at a time. Closing the
      // others is invisible — resume revives them on their next message.
      for (const other of sessions.values()) {
        if (other.mode === "lesson" && other.key !== key) {
          closeSession(other);
          // Drop it from the map now. startSession's finally would do it, but
          // only after the SDK finishes the in-flight turn — and in that window
          // a message for the closed key would be pushed onto a queue nothing
          // drains.
          sessions.delete(other.key);
        }
      }
    }
    session = {
      key,
      lesson,
      mode,
      placementInfo: opts.placementInfo,
      level: opts.level,
      levelChanged: false,
      latestFiles: opts.files,
      lastRun: opts.lastRun ?? null,
      lastChecks: opts.lastChecks ?? null,
      queue: new AsyncQueue<QueuedTurn>(),
      done: Promise.resolve(),
    };
    sessions.set(key, session);
    session.done = startSession(deps, session);
  } else if (opts.level !== session.level) {
    const crossed = session.mode === "lesson" && crossesSolutionThreshold(session.level, opts.level);
    session.level = opts.level;
    session.levelChanged = true;
    if (crossed) session = restartSession(deps, session);
  }
  session.latestFiles = opts.files;
  if (opts.lastRun) session.lastRun = opts.lastRun;
  if (opts.lastChecks) session.lastChecks = opts.lastChecks;

  const wrapped = wrapTurn({
    text: opts.text,
    level: session.level,
    levelChanged: session.levelChanged,
    files: opts.files,
    lastRun: session.lastRun,
    lastChecks: session.lastChecks,
    stage: session.lesson.stage
      ? {
          index: session.lesson.stage.stageIndex,
          count: session.lesson.stage.stageCount,
          title: session.lesson.title,
        }
      : null,
  });
  session.levelChanged = false;
  session.queue.push({ wrapped });
  armIdleTimer(session);

  // Placement interviews end shortly after the recommendation is delivered;
  // any later visit starts a genuinely fresh interview (no resume).
  if (session.mode === "placement" && session.postRecommendTurns !== undefined) {
    session.postRecommendTurns += 1;
    if (session.postRecommendTurns >= POST_RECOMMEND_TURNS) {
      closeSession(session); // queued turns still drain before the query ends
      if (sessions.get(key) === session) sessions.delete(key);
    }
  }
}

// ---------- startup self-test ----------

export type SdkAuthStatus = "unknown" | "checking" | "ok" | "failed";

/** The two ways the tutor can be off are fixed by different things, so they
 *  are reported separately: install Claude Code, or sign the one you have in.
 *  `sdkAuth` below stays as the coarse legacy view of the same state. */
export type TutorState = "unknown" | "checking" | "ok" | "not-installed" | "not-logged-in";

let tutorState: TutorState = "unknown";
let tutorDetail = "";
let tutorExecutable: string | null = null;

const COARSE: Record<TutorState, SdkAuthStatus> = {
  unknown: "unknown",
  checking: "checking",
  ok: "ok",
  "not-installed": "failed",
  "not-logged-in": "failed",
};

export function getAuthStatus(): { status: SdkAuthStatus; detail: string } {
  return { status: COARSE[tutorState], detail: tutorDetail };
}

export function getTutorStatus(): { state: TutorState; detail: string; executable: string | null } {
  return { state: tutorState, detail: tutorDetail, executable: tutorExecutable };
}

/** One sentence naming the actual fix, or null when the tutor is usable.
 *  Shared by everything that has to decline AI work: judging, authoring. */
export function tutorOfflineReason(): string | null {
  if (tutorState === "not-installed") {
    return "The AI tutor runs on your own Claude Code, which isn't installed on this machine.";
  }
  if (tutorState === "not-logged-in") {
    return 'Claude Code is installed but not signed in — run "claude setup-token" in a terminal, then restart the app.';
  }
  return null;
}

/** An executable that exists but won't start is an install problem, not a
 *  login problem — the SDK says so in the failure text. */
function looksLikeMissingBinary(detail: string): boolean {
  return /not found|ENOENT|failed to launch|no such file/i.test(detail);
}

let selfTest: Promise<void> | null = null;

/** Locate the learner's Claude Code and, if there is one, spend a single
 *  cheap turn proving it is signed in. Concurrent callers share one run. */
export async function selfTestAuth(): Promise<void> {
  selfTest ??= runSelfTest().finally(() => {
    selfTest = null;
  });
  return selfTest;
}

async function runSelfTest(): Promise<void> {
  const location = await locateClaude();
  if (!location) {
    tutorState = "not-installed";
    tutorExecutable = null;
    tutorDetail = "Claude Code was not found on this machine.";
    console.log("[tutor] no Claude Code executable found — the tutor is off (everything else still works)");
    return; // nothing to spawn: skip the self-test entirely
  }
  tutorExecutable = location.path;
  console.log(`[tutor] using Claude Code at ${location.path} (found via ${location.source})`);

  tutorState = "checking";
  try {
    for await (const message of query({
      prompt: "Reply with exactly: ok",
      options: {
        pathToClaudeCodeExecutable: location.path,
        model: "claude-haiku-4-5-20251001",
        maxTurns: 1,
        allowedTools: [],
        env: sdkEnv(),
      },
    })) {
      if (message.type === "result") {
        if (message.subtype === "success") {
          tutorState = "ok";
          tutorDetail = "";
        } else {
          tutorState = "not-logged-in";
          tutorDetail = message.subtype;
        }
      }
    }
  } catch (err) {
    tutorDetail = String(err);
    tutorState = looksLikeMissingBinary(tutorDetail) ? "not-installed" : "not-logged-in";
  }
  console.log(`[tutor] self-test: ${tutorState}${tutorDetail ? ` (${tutorDetail})` : ""}`);
}

/** /api/health calls this, so installing Claude Code (or pointing Settings at
 *  it) takes effect without a restart. Cheap: the lookup is filesystem-only
 *  and memoized for a minute, and the paid self-test only re-runs when the
 *  executable we would use actually changed. */
export async function refreshTutorStatus(): Promise<void> {
  if (selfTest) return; // a run is already in flight
  const found = (await locateClaude())?.path ?? null;
  if (found === tutorExecutable && tutorState !== "unknown") return;
  if (!found) {
    tutorState = "not-installed";
    tutorExecutable = null;
    tutorDetail = "Claude Code was not found on this machine.";
    return;
  }
  await selfTestAuth();
}
