// Rubberduck desktop shell.
//
// Packaged, this exe is the whole app: the bundled API server, the curriculum,
// the docs library and the built frontend all ship as resources, and the
// server runs on ELECTRON'S OWN Node (ELECTRON_RUN_AS_NODE=1) — nothing needs
// to be installed on the machine, not even Node.
//
// Run from source (npm run app), the same code points at the repo instead, so
// development is unchanged.
const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn, execFile } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const PORT = 4517; // hard-coded in the server too
// 127.0.0.1, never localhost: the server binds IPv4 only, and Chromium
// resolves localhost to ::1 first, waits for that connection to fail, then
// falls back. Measured at 200 ms on every cold socket — the first request
// after any pause longer than Node's 5 s keep-alive, which is most clicks.
const APP_URL = `http://127.0.0.1:${PORT}`;
const DEV_UI_URL = "http://127.0.0.1:5173"; // Vite, when a dev session is running
const KEEP_LOGS = 5;
const CUSTOM_UNIT_ID = "90-custom"; // must match server/src/tutor/author.ts
const CONTENT_STAMP = ".packaged-content-version";

// Where the window actually points — APP_URL normally, the Vite dev UI when a
// development server owns the API port.
let appUrl = APP_URL;

let serverProc = null;
let serverLog = null;
let win = null;
let PATHS = null;

// Packaged: extraResources sit beside app.asar under process.resourcesPath.
// From source: main.cjs lives in app/, so the repo is one level up.
const PACKAGED = app.isPackaged;
const RES = PACKAGED ? process.resourcesPath : path.join(__dirname, "..");

/**
 * Every location the shell and the server need. The packaged layout shares
 * nothing with the repo layout, which is exactly why the server reads all of
 * them from PT_* env vars instead of deriving them (server/src/paths.ts).
 */
/** Can we actually create and write files here? Probed, not guessed. */
function writableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Is this folder owned by an installer? The NSIS uninstaller does RMDir /r on
 * the install directory — and an upgrade runs the old uninstaller first — so
 * anything we keep beside the exe there would be deleted along with the app.
 * The zip build has no uninstaller, so its folder is genuinely ours.
 */
function installerManaged(dir) {
  try {
    return fs.readdirSync(dir).some((f) => /^Uninstall .*\.exe$/i.test(f));
  } catch {
    return false;
  }
}

// Portable by default: everything lives in the app's own folder, so the whole
// thing is one directory you can copy, move, or delete. Two cases fall back to
// the per-user location instead: an installed build (above), and a folder we
// can't write to (Program Files, a read-only share).
const PORTABLE_DATA = (() => {
  if (!PACKAGED) return null;
  // An AppImage never runs from the folder it lives in: it runs from a
  // read-only FUSE mount, or from a scratch directory under /tmp when the user
  // (or CI) sets APPIMAGE_EXTRACT_AND_RUN. Writing data "beside the exe" there
  // means writing to a directory that vanishes at exit. The AppImage runtime
  // exports APPIMAGE for exactly this question, so Linux uses the per-user
  // location — which is what Linux users expect anyway.
  if (process.env.APPIMAGE) return null;
  const dir = path.dirname(process.execPath);
  if (installerManaged(dir)) return null;
  const beside = path.join(dir, "data");
  return writableDir(beside) ? beside : null;
})();

// Chromium keeps its own profile — cache, localStorage, window state — under
// userData, which defaults to %APPDATA%. Move it inside the app folder too, or
// "delete the folder to uninstall" would quietly leave ~50 MB behind. This has
// to run before the app is ready: Chromium creates the profile at startup.
if (PORTABLE_DATA) app.setPath("userData", path.join(PORTABLE_DATA, "chromium"));

function resolveLayout() {
  if (!PACKAGED) {
    return {
      serverEntry: path.join(RES, "build", "server.cjs"),
      repoFallback: path.join(RES, "server", "src", "index.ts"),
      contentDir: path.join(RES, "content"),
      docsDir: path.join(RES, "docs-content"),
      webDist: path.join(RES, "web", "dist"),
      dataDir: path.join(RES, "data"),
    };
  }
  const userData = PORTABLE_DATA ?? app.getPath("userData");
  return {
    serverEntry: path.join(RES, "server", "server.cjs"),
    repoFallback: null,
    // Resources are read-only in principle, and an update overwrites them
    // wholesale. The curriculum is the one tree the app writes into — accepting
    // a custom lesson adds a lesson folder and edits track.json — so it gets
    // copied into the data folder once and used from there, where an update
    // can't clobber it. syncContent() picks the final value.
    contentDir: path.join(userData, "content"),
    shippedContent: path.join(RES, "content"),
    docsDir: path.join(RES, "docs-content"),
    webDist: path.join(RES, "web-dist"),
    dataDir: userData,
  };
}

