import { spawn, execFile } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import initSqlJs from "sql.js";
import type { Language, RunResult } from "@teacher/shared";
import { extractTestEvents, formatSqlResults, runSqlProgram } from "@teacher/shared";
import { withFileLock } from "../store/jsonStore.js";

// Raw capture is generous so late __TEST__ events survive a chatty program;
// the learner-visible output is trimmed to OUTPUT_CAP after event extraction.
const RAW_CAP = 256 * 1024;
const OUTPUT_CAP = 64 * 1024;

const IS_WINDOWS = process.platform === "win32";

// POSIX children are spawned detached (see spawnCapture), which means they
// survive this process. Track the live groups so a server shutdown can't
// strand a learner's runaway program.
const liveGroups = new Set<number>();
if (!IS_WINDOWS) {
  process.on("exit", () => {
    for (const pid of liveGroups) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
}

function killTree(pid: number): void {
  if (IS_WINDOWS) {
    // child.kill() does not kill process trees on Windows, and dotnet/python
    // spawn children — taskkill /T /F is the reliable way.
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {});
    return;
  }
  // POSIX: the child leads its own process group (detached: true), so one
  // signal to the negative pid fells the interpreter AND everything it
  // spawned — the equivalent of taskkill /T. The group may already be gone
  // (the child exited between the timeout firing and this call), which throws.
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // nothing left to kill
  }
}

/** Trim display output to OUTPUT_CAP, never splitting a surrogate pair. */
function truncateOutput(s: string): string {
  if (s.length <= OUTPUT_CAP) return s;
  let end = OUTPUT_CAP;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // lone high surrogate: cut before it
  return `${s.slice(0, end)}\n…output truncated`;
}

interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  /** per-run test-harness nonce — only matching __TEST__ lines become events */
  nonce?: string;
}

export function spawnCapture(spec: SpawnSpec): Promise<RunResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    // Stateful decoding: a multibyte character split across pipe chunks must
    // not become U+FFFD mojibake (which would fail exact stdout matches).
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");

    // Lesson programs must produce plain output: the dev environment sets
    // FORCE_COLOR (concurrently), which would make Node colorize console.log
    // with ANSI codes and break output checks.
    const env: Record<string, string | undefined> = { ...process.env, ...spec.env, NO_COLOR: "1" };
    delete env.FORCE_COLOR;

    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env,
      shell: false,
      windowsHide: true,
      // POSIX: make the child a process-group leader so a timeout can kill
      // the whole tree with one signal (killTree). Windows keeps the default
      // — detached there would pop a console window; taskkill /T handles it.
      detached: !IS_WINDOWS,
    });
    if (!IS_WINDOWS && child.pid) liveGroups.add(child.pid);
    const untrack = (): void => {
      if (child.pid) liveGroups.delete(child.pid);
    };
    child.on("close", untrack);
    child.on("error", untrack);

    let forceTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
      // If the kill can't fell the tree (wedged/AV-locked process), 'close'
      // may never fire — force-finish so the request can't hang forever.
      forceTimer = setTimeout(() => finish(null), 5_000);
      forceTimer.unref();
    }, spec.timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < RAW_CAP) stdout += outDecoder.write(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < RAW_CAP) stderr += errDecoder.write(d);
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      // Extract events from the full raw capture BEFORE trimming, so debug
      // spam can't push the harness's test results past the display cap.
      const [clean, events] = extractTestEvents(stdout + outDecoder.end(), spec.nonce);
      const errText = truncateOutput(stderr + errDecoder.end());
      resolve({
        ok: exitCode === 0 && !timedOut,
        exitCode,
        stdout: truncateOutput(clean),
        stderr:
          errText +
          (timedOut ? (errText ? "\n" : "") + `Timed out after ${spec.timeoutMs / 1000}s (infinite loop?)` : ""),
        durationMs: Date.now() - start,
        timedOut,
        events: events.length > 0 ? events : undefined,
      });
    };

    child.on("error", (err) => {
      stderr += String(err);
      finish(null);
    });
    child.on("close", (code) => finish(code));

    // A child that exits before draining stdin fails the write with EPIPE;
    // without a listener that 'error' event would crash the whole server.
    child.stdin.on("error", () => {});
    if (spec.stdin !== undefined) child.stdin.write(spec.stdin);
    child.stdin.end();
  });
}

