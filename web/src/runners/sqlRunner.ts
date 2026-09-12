import type { RunResult } from "@teacher/shared";
import { formatSqlResults, runSqlProgram } from "@teacher/shared";

// sql.js manager: one memoized wasm init (same warm pattern as pyodide), a
// fresh in-memory Database per run so runs can't contaminate each other.
// Seed-then-entry semantics and the output format are shared with the
// server's in-process runner (@teacher/shared sqlFormat), so a lesson's
// stdout check byte-matches whichever side produced the output.

type SqlJsStatic = Awaited<ReturnType<(typeof import("sql.js"))["default"]>>;

let sqlJsInit: Promise<SqlJsStatic> | null = null;

function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsInit) {
    // scripts/copy-pyodide.mjs copies the wasm next to index.html, so the
    // fetch stays on the app's own origin.
    // sql.js's JS glue is 39 kB and only SQL lessons need it — loaded with the
    // wasm on first use, not in the boot chunk.
    sqlJsInit = import("sql.js").then(({ default: initSqlJs }) => initSqlJs({ locateFile: (file: string) => `/${file}` }));
    sqlJsInit.catch(() => {
      sqlJsInit = null; // a failed load shouldn't poison every later run
    });
  }
  return sqlJsInit;
}

/** Kick off the wasm load early so the first Run doesn't pay for it. */
export function warmSqlJs(): void {
  void getSqlJs().catch(() => {});
}

export async function runSql(files: Record<string, string>, entry: string): Promise<RunResult> {
  const start = performance.now();
  const done = (partial: Pick<RunResult, "ok" | "exitCode" | "stdout" | "stderr">): RunResult => ({
    ...partial,
    durationMs: Math.round(performance.now() - start),
    timedOut: false,
  });
  let db: InstanceType<SqlJsStatic["Database"]> | null = null;
  try {
    const SQL = await getSqlJs();
    db = new SQL.Database();
    const results = runSqlProgram(db, files, entry);
    return done({ ok: true, exitCode: 0, stdout: formatSqlResults(results), stderr: "" });
  } catch (err) {
    // SQL errors (syntax, missing table, …) are the learning content.
    return done({ ok: false, exitCode: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
  } finally {
    db?.close();
  }
}