/**
 * Copy the shipped curriculum into the writable user-data copy, once per app
 * version. Custom lessons the learner accepted live in `units/90-custom` and
 * are registered in each track.json — cpSync only adds and overwrites, so the
 * lesson folders survive a re-sync, but track.json would be replaced by the
 * shipped one and lose the registration. So it is captured and re-merged.
 *
 * Returns the directory to actually use: the writable copy, or (if the copy
 * failed) the read-only shipped one, so a failure here degrades to "custom
 * lessons can't be saved" instead of "the app won't start".
 */
function syncContent(shipped, writable, version) {
  const stamp = path.join(writable, CONTENT_STAMP);
  try {
    if (fs.readFileSync(stamp, "utf8").trim() === version) return writable;
  } catch {
    // no stamp yet, or unreadable — (re)sync below
  }
  try {
    const custom = readCustomUnits(writable);
    logLine(`syncing curriculum into ${writable} (version ${version})`);
    fs.mkdirSync(writable, { recursive: true });
    fs.cpSync(shipped, writable, { recursive: true, force: true });
    restoreCustomUnits(writable, custom);
    fs.writeFileSync(stamp, `${version}\n`);
    return writable;
  } catch (err) {
    logLine(`curriculum sync failed (${err.message}) — using the read-only copy; custom lessons can't be saved.`);
    return shipped;
  }
}

/** track id -> the "90-custom" unit object from that track's track.json. */
function readCustomUnits(contentRoot) {
  const units = new Map();
  const tracksDir = path.join(contentRoot, "tracks");
  let entries;
  try {
    entries = fs.readdirSync(tracksDir, { withFileTypes: true });
  } catch {
    return units; // nothing there yet — first run
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const json = JSON.parse(
        fs.readFileSync(path.join(tracksDir, entry.name, "track.json"), "utf8").replace(/^﻿/, ""),
      );
      const unit = json.units?.find((u) => u.id === CUSTOM_UNIT_ID);
      if (unit) units.set(entry.name, unit);
    } catch {
      // unreadable/absent track.json — nothing to preserve
    }
  }
  return units;
}

function restoreCustomUnits(contentRoot, units) {
  for (const [trackId, unit] of units) {
    const file = path.join(contentRoot, "tracks", trackId, "track.json");
    try {
      const json = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
      json.units ??= [];
      if (!json.units.some((u) => u.id === CUSTOM_UNIT_ID)) {
        json.units.push(unit);
        fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
        logLine(`restored ${unit.lessons?.length ?? 0} custom lesson(s) in track ${trackId}`);
      }
    } catch (err) {
      logLine(`could not restore custom lessons for track ${trackId}: ${err.message}`);
    }
  }
}

function logDir() {
  return path.join(PATHS.dataDir, "logs");
}

// Everything the server prints lands in <data>/logs/server-<date>.log — in exe
// mode there is no terminal, and a crash without a log is undiagnosable.
// Keeps the newest KEEP_LOGS files.
function openServerLog() {
  try {
    const dir = logDir();
    fs.mkdirSync(dir, { recursive: true });
    const name = `server-${new Date().toISOString().slice(0, 10)}.log`;
    const logs = fs
      .readdirSync(dir)
      .filter((f) => /^server-\d{4}-\d{2}-\d{2}\.log$/.test(f) && f !== name)
      .sort();
    for (const stale of logs.slice(0, Math.max(0, logs.length - (KEEP_LOGS - 1)))) {
      try {
        fs.rmSync(path.join(dir, stale), { force: true });
      } catch {
        // locked/vanished — fine
      }
    }
    return fs.createWriteStream(path.join(dir, name), { flags: "a" });
  } catch {
    return null; // never let logging break the app
  }
}

function logLine(text) {
  serverLog?.write(`[shell ${new Date().toISOString()}] ${text}\n`);
}

/**
 * quick=1 skips the tutor self-test and the toolchain probes. This only asks
 * whether the server is up; the window shouldn't wait on either.
 * @param timeoutMs generous while waiting for a cold start.
 */