/**
 * Resolve a content/tutor-provided file name inside its workspace, refusing
 * escapes. A backslash separates path segments on Windows but is a perfectly
 * legal filename character on Linux, so "..\\..\\evil.py" would escape on one
 * platform and quietly create a bizarre file on the other — reject it outright
 * and the rule reads the same on both. Lesson paths always use "/".
 */
export function workspaceFile(dir: string, name: string): string {
  const full = path.resolve(dir, name);
  const rel = path.relative(dir, full);
  if (name.includes("\\") || rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`illegal file path: ${name}`);
  }
  return full;
}

async function writeWorkspaceFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, contents] of Object.entries(files)) {
    const full = workspaceFile(dir, name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, contents, "utf8");
  }
}

// Reuse one parent dir for workspaces so Windows Defender warms up on it.
export async function makeWorkspace(dataDir: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(dataDir, "run-workspaces", crypto.randomUUID());
  await fs.mkdir(dir, { recursive: true });
  await writeWorkspaceFiles(dir, files);
  return dir;
}

export async function cleanupWorkspace(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Delete run-workspace dirs left behind when cleanup failed (Defender or a
 * just-killed child holding a lock). Best effort; called at server start.
 */
export async function sweepStaleWorkspaces(dataDir: string, maxAgeMs = 60 * 60 * 1000): Promise<void> {
  const root = path.join(dataDir, "run-workspaces");
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return; // nothing ever ran
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of entries) {
    const full = path.join(root, name);
    try {
      const st = await fs.stat(full);
      if (st.mtimeMs < cutoff) await fs.rm(full, { recursive: true, force: true });
    } catch {
      // still locked or already gone — the next sweep gets it
    }
  }
}

// ---------- binary resolution ----------
// Go, Rust and .NET install per-user and are often missing from the PATH this
// server inherited (installed after launch, or via a user-scope installer the
// parent shell never saw). Resolve at spawn time: bare names via the OS
// lookup, absolute candidates via the filesystem — cached briefly so "install
// it, then hit Run again" works without a restart. Preflight shares these.

const RESOLVE_TTL_MS = 60_000;
const resolveCache = new Map<string, { at: number; bin: string }>();

/** Where a bare command name lives on PATH, or null. Windows asks where.exe
 *  (which honours PATHEXT and prints real paths); POSIX walks PATH itself,
 *  which beats shelling out to `which` (absent from slim containers) and
 *  costs no process. Callers that need the path itself — not just "is it
 *  installed" — use this: the tutor hands the Agent SDK an absolute path to
 *  the learner's own Claude Code. */
export async function lookupOnPath(name: string): Promise<string | null> {
  if (IS_WINDOWS) {
    return new Promise<string | null>((resolve) => {
      const child = execFile("where.exe", [name], { timeout: 5_000, windowsHide: true }, (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        // where.exe prints every match, newest PATH entry first.
        resolve(stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null);
      });
      child.on("error", () => resolve(null));
    });
  }
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue; // an empty PATH entry means cwd — never trust it here
    const full = path.join(entry, name);
    const ok = await fs.access(full, fsConstants.X_OK).then(
      () => true,
      () => false,
    );
    if (ok) return full;
  }
  return null;
}

/** Is a bare command name resolvable? */
async function foundOnPath(name: string): Promise<boolean> {
  return (await lookupOnPath(name)) !== null;
}

/** First candidate that exists: bare names checked against PATH, absolute
 *  paths via the filesystem. Falls back to the first bare name (letting the
 *  spawn fail with a real ENOENT) when nothing is found. */
export async function resolveBinary(candidates: string[]): Promise<string> {
  const key = candidates.join(";");
  const hit = resolveCache.get(key);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.bin;
  for (const c of candidates) {
    const found = path.isAbsolute(c)
      ? await fs.access(c).then(() => true, () => false)
      : await foundOnPath(c);
    if (found) {
      resolveCache.set(key, { at: Date.now(), bin: c });
      return c;
    }
  }
  return candidates.find((c) => !path.isAbsolute(c)) ?? candidates[0];
}

