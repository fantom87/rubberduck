import { execFile } from "node:child_process";
import {
  bashCandidates,
  dotnetCandidates,
  goCandidates,
  powershellCandidates,
  pythonCandidates,
  resolveBinary,
  rustcCandidates,
} from "./runner/localRunner.js";

export interface RuntimeStatus {
  python: string | null;
  node: string | null;
  dotnet: string | null;
  go: string | null;
  rust: string | null;
  powershell: string | null;
  bash: string | null;
  /** in-process sql.js — bundled with the app, never missing */
  sql: string;
}

function version(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(command, args, { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout.trim().split("\n")[0] || null);
    });
    child.on("error", () => resolve(null));
  });
}

// Cached with a short TTL — not for the process lifetime — so "install it,
// then hit Run again" can actually succeed without restarting the app.
const TTL_MS = 60_000;
let cached: { at: number; status: RuntimeStatus } | null = null;
let probing: Promise<RuntimeStatus> | null = null;

export async function detectRuntimes(force = false): Promise<RuntimeStatus> {
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.status;
  probing ??= (async () => {
    // Preflight is called from /api/health, which the desktop shell polls to
    // decide whether the app started at all. It must therefore never reject:
    // a probe that blows up (a wedged binary, a permissions error) has to look
    // exactly like a runtime that isn't installed.
    const nothing: RuntimeStatus = {
      python: null,
      node: null,
      dotnet: null,
      go: null,
      rust: null,
      powershell: null,
      bash: null,
      sql: "sql.js (bundled)",
    };
    try {
      // Every probe goes through the same resolver the runner spawns with, so
      // preflight can never disagree with what Run does: off-PATH user-scope
      // installs, python3-vs-python, powershell.exe-vs-pwsh, Git Bash vs the
      // system bash. A missing runtime resolves to its bare name, the version
      // probe fails, and the field comes back null.
      const [python, node, dotnet, go, rust, powershell, bash] = await Promise.all([
        resolveBinary(pythonCandidates()).then((bin) => version(bin, ["--version"])),
        version("node", ["--version"]),
        resolveBinary(dotnetCandidates()).then((bin) => version(bin, ["--version"])),
        resolveBinary(goCandidates()).then((bin) => version(bin, ["version"])),
        resolveBinary(rustcCandidates()).then((bin) => version(bin, ["--version"])),
        resolveBinary(powershellCandidates())
          .then((bin) => version(bin, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]))
          .then((v) => (v ? `PowerShell ${v}` : null)),
        resolveBinary(bashCandidates()).then((bin) => version(bin, ["--version"])),
      ]);
      cached = {
        at: Date.now(),
        status: { python, node, dotnet, go, rust, powershell, bash, sql: "sql.js (bundled)" },
      };
      return cached.status;
    } catch (err) {
      console.warn("[preflight] runtime detection failed — reporting nothing installed:", err);
      return nothing;
    } finally {
      probing = null;
    }
  })();
  // A stale answer now beats a fresh one in half a second. Run and Check ask
  // about one language, and a runtime installed in the last minute is picked
  // up by the probe that just started; the next caller gets the fresh set.
  // Only the first call (nothing cached yet) and an explicit force wait.
  if (!force && cached) return cached.status;
  return probing;
}
