import path from "node:path";
import { Router } from "express";
import type { AssistanceLevel, Language, Lesson, Settings } from "@teacher/shared";
import { DEFAULT_SETTINGS } from "@teacher/shared";
import { getCurriculum } from "../curriculum/loader.js";
import { readJson } from "../store/jsonStore.js";
import { getJournal, getProfile, setProfile } from "../store/profile.js";
import { resolvePaths } from "../paths.js";
import { allDocSlugs } from "./docs.js";
import { setSolutionProvider } from "../tutor/judge.js";
import { parseFiles } from "./files.js";
import {
  hub,
  interruptSession,
  resetSession,
  sendMessage,
  setLevel,
  type PlacementInfo,
  type SessionMode,
  type TutorDeps,
} from "../tutor/service.js";

const PLAYGROUND_FILES: Record<Language, string> = {
  python: "main.py",
  javascript: "main.js",
  "html-css": "index.html",
  csharp: "Program.cs",
  sql: "query.sql",
  powershell: "script.ps1",
  bash: "script.sh",
  go: "main.go",
  rust: "main.rs",
};

// Languages whose playground runs go through the server's local runner; the
// rest (including sql, which runs on sql.js in the browser) run client-side.
const LOCAL_PLAYGROUND: ReadonlySet<Language> = new Set(["csharp", "powershell", "bash", "go", "rust"]);

// Pseudo-lesson keys: "playground/<lang>/scratch" and "placement/<track>/interview".
export async function resolveLesson(
  contentDir: string,
  lessonId: string,
): Promise<{ lesson: Lesson; mode: SessionMode; placementInfo?: PlacementInfo } | null> {
  const cur = await getCurriculum(contentDir);
  const real = cur.lessons.get(lessonId);
  if (real) return { lesson: real, mode: "lesson" };

  const [kind, sub] = lessonId.split("/");
  if (kind === "playground" && sub in PLAYGROUND_FILES) {
    const language = sub as Language;
    const entry = PLAYGROUND_FILES[language];
    return {
      mode: "playground",
      lesson: {
        id: "scratch",
        trackId: "playground",
        unitId: language,
        title: `${language} playground`,
        language,
        runner: LOCAL_PLAYGROUND.has(language) ? "local" : "browser",
        estMinutes: 0,
        files: [{ path: entry, starter: entry }],
        goal: "(playground — no goal)",
        checks: [{ id: "none", type: "ai-judge", rubric: "(unused placeholder)" }],
        body: "",
        starterFiles: { [entry]: "" },
        testFiles: {},
      },
    };
  }
  if (kind === "placement") {
    const track = cur.tracks.find((t) => t.id === sub);
    if (!track) return null;
    return {
      mode: "placement",
      placementInfo: {
        trackTitle: track.title,
        units: track.units.map((u) => ({ id: u.id, title: u.title, tier: u.tier, summary: u.summary })),
      },
      lesson: {
        id: "interview",
        trackId: "placement",
        unitId: track.id,
        title: `${track.title} placement`,
        language: track.language,
        runner: "browser",
        estMinutes: 0,
        files: [{ path: "notes.txt", starter: "notes.txt" }],
        goal: "(placement interview)",
        checks: [{ id: "none", type: "ai-judge", rubric: "(unused placeholder)" }],
        body: "",
        starterFiles: {},
        testFiles: {},
      },
    };
  }
  return null;
}

export function tutorRoutes(contentDir: string, dataDir: string): Router {
  const r = Router();
  const docsDir = resolvePaths().docsDir;

  const deps: TutorDeps = {
    dataDir,
    contentDir,
    getSolution: async (key) => {
      const cur = await getCurriculum(contentDir);
      return cur.solutions.get(key) ?? null;
    },
    getDocSlugs: () => allDocSlugs(docsDir),
    getSettings: () => readJson<Settings>(path.join(dataDir, "settings.json"), DEFAULT_SETTINGS),
  };

  // ai-judge grading always sees the reference solution when one exists.
  setSolutionProvider(deps.getSolution);

  r.get("/api/tutor/stream", (req, res) => {
    const key = String(req.query.id ?? "");
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    // Replay everything buffered (or everything after Last-Event-ID on a
    // reconnect) so remounts recover the transcript.
    const lastEventId = Number(req.headers["last-event-id"]);
    const unsubscribe = hub.subscribe(key, res, Number.isFinite(lastEventId) ? lastEventId : undefined);
    req.on("close", unsubscribe);
  });

  r.post("/api/tutor/message", async (req, res) => {
    const { lessonId, text, lastRun, lastChecks, level } = req.body ?? {};
    const files = parseFiles(req.body?.files);
    const resolved = await resolveLesson(contentDir, String(lessonId));
    if (!resolved || typeof text !== "string" || !files) {
      res.status(400).json({ error: "lessonId, text, files (path -> string) required" });
      return;
    }
    await sendMessage(deps, resolved.lesson, {
      text,
      files,
      lastRun: lastRun ?? null,
      lastChecks: Array.isArray(lastChecks) ? lastChecks : null,
      level: (Number(level) || 3) as AssistanceLevel,
      mode: resolved.mode,
      placementInfo: resolved.placementInfo,
    });
    res.status(202).end();
  });

  r.post("/api/tutor/level", async (req, res) => {
    const { lessonId, level } = req.body ?? {};
    await setLevel(deps, String(lessonId), (Number(level) || 3) as AssistanceLevel);
    res.status(204).end();
  });

  r.post("/api/tutor/interrupt", async (req, res) => {
    const key = String(req.body?.lessonId ?? "");
    await interruptSession(key);
    hub.send(key, { type: "turn-end" });
    res.status(204).end();
  });

  r.delete("/api/tutor", async (req, res) => {
    await resetSession(deps, String(req.query.id ?? ""));
    res.status(204).end();
  });

  r.get("/api/profile", async (_req, res) => {
    res.json({ profile: await getProfile(dataDir) });
  });

  r.put("/api/profile", async (req, res) => {
    await setProfile(dataDir, String(req.body?.profile ?? ""));
    res.status(204).end();
  });

  r.get("/api/journal", async (_req, res) => {
    res.json(await getJournal(dataDir));
  });

  return r;
}