// Candidate lists take the platform so tests can inspect both branches from
// either OS; the Windows paths are built with path.win32 for the same reason.
// Order matters: the first candidate that exists wins.

function inHome(...parts: string[]): string {
  // POSIX-shaped home path, stable even when this runs on Windows (tests).
  return path.posix.join(os.homedir().replaceAll("\\", "/"), ...parts);
}

export function goCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    return ["go", path.win32.join(process.env.LOCALAPPDATA ?? "C:\\", "Programs", "go", "bin", "go.exe")];
  }
  // The official Linux/macOS tarball extracts to /usr/local/go.
  return ["go", "/usr/local/go/bin/go"];
}

export function rustcCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    return ["rustc", path.win32.join(process.env.USERPROFILE ?? "C:\\", ".cargo", "bin", "rustc.exe")];
  }
  return ["rustc", inHome(".cargo", "bin", "rustc")];
}

export function dotnetCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    return ["dotnet", path.win32.join(process.env.ProgramFiles ?? "C:\\Program Files", "dotnet", "dotnet.exe")];
  }
  // dotnet-install.sh defaults to ~/.dotnet; the packaged SDK lands in /usr/share.
  return ["dotnet", inHome(".dotnet", "dotnet"), "/usr/share/dotnet/dotnet"];
}

export function bashCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    // Git Bash first — plain `bash` on PATH is usually the WSL shim in
    // System32, which needs a Linux distro and can't run workspace scripts.
    return [path.win32.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"), "bash"];
  }
  return ["bash", "/bin/bash"];
}

export function powershellCandidates(platform: NodeJS.Platform = process.platform): string[] {
  // Windows PowerShell 5.1 ships with Windows. Elsewhere PowerShell 7 (pwsh)
  // is an optional install — missing pwsh is reported, never crashed on.
  if (platform === "win32") return ["powershell.exe"];
  return ["pwsh", "/opt/microsoft/powershell/7/pwsh"];
}

export function pythonCandidates(platform: NodeJS.Platform = process.platform): string[] {
  // Ubuntu (and most distros) ship python3 with no bare `python` unless
  // python-is-python3 is installed.
  if (platform === "win32") return ["python"];
  return ["python3", "python"];
}

/** Script-host arguments for a PowerShell run. -ExecutionPolicy is a
 *  Windows-only switch: pwsh on Linux rejects it. */
export function powershellArgs(entry: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32"
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", entry]
    : ["-NoProfile", "-File", entry];
}

/** Name rustc compiles to — Windows needs the .exe suffix to be runnable. */
export function rustBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "main.exe" : "main";
}

export interface LocalRunOptions {
  language: Language;
  entry: string;
  files: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  /** lesson key — C# runs reuse a persistent per-lesson workspace keyed on it */
  lessonKey?: string;
  /** per-run test-harness nonce (see extractTestEvents) */
  nonce?: string;
}