function ping(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`${APP_URL}/api/health?quick=1`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** True when the URL returns an HTML document — i.e. something serving the app. */
function servesHtml(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      const type = String(res.headers["content-type"] ?? "");
      res.resume();
      resolve(res.statusCode === 200 && type.includes("html"));
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function healthJson() {
  return new Promise((resolve) => {
    const req = http.get(`${APP_URL}/api/health?quick=1`, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function ensureServer() {
  PATHS = resolveLayout();
  serverLog = openServerLog();
  if (PACKAGED) PATHS.contentDir = syncContent(PATHS.shippedContent, PATHS.contentDir, app.getVersion());

  if (await ping()) {
    // Something already owns the port. Only a PRODUCTION server serves the
    // app itself — a dev server (npm run dev) answers /api/* but returns 404
    // for "/", which would open an empty window with a cryptic error.
    const health = await healthJson();
    if (health?.servesUi === false || health?.mode === "development") {
      logLine(`a development server owns ${APP_URL}; it serves the API but not the app UI.`);
      // Vite serves the UI in that setup — use it so a running dev session
      // opens the real app instead of failing.
      if (await servesHtml(DEV_UI_URL)) {
        logLine(`using the Vite dev UI at ${DEV_UI_URL} instead.`);
        appUrl = DEV_UI_URL;
        return true;
      }
      dialog.showErrorBox(
        "Rubberduck",
        "A development server is already using port 4517, and it doesn't serve the app.\n\n" +
          "Close it (the terminal running 'npm run dev'), then start Rubberduck again.",
      );
      return false;
    }
    logLine(
      `attached to an already-running server on ${APP_URL} (version ${health?.version ?? "unknown"}) — ` +
        "if the app looks out of date, close that server and relaunch.",
    );
    return true;
  }

  if (!startServer()) return false;

  // Cold start: unpacking, first curriculum load and the toolchain probes all
  // land here, so the window is patient.
  for (let i = 0; i < 120; i++) {
    if (await ping(8000)) return true;
    if (serverProc === null) break; // spawn failed or the process died
    await new Promise((r) => setTimeout(r, 500));
  }
  dialog.showErrorBox(
    "Rubberduck",
    `The local server didn't start.\n\nDetails are in:\n${logDir()}`,
  );
  return false;
}

/** Spawns the bundled server. Returns false only if there is nothing to spawn. */
function startServer() {
  const env = {
    ...process.env,
    // Run the bundle on Electron's own Node. This is what makes the app
    // self-contained: `node` need not exist on the machine.
    ELECTRON_RUN_AS_NODE: "1",
    PT_CONTENT_DIR: PATHS.contentDir,
    PT_DOCS_DIR: PATHS.docsDir,
    PT_WEB_DIST: PATHS.webDist,
    PT_DATA_DIR: PATHS.dataDir,
    // No vite, no frontend sources, read-only resources: the staleness check
    // has nothing to do but fail.
    PT_NO_REBUILD: "1",
  };

  let command;
  let args;
  if (fs.existsSync(PATHS.serverEntry)) {
    command = process.execPath;
    args = [PATHS.serverEntry, "--prod"];
  } else if (PATHS.repoFallback && fs.existsSync(PATHS.repoFallback)) {
    // Running from source without a bundle: keep the old dev path working so
    // `npm run app` doesn't require `npm run bundle:server` first.
    logLine(`no bundle at ${PATHS.serverEntry} — falling back to tsx sources (development only).`);
    command = "node";
    args = ["--import", "tsx", PATHS.repoFallback, "--prod"];
    delete env.ELECTRON_RUN_AS_NODE;
  } else {
    dialog.showErrorBox("Rubberduck", `The app files are missing:\n${PATHS.serverEntry}`);
    return false;
  }

  logLine(`starting server: ${command} ${args.join(" ")}`);
  logLine(`  content=${PATHS.contentDir}`);
  logLine(`  docs=${PATHS.docsDir}`);
  logLine(`  web=${PATHS.webDist}`);
  logLine(`  data=${PATHS.dataDir}`);
  serverProc = spawn(command, args, {
    cwd: path.dirname(PATHS.serverEntry),
    env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc.stdout.on("data", (chunk) => serverLog?.write(chunk));
  serverProc.stderr.on("data", (chunk) => serverLog?.write(chunk));
  serverProc.on("exit", (code) => {
    logLine(`server exited with code ${code}`);
    serverProc = null;
  });
  serverProc.on("error", (err) => {
    logLine(`failed to spawn server: ${err.message}`);
    serverProc = null;
  });
  return true;
}

function stopServer() {
  if (serverProc?.pid) {
    // Kill the whole tree — the server spawns runners of its own.
    const pid = serverProc.pid;
    serverProc = null;
    if (process.platform === "win32") execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {});
    else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }
  serverLog?.end();
  serverLog = null;
}

function isAppUrl(url) {
  try {
    return new URL(url).origin === appUrl;
  } catch {
    return false;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    autoHideMenuBar: true,
    backgroundColor: "#16181d",
    show: false,
  });
  // External links (docs, tutor replies) open in the system browser — never
  // navigate the app window itself away from the local server, and never
  // spawn child BrowserWindows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  win.once("ready-to-show", () => win.show());
  win.loadURL(appUrl);
  win.on("closed", () => {
    win = null;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    if (await ensureServer()) createWindow();
    else app.quit();
  });

  app.on("window-all-closed", () => {
    stopServer();
    app.quit();
  });

  app.on("before-quit", stopServer);
}
