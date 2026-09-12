import express from "express";
import path from "node:path";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { curriculumRoutes } from "./routes/curriculum.js";
import { progressRoutes } from "./routes/progress.js";
import { draftRoutes } from "./routes/drafts.js";
import { settingsRoutes } from "./routes/settings.js";
import { runRoutes } from "./routes/run.js";
import { tutorRoutes } from "./routes/tutor.js";
import { customLessonRoutes } from "./routes/customLesson.js";
import { docsRoutes } from "./routes/docs.js";
import { exportRoutes } from "./routes/export.js";
import { getCurriculum } from "./curriculum/loader.js";
import { detectRuntimes } from "./preflight.js";
import { setJudge } from "./checks/run.js";
import { judgeCheck } from "./tutor/judge.js";
import { getAuthStatus, getTutorStatus, refreshTutorStatus, selfTestAuth } from "./tutor/service.js";
import { setClaudePathProvider } from "./tutor/claudeBinary.js";
import { readJson } from "./store/jsonStore.js";
import { resolvePaths } from "./paths.js";
import { DEFAULT_SETTINGS, type Settings } from "@teacher/shared";

const PATHS = resolvePaths();
export const ROOT = PATHS.root;
export const DATA_DIR = PATHS.dataDir;
export const CONTENT_DIR = PATHS.contentDir;

const isProd = process.argv.includes("--prod");
const PORT = 4517;

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();

// This server runs code and spends the user's Claude subscription — it must
// only ever serve the local machine. Binding to 127.0.0.1 keeps the LAN out;
// the Host check keeps DNS-rebinding pages out (a hostile site can point its
// own hostname at 127.0.0.1, but can't forge the Host header).
const ALLOWED_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
app.use((req, res, next) => {
  if (ALLOWED_HOST.test(req.headers.host ?? "")) {
    next();
    return;
  }
  res.status(403).json({ error: "Rubberduck only accepts local requests" });
});

app.use(express.json({ limit: "2mb" }));

// Settings may name an unusual Claude Code install; the resolver asks here
// rather than learning where settings live.
setClaudePathProvider(async () => {
  const settings = await readJson<Settings>(path.join(DATA_DIR, "settings.json"), DEFAULT_SETTINGS);
  return settings.claudePath;
});

app.get("/api/health", async (req, res) => {
  // quick=1 is the desktop shell asking "are you up?" while the window waits
  // to open. The full answer spends a Claude turn on the tutor self-test and
  // seven toolchain spawns; neither belongs between a double-click and a
  // window. Both still happen: in the background from the listen callback,
  // and on the UI's own health fetch.
  const quick = req.query.quick === "1";
  // Installing Claude Code while the app is open should be enough — no restart.
  if (!quick) await refreshTutorStatus().catch(() => {});
  const auth = getAuthStatus();
  const tutor = getTutorStatus();
  res.json({
    ok: true,
    version: "0.1.0",
    runtimes: quick ? null : await detectRuntimes(),
    // Coarse legacy view: "failed" covers both ways the tutor can be off.
    sdkAuth: auth.status,
    sdkAuthDetail: auth.detail,
    // Which way it is off, and the executable we found — the two have
    // different fixes, and the UI says so.
    tutor: { state: tutor.state, detail: tutor.detail, executable: tutor.executable },
    // The desktop shell needs this: a dev-mode server answers /api/* but does
    // NOT serve the built UI, so attaching to one would show a blank 404.
    mode: isProd ? "production" : "development",
    servesUi: isProd,
  });
});

app.use(curriculumRoutes(CONTENT_DIR, DATA_DIR));
app.use(progressRoutes(DATA_DIR));
app.use(draftRoutes(DATA_DIR));
app.use(settingsRoutes(DATA_DIR));
app.use(runRoutes(CONTENT_DIR, DATA_DIR));
app.use(tutorRoutes(CONTENT_DIR, DATA_DIR));
app.use(customLessonRoutes(CONTENT_DIR, DATA_DIR));
app.use(docsRoutes(PATHS.docsDir));
app.use(exportRoutes(DATA_DIR));

// The ai-judge check type is powered by the tutor's one-shot grader.
setJudge((lesson, rubric, files, run) =>
  judgeCheck(
    async () => (await readJson<Settings>(path.join(DATA_DIR, "settings.json"), DEFAULT_SETTINGS)).tutorModel,
    lesson,
    rubric,
    files,
    run,
  ),
);