export async function runLocal(dataDir: string, opts: LocalRunOptions): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  if (opts.language === "csharp" || opts.language === "rust") {
    // These two reuse a persistent per-lesson workspace. Two overlapping runs
    // on one key — the learner's Run while the tutor's check_goal is in flight
    // — would write into the same directory and each grade the other's
    // program. Serialise on the workspace path; other runs are unaffected.
    const kind = opts.language === "csharp" ? "cs-workspaces" : "rs-workspaces";
    const lock = path.join(dataDir, kind, workspaceHash(opts));
    return withFileLock(lock, () =>
      opts.language === "csharp" ? runCsharp(dataDir, opts, timeoutMs) : runRust(dataDir, opts, timeoutMs),
    );
  }
  if (opts.language === "sql") return runSqlInProcess(opts, timeoutMs);
  const dir = await makeWorkspace(dataDir, opts.files);
  try {
    switch (opts.language) {
      case "python":
        return await spawnCapture({
          command: await resolveBinary(pythonCandidates()),
          args: ["-X", "utf8", opts.entry],
          cwd: dir,
          env: { PYTHONIOENCODING: "utf-8" },
          stdin: opts.stdin,
          timeoutMs,
          nonce: opts.nonce,
        });
      case "javascript":
        return await spawnCapture({
          command: "node",
          args: opts.entry.endsWith(".ts") ? ["--experimental-strip-types", opts.entry] : [opts.entry],
          cwd: dir,
          stdin: opts.stdin,
          timeoutMs,
          nonce: opts.nonce,
        });
      case "powershell":
        return await spawnCapture({
          command: await resolveBinary(powershellCandidates()),
          args: powershellArgs(opts.entry),
          cwd: dir,
          stdin: opts.stdin,
          timeoutMs,
          nonce: opts.nonce,
        });
      case "bash":
        return await spawnCapture({
          command: await resolveBinary(bashCandidates()),
          args: [opts.entry],
          cwd: dir,
          stdin: opts.stdin,
          timeoutMs,
          nonce: opts.nonce,
        });
      case "go":
        return await spawnCapture({
          command: await resolveBinary(goCandidates()),
          args: ["run", opts.entry],
          cwd: dir,
          // GOCACHE under data/ persists the build cache between runs, so
          // only the first `go run` pays the full compile.
          env: { GOFLAGS: "-mod=mod", GOCACHE: path.join(dataDir, "go-cache") },
          stdin: opts.stdin,
          timeoutMs: Math.max(timeoutMs, 30_000), // first compile is slow
          nonce: opts.nonce,
        });
      case "html-css":
        throw new Error("html-css lessons never use the local runner");
    }
  } finally {
    await cleanupWorkspace(dir);
  }
}

// C#: `dotnet run` in a persistent per-lesson workspace under
// data/cs-workspaces — bin/obj survive between runs, so only the first run
// pays the full restore+compile; later runs reuse the incremental build.
const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
`;

function workspaceHash(opts: LocalRunOptions): string {
  const wsKey = opts.lessonKey ?? `adhoc/${opts.entry}`;
  return crypto.createHash("sha1").update(wsKey).digest("hex");
}

async function csWorkspace(dataDir: string, opts: LocalRunOptions): Promise<string> {
  const dir = path.join(dataDir, "cs-workspaces", workspaceHash(opts));
  await fs.mkdir(dir, { recursive: true });
  const csproj = path.join(dir, "app.csproj");
  try {
    await fs.access(csproj);
  } catch {
    await fs.writeFile(csproj, CSPROJ, "utf8"); // written once; bin/obj stay warm
  }
  // Drop stray sources from earlier runs — the csproj compiles every .cs in
  // the folder, so a leftover file would silently change the program.
  for (const existing of await fs.readdir(dir)) {
    if (existing.endsWith(".cs") && !(existing in opts.files)) {
      await fs.rm(path.join(dir, existing), { force: true });
    }
  }
  await writeWorkspaceFiles(dir, opts.files);
  return dir;
}

const DOTNET_ENV = {
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  DOTNET_NOLOGO: "1",
  // Suppress the one-time "Welcome to .NET" banner — on a fresh machine it
  // lands on the first invocation and would otherwise be read as program output.
  DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
  // Culture-proof formatting: "9.75" must never become "9,75" on a
  // comma-decimal locale, or every exact stdout check would fail.
  DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1",
};

async function runCsharp(dataDir: string, opts: LocalRunOptions, timeoutMs: number): Promise<RunResult> {
  const dir = await csWorkspace(dataDir, opts);
  const dotnet = await resolveBinary(dotnetCandidates());

  // Build and run as SEPARATE steps. `dotnet run` interleaves restore/build
  // chatter with the program's own output on a cold machine — the first C# run
  // on a fresh install failed every exact-output check because of it, then
  // passed forever after. Building first keeps the run's stdout purely the
  // learner's program.
  const build = await spawnCapture({
    command: dotnet,
    args: ["build", "-v", "q", "--nologo"],
    cwd: dir,
    env: DOTNET_ENV,
    timeoutMs: Math.max(timeoutMs, 90_000), // restore + compile, cold
  });
  if (!build.ok) {
    // Compiler errors ARE the lesson content — surface them as the run's
    // failure, with build output on stderr where the error explainer reads it.
    return {
      ...build,
      stdout: "",
      stderr: [build.stdout, build.stderr].filter(Boolean).join("\n").trim(),
    };
  }

  const run = await spawnCapture({
    command: dotnet,
    args: ["run", "--no-build", "--project", ".", "-v", "q", "--nologo"],
    cwd: dir,
    env: DOTNET_ENV,
    stdin: opts.stdin,
    timeoutMs: Math.max(timeoutMs, 30_000),
    nonce: opts.nonce,
  });
  return { ...run, durationMs: build.durationMs + run.durationMs };
}

// Rust: rustc in a persistent per-lesson workspace under data/rs-workspaces
// (same shape as C#) — the compiled binary (main.exe / main) and rustc's
// incremental state stay put between runs. Compile errors come back as the
// run's stderr with ok:false: they ARE the learning content, not an internal
// failure.

async function rustWorkspace(dataDir: string, opts: LocalRunOptions): Promise<string> {
  const dir = path.join(dataDir, "rs-workspaces", workspaceHash(opts));
  await fs.mkdir(dir, { recursive: true });
  // Drop stray sources from earlier runs — a leftover module file would let
  // `mod x;` silently resolve against stale code.
  for (const existing of await fs.readdir(dir)) {
    if (existing.endsWith(".rs") && !(existing in opts.files)) {
      await fs.rm(path.join(dir, existing), { force: true });
    }
  }
  await writeWorkspaceFiles(dir, opts.files);
  return dir;
}

async function runRust(dataDir: string, opts: LocalRunOptions, timeoutMs: number): Promise<RunResult> {
  const dir = await rustWorkspace(dataDir, opts);
  const rustc = await resolveBinary(rustcCandidates());
  const binary = rustBinaryName();
  const compile = await spawnCapture({
    command: rustc,
    args: [opts.entry, "-o", binary, "--edition", "2021"],
    cwd: dir,
    timeoutMs: Math.max(timeoutMs, 60_000),
  });
  if (!compile.ok) return compile; // rustc diagnostics are already in stderr
  const run = await spawnCapture({
    command: path.join(dir, binary),
    args: [],
    cwd: dir,
    stdin: opts.stdin,
    timeoutMs,
    nonce: opts.nonce,
  });
  return {
    ...run,
    // Surface compile warnings (unused variables etc.) alongside the program's
    // own stderr — learners should see them without failing the run.
    stderr: compile.stderr ? compile.stderr + (run.stderr ? `\n${run.stderr}` : "") : run.stderr,
    durationMs: compile.durationMs + run.durationMs,
  };
}

// SQL: not a child process — sql.js (SQLite compiled to wasm) runs in-process
// against a fresh in-memory database per run. Seed files execute before the
// entry; result sets render through the shared formatter so stdout checks
// byte-match the browser runner.

type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>;
let sqlJsInit: Promise<SqlJsStatic> | null = null;

function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsInit) {
    sqlJsInit = initSqlJs();
    sqlJsInit.catch(() => {
      sqlJsInit = null; // failed wasm init shouldn't poison every later run
    });
  }
  return sqlJsInit;
}

async function runSqlInProcess(opts: LocalRunOptions, timeoutMs: number): Promise<RunResult> {
  const start = Date.now();
  const guardMs = Math.max(timeoutMs, 5_000);
  let timer: NodeJS.Timeout | undefined;
  // Execution is synchronous inside sql.js — the race only guards a wedged
  // wasm load, so no kill machinery is needed.
  const guard = new Promise<RunResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          exitCode: null,
          stdout: "",
          stderr: `Timed out after ${guardMs / 1000}s`,
          durationMs: Date.now() - start,
          timedOut: true,
        }),
      guardMs,
    );
    timer.unref();
  });
  const exec = (async (): Promise<RunResult> => {
    const SQL = await getSqlJs();
    const db = new SQL.Database();
    try {
      const results = runSqlProgram(db, opts.files, opts.entry);
      return {
        ok: true,
        exitCode: 0,
        stdout: truncateOutput(formatSqlResults(results)),
        stderr: "",
        durationMs: Date.now() - start,
        timedOut: false,
      };
    } catch (err) {
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        timedOut: false,
      };
    } finally {
      db.close();
    }
  })();
  try {
    return await Promise.race([exec, guard]);
  } finally {
    clearTimeout(timer);
  }
}