// Unknown API paths 404 as JSON in every mode — the frontend (and the
// tutor's tools) always parse responses as JSON. Registered after the real
// routes and before the prod SPA fallback.
app.use("/api", (req, res) => {
  res.status(404).json({ error: `no such endpoint: ${req.baseUrl}${req.path}` });
});

// In prod, never serve a stale frontend: if any source file is newer than the
// built bundle, rebuild before serving. Keeps the desktop app honest after
// code changes — a restart is all it takes.
function newestMtime(dir: string): number {
  let newest = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0; // missing dir — nothing newer than the build
  }
  for (const entry of entries) {
    const full = path.join(entry.parentPath ?? dir, entry.name);
    try {
      newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs);
    } catch {
      // entry vanished mid-scan — ignore
    }
  }
  return newest;
}

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function ensureFreshDist(dist: string): void {
  // Best-effort: any failure here must fall back to serving the existing
  // dist, never crash the desktop app's backend at boot.
  try {
    const built = mtimeOf(path.join(dist, "index.html"));
    const sources = Math.max(
      newestMtime(path.join(ROOT, "web", "src")),
      newestMtime(path.join(ROOT, "shared", "src")),
      mtimeOf(path.join(ROOT, "web", "index.html")),
      mtimeOf(path.join(ROOT, "web", "vite.config.ts")),
      mtimeOf(path.join(ROOT, "web", "package.json")),
    );
    if (sources === 0 || sources <= built) return; // sources missing, or dist is fresh
    console.log("[server] frontend changed since last build — rebuilding…");
    const result = spawnSync("node", [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build"], {
      cwd: path.join(ROOT, "web"),
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.status !== 0) console.warn("[server] frontend rebuild failed — serving the previous build");
  } catch (err) {
    console.warn("[server] freshness check failed — serving the existing build:", err);
  }
}

if (isProd) {
  const dist = PATHS.webDist;
  // A packaged app ships dist as a read-only resource with no sources and no
  // vite to rebuild from — the freshness check has nothing to do but fail.
  if (!PATHS.noRebuild) ensureFreshDist(dist);
  app.use(express.static(dist));
  // SPA fallback (API paths were already handled — and 404ed — above).
  app.get("/*splat", (_req, res) => {
    res.sendFile(path.join(dist, "index.html"));
  });
}

// API errors must come back as JSON, never as Express's HTML error page —
// the frontend (and the tutor's tools) always parse responses as JSON.
app.use(
  (
    err: Error & { status?: number; statusCode?: number },
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    console.error("[server] unhandled error:", err);
    if (res.headersSent) {
      next(err); // let Express close the half-sent response
      return;
    }
    res.status(err.status ?? err.statusCode ?? 500).json({ error: err.message || "internal error" });
  },
);

const server = app.listen(PORT, "127.0.0.1", async () => {
  console.log(`[server] listening on http://localhost:${PORT}${isProd ? " (production)" : ""}`);
  // Everything below is startup reporting, not startup work. It runs inside an
  // async listen callback, so an unhandled rejection here would kill a server
  // that is already accepting requests — the desktop app would show a window
  // that dies a second later. Report and carry on instead.
  try {
    const cur = await getCurriculum(CONTENT_DIR);
    if (cur.errors.length > 0) {
      console.warn(`[content] ${cur.errors.length} validation error(s):`);
      for (const e of cur.errors) console.warn(`  ${e.file}: ${e.message}`);
    } else {
      console.log(`[content] ${cur.tracks.length} tracks, ${cur.lessons.size} lessons loaded`);
    }
  } catch (err) {
    console.error(`[content] failed to load the curriculum from ${CONTENT_DIR}:`, err);
  }
  void selfTestAuth();
  // Terminal `npm run start` opens the browser; the Electron shell (which
  // spawns us with piped/ignored stdio, so no TTY) opens its own window.
  // Each OS has its own opener — in a container there may be none at all, and
  // the error handler makes that a no-op rather than a crash.
  if (isProd && process.stdout.isTTY) {
    const url = `http://localhost:${PORT}`;
    const opener: [string, string[]] =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    spawn(opener[0], opener[1], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[server] port ${PORT} is already in use — is Rubberduck already running?`);
  } else {
    console.error("[server] failed to start:", err);
  }
  process.exit(1);
});
